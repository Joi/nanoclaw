/**
 * Email pre-processor — intercepts known email patterns before the Claude
 * agent sees them.  Runs after identity resolution and policy check, before
 * handleAction() / opts.onMessage().
 *
 * Patterns checked in order:
 *   A. Calendar invite with Zoom URL  → scheduled-zooms.jsonl
 *   B. Crypto transaction confirmation → crypto-transactions.jsonl
 *   C. Workstream forward (#ws: tag)  → confidential/{slug}/intake/
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { extractWorkstreamSlug } from './workstream-routing.js';

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export interface PreprocessResult {
  handled: boolean;
  reason: string;
  pattern?: 'calendar-zoom' | 'crypto-tx' | 'workstream-intake';
}

export interface MessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MessagePart[];
}

// --------------------------------------------------------------------------
// Workstream directory map
// --------------------------------------------------------------------------

const WORKSTREAM_INTAKE_DIRS: Record<string, string> = {
  'sankosh': '/Users/jibot/switchboard/confidential/sankosh/intake',
  'gidc': '/Users/jibot/switchboard/confidential/gidc/intake',
  'bhutan': '/Users/jibot/switchboard/confidential/bhutan/intake',
  'enterprise-agents': '/Users/jibot/switchboard/confidential/enterprise-agents/intake',
};

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

function appendJsonl(filePath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
}

function flattenParts(parts: MessagePart[]): MessagePart[] {
  const result: MessagePart[] = [];
  for (const p of parts) {
    result.push(p);
    if (p.parts) result.push(...flattenParts(p.parts));
  }
  return result;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// --------------------------------------------------------------------------
// ICS utilities
// --------------------------------------------------------------------------

function parseIcsDate(raw: string): string | null {
  // Strip property name and parameters: everything before the last ':'
  const value = raw.includes(':') ? raw.split(':').slice(-1)[0]! : raw;
  const s = value.trim();

  // YYYYMMDDTHHMMSSZ  (UTC)
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (utc) {
    const [, yr, mo, dy, hr, mn, sc] = utc;
    return `${yr}-${mo}-${dy}T${hr}:${mn}:${sc}.000Z`;
  }

  // YYYYMMDDTHHMMSS  (floating / treat as UTC)
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (local) {
    const [, yr, mo, dy, hr, mn, sc] = local;
    return `${yr}-${mo}-${dy}T${hr}:${mn}:${sc}.000Z`;
  }

  // YYYYMMDD  (all-day)
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (date) {
    const [, yr, mo, dy] = date;
    return `${yr}-${mo}-${dy}T00:00:00.000Z`;
  }

  return null;
}

function normalizeIcs(raw: string): string {
  // Unfold RFC 5545 line continuations (CRLF or LF followed by space/tab)
  return raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function extractIcsField(icsText: string, fieldName: string): string | null {
  const normalized = normalizeIcs(icsText);
  const re = new RegExp(`^${fieldName}[^:\r\n]*:(.+)$`, 'm');
  const m = re.exec(normalized);
  return m ? m[1]!.trim() : null;
}

function extractIcsAttendees(icsText: string): string[] {
  const normalized = normalizeIcs(icsText);
  const results: string[] = [];
  const re = /^ATTENDEE[^:\r\n]*:(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    results.push(m[1]!.trim());
  }
  return results;
}

// --------------------------------------------------------------------------
// Pattern A: Calendar invite with Zoom link
// --------------------------------------------------------------------------

const ZOOM_URL_RE = /https:\/\/[a-z0-9-]+\.zoom\.us\/[jw]\/[0-9]+[?#\S]*/i;

