import Database from "better-sqlite3";
import os from "os";
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../group-folder.js';
import { ASSISTANT_NAME } from '../config.js';
import { markdownToSignal } from '../format.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const POLL_INTERVAL_MS = 3000;
const RECEIVE_TIMEOUT_S = 1; // signal-cli receive timeout in seconds
const RECEIVE_FETCH_TIMEOUT_MS = RECEIVE_TIMEOUT_S * 1000 + 5000; // HTTP timeout for receive calls

// Reconnection constants
const CONNECT_MAX_RETRIES = 10;
const CONNECT_INITIAL_DELAY_MS = 2000;   // 2s, doubles each retry up to ~60s
const RECONNECT_FAILURE_THRESHOLD = 5;   // consecutive poll RPC failures before reconnect attempt
const RECONNECT_COOLDOWN_MS = 30000;     // minimum 30s between reconnect attempts

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  signalCliUrl: string;
  signalAccount: string;
  botUuid?: string;
  // Called when a DM arrives from an unregistered contact.
  // Returns true if the contact was auto-registered and the message should be stored.
  onNewContact?: (chatJid: string, senderName: string) => boolean;
}

// JSON-RPC types
interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
  id: number;
}

interface SignalAttachment {
  contentType: string;
  filename?: string;
  id: string;
  size?: number;
}

interface SignalReceiveEntry {
  envelope: {
    source?: string;
    sourceName?: string;
    sourceNumber?: string;
    timestamp?: number;
    dataMessage?: {
      message?: string;
      timestamp?: number;
      groupInfo?: {
        groupId: string;
        type: string;
      };
      attachments?: SignalAttachment[];
      mentions?: Array<{ start: number; length: number; uuid: string }>;
    };
    syncMessage?: {
      sentMessage?: {
        message?: string;
        timestamp?: number;
        destination?: string;
        groupInfo?: {
          groupId: string;
          type: string;
        };
        attachments?: SignalAttachment[];
        mentions?: Array<{ start: number; length: number; uuid: string }>;
      };
    };
  };
}


/**
 * Expand Signal mention placeholders (U+FFFC) into readable @name text.
 * Resolves profile names from signal-cli's local SQLite database.
 */
let profileNameCache: Record<string, string> | undefined;

