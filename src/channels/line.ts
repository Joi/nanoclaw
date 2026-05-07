/**
 * LINE Messaging API channel adapter (v2 — native, no Chat SDK bridge).
 *
 * Receives messages via webhook (LINE pushes events to us) and sends via
 * the LINE push-message endpoint. Authored fresh for 2.0 — there's no
 * `@chat-adapter/line` upstream package, and the legacy 1.x adapter
 * imported types that the 2.0 rewrite deleted, so it couldn't be ported
 * surgically. Behavior matches the 1.x version (joi commits 380f4e8,
 * ff5c939, f194607, ced3f95): same wire protocol, same pushMessage
 * shape, same signature scheme; what differs is the host-side hookup.
 *
 * Platform-ID scheme (chosen here, no 1.x carryover constraint since
 * 2.0's DB is a fresh start):
 *
 *   DM:    line:user:{userId}
 *   Group: line:group:{groupId}
 *   Room:  line:room:{roomId}
 *
 * Symmetric and self-describing — `platformId.startsWith('line:user:')`
 * is unambiguously a DM. The legacy `line:{groupId}` / `line:dm:{userId}`
 * scheme worked but required collapsing groups+rooms and inferring DM
 * status from the absence of a colon-separated kind segment.
 *
 * Required env:
 *   LINE_CHANNEL_ACCESS_TOKEN — long-lived channel access token
 *   LINE_CHANNEL_SECRET       — for webhook signature validation
 *
 * Optional env:
 *   LINE_WEBHOOK_PORT — HTTP port for the webhook listener (default 10280)
 *   LINE_WEBHOOK_PATH — request path (default '/webhook')
 */
import crypto from 'crypto';
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { ASSISTANT_NAME } from '../config.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const DEFAULT_PORT = 10280;
const DEFAULT_PATH = '/webhook';
const MAX_MESSAGE_CHARS = 5000;
const LINE_API_BASE = 'https://api.line.me';

interface LineEventSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineMessage {
  id: string;
  type: string;
  text?: string;
}

interface LineEvent {
  type: string;
  replyToken?: string;
  source: LineEventSource;
  timestamp: number;
  message?: LineMessage;
}

interface LineProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
}

/** Timing-safe webhook signature check. Exported for tests. */
export function validateSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64');
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signature);
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

/**
 * Build the platformId for an event source. Returns null when the source
 * doesn't carry the id we need (defensive — LINE shouldn't send events
 * without the relevant id, but we don't trust the wire).
 */
export function platformIdForSource(source: LineEventSource): string | null {
  if (source.type === 'group' && source.groupId) return `line:group:${source.groupId}`;
  if (source.type === 'room' && source.roomId) return `line:room:${source.roomId}`;
  if (source.type === 'user' && source.userId) return `line:user:${source.userId}`;
  return null;
}

/**
 * Parse a platformId back into `{ kind, id }` for outbound delivery. Returns
 * null on malformed input. The push-message API takes the bare id string
 * (groupId / roomId / userId) — kind is just for debugging.
 */
export function parsePlatformId(platformId: string): { kind: 'user' | 'group' | 'room'; id: string } | null {
  const m = /^line:(user|group|room):(.+)$/.exec(platformId);
  if (!m) return null;
  return { kind: m[1] as 'user' | 'group' | 'room', id: m[2]! };
}

/** Split text on the LINE 5000-char per-message ceiling. Exported for tests. */
export function splitForLineLimit(text: string, limit: number = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    out.push(text.slice(i, i + limit));
  }
  return out;
}

interface LineAdapterConfig {
  accessToken: string;
  channelSecret: string;
  port: number;
  path: string;
  apiBase?: string; // override for tests
}

class LineChannelAdapter implements ChannelAdapter {
  readonly name = 'line';
  readonly channelType = 'line';
  readonly supportsThreads = false;

  private cfg: LineAdapterConfig;
  private setupConfig: ChannelSetup | null = null;
  private server: http.Server | null = null;
  private profileCache = new Map<string, string>();

  constructor(cfg: LineAdapterConfig) {
    this.cfg = cfg;
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    return this.startServer();
  }

  async teardown(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
    log.info('LINE webhook server stopped');
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const parsed = parsePlatformId(platformId);
    if (!parsed) {
      log.warn('LINE deliver: unrecognized platformId', { platformId });
      return undefined;
    }

    // Extract a flat text from the outbound payload. Card support is a
    // future enhancement; for now we serialize anything non-text into
    // its JSON to surface the shape rather than silently dropping it.
    const text = extractText(message);
    if (!text) return undefined;

    const chunks = splitForLineLimit(text);
    let lastId: string | undefined;
    for (const chunk of chunks) {
      const resp = (await this.pushMessage(parsed.id, chunk)) as
        | { sentMessages?: Array<{ id: string }> }
        | null;
      lastId = resp?.sentMessages?.[0]?.id ?? lastId;
    }
    return lastId;
  }

  // ── HTTP server ────────────────────────────────────────────────────────

