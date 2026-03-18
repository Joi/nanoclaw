/**
 * Email channel — polls Gmail for emails from the owner.
 * URL-only emails are sent to the bookmark relay.
 * Natural language emails are delivered as messages to the agent pipeline.
 * Replies are sent via reply-all to preserve thread context.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  BOOKMARK_RELAY_URL,
  EMAIL_INTAKE_ACCOUNT,
  EMAIL_INTAKE_FROM_FILTER,
  EMAIL_INTAKE_POLL_INTERVAL,
  GOG_BIN,
  GOG_KEYRING_PASSWORD,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const execFileAsync = promisify(execFile);

const LABEL_NAME = 'nanoclaw-processed';
const GOG_TIMEOUT = 30_000;
const RELAY_TIMEOUT = 90_000;
const MAX_BODY_LENGTH = 10_000; // Truncate very long email bodies

// URL patterns to reject (noise from forwarded emails)
const REJECT_PATTERNS = [
  /teams\.microsoft\.com/i,
  /aka\.ms\//i,
  /google\.com\/calendar/i,
  /dialin\.teams/i,
  /unsubscribe/i,
  /manage.*preferences/i,
  /tracking/i,
  /click\./i,
  /open\./i,
  /^tel:/i,
  /^mailto:/i,
];

const MIN_URL_LENGTH = 15;
// Threshold: if non-URL text is under this many chars, treat as URL-only
const URL_ONLY_TEXT_THRESHOLD = 50;

export interface EmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// --- gog JSON types ---

interface GogListResponse {
  threads?: GogThread[];
  nextPageToken?: string;
}

interface GogThread {
  id: string;
  subject?: string;
  from?: string;
  date?: string;
  messageCount?: number;
}

interface GogThreadDetail {
  thread: {
    id: string;
    messages: GogMessageDetail[];
  };
}

interface GogMessageDetail {
  id: string;
  internalDate?: string;
  payload?: {
    body?: { data?: string };
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{
      mimeType?: string;
      body?: { data?: string };
      parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    }>;
  };
  body?: string;
  snippet?: string;
}

interface ReplyContext {
  messageId: string;
  threadId: string;
  subject: string;
}

export class EmailChannel implements Channel {
  name = 'email';

  private opts: EmailChannelOpts;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  // Most recent reply context per JID for threading
  private replyContext = new Map<string, ReplyContext>();

  constructor(opts: EmailChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    await this.ensureLabel();
    this.connected = true;

    // Initial poll
    this.poll().catch((err) =>
      logger.error({ err }, 'Email channel: initial poll error'),
    );

    // Repeating poll
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        logger.warn({ err }, 'Email channel: poll error'),
      );
    }, EMAIL_INTAKE_POLL_INTERVAL);

    logger.info(
      { account: EMAIL_INTAKE_ACCOUNT, from: EMAIL_INTAKE_FROM_FILTER },
      'Email channel connected, polling started',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const ctx = this.replyContext.get(jid);

    const args = [
      'gmail', 'send',
      '--account', EMAIL_INTAKE_ACCOUNT,
      '-y',
    ];

    if (ctx?.messageId) {
      // Reply-all within existing thread
      args.push('--reply-to-message-id', ctx.messageId);
      args.push('--reply-all');
      args.push('--subject', `Re: ${ctx.subject}`);
    } else {
      // Fallback: send new email to owner
      const recipient = jid.replace(/^email:/, '');
      args.push('--to', recipient);
      args.push('--subject', 'Message from jibot');
    }

    args.push('--body-file', '-'); // read body from stdin

    try {
      await this.callGogWithStdin(args, text);
      logger.info({ jid, length: text.length }, 'Email reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send email reply');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Email channel disconnected');
  }

  // --- Polling ---

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.doPoll();
    } finally {
      this.polling = false;
    }
  }

  private async doPoll(): Promise<void> {
    // List unprocessed emails from owner
    let threads: GogThread[];
    try {
      const query = `from:${EMAIL_INTAKE_FROM_FILTER} -label:${LABEL_NAME}`;
      const raw = await this.callGog([
        'gmail', 'list', '-j',
        '--account', EMAIL_INTAKE_ACCOUNT,
        query,
        '--max', '20',
      ]);
      const parsed = JSON.parse(raw) as GogListResponse;
      threads = parsed.threads || [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'Email channel: failed to list emails');
      return;
    }

    if (threads.length === 0) return;

    logger.info({ count: threads.length }, 'Email channel: processing threads');

    for (const thread of threads) {
      try {
        await this.processThread(thread);
      } catch (err) {
        logger.error(
          { threadId: thread.id, err },
          'Email channel: failed to process thread',
        );
      }
    }
  }

  private async processThread(thread: GogThread): Promise<void> {
    // Fetch full thread with all messages
    let threadDetail: GogThreadDetail;
    try {
      const raw = await this.callGog([
        'gmail', 'thread', 'get', thread.id,
        '-j', '--full',
        '--account', EMAIL_INTAKE_ACCOUNT,
      ]);
      threadDetail = JSON.parse(raw) as GogThreadDetail;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ threadId: thread.id, error: msg }, 'Email channel: failed to get thread');
      return;
    }

    const messages = threadDetail.thread?.messages;
    if (!messages || messages.length === 0) return;

    // Parse all messages in thread
    const parsed = messages.map((m) => this.parseMessage(m));

    // Classify based on the newest message (last in array)
    const newest = parsed[parsed.length - 1];
    const latestMessage = messages[messages.length - 1];
    const subject = newest.subject || thread.subject || '(no subject)';
    let classification = this.classifyEmail(newest.body);
    // Override: if subject contains a #ws: tag, force agent classification
    // so workstream-tagged emails always reach the jibrain intake hook
    if (classification === 'bookmark' && /#ws:[a-z0-9_:-]+/i.test(subject)) {
      classification = 'agent';
      logger.info({ threadId: thread.id, subject }, 'Email channel: ws: tag in subject, forcing agent classification');
    }

    logger.info(
      { threadId: thread.id, subject, classification, messageCount: messages.length },
      'Email channel: classified thread',
    );

    if (classification === 'bookmark') {
      // URL-only: extract and bookmark
      const urls = extractUrls(newest.body);
      // Extract ws: tag from subject for relay passthrough to bookmark-relay
      const wsMatch = subject.match(/#(ws:[a-z0-9_:-]+)/i);
      const relayTags = wsMatch ? [wsMatch[1]] : [];
      let relayFailed = false;
      for (const url of urls) {
        const ok = await bookmarkViaRelay(url, relayTags);
        if (!ok) {
          relayFailed = true;
          break;
        }
        logger.info({ url }, 'Email channel: bookmarked URL');
      }
      if (relayFailed) {
        logger.warn({ threadId: thread.id }, 'Email channel: relay down, will retry');
        return; // Don't mark processed — retry next poll
      }
    } else {
      // Natural language: deliver as message to agent pipeline
      const chatJid = `email:${EMAIL_INTAKE_FROM_FILTER}`;
      const timestamp = newest.date
        ? new Date(newest.date).toISOString()
        : new Date().toISOString();

      // Format full thread as message content
      const content = this.formatThread(parsed, subject);

      // Store reply context for reply-all
      this.replyContext.set(chatJid, {
        messageId: latestMessage.id,
        threadId: thread.id,
        subject,
      });

      const msgId = `email_${latestMessage.id}_${thread.id}`;

      // Notify chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, newest.from, 'email', false);

      const newMsg: NewMessage = {
        id: msgId,
        chat_jid: chatJid,
        sender: EMAIL_INTAKE_FROM_FILTER,
        sender_name: newest.from || EMAIL_INTAKE_FROM_FILTER,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.onMessage(chatJid, newMsg);
    }

    // Mark thread as processed (label + archive)
    try {
      await this.callGog([
        'gmail', 'thread', 'modify', thread.id,
        '--add', LABEL_NAME,
        '--remove', 'INBOX',
        '--account', EMAIL_INTAKE_ACCOUNT,
      ]);
      logger.info({ threadId: thread.id }, 'Email channel: marked processed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ threadId: thread.id, error: msg }, 'Email channel: failed to label thread');
    }
  }

  // --- Message parsing ---

  private parseMessage(msg: GogMessageDetail): {
    from: string;
    to: string;
    cc: string;
    subject: string;
    date: string;
    body: string;
    rfc822MessageId: string;
  } {
    const headers: Record<string, string> = {};
    for (const h of msg.payload?.headers || []) {
      headers[h.name] = h.value;
    }

    let body = extractBodyText(msg);
    if (body.length > MAX_BODY_LENGTH) {
      body = body.slice(0, MAX_BODY_LENGTH) + '\n[... truncated]';
    }

    return {
      from: headers['From'] || '',
      to: headers['To'] || '',
      cc: headers['Cc'] || '',
      subject: headers['Subject'] || '',
      date: headers['Date'] || '',
      body,
      rfc822MessageId: headers['Message-ID'] || headers['Message-Id'] || '',
    };
  }

  private formatThread(
    messages: Array<{ from: string; to: string; cc: string; subject: string; date: string; body: string; rfc822MessageId: string }>,
    subject: string,
  ): string {
    const participants = new Set<string>();
    for (const m of messages) {
      if (m.to) m.to.split(',').forEach((p) => participants.add(p.trim()));
      if (m.cc) m.cc.split(',').forEach((p) => participants.add(p.trim()));
      if (m.from) participants.add(m.from.trim());
    }

    // Build Mail.app link from the latest message's RFC 822 Message-ID
    const latestMsgId = messages[messages.length - 1]?.rfc822MessageId || '';
    const mailAppLink = latestMsgId
      ? `message://${encodeURIComponent(latestMsgId)}`
      : '';

    const lines: string[] = [
      `[Email Thread] Subject: ${subject}`,
      `Participants: ${[...participants].join(', ')}`,
    ];
    if (mailAppLink) {
      lines.push(`Mail.app link: ${mailAppLink}`);
    }
    lines.push('');

    for (const m of messages) {
      lines.push(`--- ${m.from} (${m.date}) ---`);
      lines.push(m.body.trim());
      lines.push('');
    }

    return lines.join('\n');
  }

  // --- Classification ---

  private classifyEmail(bodyText: string): 'bookmark' | 'agent' {
    const urls = extractUrls(bodyText);
    if (urls.length === 0) return 'agent';

    // Strip URLs from text
    let textOnly = bodyText.replace(/https?:\/\/[^\s<>"')\]},;]+/gi, '');

    // Strip forwarding artifacts
    textOnly = textOnly
      .replace(/^>+\s?/gm, '') // quoted text markers
      .replace(/^-{5,}\s*Forwarded message\s*-{5,}/gim, '')
      .replace(/^(From|To|Cc|Subject|Date|Sent):.*$/gim, '')
      .replace(/\s+/g, ' ')
      .trim();

    return textOnly.length < URL_ONLY_TEXT_THRESHOLD ? 'bookmark' : 'agent';
  }

  // --- Helpers ---

  private async ensureLabel(): Promise<void> {
    try {
      await this.callGog([
        'gmail', 'labels', 'create', LABEL_NAME,
        '--account', EMAIL_INTAKE_ACCOUNT,
      ]);
      logger.info('Created Gmail label: nanoclaw-processed');
    } catch {
      logger.debug('Gmail label nanoclaw-processed already exists or creation skipped');
    }
  }

  private async callGog(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(GOG_BIN, args, {
      env: { ...process.env, GOG_KEYRING_PASSWORD },
      encoding: 'utf-8',
      timeout: GOG_TIMEOUT,
    });
    return stdout;
  }

  private callGogWithStdin(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile(GOG_BIN, args, {
        env: { ...process.env, GOG_KEYRING_PASSWORD },
        encoding: 'utf-8',
        timeout: GOG_TIMEOUT,
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${err.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    });
  }
}

// --- Shared helpers (extracted from email-intake.ts) ---

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"')\]},;]+/gi;
  const matches = text.match(urlRegex) || [];

  const seen = new Set<string>();
  const results: string[] = [];

  for (let url of matches) {
    url = url.replace(/[.)>,;:!?]+$/, '');
    if (url.length < MIN_URL_LENGTH) continue;
    if (REJECT_PATTERNS.some((p) => p.test(url))) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push(url);
  }

  return results;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractBodyText(detail: GogMessageDetail): string {
  // Try top-level body (gog sometimes returns decoded body directly)
  if (detail.body) return detail.body;

  // Try payload body
  if (detail.payload?.body?.data) {
    return decodeBase64Url(detail.payload.body.data);
  }

  // Try payload parts (multipart emails)
  if (detail.payload?.parts) {
    for (const part of detail.payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Try nested parts (e.g., multipart/alternative inside multipart/mixed)
    for (const part of detail.payload.parts) {
      if (part.parts) {
        for (const subpart of part.parts) {
          if (subpart.mimeType === 'text/plain' && subpart.body?.data) {
            return decodeBase64Url(subpart.body.data);
          }
        }
      }
    }
    // Fall back to text/html if no plain text
    for (const part of detail.payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
  }

  return detail.snippet || '';
}

async function bookmarkViaRelay(url: string, tags?: string[]): Promise<boolean> {
  try {
    const resp = await fetch(`${BOOKMARK_RELAY_URL}/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, hint: "reference", ...(tags && tags.length > 0 ? { tags } : {}) }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT),
    });
    const result = (await resp.json()) as Record<string, unknown>;
    if (result.error) {
      logger.warn({ url, error: result.error }, 'Bookmark relay returned error');
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ url, error: msg }, 'Bookmark relay unreachable');
    return false;
  }
}
