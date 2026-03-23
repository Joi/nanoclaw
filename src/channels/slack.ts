import { App, LogLevel } from '@slack/bolt';
import fs from 'fs';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  onNewContact?: (chatJid: string, senderName: string, isGroup: boolean) => boolean;
  /** Namespace for multi-workspace support (e.g. 'cit' → JIDs become slack:cit:U...) */
  namespace?: string;
  /** Persist state across restarts (key-value store backed by SQLite) */
  getState?: (key: string) => string | undefined;
  setState?: (key: string, value: string) => void;
}

export class SlackChannel implements Channel {
  name: string;

  private app: App;
  private opts: SlackChannelOpts;
  private connected = false;
  private userCache = new Map<string, string>(); // userId -> displayName
  private dmChannelCache = new Map<string, string>(); // userId -> DM channel ID
  private botUserId: string | null = null;
  /** JID prefix for DMs: "slack:" or "slack:cit:" */
  private prefix: string;
  /** JID prefix for channels: "slack:channel:" or "slack:cit:channel:" */
  private channelPrefix: string;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    const ns = opts.namespace;
    this.name = ns ? `slack-${ns}` : 'slack';
    this.prefix = ns ? `slack:${ns}:` : 'slack:';
    this.channelPrefix = ns ? `slack:${ns}:channel:` : 'slack:channel:';
    this.app = new App({
      token: opts.slackBotToken,
      appToken: opts.slackAppToken,
      signingSecret: opts.slackSigningSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    this.setupListeners();
  }

  async connect(): Promise<void> {
    // Global error handler for Bolt
    this.app.error(async (error) => {
      logger.error({ err: error, channel: this.name }, 'Slack Bolt app error');
    });

    await this.app.start();

    // Get bot's own user ID to filter self-messages
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId, team: auth.team }, 'Slack bot authenticated');
    } catch (err) {
      logger.warn({ err }, 'Could not get Slack bot user ID');
    }

    // Hook into SocketModeClient reconnect events for connection state tracking
    this.setupReconnectHooks();

    this.connected = true;
    logger.info('Slack channel connected via Socket Mode');

    // Catch up on any messages missed while disconnected
    try {
      const count = await this.catchUpHistory();
      if (count > 0) {
        logger.info({ channel: this.name, count }, 'Slack history catchup delivered missed messages');
      }
    } catch (err) {
      logger.error({ err, channel: this.name }, 'Failed initial history catchup');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = await this.resolveChannelId(jid);
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text,
      });
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
      throw err;
    }
  }


  async sendFile(jid: string, filePath: string, filename: string): Promise<void> {
    const channelId = await this.resolveChannelId(jid);
    try {
      await this.app.client.filesUploadV2({
        channel_id: channelId,
        file: fs.createReadStream(filePath),
        filename,
      });
      logger.info({ jid, filename }, 'Slack file uploaded');
    } catch (err) {
      logger.error({ jid, filename, err }, 'Failed to upload Slack file');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    if (this.opts.namespace) {
      // Namespaced instance: only owns JIDs with our exact prefix
      return jid.startsWith(this.prefix);
    }
    // Default (no namespace): owns slack:U..., slack:channel:C...
    // but NOT slack:cit:... (namespace prefixes start with a lowercase letter)
    if (!jid.startsWith('slack:')) return false;
    const afterSlack = jid.charAt(6); // char after "slack:"
    return afterSlack === afterSlack.toUpperCase() || jid.startsWith('slack:channel:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.app.stop();
    } catch (err) {
      logger.warn({ err }, 'Error stopping Slack app');
    }
    logger.info('Slack channel disconnected');
  }

  // --- History catchup ---

  /**
   * Catch up on messages missed during disconnection.
   * For each registered channel, fetches messages newer than the last-seen
   * timestamp via conversations.history and injects them into the message pipeline.
   * Returns the total number of caught-up messages.
   */
  async catchUpHistory(): Promise<number> {
    const groups = this.opts.registeredGroups();
    let totalCaughtUp = 0;

    for (const [jid, _group] of Object.entries(groups)) {
      // Only process JIDs owned by this Slack instance
      if (!this.ownsJid(jid)) continue;

      try {
        const count = await this.catchUpChannel(jid);
        totalCaughtUp += count;
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to catch up history for channel');
      }
    }

    return totalCaughtUp;
  }

  private async catchUpChannel(jid: string): Promise<number> {
    const isChannel = jid.startsWith(this.channelPrefix);
    let slackChannelId: string;

    if (isChannel) {
      slackChannelId = jid.slice(this.channelPrefix.length);
    } else {
      // DM: resolve the Slack DM channel ID
      const userId = jid.slice(this.prefix.length);
      try {
        const result = await this.app.client.conversations.open({ users: userId });
        slackChannelId = result.channel?.id || '';
        if (!slackChannelId) return 0;
        this.dmChannelCache.set(userId, slackChannelId);
      } catch (err) {
        logger.debug({ jid, err }, 'Could not open DM for history catchup');
        return 0;
      }
    }

    const stateKey = `${this.name}_last_ts:${slackChannelId}`;
    const lastTs = this.opts.getState?.(stateKey);

    if (!lastTs) {
      // First time seeing this channel — seed the timestamp with "now" so future
      // reconnects have a baseline. Don't replay the entire channel history.
      const now = (Date.now() / 1000).toFixed(6);
      this.opts.setState?.(stateKey, now);
      logger.debug({ jid, slackChannelId }, 'Seeded last-seen timestamp (first run)');
      return 0;
    }

    // Fetch messages newer than lastTs
    const result = await this.app.client.conversations.history({
      channel: slackChannelId,
      oldest: lastTs,
      inclusive: false, // don't re-process the last seen message
      limit: 200,
    });

    const messages = (result.messages || [])
      .filter(m => {
        // Skip bot messages and our own messages
        if (m.bot_id) return false;
        if (!m.user) return false;
        if (m.user === this.botUserId) return false;
        // Allow file_share subtypes (they have text + files) but skip other subtypes
        if (m.subtype && m.subtype !== 'file_share') return false;
        return true;
      })
      .reverse(); // API returns newest-first; we want oldest-first for correct ordering

    if (messages.length === 0) return 0;

    let newestTs = lastTs;

    for (const msg of messages) {
      const userId = msg.user!;
      const ts = msg.ts!;
      const senderName = await this.resolveUserName(userId);
      const isDm = !isChannel;

      // Build content: include file names if present
      let content = msg.text || '';
      const files = (msg as any).files as Array<{ name: string; url_private: string }> | undefined;
      if (files && files.length > 0) {
        const fileList = files.map(f => f.name).join(', ');
        content = content
          ? `${content}\n[Attached files: ${fileList}]`
          : `[Attached files: ${fileList}]`;
      }

      const cleanText = isDm ? content : this.stripBotMention(content);
      const timestamp = this.slackTsToIso(ts);
      const msgId = `slack_${ts}_${userId}`;
      const senderJid = `${this.prefix}${userId}`;

      // Notify chat metadata
      this.opts.onChatMetadata(jid, timestamp, isDm ? senderName : undefined, 'slack', !isDm);

      const newMsg: NewMessage = {
        id: msgId,
        chat_jid: jid,
        sender: senderJid,
        sender_name: senderName,
        content: cleanText,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };
      this.opts.onMessage(jid, newMsg);
      logger.info(
        { channel: this.name, slackChannel: slackChannelId, sender: senderName, ts, hasFiles: !!files },
        'Caught up missed Slack message',
      );

      if (parseFloat(ts) > parseFloat(newestTs)) {
        newestTs = ts;
      }
    }

    // Persist the newest timestamp
    this.opts.setState?.(stateKey, newestTs);
    logger.info(
      { channel: this.name, slackChannel: slackChannelId, count: messages.length },
      'Slack channel history catchup complete',
    );

    return messages.length;
  }

  // --- Private helpers ---

  private setupReconnectHooks(): void {
    // Access Bolt's internal SocketModeClient for connection lifecycle events.
    // This uses Bolt internals but is stable across @slack/bolt 4.x.
    try {
      const receiver = (this.app as any).receiver;
      const smClient = receiver?.client;
      if (!smClient) {
        logger.debug({ channel: this.name }, 'Could not access SocketModeClient for reconnect hooks');
        return;
      }

      smClient.on('connected', () => {
        const wasDisconnected = !this.connected;
        this.connected = true;
        if (wasDisconnected) {
          logger.info({ channel: this.name }, 'Slack WebSocket reconnected — running history catchup');
          this.catchUpHistory().catch(err => {
            logger.error({ err, channel: this.name }, 'Failed history catchup after reconnect');
          });
        }
      });

      smClient.on('disconnecting', () => {
        this.connected = false;
        logger.warn({ channel: this.name }, 'Slack WebSocket disconnecting');
      });

      smClient.on('reconnecting', () => {
        this.connected = false;
        logger.warn({ channel: this.name }, 'Slack WebSocket reconnecting');
      });

      logger.debug({ channel: this.name }, 'Slack reconnect hooks installed');
    } catch (err) {
      logger.warn({ err, channel: this.name }, 'Failed to install Slack reconnect hooks');
    }
  }

  private setupListeners(): void {
    // Listen to all message events
    this.app.message(async ({ message }) => {
      // Filter out bot messages and subtypes (edits, deletes, etc.)
      // Allow file_share subtype since it contains text + attached files
      const msg = message as unknown as Record<string, unknown>;
      if (msg.bot_id) return;
      if (msg.subtype && msg.subtype !== 'file_share') return;

      const userId = msg.user as string | undefined;
      if (!userId) return;

      // Filter self-messages
      if (userId === this.botUserId) return;

      const channelId = msg.channel as string;
      const channelType = msg.channel_type as string;
      const text = msg.text as string || '';
      const ts = msg.ts as string;

      const isDm = channelType === 'im';
      const chatJid = isDm
        ? `${this.prefix}${userId}`
        : `${this.channelPrefix}${channelId}`;
      const senderJid = `${this.prefix}${userId}`;

      // Cache DM channel ID for outbound replies
      if (isDm) {
        this.dmChannelCache.set(userId, channelId);
      }

      const senderName = await this.resolveUserName(userId);
      const timestamp = this.slackTsToIso(ts);
      const msgId = `slack_${ts}_${userId}`;

      // Build content: include file names if present
      let content = text;
      const files = msg.files as Array<{ name: string; url_private: string }> | undefined;
      if (files && files.length > 0) {
        const fileList = files.map(f => f.name).join(', ');
        content = content
          ? `${content}\n[Attached files: ${fileList}]`
          : `[Attached files: ${fileList}]`;
      }

      // Strip bot mention from channel messages (e.g. "<@U123ABC> hello" -> "@jibot hello")
      const cleanText = isDm ? content : this.stripBotMention(content);

      // Notify chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, isDm ? senderName : undefined, 'slack', !isDm);

      // Check registration and auto-register if needed
      let groups = this.opts.registeredGroups();
      if (!groups[chatJid] && this.opts.onNewContact) {
        const registered = this.opts.onNewContact(chatJid, isDm ? senderName : channelId, !isDm);
        if (registered) {
          groups = this.opts.registeredGroups();
        }
      }

      if (groups[chatJid]) {
        const newMsg: NewMessage = {
          id: msgId,
          chat_jid: chatJid,
          sender: senderJid,
          sender_name: senderName,
          content: cleanText,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        };
        this.opts.onMessage(chatJid, newMsg);
      }

      // Update last-seen timestamp for this channel (for history catchup)
      if (this.opts.setState) {
        const slackChannelId = isDm ? channelId : channelId;
        const stateKey = `${this.name}_last_ts:${slackChannelId}`;
        this.opts.setState(stateKey, ts);
      }
    });
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.profile?.display_name
        || result.user?.real_name
        || result.user?.name
        || userId;
      this.userCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return userId;
    }
  }

  private stripBotMention(text: string): string {
    if (!this.botUserId) return text;
    // Slack mentions look like <@U01ABC123>
    return text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "@jibot ").trim();
  }

  private slackTsToIso(ts: string): string {
    // Slack timestamps are Unix epoch with microseconds: "1234567890.123456"
    const epochSeconds = parseFloat(ts);
    return new Date(epochSeconds * 1000).toISOString();
  }

  private async resolveChannelId(jid: string): Promise<string> {
    if (jid.startsWith(this.channelPrefix)) {
      return jid.slice(this.channelPrefix.length);
    }
    // DM: slack:{user_id} or slack:ns:{user_id} — open a DM conversation to get the channel ID
    const userId = jid.slice(this.prefix.length);
    const cached = this.dmChannelCache.get(userId);
    if (cached) return cached;

    const result = await this.app.client.conversations.open({ users: userId });
    const dmChannelId = result.channel?.id;
    if (!dmChannelId) throw new Error(`Failed to open DM with ${userId}`);
    this.dmChannelCache.set(userId, dmChannelId);
    return dmChannelId;
  }
}
