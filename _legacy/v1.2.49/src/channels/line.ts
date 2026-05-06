/**
 * LINE Messaging API channel for NanoClaw.
 *
 * Receives messages via webhook (LINE pushes events to us).
 * Sends messages via the LINE Messaging API (push messages).
 *
 * JID format: line:{groupId} (group) or line:dm:{userId} (DM)
 *
 * Requires:
 *   LINE_CHANNEL_ACCESS_TOKEN — long-lived channel access token
 *   LINE_CHANNEL_SECRET — for webhook signature validation
 *   LINE_WEBHOOK_PORT — HTTP port for webhook listener (default: 10280)
 */
import http from 'http';
import crypto from 'crypto';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface LineChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface LineEvent {
  type: string;
  replyToken?: string;
  source: {
    type: 'user' | 'group' | 'room';
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  timestamp: number;
  message?: {
    id: string;
    type: string;
    text?: string;
  };
}

interface LineProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
}

export class LineChannel implements Channel {
  name = 'line';

  private opts: LineChannelOpts;
  private accessToken: string;
  private channelSecret: string;
  private webhookPort: number;
  private server: http.Server | null = null;
  private connected = false;
  /** Cache of userId → displayName for readable messages */
  private profileCache = new Map<string, string>();

  constructor(
    accessToken: string,
    channelSecret: string,
    webhookPort: number,
    opts: LineChannelOpts,
  ) {
    this.accessToken = accessToken;
    this.channelSecret = channelSecret;
    this.webhookPort = webhookPort;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/webhook') {
        await this.handleWebhook(req, res);
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', channel: 'line' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.webhookPort, () => {
        this.connected = true;
        logger.info(
          { port: this.webhookPort },
          'LINE webhook server listening',
        );
        console.log(`\n  LINE webhook: http://localhost:${this.webhookPort}/webhook`);
        console.log(`  JID format: line:{groupId} or line:dm:{userId}\n`);
        resolve();
      });
      this.server!.on('error', (err) => {
        logger.error({ err }, 'LINE webhook server failed to start');
        reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Parse JID: line:{groupId} or line:dm:{userId}
    const prefix = 'line:';
    if (!jid.startsWith(prefix)) {
      logger.warn({ jid }, 'LINE: invalid JID format');
      return;
    }
    const rest = jid.slice(prefix.length);
    const isDm = rest.startsWith('dm:');
    const targetId = isDm ? rest.slice(3) : rest;

    // LINE has a 5000 character limit per text message
    const MAX_LENGTH = 5000;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_LENGTH) {
      chunks.push(text.slice(i, i + MAX_LENGTH));
    }

    for (const chunk of chunks) {
      await this.pushMessage(targetId, chunk);
    }

    logger.info({ jid, length: text.length }, 'LINE message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('line:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.connected = false;
      logger.info('LINE webhook server stopped');
    }
  }

  // --- Webhook handling ---

  private async handleWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks);

    // Validate signature
    const signature = req.headers['x-line-signature'] as string;
    if (!this.validateSignature(body, signature)) {
      logger.warn('LINE: webhook signature validation failed');
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    // Respond immediately (LINE expects 200 within seconds)
    res.writeHead(200);
    res.end('OK');

    // Process events asynchronously
    try {
      const payload = JSON.parse(body.toString('utf-8'));
      const events: LineEvent[] = payload.events || [];

      for (const event of events) {
        await this.processEvent(event);
      }
    } catch (err) {
      logger.error({ err }, 'LINE: failed to process webhook events');
    }
  }

  private validateSignature(body: Buffer, signature: string): boolean {
    if (!signature) return false;
    const hmac = crypto.createHmac('SHA256', this.channelSecret);
    hmac.update(body);
    const expected = hmac.digest('base64');
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  }

  private async processEvent(event: LineEvent): Promise<void> {
    if (event.type !== 'message' || !event.message || event.message.type !== 'text') {
      // Only handle text messages for now
      return;
    }

    const text = event.message.text || '';
    const timestamp = new Date(event.timestamp).toISOString();
    const msgId = event.message.id;

    // Build JID from source
    const source = event.source;
    let chatJid: string;
    let isGroup = false;

    if (source.type === 'group' && source.groupId) {
      chatJid = `line:${source.groupId}`;
      isGroup = true;
    } else if (source.type === 'room' && source.roomId) {
      chatJid = `line:${source.roomId}`;
      isGroup = true;
    } else if (source.userId) {
      chatJid = `line:dm:${source.userId}`;
    } else {
      logger.warn({ source }, 'LINE: cannot determine chat JID');
      return;
    }

    // Resolve sender name
    const senderId = source.userId || 'unknown';
    let senderName = this.profileCache.get(senderId) || senderId;
    if (!this.profileCache.has(senderId) && senderId !== 'unknown') {
      // Fetch profile (works for 1-on-1 and group chats)
      try {
        const profile = source.type === 'group' && source.groupId
          ? await this.getGroupMemberProfile(source.groupId, senderId)
          : await this.getUserProfile(senderId);
        if (profile) {
          senderName = profile.displayName;
          this.profileCache.set(senderId, senderName);
        }
      } catch {
        // Profile fetch may fail for users who haven't added the bot
        logger.debug({ senderId }, 'LINE: could not fetch user profile');
      }
    }

    // Get group name for metadata
    let chatName = chatJid;
    if (isGroup && source.groupId) {
      try {
        const groupSummary = await this.getGroupSummary(source.groupId);
        if (groupSummary) chatName = groupSummary;
      } catch {
        // Group summary not available
      }
    } else {
      chatName = senderName;
    }

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'line', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, chatName }, 'Message from unregistered LINE chat');
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, chatName, sender: senderName }, 'LINE message stored');
  }

  // --- LINE API calls ---

  private async apiRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `https://api.line.me${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };
    const opts: RequestInit = { method, headers };

    if (body) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LINE API ${method} ${path}: ${res.status} ${text}`);
    }

    const contentType = res.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return res.json();
    }
    return null;
  }

  private async pushMessage(to: string, text: string): Promise<void> {
    await this.apiRequest('POST', '/v2/bot/message/push', {
      to,
      messages: [{ type: 'text', text }],
    });
  }

  private async getUserProfile(userId: string): Promise<LineProfile | null> {
    try {
      return (await this.apiRequest('GET', `/v2/bot/profile/${userId}`)) as LineProfile;
    } catch {
      return null;
    }
  }

  private async getGroupMemberProfile(
    groupId: string,
    userId: string,
  ): Promise<LineProfile | null> {
    try {
      return (await this.apiRequest(
        'GET',
        `/v2/bot/group/${groupId}/member/${userId}`,
      )) as LineProfile;
    } catch {
      return null;
    }
  }

  private async getGroupSummary(groupId: string): Promise<string | null> {
    try {
      const summary = (await this.apiRequest(
        'GET',
        `/v2/bot/group/${groupId}/summary`,
      )) as { groupName?: string };
      return summary?.groupName || null;
    } catch {
      return null;
    }
  }
}