  private startServer(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', channel: 'line' }));
        return;
      }
      if (req.method === 'POST' && req.url === this.cfg.path) {
        await this.handleWebhook(req, res).catch((err) => {
          log.error('LINE webhook handler threw', { err });
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.cfg.port, () => {
        log.info('LINE webhook server listening', { port: this.cfg.port, path: this.cfg.path });
        resolve();
      });
    });
  }

  private async handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks);

    const signature = req.headers['x-line-signature'];
    const sigStr = Array.isArray(signature) ? signature[0] : signature;
    if (!validateSignature(body, sigStr, this.cfg.channelSecret)) {
      log.warn('LINE webhook signature validation failed');
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    // 200 OK immediately — LINE expects acknowledgement within a few
    // seconds and retries otherwise. Process events async after the ack.
    res.writeHead(200);
    res.end('OK');

    let payload: { events?: LineEvent[] };
    try {
      payload = JSON.parse(body.toString('utf-8')) as { events?: LineEvent[] };
    } catch (err) {
      log.error('LINE webhook payload not JSON', { err });
      return;
    }

    for (const event of payload.events ?? []) {
      try {
        await this.processEvent(event);
      } catch (err) {
        log.error('LINE event processing failed', { err, eventType: event.type });
      }
    }
  }

  private async processEvent(event: LineEvent): Promise<void> {
    if (event.type !== 'message' || !event.message) return;
    if (event.message.type !== 'text' || !event.message.text) return; // Text-only for now

    const platformId = platformIdForSource(event.source);
    if (!platformId) {
      log.warn('LINE event source missing id', { source: event.source });
      return;
    }

    const senderUserId = event.source.userId;
    const senderName = senderUserId ? await this.resolveDisplayName(senderUserId, event.source) : 'unknown';
    const isGroup = event.source.type === 'group' || event.source.type === 'room';
    const timestamp = new Date(event.timestamp).toISOString();

    if (isGroup) {
      await this.publishGroupName(event.source);
    } else {
      this.setupConfig?.onMetadata(platformId, senderName, false);
    }

    // Group-mention detection (mirror of signal.ts / whatsapp.ts pattern).
    // LINE's webhook payload includes message.mention.mentionees[] with
    // isSelf for native picker mentions, but the simpler text-match
    // catches both that case (the bot's display-name normally appears
    // as "@jibot" in the rendered text) and explicit "jibot" mentions.
    // Without this, attentive LINE groups never engage because
    // mention-sticky requires isMention=true.
    const text = event.message.text || '';
    const botMentionedInGroup =
      isGroup && new RegExp(`(?:^|\\W)@?${ASSISTANT_NAME}(?:$|\\W)`, 'i').test(text);
    this.setupConfig?.onInbound(platformId, null, {
      id: event.message.id,
      kind: 'chat',
      content: { text: event.message.text, sender: senderName, senderId: senderUserId ?? null },
      timestamp,
      isGroup,
      // DMs are by definition addressed to the bot — same convention as the
      // Signal and WhatsApp native adapters. Without this flag, routeInbound
      // treats DMs as plain chatter and silently drops them at line 209
      // (`if (!isMention) return`).
      isMention: !isGroup || botMentionedInGroup ? true : undefined,
    });
  }

  private async publishGroupName(source: LineEventSource): Promise<void> {
    if (!this.setupConfig) return;
    if (source.type === 'group' && source.groupId) {
      const summary = await this.apiGetJson<{ groupName?: string }>(`/v2/bot/group/${encodeURIComponent(source.groupId)}/summary`);
      this.setupConfig.onMetadata(`line:group:${source.groupId}`, summary?.groupName ?? undefined, true);
    } else if (source.type === 'room' && source.roomId) {
      // LINE rooms have no name endpoint — pass id through.
      this.setupConfig.onMetadata(`line:room:${source.roomId}`, undefined, true);
    }
  }

  private async resolveDisplayName(userId: string, source: LineEventSource): Promise<string> {
    const cached = this.profileCache.get(userId);
    if (cached) return cached;

    let profile: LineProfile | null = null;
    if (source.type === 'group' && source.groupId) {
      profile = await this.apiGetJson<LineProfile>(`/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`);
    } else if (source.type === 'room' && source.roomId) {
      profile = await this.apiGetJson<LineProfile>(`/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(userId)}`);
    } else {
      profile = await this.apiGetJson<LineProfile>(`/v2/bot/profile/${encodeURIComponent(userId)}`);
    }
    const name = profile?.displayName ?? userId;
    this.profileCache.set(userId, name);
    return name;
  }

  // ── LINE API ───────────────────────────────────────────────────────────

  private async pushMessage(to: string, text: string): Promise<unknown> {
    return this.apiPost('/v2/bot/message/push', { to, messages: [{ type: 'text', text }] });
  }

  private async apiGetJson<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${this.cfg.apiBase ?? LINE_API_BASE}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (err) {
      log.debug('LINE API GET failed', { path, err });
      return null;
    }
  }

  private async apiPost(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.cfg.apiBase ?? LINE_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LINE API POST ${path} ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.headers.get('content-type')?.includes('application/json')) {
      return res.json();
    }
    return null;
  }
}

function extractText(message: OutboundMessage): string {
  if (message.kind === 'chat' || message.kind === 'chat-sdk') {
    const c = message.content as { text?: string; markdown?: string };
    return c?.text ?? c?.markdown ?? '';
  }
  return '';
}

// Test-only export so unit tests can exercise the adapter without a live
// HTTP listener.
export { LineChannelAdapter };

registerChannelAdapter('line', {
  factory: () => {
    const env = readEnvFile(['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_WEBHOOK_PORT', 'LINE_WEBHOOK_PATH']);
    if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_CHANNEL_SECRET) return null;
    const port = env.LINE_WEBHOOK_PORT ? parseInt(env.LINE_WEBHOOK_PORT, 10) : DEFAULT_PORT;
    return new LineChannelAdapter({
      accessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: env.LINE_CHANNEL_SECRET,
      port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
      path: env.LINE_WEBHOOK_PATH || DEFAULT_PATH,
    });
  },
});