function loadProfileNames(): Record<string, string> {
  if (profileNameCache) return profileNameCache;
  profileNameCache = {};
  try {
    const homedir = os.homedir();
    const dataDir = path.join(homedir, '.local/share/signal-cli/data');
    // Find the account directory (e.g. 692992.d/)
    const entries = fs.readdirSync(dataDir).filter((e: string) => e.endsWith('.d'));
    for (const dir of entries) {
      const dbPath = path.join(dataDir, dir, 'account.db');
      if (!fs.existsSync(dbPath)) continue;
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(
        "SELECT aci, TRIM(COALESCE(profile_given_name,'') || ' ' || COALESCE(profile_family_name,'')) as name FROM recipient WHERE aci IS NOT NULL AND profile_given_name IS NOT NULL"
      ).all() as Array<{ aci: string; name: string }>;
      for (const row of rows) {
        if (row.name.trim()) profileNameCache[row.aci] = row.name.trim();
      }
      db.close();
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load signal-cli profile names');
  }
  return profileNameCache;
}

function expandMentions(
  text: string,
  mentions: Array<{ start: number; length: number; uuid: string }> | undefined,
  botUuid: string,
): string {
  if (!mentions?.length || !text) return text;
  const names = loadProfileNames();
  const sorted = [...mentions].sort((a, b) => b.start - a.start);
  let result = text;
  for (const m of sorted) {
    let name: string;
    if (m.uuid === botUuid) {
      name = ASSISTANT_NAME;
    } else {
      name = names[m.uuid] || m.uuid.slice(0, 8);
    }
    const before = result.slice(0, m.start);
    const after = result.slice(m.start + m.length);
    result = `${before}@${name}${after}`;
  }
  return result;
}

// --- Outbound mention support ---

/**
 * Build reverse lookup: lowercased name -> recipient identifier.
 * Prefers phone number (signal-cli docs say "recipientNumber"), falls back to UUID.
 * Also indexes unambiguous first names for convenient @FirstName matching.
 */
let reverseNameCache: Map<string, string> | undefined;

function buildReverseNameMap(): Map<string, string> {
  if (reverseNameCache) return reverseNameCache;
  reverseNameCache = new Map();
  try {
    const dataDir = path.join(os.homedir(), '.local/share/signal-cli/data');
    const dirs = fs.readdirSync(dataDir).filter((e: string) => e.endsWith('.d'));
    const firstNameCount = new Map<string, number>();
    const firstNameId = new Map<string, string>();

    for (const dir of dirs) {
      const dbPath = path.join(dataDir, dir, 'account.db');
      if (!fs.existsSync(dbPath)) continue;
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(
        "SELECT aci, number, TRIM(COALESCE(profile_given_name,'') || ' ' || COALESCE(profile_family_name,'')) as name FROM recipient WHERE aci IS NOT NULL AND profile_given_name IS NOT NULL"
      ).all() as Array<{ aci: string; number: string | null; name: string }>;
      for (const row of rows) {
        const trimmed = row.name.trim();
        if (!trimmed) continue;
        const recipientId = row.number || row.aci;
        reverseNameCache.set(trimmed.toLowerCase(), recipientId);

        const firstName = trimmed.split(' ')[0].toLowerCase();
        firstNameCount.set(firstName, (firstNameCount.get(firstName) || 0) + 1);
        firstNameId.set(firstName, recipientId);
      }
      db.close();
    }

    // Add unambiguous first names (only if no full-name collision)
    for (const [firstName, count] of firstNameCount) {
      if (count === 1 && !reverseNameCache.has(firstName)) {
        reverseNameCache.set(firstName, firstNameId.get(firstName)!);
      }
    }
    logger.info({ entries: reverseNameCache.size }, 'Built reverse name map for outbound mentions');
  } catch (err) {
    logger.warn({ err }, 'Failed to build reverse name map for mentions');
  }
  return reverseNameCache;
}

/** Invalidate both name caches (call when new contacts join). */
export function invalidateNameCaches(): void {
  profileNameCache = undefined;
  reverseNameCache = undefined;
}

/**
 * Scan text for @Name patterns, strip the '@' (Signal adds its own),
 * and produce signal-cli mention entries.
 *
 * Returns modified text (with '@' removed at mention sites), adjusted
 * textStyles, and a mentions array of "start:length:recipientId" strings.
 *
 * Signal's mention rendering prepends '@' to the display name, so leaving
 * '@' in the source text causes "@@Name" in the UI.
 */
function extractMentions(
  text: string,
  textStyles?: string[],
): { text: string; mentions: string[]; textStyles: string[] } {
  const nameMap = buildReverseNameMap();
  if (nameMap.size === 0) return { text, mentions: [], textStyles: textStyles || [] };

  const sortedNames = [...nameMap.keys()].sort((a, b) => b.length - a.length);

  // First pass: collect match positions (in original text coordinates)
  const matches: Array<{ atPos: number; nameLen: number; recipientId: string }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    if (i > 0 && /[a-zA-Z0-9_]/.test(text[i - 1])) continue;

    const rest = text.slice(i + 1).toLowerCase();
    for (const name of sortedNames) {
      if (!rest.startsWith(name)) continue;
      const charAfter = text[i + 1 + name.length];
      if (charAfter && /[a-zA-Z0-9_]/.test(charAfter)) continue;

      matches.push({ atPos: i, nameLen: name.length, recipientId: nameMap.get(name)! });
      i += name.length; // skip past (the for-loop adds 1 more)
      break;
    }
  }

  if (matches.length === 0) return { text, mentions: [], textStyles: textStyles || [] };

  // Second pass: remove '@' chars at match positions (right-to-left preserves indices)
  let newText = text;
  const removedPositions: number[] = [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const pos = matches[i].atPos;
    newText = newText.slice(0, pos) + newText.slice(pos + 1);
    removedPositions.unshift(pos); // keep sorted ascending
  }

  // Helper: shift a position by the number of '@' chars removed before it
  function adjust(pos: number): number {
    let shift = 0;
    for (const rp of removedPositions) {
      if (rp < pos) shift++;
      else break;
    }
    return pos - shift;
  }

  // Build mention entries in new-text coordinates (name only, no '@')
  const mentions: string[] = [];
  for (const m of matches) {
    const start = adjust(m.atPos); // '@' was here, now the name starts here
    mentions.push(`${start}:${m.nameLen}:${m.recipientId}`);
  }

  // Adjust textStyle positions for removed characters
  const adjustedStyles = (textStyles || []).map((style) => {
    const [startStr, lenStr, ...rest] = style.split(':');
    const origStart = parseInt(startStr, 10);
    const origLen = parseInt(lenStr, 10);
    const newStart = adjust(origStart);
    // Shrink length if any '@' was removed inside this style range
    let lenShrink = 0;
    for (const rp of removedPositions) {
      if (rp >= origStart && rp < origStart + origLen) lenShrink++;
    }
    return `${newStart}:${origLen - lenShrink}:${rest.join(':')}`;
  });

  logger.info({ count: mentions.length, mentions }, 'Extracted outbound Signal mentions');
  return { text: newText, mentions, textStyles: adjustedStyles };
}