function handleCalendarZoom(params: {
  rawParts: MessagePart[];
  bodyText: string;
  subject: string;
  senderEmail: string;
  threadId: string;
}): PreprocessResult | null {
  const { rawParts, bodyText, subject, senderEmail, threadId } = params;

  // Find ICS text from MIME parts first, then fall back to inline body
  let icsText: string | null = null;

  const allParts = flattenParts(rawParts);
  for (const part of allParts) {
    if (
      part.mimeType === 'text/calendar' ||
      (part.filename && part.filename.toLowerCase().endsWith('.ics'))
    ) {
      if (part.body?.data) {
        try {
          icsText = decodeBase64Url(part.body.data);
        } catch {
          // fall through to body text check
        }
      }
      break;
    }
  }

  if (!icsText && (bodyText.includes('BEGIN:VCALENDAR') || bodyText.includes('BEGIN:VEVENT'))) {
    icsText = bodyText;
  }

  if (!icsText) return null;

  // Parse key fields
  const rawDtstart = extractIcsField(icsText, 'DTSTART');
  const rawDtend = extractIcsField(icsText, 'DTEND');
  const summary = extractIcsField(icsText, 'SUMMARY') || subject;
  const location = extractIcsField(icsText, 'LOCATION') || '';
  const description = (extractIcsField(icsText, 'DESCRIPTION') || '')
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',');

  const attendees = extractIcsAttendees(icsText);

  // Must be addressed to jibot (or open invite with no attendee list)
  const jibotIsAttendee =
    attendees.length === 0 ||
    attendees.some((a) => a.toLowerCase().includes('jibot@ito.com'));

  if (!jibotIsAttendee) return null;

  // Extract Zoom URL from location + description, then full body as fallback
  const searchText = `${location} ${description}`;
  const zoomMatch = ZOOM_URL_RE.exec(searchText) || ZOOM_URL_RE.exec(bodyText);

  if (!zoomMatch) {
    // ICS found but no Zoom URL — let agent handle
    return null;
  }

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    meeting_ts: rawDtstart ? parseIcsDate(rawDtstart) : null,
    end_ts: rawDtend ? parseIcsDate(rawDtend) : null,
    title: summary,
    zoom_url: zoomMatch[0],
    thread_id: threadId,
    from: senderEmail,
    status: 'pending',
  };

  const outPath = path.join(DATA_DIR, 'scheduled-zooms.jsonl');
  appendJsonl(outPath, record);

  logger.info({ threadId, zoomUrl: zoomMatch[0], title: summary }, 'preprocess: calendar-zoom appended');
  return { handled: true, reason: 'calendar-zoom: scheduled zoom join', pattern: 'calendar-zoom' };
}

// --------------------------------------------------------------------------
// Pattern B: Crypto transaction confirmation
// --------------------------------------------------------------------------

const CRYPTO_DOMAINS = new Set([
  'coinbase.com', 'gemini.com', 'kraken.com', 'binance.com', 'blockchain.com',
  'etherscan.io', 'polygonscan.com', 'basescan.org', 'solscan.io',
  'metamask.io', 'rainbow.me', 'phantom.app', 'uniswap.org', 'magic.link',
]);

const CRYPTO_SUBJECT_RE =
  /transaction confirmed|transfer complete|you sent|you received|deposit confirmed|withdrawal confirmed|swap completed|transaction receipt|payment confirmed|crypto sent/i;

const ETH_TX_RE = /0x[0-9a-fA-F]{64}/;
const ETH_WALLET_RE = /0x[0-9a-fA-F]{40}/g;
const SOL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const CRYPTO_AMOUNT_RE = /\d+\.?\d*\s*(ETH|MATIC|SOL|USDC|USDT|BTC|BASE|OP|ARB)/i;

