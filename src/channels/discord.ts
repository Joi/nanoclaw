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

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord <@BOT_ID> mentions won't match TRIGGER_PATTERN (e.g., ^@jibot\b),
      // so we prepend the trigger when the bot is @mentioned.
      if (this.botUserId && content.includes(`<@${this.botUserId}>`)) {
        // Remove the Discord mention syntax
        content = content.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

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
