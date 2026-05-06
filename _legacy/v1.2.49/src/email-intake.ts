/**
 * Email-to-bookmark pipeline.
 * Polls jibot@ito.com for forwarded emails from joi@ito.com,
 * extracts URLs, and sends them to the bookmark relay for knowledge extraction.
 * Gmail labels are used as state — no local DB needed.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  BOOKMARK_RELAY_URL,
  EMAIL_INTAKE_ACCOUNT,
  EMAIL_INTAKE_FROM_FILTER,
  GOG_BIN,
  GOG_KEYRING_PASSWORD,
} from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const LABEL_NAME = 'nanoclaw-processed';
const GOG_TIMEOUT = 30_000;
const RELAY_TIMEOUT = 90_000;

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

interface GogMessage {
  id: string;
  threadId: string;
  subject?: string;
  snippet?: string;
  [key: string]: unknown;
}

interface GogMessageDetail {
  id: string;
  threadId: string;
  body?: string;
  snippet?: string;
  payload?: {
    body?: { data?: string };
    parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
  };
  [key: string]: unknown;
}

async function callGog(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(GOG_BIN, args, {
    env: { ...process.env, GOG_KEYRING_PASSWORD },
    encoding: 'utf-8',
    timeout: GOG_TIMEOUT,
  });
  return stdout;
}

export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"')\]},;]+/gi;
  const matches = text.match(urlRegex) || [];

  const seen = new Set<string>();
  const results: string[] = [];

  for (let url of matches) {
    // Strip trailing punctuation that's likely not part of the URL
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
  // Try top-level body
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
    // Fall back to text/html if no plain text
    for (const part of detail.payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
  }

  // Last resort: snippet
  return detail.snippet || '';
}

async function bookmarkViaRelay(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${BOOKMARK_RELAY_URL}/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, hint: 'reference' }),
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

/**
 * One-time setup: ensure the nanoclaw-processed label exists in Gmail.
 */
export async function ensureEmailLabel(): Promise<void> {
  try {
    await callGog([
      'gmail', 'labels', 'create', LABEL_NAME,
      '--account', EMAIL_INTAKE_ACCOUNT,
    ]);
    logger.info('Created Gmail label: nanoclaw-processed');
  } catch {
    // Label likely already exists — that's fine
    logger.debug('Gmail label nanoclaw-processed already exists or creation skipped');
  }
}

/**
 * Poll for unprocessed forwarded emails, extract URLs, bookmark them.
 */
export async function pollEmailIntake(): Promise<void> {
  let messages: GogMessage[];

  try {
    const query = `from:${EMAIL_INTAKE_FROM_FILTER} -label:${LABEL_NAME}`;
    const raw = await callGog([
      'gmail', 'list', '-j',
      '--account', EMAIL_INTAKE_ACCOUNT,
      query,
      '--max', '20',
    ]);
    messages = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'Email intake: failed to list emails');
    return;
  }

  if (!Array.isArray(messages) || messages.length === 0) return;

  logger.info({ count: messages.length }, 'Email intake: processing emails');

  for (const msg of messages) {
    let bodyText: string;
    try {
      const raw = await callGog([
        'gmail', 'get', msg.id, '-j',
        '--account', EMAIL_INTAKE_ACCOUNT,
      ]);
      const detail: GogMessageDetail = JSON.parse(raw);
      bodyText = extractBodyText(detail);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ messageId: msg.id, error: errMsg }, 'Email intake: failed to get message');
      continue;
    }

    const urls = extractUrls(bodyText);
    logger.info(
      { messageId: msg.id, subject: msg.subject, urlCount: urls.length },
      'Email intake: extracted URLs',
    );

    let relayFailed = false;
    for (const url of urls) {
      const ok = await bookmarkViaRelay(url);
      if (!ok) {
        relayFailed = true;
        break;
      }
      logger.info({ url }, 'Email intake: bookmarked URL');
    }

    // If relay is down, don't mark processed — retry next poll
    if (relayFailed) {
      logger.warn({ messageId: msg.id }, 'Email intake: relay down, will retry');
      continue;
    }

    // Mark thread as processed (label + archive)
    try {
      await callGog([
        'gmail', 'thread', 'modify', msg.threadId,
        '--add', LABEL_NAME,
        '--remove', 'INBOX',
        '--account', EMAIL_INTAKE_ACCOUNT,
      ]);
      logger.info({ threadId: msg.threadId }, 'Email intake: marked processed');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ threadId: msg.threadId, error: errMsg }, 'Email intake: failed to label thread');
    }
  }
}
