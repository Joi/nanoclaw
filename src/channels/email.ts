/**
 * Email Channel v2 — first-class NanoClaw channel.
 *
 * Polls Gmail for emails addressed to jibot@ito.com (and +action/+intake aliases).
 * Resolves sender identity, classifies intent, enforces policy, executes actions,
 * creates receipts, and replies in-thread with sanitized recipients.
 *
 * Replaces the dormant v1 email channel and legacy email-intake pipeline.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  BOOKMARK_RELAY_URL,
  CONFIDENTIAL_ROOT,
  DATA_DIR,
  EMAIL_ALIAS_MAP_PATH,
  EMAIL_CALENDAR_ID,
  EMAIL_CHANNEL_POLL_INTERVAL,
  EMAIL_IDENTITY_INDEX_PATH,
  EMAIL_INTAKE_ACCOUNT,
  GOG_BIN,
  GOG_KEYRING_PASSWORD,
} from '../config.js';
import { extractSenderEmail, isJibotAddress, parseEmailAlias, EmailAlias } from '../email-address-parser.js';
import { EmailApprovalGate } from '../email-approval-gate.js';
import { filterAttachments } from '../email-attachment-filter.js';
import { CalendarAdapter } from '../email-calendar-adapter.js';
import { EmailIdentityResolver, IdentityResult } from '../email-identity-resolver.js';
import { resolveEmailIntent, IntentResult } from '../email-intent-resolver.js';
import { checkEmailPolicy } from '../email-policy-adapter.js';
import { createEmailReceipt } from '../email-receipt.js';
import { resolveReceiptDir } from '../workstream-routing.js';
import { ReminderAdapter } from '../email-reminder-adapter.js';
import { sanitizeReplyRecipients } from '../email-reply-sanitizer.js';
import { EmailThreadSessionStore } from '../email-thread-session.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const execFileAsync = promisify(execFile);

const LABEL_NAME = 'nanoclaw-processed';
const GOG_TIMEOUT = 30_000;
const MAX_BODY_LENGTH = 10_000;

// --- gog JSON types (preserved from v1) ---

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

interface GogPartDetail {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GogPartDetail[];
}

interface GogMessageDetail {
  id: string;
  internalDate?: string;
  payload?: {
    body?: { data?: string };
    headers?: Array<{ name: string; value: string }>;
    parts?: GogPartDetail[];
  };
  body?: string;
  snippet?: string;
}

interface AttachmentInfo {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface DownloadedAttachment {
  filename: string;
  hostPath: string;
  containerPath: string;
  mimeType: string;
  size: number;
}

// --- Parsed email message ---

interface ParsedEmailMessage {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
  rfc822MessageId: string;
  attachments: AttachmentInfo[];
}

export interface EmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendSignalMessage?: (jid: string, text: string) => Promise<void>;
  ownerSignalJid?: string;
  /** Override for testing: set to true to skip gog calls */
  dryRun?: boolean;
}

export class EmailChannel implements Channel {
  name = 'email';

  private opts: EmailChannelOpts;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  // Components
  private identityResolver: EmailIdentityResolver;
  private approvalGate: EmailApprovalGate;
  private threadStore: EmailThreadSessionStore;
  private calendarAdapter: CalendarAdapter;
  private reminderAdapter: ReminderAdapter;

