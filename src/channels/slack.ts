import { App, LogLevel } from '@slack/bolt';
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
    await this.app.start();

    // Get bot's own user ID to filter self-messages
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId, team: auth.team }, 'Slack bot authenticated');
    } catch (err) {
      logger.warn({ err }, 'Could not get Slack bot user ID');
    }

    this.connected = true;
    logger.info('Slack channel connected via Socket Mode');
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

  // --- Private helpers ---

  private setupListeners(): void {
    // Listen to all message events
    this.app.message(async ({ message }) => {
      // Filter out bot messages and subtypes (edits, deletes, etc.)
      const msg = message as unknown as Record<string, unknown>;
      if (msg.bot_id || msg.subtype) return;

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

      // Strip bot mention from channel messages (e.g. "<@U123ABC> hello" -> "hello")
      const cleanText = isDm ? text : this.stripBotMention(text);

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
    return text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
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
