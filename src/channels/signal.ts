import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const POLL_INTERVAL_MS = 2000;
const RECEIVE_TIMEOUT_S = 1; // signal-cli receive timeout in seconds

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  signalCliUrl: string;
  signalAccount: string;
}

// JSON-RPC types
interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
  id: number;
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
      };
    };
  };
}

export class SignalChannel implements Channel {
  name = 'signal';

  private opts: SignalChannelOpts;
  private rpcUrl: string;
  private account: string;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private polling = false;
  private rpcId = 0;

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
    const baseUrl = opts.signalCliUrl.replace(/\/+$/, '');
    this.rpcUrl = `${baseUrl}/api/v1/rpc`;
    this.account = opts.signalAccount;
  }

  async connect(): Promise<void> {
    // Verify signal-cli is reachable via JSON-RPC version call
    const result = await this.rpc<{ version: string }>('version', {});
    if (!result) {
      throw new Error(`Cannot reach signal-cli JSON-RPC at ${this.rpcUrl}`);
    }
    logger.info({ url: this.rpcUrl, version: result.version }, 'signal-cli daemon reachable');

    this.connected = true;

    // Flush any messages queued before connection
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush Signal outgoing queue'),
    );

    // Start polling for inbound messages
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        logger.warn({ err }, 'Signal poll error'),
      );
    }, POLL_INTERVAL_MS);

    logger.info('Signal channel connected, polling started');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Signal disconnected, message queued',
      );
      return;
    }

    try {
      await this.sendViaRpc(jid, text);
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
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

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T | null> {
    const id = ++this.rpcId;
    try {
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        logger.warn({ status: res.status, method }, 'JSON-RPC HTTP error');
        return null;
      }
      const body = (await res.json()) as JsonRpcResponse<T>;
      if (body.error) {
        logger.warn({ method, error: body.error }, 'JSON-RPC error');
        return null;
      }
      return body.result ?? null;
    } catch (err) {
      logger.debug({ err, method }, 'JSON-RPC fetch failed');
      return null;
    }
  }

  // --- Polling ---

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
    const entries = await this.rpc<SignalReceiveEntry[]>('receive', {
      timeout: RECEIVE_TIMEOUT_S,
    });

    if (!entries || entries.length === 0) return;

    for (const entry of entries) {
      this.handleEntry(entry);
    }
    } finally {
      this.polling = false;
    }
  }

  private handleEntry(entry: SignalReceiveEntry): void {
    const { envelope } = entry;
    if (!envelope) return;

    // Handle direct data messages
    if (envelope.dataMessage?.message) {
      this.processInbound({
        source: envelope.source || envelope.sourceNumber || '',
        sourceName: envelope.sourceName,
        message: envelope.dataMessage.message,
        timestamp: envelope.dataMessage.timestamp || envelope.timestamp || Date.now(),
        groupId: envelope.dataMessage.groupInfo?.groupId,
      });
    }

    // Handle sync messages (sent from another device)
    if (envelope.syncMessage?.sentMessage?.message) {
      const sent = envelope.syncMessage.sentMessage;
      this.processInbound({
        source: this.account, // sent by us
        sourceName: undefined,
        message: sent.message!,
        timestamp: sent.timestamp || envelope.timestamp || Date.now(),
        groupId: sent.groupInfo?.groupId,
        isFromMe: true,
      });
    }
  }

  private processInbound(msg: {
    source: string;
    sourceName?: string;
    message: string;
    timestamp: number;
    groupId?: string;
    isFromMe?: boolean;
  }): void {
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

    // Deliver to registered groups
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      const newMsg: NewMessage = {
        id: msgId,
        chat_jid: chatJid,
        sender: msg.source,
        sender_name: senderName,
        content: msg.message,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isFromMe,
      };
      this.opts.onMessage(chatJid, newMsg);
    }
  }

  // --- Sending ---

  private async sendViaRpc(jid: string, text: string): Promise<void> {
    const isGroup = jid.startsWith('sig:group:');

    let params: Record<string, unknown>;
    if (isGroup) {
      const groupId = jid.replace('sig:group:', '');
      params = {
        groupId,
        message: text,
      };
    } else {
      const recipient = jid.replace('sig:', '');
      params = {
        recipient: [recipient],
        message: text,
      };
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
        await this.sendViaRpc(item.jid, item.text);
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued Signal message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