  constructor(opts: EmailChannelOpts) {
    this.opts = opts;

    this.identityResolver = new EmailIdentityResolver(
      EMAIL_IDENTITY_INDEX_PATH,
      EMAIL_ALIAS_MAP_PATH,
    );

    this.approvalGate = new EmailApprovalGate({
      ownerSignalJid: opts.ownerSignalJid || '',
      sendSignalMessage: opts.sendSignalMessage || (async () => {}),
    });

    this.threadStore = new EmailThreadSessionStore();

    this.calendarAdapter = new CalendarAdapter({
      gogBin: GOG_BIN,
      account: EMAIL_INTAKE_ACCOUNT,
      calendarId: EMAIL_CALENDAR_ID,
      keyringPassword: GOG_KEYRING_PASSWORD,
    });

    this.reminderAdapter = new ReminderAdapter();
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
    }, EMAIL_CHANNEL_POLL_INTERVAL);

    logger.info(
      { account: EMAIL_INTAKE_ACCOUNT, interval: EMAIL_CHANNEL_POLL_INTERVAL },
      'Email channel v2 connected, polling started',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // For email, sendMessage sends a new email (fallback path).
    // Thread-aware replies use sendReply() instead.
    const recipient = jid.replace(/^email:/, '');
    const args = [
      'gmail', 'send',
      '--account', EMAIL_INTAKE_ACCOUNT,
      '--to', recipient,
      '--subject', 'Message from jibot',
      '--body-file', '-',
      '-y',
    ];

    try {
      await this.callGogWithStdin(args, text);
      logger.info({ jid, length: text.length }, 'Email message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send email message');
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
    logger.info('Email channel v2 disconnected');
  }

  // --- Reply in thread ---

  private async sendReply(
    messageId: string,
    subject: string,
    recipients: string[],
    body: string,
  ): Promise<void> {
    const args = [
      'gmail', 'send',
      '--account', EMAIL_INTAKE_ACCOUNT,
      '--reply-to-message-id', messageId,
      '--quote',
      '--to', recipients.join(','),
      '--subject', `Re: ${subject}`,
      '--body-file', '-',
      '-y',
    ];

    try {
      await this.callGogWithStdin(args, body);
      logger.info(
        { messageId, recipients: recipients.length, length: body.length },
        'Email reply sent',
      );
    } catch (err) {
      logger.error({ messageId, err }, 'Failed to send email reply');
      throw err;
    }
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
    let threads: GogThread[];
    try {
      // Query for unprocessed emails addressed to any jibot address
      const query = `to:jibot@ito.com -label:${LABEL_NAME}`;
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
    // Fetch full thread
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

    // Parse all messages
    const parsed = messages.map((m) => this.parseMessage(m));
    const newest = parsed[parsed.length - 1];
    const latestGogMsg = messages[messages.length - 1];
    const subject = newest.subject || thread.subject || '(no subject)';

    // Event: email.received
    logger.info(
      { threadId: thread.id, subject, from: newest.from, messageCount: messages.length },
      'email.received',
    );

    // Determine which jibot alias was used
    const allRecipients = this.collectRecipients(parsed);
    const jibotAlias = this.detectJibotAlias(allRecipients);

    if (!jibotAlias) {
      // Not addressed to jibot — skip (shouldn't happen with query filter)
      logger.debug({ threadId: thread.id }, 'Email channel: no jibot address found, skipping');
      await this.markProcessed(thread.id);
      return;
    }

    // Resolve sender identity
    const senderEmail = extractSenderEmail(newest.from);
    const identity = this.identityResolver.resolve(senderEmail);

    if (!identity.resolved) {
      // Unknown sender — send to approval gate
      logger.info({ senderEmail, threadId: thread.id }, 'email.sender.unresolved');

      if (!this.approvalGate.hasPendingApproval(senderEmail)) {
        await this.approvalGate.requestApproval({
          senderEmail,
          threadId: thread.id,
          subject,
          inferredIntent: jibotAlias === 'action' ? 'action' : jibotAlias === 'intake' ? 'intake' : 'unknown',
          riskSummary: `Unknown sender "${newest.from}" attempted to contact jibot via ${jibotAlias} alias`,
        });
      }

      await this.markProcessed(thread.id);
      return;
    }

    logger.info(
      { senderEmail, tier: identity.tier, name: identity.name },
      'email.sender.resolved',
    );

    // Resolve intent
    const intentResult = resolveEmailIntent(
      jibotAlias,
      identity.tier || 'unknown',
      newest.body,
    );

    logger.info(
      { intent: intentResult.intent, subtype: intentResult.actionSubtype, confidence: intentResult.confidence },
      'email.intent.resolved',
    );

    // Check policy
    const policy = checkEmailPolicy(
      identity.tier || 'unknown',
      intentResult.intent,
      intentResult.actionSubtype,
    );

    if (!policy.allowed) {
      logger.warn(
        { senderEmail, tier: identity.tier, intent: intentResult.intent, reason: policy.reason },
        'email.policy.denied',
      );
      await this.markProcessed(thread.id);
      return;
    }

    // Build known emails set for reply sanitization
    const knownEmails = this.buildKnownEmailsSet();

    // Sanitize reply recipients
    const replyRecipients = sanitizeReplyRecipients(
      newest.from,
      allRecipients,
      knownEmails,
    );

    // Execute based on intent
    switch (intentResult.intent) {
      case 'action':
        await this.handleAction(
          intentResult, parsed, newest, latestGogMsg, thread.id, subject,
          senderEmail, identity, replyRecipients,
        );
        break;

      case 'intake':
        await this.handleIntake(
          parsed, newest, latestGogMsg, thread.id, subject,
          senderEmail, identity, replyRecipients,
        );
        break;

      case 'clarify':
        await this.handleClarify(
          intentResult, latestGogMsg.id, subject, replyRecipients,
        );
        break;
    }

    // Save thread session
    this.threadStore.save({
      threadId: thread.id,
      subject,
      participants: allRecipients.filter((r) => !isJibotAddress(r)),
      lastMessageAt: newest.date || new Date().toISOString(),
      contextSummary: `${intentResult.intent}: ${newest.body.slice(0, 200)}`,
    });

    // Mark thread as processed
    await this.markProcessed(thread.id);
  }

  // --- Intent handlers ---

  private async handleAction(
    intentResult: IntentResult,
    allParsed: ParsedEmailMessage[],
    newest: ParsedEmailMessage,
    latestGogMsg: GogMessageDetail,
    threadId: string,
    subject: string,
    senderEmail: string,
    identity: IdentityResult,
    replyRecipients: string[],
  ): Promise<void> {
    let actionResult: string;

    switch (intentResult.actionSubtype) {
      case 'calendar': {
        // For now, deliver as a message to the agent pipeline for parsing
        // The agent will use gog calendar create with parsed details
        actionResult = 'Calendar scheduling request received. Delivering to agent pipeline for execution.';
        break;
      }
      case 'reminder': {
        actionResult = 'Reminder request received. Delivering to agent pipeline for execution.';
        break;
      }
      default: {
        actionResult = 'Action request received. Delivering to agent pipeline for execution.';
        break;
      }
    }

    // Deliver as message to agent pipeline (reusing existing pattern)
    const chatJid = `email:${senderEmail}`;
    const timestamp = newest.date
      ? new Date(newest.date).toISOString()
      : new Date().toISOString();

    // Format thread content for agent
    const content = this.formatThreadForAgent(allParsed, subject, intentResult);

    this.opts.onChatMetadata(chatJid, timestamp, identity.name || senderEmail, 'email', false);

    const msgId = `email_${latestGogMsg.id}_${threadId}`;
    const newMsg: NewMessage = {
      id: msgId,
      chat_jid: chatJid,
      sender: senderEmail,
      sender_name: identity.name || senderEmail,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      thread_id: threadId,
    };

    this.opts.onMessage(chatJid, newMsg);

    // Create receipt artifact
    createEmailReceipt(
      resolveReceiptDir(CONFIDENTIAL_ROOT, subject),
      {
        type: 'action',
        senderEmail,
        senderName: identity.name || senderEmail,
        subject,
        threadId,
        timestamp,
        body: newest.body,
        actionSubtype: intentResult.actionSubtype,
        actionResult,
      },
    );

    logger.info(
      { threadId, subtype: intentResult.actionSubtype, sender: senderEmail },
      'email.execution.success',
    );
  }

  private async handleIntake(
    allParsed: ParsedEmailMessage[],
    newest: ParsedEmailMessage,
    latestGogMsg: GogMessageDetail,
    threadId: string,
    subject: string,
    senderEmail: string,
    identity: IdentityResult,
    replyRecipients: string[],
  ): Promise<void> {
    const timestamp = newest.date
      ? new Date(newest.date).toISOString()
      : new Date().toISOString();

    // Create intake receipt
    const receiptPath = createEmailReceipt(
      resolveReceiptDir(CONFIDENTIAL_ROOT, subject),
      {
        type: 'intake',
        senderEmail,
        senderName: identity.name || senderEmail,
        subject,
        threadId,
        timestamp,
        body: newest.body,
      },
    );

    // Send receipt reply
    const receiptBody = [
      `✅ Captured for reference.`,
      ``,
      `Subject: ${subject}`,
      `From: ${identity.name || senderEmail}`,
      `Saved: ${path.basename(receiptPath)}`,
    ].join('\n');

    try {
      await this.sendReply(latestGogMsg.id, subject, replyRecipients, receiptBody);
      logger.info({ threadId }, 'email.reply.sent');
    } catch (err) {
      logger.error({ threadId, err }, 'email.reply.failed');
    }

    logger.info(
      { threadId, sender: senderEmail, receiptPath },
      'email.receipt.created',
    );
  }

  private async handleClarify(
    intentResult: IntentResult,
    messageId: string,
    subject: string,
    replyRecipients: string[],
  ): Promise<void> {
    const clarifyBody = intentResult.reason
      || 'I wasn\'t sure whether to act on this or capture it. Could you clarify? You can also resend to jibot+action@ito.com (to execute) or jibot+intake@ito.com (to capture).';

    try {
      await this.sendReply(messageId, subject, replyRecipients, clarifyBody);
      logger.info({ messageId }, 'email.reply.sent (clarify)');
    } catch (err) {
      logger.error({ messageId, err }, 'email.reply.failed (clarify)');
    }
  }

  // --- Helper methods ---

  private collectRecipients(messages: ParsedEmailMessage[]): string[] {
    const all = new Set<string>();
    for (const m of messages) {
      for (const field of [m.to, m.cc, m.from]) {
        if (!field) continue;
        for (const addr of field.split(',')) {
          const email = extractSenderEmail(addr.trim());
          if (email) all.add(email);
        }
      }
    }
    return [...all];
  }

  private detectJibotAlias(recipients: string[]): EmailAlias | null {
    // Check all recipients for jibot addresses, preferring explicit aliases
    let foundPlain = false;
    for (const email of recipients) {
      const alias = parseEmailAlias(email);
      if (alias === 'action' || alias === 'intake') return alias;
      if (alias === 'plain') foundPlain = true;
    }
    return foundPlain ? 'plain' : null;
  }

  private buildKnownEmailsSet(): Set<string> {
    // Build from identity index + alias map
    // For now, reload the resolver and extract known emails
    this.identityResolver.reload();
    // Simple approach: known emails are in the alias map + identity index
    // This will be populated at runtime; for now return empty set
    // TODO: Wire this properly from identity-index + alias-map
    const known = new Set<string>();
    known.add('jibot@ito.com');
    known.add('joi@ito.com');
    return known;
  }

  private formatThreadForAgent(
    messages: ParsedEmailMessage[],
    subject: string,
    intentResult: IntentResult,
  ): string {
    const participants = new Set<string>();
    for (const m of messages) {
      if (m.to) m.to.split(',').forEach((p) => participants.add(p.trim()));
      if (m.cc) m.cc.split(',').forEach((p) => participants.add(p.trim()));
      if (m.from) participants.add(m.from.trim());
    }

    const lines: string[] = [
      `[Email Thread] Subject: ${subject}`,
      `Intent: ${intentResult.intent}${intentResult.actionSubtype ? ` (${intentResult.actionSubtype})` : ''}`,
      `Participants: ${[...participants].join(', ')}`,
      '',
    ];

    for (const m of messages) {
      lines.push(`--- ${m.from} (${m.date}) ---`);
      lines.push(m.body.trim());
      lines.push('');
    }

    return lines.join('\n');
  }

  private parseMessage(msg: GogMessageDetail): ParsedEmailMessage {
    const headers: Record<string, string> = {};
    for (const h of msg.payload?.headers || []) {
      headers[h.name] = h.value;
    }

    let body = extractBodyText(msg);
    if (body.length > MAX_BODY_LENGTH) {
      body = body.slice(0, MAX_BODY_LENGTH) + '\n[... truncated]';
    }

    const attachments: AttachmentInfo[] = [];
    const collectAttachments = (parts: GogPartDetail[] | undefined) => {
      if (!parts) return;
      for (const part of parts) {
        if (part.filename && part.body?.attachmentId) {
          attachments.push({
            messageId: msg.id,
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType || 'application/octet-stream',
            size: part.body.size || 0,
          });
        }
        if (part.parts) collectAttachments(part.parts);
      }
    };
    collectAttachments(msg.payload?.parts);

    return {
      from: headers['From'] || '',
      to: headers['To'] || '',
      cc: headers['Cc'] || '',
      subject: headers['Subject'] || '',
      date: headers['Date'] || '',
      body,
      rfc822MessageId: headers['Message-ID'] || headers['Message-Id'] || '',
      attachments,
    };
  }

  private async markProcessed(threadId: string): Promise<void> {
    try {
      await this.callGog([
        'gmail', 'thread', 'modify', threadId,
        '--add', LABEL_NAME,
        '--remove', 'INBOX',
        '--account', EMAIL_INTAKE_ACCOUNT,
      ]);
      logger.info({ threadId }, 'Email channel: marked processed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ threadId, error: msg }, 'Email channel: failed to label thread');
    }
  }

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

// --- Shared helpers (preserved from v1) ---

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractBodyText(detail: GogMessageDetail): string {
  if (detail.body) return detail.body;
  if (detail.payload?.body?.data) {
    return decodeBase64Url(detail.payload.body.data);
  }
  if (detail.payload?.parts) {
    for (const part of detail.payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of detail.payload.parts) {
      if (part.parts) {
        for (const subpart of part.parts) {
          if (subpart.mimeType === 'text/plain' && subpart.body?.data) {
            return decodeBase64Url(subpart.body.data);
          }
        }
      }
    }
    for (const part of detail.payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
  }
  return detail.snippet || '';
}