export class SignalChannel implements Channel {
  name = 'signal';

  private opts: SignalChannelOpts;
  private rpcUrl: string;
  private account: string;
  private botUuid: string = '';
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private outgoingQueue: Array<{ jid: string; text: string; textStyles?: string[]; mentions?: string[] }> = [];
  private flushing = false;
  private polling = false;
  private rpcId = 0;
  private pollCount = 0;
  private consecutiveEmpty = 0;
  private lastReceiveAt = 0;
  private consecutiveRpcFailures = 0;
  private lastReconnectAttempt = 0;
  private reconnecting = false;

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
    const baseUrl = opts.signalCliUrl.replace(/\/+$/, '');
    this.rpcUrl = `${baseUrl}/api/v1/rpc`;
    this.account = opts.signalAccount;
    this.botUuid = opts.botUuid || process.env.SIGNAL_BOT_UUID || "2e28a309-9ead-4cf4-9186-a5d133d50e70";
  }

  async connect(): Promise<void> {
    // Retry with exponential backoff — signal-cli (Java) can take several
    // seconds to start, especially after a launchd restart.
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < CONNECT_MAX_RETRIES; attempt++) {
      const result = await this.rpc<{ version: string }>('version', {});
      if (result) {
        logger.info(
          { url: this.rpcUrl, version: result.version, attempt },
          'signal-cli daemon reachable',
        );
        this.connected = true;
        this.consecutiveRpcFailures = 0;

        // Flush any messages queued before connection
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush Signal outgoing queue'),
        );

        // Start polling for inbound messages
        this.startPolling();

        logger.info('Signal channel connected, polling started');
        return;
      }

      const delay = Math.min(
        CONNECT_INITIAL_DELAY_MS * Math.pow(2, attempt),
        60000,
      );
      lastErr = new Error(
        `Cannot reach signal-cli JSON-RPC at ${this.rpcUrl}`,
      );
      logger.warn(
        { attempt: attempt + 1, maxRetries: CONNECT_MAX_RETRIES, retryInMs: delay },
        'signal-cli not reachable, retrying...',
      );
      await sleep(delay);
    }

    throw lastErr ?? new Error(`Cannot reach signal-cli JSON-RPC at ${this.rpcUrl}`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const { text: mdText, textStyles: mdStyles } = markdownToSignal(text);
    const { text: formatted, mentions, textStyles } = extractMentions(mdText, mdStyles);
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: formatted, textStyles, mentions });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Signal disconnected, message queued',
      );
      return;
    }

    try {
      await this.sendViaRpc(jid, formatted, textStyles, mentions);
      logger.info({ jid, length: formatted.length, styles: textStyles.length, mentions: mentions.length }, 'Signal message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text: formatted, textStyles, mentions });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Signal message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sig:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Signal channel disconnected');
  }

  // --- JSON-RPC helper ---

  private async rpc<T>(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<T | null> {
    const id = ++this.rpcId;
    try {
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        logger.warn({ status: res.status, method }, 'JSON-RPC HTTP error');
        return null;
      }
      const body = (await res.json()) as JsonRpcResponse<T>;
      if (body.error) {
        // "already being received" is a benign race — signal-cli's previous
        // receive hasn't finished server-side. Suppress to avoid log noise.
        if (method === 'receive' && body.error.message?.includes('already being received')) {
          logger.debug('signal-cli receive overlap, skipping');
          return null;
        }
        logger.warn({ method, error: body.error }, 'JSON-RPC error');
        return null;
      }
      return body.result ?? null;
    } catch (err) {
      logger.warn({ err, method, timeoutMs }, 'JSON-RPC fetch failed');
      return null;
    }
  }

  // --- Polling ---

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        logger.warn({ err }, 'Signal poll error'),
      );
    }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      logger.debug('Signal poll skipped (previous still running)');
      return;
    }
    this.polling = true;
    this.pollCount++;
    try {
      const entries = await this.rpc<SignalReceiveEntry[]>('receive', {
        timeout: RECEIVE_TIMEOUT_S,
      }, RECEIVE_FETCH_TIMEOUT_MS);

      if (entries === null) {
        // RPC call itself failed (not just empty results)
        this.consecutiveRpcFailures++;

        if (this.consecutiveRpcFailures >= RECONNECT_FAILURE_THRESHOLD) {
          await this.attemptReconnect();
        }
        return;
      }

      // RPC succeeded — reset failure counter
      this.consecutiveRpcFailures = 0;

      if (entries.length === 0) {
        this.consecutiveEmpty++;
        // Heartbeat every 20 polls (~60s) when idle
        if (this.pollCount % 20 === 0) {
          logger.info(
            { pollCount: this.pollCount, consecutiveEmpty: this.consecutiveEmpty },
            'Signal poll heartbeat (no messages)',
          );
        }
        // Warn if no messages for 2+ minutes — signal-cli may be disconnected upstream
        if (this.consecutiveEmpty === 40) {
          logger.warn(
            { consecutiveEmpty: this.consecutiveEmpty, pollCount: this.pollCount },
            'Signal: no messages received for 2+ minutes — signal-cli may be disconnected from Signal servers. Check: lsof -i -n -P -a -p $(pgrep -f signal-cli) | grep 443',
          );
        }
        return;
      }

      this.consecutiveEmpty = 0;
      this.lastReceiveAt = Date.now();
      logger.info({ count: entries.length }, 'Signal: received messages');

      for (const entry of entries) {
        await this.handleEntry(entry);
      }
    } finally {
      this.polling = false;
    }
  }

  // --- Reconnection ---

  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting) return;

    const now = Date.now();
    if (now - this.lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
      return; // too soon since last attempt
    }

    this.reconnecting = true;
    this.lastReconnectAttempt = now;

    logger.warn(
      { consecutiveRpcFailures: this.consecutiveRpcFailures },
      'Signal: RPC failures exceeded threshold, attempting reconnect...',
    );

    // Mark disconnected while we try
    this.connected = false;

    try {
      const result = await this.rpc<{ version: string }>('version', {});
      if (result) {
        this.connected = true;
        this.consecutiveRpcFailures = 0;
        logger.info(
          { version: result.version },
          'Signal: reconnected to signal-cli',
        );

        // Flush queued messages
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush Signal outgoing queue after reconnect'),
        );
      } else {
        logger.warn('Signal: reconnect failed, signal-cli still unreachable');
      }
    } catch (err) {
      logger.warn({ err }, 'Signal: reconnect attempt error');
    } finally {
      this.reconnecting = false;
    }
  }

  private async handleEntry(entry: SignalReceiveEntry): Promise<void> {
    const { envelope } = entry;
    if (!envelope) return;

    // Handle direct data messages (text, attachments, or both)
    const dm = envelope.dataMessage;
    if (dm?.message || dm?.attachments?.length) {
      await this.processInbound({
        source: envelope.source || envelope.sourceNumber || '',
        sourceName: envelope.sourceName,
        message: expandMentions(dm.message || '', dm.mentions, this.botUuid),
        timestamp: dm.timestamp || envelope.timestamp || Date.now(),
        groupId: dm.groupInfo?.groupId,
        attachments: dm.attachments,
      });
    }

    // Handle sync messages (sent from another device)
    const sent = envelope.syncMessage?.sentMessage;
    if (sent?.message || sent?.attachments?.length) {
      await this.processInbound({
        source: this.account, // sent by us
        sourceName: undefined,
        message: expandMentions(sent.message || '', sent.mentions, this.botUuid),
        timestamp: sent.timestamp || envelope.timestamp || Date.now(),
        groupId: sent.groupInfo?.groupId,
        isFromMe: true,
        attachments: sent.attachments,
      });
    }
  }

  private async processInbound(msg: {
    source: string;
    sourceName?: string;
    message: string;
    timestamp: number;
    groupId?: string;
    isFromMe?: boolean;
    attachments?: SignalAttachment[];
  }): Promise<void> {
    const isGroup = !!msg.groupId;
    const chatJid = isGroup
      ? `sig:group:${msg.groupId}`
      : `sig:${msg.source}`;

    const timestamp = new Date(msg.timestamp).toISOString();
    const msgId = `sig_${msg.timestamp}_${msg.source}`;
    const senderName = msg.sourceName || msg.source;
    const isFromMe = msg.isFromMe || msg.source === this.account;

    // Notify chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, isGroup ? undefined : senderName, 'signal', isGroup);

    // Deliver to registered groups (or auto-register new Signal DM contacts)
    let groups = this.opts.registeredGroups();
    if (!groups[chatJid] && !isGroup && !isFromMe && this.opts.onNewContact) {
      const registered = this.opts.onNewContact(chatJid, senderName);
      if (registered) {
        // Refresh groups after auto-registration
        groups = this.opts.registeredGroups();
      }
    }

    let content = msg.message;

    // Download and stage attachments for registered groups
    if (groups[chatJid] && msg.attachments?.length) {
      const group = groups[chatJid];
      for (const att of msg.attachments) {
        try {
          const data = await this.downloadAttachment(att.id);
          if (data && data.length > 0) {
            const ipcPath = resolveGroupIpcPath(group.folder);
            const inputDir = path.join(ipcPath, 'input');
            fs.mkdirSync(inputDir, { recursive: true });
            const ext = att.filename ? '' : mimeToExt(att.contentType);
            const originalName = att.filename || `attachment${ext}`;
            const safeName = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            fs.writeFileSync(path.join(inputDir, safeName), data);

            const annotation = `[Attached: ${originalName} (${att.contentType}, ${formatSize(data.length)}) — saved to /workspace/ipc/input/${safeName}]`;
            content = content ? `${content}\n${annotation}` : annotation;
            logger.info(
              { chatJid, filename: safeName, size: data.length, contentType: att.contentType },
              'Signal attachment saved',
            );
          }
        } catch (err) {
          logger.warn({ chatJid, attachmentId: att.id, err }, 'Failed to download Signal attachment');
          const annotation = `[Attached: ${att.filename || 'file'} (${att.contentType}) — download failed]`;
          content = content ? `${content}\n${annotation}` : annotation;
        }
      }
    }

    // Skip if no content (no text AND no attachment annotations)
    if (!content) return;

    if (groups[chatJid]) {
      const newMsg: NewMessage = {
        id: msgId,
        chat_jid: chatJid,
        sender: msg.source,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isFromMe,
      };
      this.opts.onMessage(chatJid, newMsg);
    }
  }

  private async downloadAttachment(attachmentId: string): Promise<Buffer | null> {
    // signal-cli native daemon stores attachments on disk (no REST endpoint)
    const attachmentsDir = path.join(
      process.env.HOME || require('os').homedir(),
      '.local', 'share', 'signal-cli', 'attachments',
    );
    const filePath = path.join(attachmentsDir, attachmentId);
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath);
      }
      logger.warn({ attachmentId, filePath }, 'Signal attachment file not found on disk');
      return null;
    } catch (err) {
      logger.warn({ err, attachmentId }, 'Attachment read failed');
      return null;
    }
  }

  // --- Sending ---

  private async sendViaRpc(jid: string, text: string, textStyles?: string[], mentions?: string[]): Promise<void> {
    const isGroup = jid.startsWith('sig:group:');

    let params: Record<string, unknown>;
    if (isGroup) {
      const groupId = jid.replace('sig:group:', '');
      params = {
        account: this.account,
        groupId,
        message: text,
      };
    } else {
      const recipient = jid.replace('sig:', '');
      params = {
        account: this.account,
        recipient: [recipient],
        message: text,
      };
    }

    // Pass body-range styles if present (signal-cli 0.14.1+)
    if (textStyles && textStyles.length > 0) {
      params.textStyle = textStyles;
    }

    // Pass mention metadata for proper Signal @-mentions (notification + highlight)
    if (mentions && mentions.length > 0) {
      params.mention = mentions;
    }

    const result = await this.rpc<{ timestamp: number }>('send', params);
    if (result === null) {
      throw new Error(`Signal send failed for ${jid}`);
    }
  }

  // --- Queue ---

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing Signal outgoing queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendViaRpc(item.jid, item.text, item.textStyles, item.mentions);
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued Signal message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeToExt(contentType: string): string {
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'text/plain': '.txt',
  };
  return map[contentType] || '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