function handleCryptoTx(params: {
  bodyText: string;
  subject: string;
  senderEmail: string;
  threadId: string;
}): PreprocessResult | null {
  const { bodyText, subject, senderEmail, threadId } = params;

  const senderDomain = (senderEmail.split('@')[1] ?? '').toLowerCase();
  const isDomainMatch =
    CRYPTO_DOMAINS.has(senderDomain) ||
    /notifications@.*\.xyz$/.test(senderEmail.toLowerCase());

  let score = 0;
  if (isDomainMatch) score++;
  if (CRYPTO_SUBJECT_RE.test(subject)) score++;
  if (ETH_TX_RE.test(bodyText) || new RegExp(ETH_WALLET_RE.source).test(bodyText)) score++;
  if (isDomainMatch && SOL_ADDR_RE.test(bodyText)) score++;
  if (CRYPTO_AMOUNT_RE.test(bodyText)) score++;

  if (score < 2) return null;

  // Best-effort field extraction
  const ethTxMatch = ETH_TX_RE.exec(bodyText);
  const ethWalletMatches = [...bodyText.matchAll(new RegExp('0x[0-9a-fA-F]{40}', 'g'))];
  const amountMatch = CRYPTO_AMOUNT_RE.exec(bodyText);

  const combined = senderEmail + ' ' + bodyText;
  let chain: string | null = null;
  if (/polygonscan\.com|polygon|matic/i.test(combined)) chain = 'polygon';
  else if (/basescan\.org|base\.org/i.test(combined)) chain = 'base';
  else if (/solscan\.io|solana|phantom/i.test(combined)) chain = 'solana';
  else if (/bitcoin|btc/i.test(bodyText)) chain = 'bitcoin';
  else if (/ethereum|etherscan|(?<!\w)eth(?!\w)/i.test(combined)) chain = 'ethereum';

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    thread_id: threadId,
    from_email: senderEmail,
    subject,
    chain,
    amount: amountMatch ? amountMatch[0]!.trim() : null,
    currency: amountMatch ? amountMatch[1]!.toUpperCase() : null,
    tx_hash: ethTxMatch ? ethTxMatch[0] : null,
    wallet_from: ethWalletMatches[0]?.[0] ?? null,
    wallet_to: ethWalletMatches[1]?.[0] ?? null,
    source_domain: senderDomain,
  };

  const outPath = path.join(DATA_DIR, 'crypto-transactions.jsonl');
  appendJsonl(outPath, record);

  logger.info({ threadId, senderDomain, score }, 'preprocess: crypto-tx logged');
  return { handled: true, reason: 'crypto-tx: logged to crypto-transactions.jsonl', pattern: 'crypto-tx' };
}

// --------------------------------------------------------------------------
// Pattern C: Workstream forward (#ws: tag in subject)
// --------------------------------------------------------------------------

function handleWorkstreamIntake(params: {
  bodyText: string;
  subject: string;
  senderEmail: string;
  threadId: string;
}): PreprocessResult | null {
  const { bodyText, subject, senderEmail, threadId } = params;

  const slug = extractWorkstreamSlug(subject);
  if (!slug) return null;

  const intakeDir = WORKSTREAM_INTAKE_DIRS[slug];
  if (!intakeDir) {
    logger.debug({ slug }, 'preprocess: unknown workstream slug, passing to agent');
    return null;
  }

  fs.mkdirSync(intakeDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slugifiedSubject = subject
    .replace(/#ws:[a-z0-9_-]+/gi, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  const filename = `${dateStr}-email-${threadId}-${slugifiedSubject}.md`;
  const filePath = path.join(intakeDir, filename);

  const content = [
    '---',
    'type: email-intake',
    'source: email',
    `from: ${senderEmail}`,
    `subject: ${subject}`,
    `thread_id: ${threadId}`,
    `workstream: ${slug}`,
    `date: ${now.toISOString()}`,
    `description: "Email forwarded to ${slug} intake: ${subject}"`,
    '---',
    '',
    `From: ${senderEmail}`,
    `Subject: ${subject}`,
    `Date: ${now.toISOString()}`,
    '',
    bodyText,
  ].join('\n');

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);

  logger.info({ threadId, slug, filePath }, 'preprocess: workstream-intake written');
  return {
    handled: true,
    reason: `workstream-intake: wrote to ${slug}/intake/`,
    pattern: 'workstream-intake',
  };
}

// --------------------------------------------------------------------------
// Main entry point
// --------------------------------------------------------------------------

export async function preprocessEmail(params: {
  parsed: Array<{ body: string }>;
  subject: string;
  senderEmail: string;
  threadId: string;
  bodyText: string;
  rawParts: MessagePart[];
}): Promise<PreprocessResult> {
  // Pattern A: Calendar invite with Zoom link
  const calResult = handleCalendarZoom({
    rawParts: params.rawParts,
    bodyText: params.bodyText,
    subject: params.subject,
    senderEmail: params.senderEmail,
    threadId: params.threadId,
  });
  if (calResult) return calResult;

  // Pattern B: Crypto transaction confirmation
  const cryptoResult = handleCryptoTx({
    bodyText: params.bodyText,
    subject: params.subject,
    senderEmail: params.senderEmail,
    threadId: params.threadId,
  });
  if (cryptoResult) return cryptoResult;

  // Pattern C: Workstream forward (#ws: tag)
  const wsResult = handleWorkstreamIntake({
    bodyText: params.bodyText,
    subject: params.subject,
    senderEmail: params.senderEmail,
    threadId: params.threadId,
  });
  if (wsResult) return wsResult;

  return { handled: false, reason: 'no pattern matched' };
}
