import {
  Client,
  GatewayIntentBits,
  Message as DiscordMessage,
  Partials,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private botUserId: string | null = null;
  /** Cache of displayName → userId for converting outbound @mentions back to Discord format */
  private mentionCache = new Map<string, string>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // Required for DM support
    });

    this.client.on('messageCreate', async (msg: DiscordMessage) => {
      // Ignore own messages
      if (msg.author.bot) return;

      const chatJid = msg.guild
        ? `dc:${msg.guild.id}:${msg.channelId}`
        : `dc:dm:${msg.author.id}`;
      let content = msg.content;
      const timestamp = msg.createdAt.toISOString();
      const senderName =
        msg.member?.displayName || msg.author.displayName || msg.author.username;
      const sender = msg.author.id;
      const msgId = msg.id;

      // Determine chat name
      const chatName = msg.guild
        ? (msg.channel as TextChannel).name || chatJid
        : senderName;

      // Translate ALL Discord <@USER_ID> mentions into readable @displayName in-place.
      // Discord mentions are opaque IDs like <@1234567890> that the LLM can't interpret.
      // Bot mentions become @jibot (for trigger matching); user mentions become @displayName.
      // Build a mention cache so outbound messages can convert names back to <@ID>.
      if (msg.mentions.users.size > 0) {
        for (const [userId, user] of msg.mentions.users) {
          const member = msg.guild?.members.cache.get(userId);
          const displayName = member?.displayName || user.displayName || user.username;
          if (userId === this.botUserId) {
            content = content.replace(new RegExp(`<@!?${userId}>`, 'g'), `@${ASSISTANT_NAME}`);
          } else {
            content = content.replace(new RegExp(`<@!?${userId}>`, 'g'), `@${displayName}`);
            this.mentionCache.set(displayName.toLowerCase(), userId);
          }
        }
      } else if (this.botUserId && content.includes(`<@${this.botUserId}>`)) {
        // Fallback: no parsed mentions but raw mention syntax present (e.g., from IPC)
        content = content.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), `@${ASSISTANT_NAME}`);
      }

      // Also cache the message sender for outbound mention resolution
      this.mentionCache.set(senderName.toLowerCase(), sender);

      // Store chat metadata for discovery
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        !!msg.guild,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord chat',
        );
        return;
      }

      // Build reply context if this is a reply
      let replyToId: string | undefined;
      let replyToContent: string | undefined;
      let replyToSender: string | undefined;
      if (msg.reference?.messageId) {
        try {
          const repliedMsg = await msg.fetchReference();
          replyToId = repliedMsg.id;
          replyToContent = repliedMsg.content?.slice(0, 200);
          replyToSender =
            repliedMsg.member?.displayName ||
            repliedMsg.author?.displayName ||
            repliedMsg.author?.username;
        } catch {
          // Reference message may be deleted
        }
      }

      // Deliver message
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        reply_to_message_id: replyToId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSender,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    this.client.on('error', (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve, reject) => {
      this.client!.once('ready', () => {
        this.botUserId = this.client!.user?.id || null;
        logger.info(
          { username: this.client!.user?.tag, id: this.botUserId },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${this.client!.user?.tag}`);
        console.log(
          `  JID format: dc:{guildId}:{channelId}\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken).catch((err) => {
        logger.error({ err }, 'Discord login failed');
        reject(err);
      });
    });
  }

  /**
   * Convert @displayName patterns in outbound text to Discord <@USER_ID> mentions.
   * Uses the mention cache first (fast), then searches guild members (slower fallback).
   */
  private async resolveOutboundMentions(text: string, channel: TextChannel): Promise<string> {
    // Find all @name patterns in the text (but not @jibot — that's us)
    const mentionRe = /@([\w.]+)/g;
    let match;
    const replacements: Array<{ from: string; to: string }> = [];

    while ((match = mentionRe.exec(text)) !== null) {
      const name = match[1];
      if (name.toLowerCase() === ASSISTANT_NAME.toLowerCase()) continue;

      // Try mention cache first
      const cachedId = this.mentionCache.get(name.toLowerCase());
      if (cachedId) {
        replacements.push({ from: match[0], to: `<@${cachedId}>` });
        continue;
      }

      // Search guild members as fallback
      if (channel.guild) {
        try {
          const members = await channel.guild.members.search({ query: name, limit: 1 });
          const member = members.first();
          if (member) {
            this.mentionCache.set(name.toLowerCase(), member.id);
            replacements.push({ from: match[0], to: `<@${member.id}>` });
          }
        } catch {
          // Guild member search failed — leave as plain text
        }
      }
    }

    // Also check for bare names (without @) that match cached users
    // Only for names that appeared as senders in this channel
    for (const [name, userId] of this.mentionCache) {
      if (name === ASSISTANT_NAME.toLowerCase()) continue;
      // Look for the name at word boundaries, case-insensitive, but only if not already a mention
      const bareRe = new RegExp(`(?<!@)\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (bareRe.test(text) && !text.includes(`<@${userId}>`)) {
        replacements.push({ from: name, to: `<@${userId}>` });
      }
    }

    // Apply replacements (longest first to avoid partial matches)
    replacements.sort((a, b) => b.from.length - a.from.length);
    for (const { from, to } of replacements) {
      text = text.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to);
    }

    return text;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      // Parse JID: dc:{guildId}:{channelId} or dc:dm:{userId}
      const parts = jid.replace(/^dc:/, '').split(':');

      let channel: TextChannel | null = null;

      if (parts[0] === 'dm') {
        // Direct message
        const user = await this.client.users.fetch(parts[1]);
        const dmChannel = await user.createDM();
        // Discord has a 2000 character limit per message
        const MAX_LENGTH = 2000;
        if (text.length <= MAX_LENGTH) {
          await dmChannel.send(text);
        } else {
          for (let i = 0; i < text.length; i += MAX_LENGTH) {
            await dmChannel.send(text.slice(i, i + MAX_LENGTH));
          }
        }
        logger.info({ jid, length: text.length }, 'Discord DM sent');
        return;
      }

      // Guild channel: parts = [guildId, channelId]
      const fetched = await this.client.channels.fetch(parts[1]);
      if (!fetched || !fetched.isTextBased()) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }
      channel = fetched as TextChannel;

      // Convert @displayName mentions back to Discord <@USER_ID> format.
      // First try the mention cache (populated from recent messages), then
      // search the guild member list for any remaining @name patterns.
      text = await this.resolveOutboundMentions(text, channel);

      // Discord has a 2000 character limit per message
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await channel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await channel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const parts = jid.replace(/^dc:/, '').split(':');
      if (parts[0] === 'dm') return; // Skip typing for DMs
      const channel = await this.client.channels.fetch(parts[1]);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}
