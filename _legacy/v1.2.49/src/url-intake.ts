/**
 * URL auto-intake to the knowledge-intake sprite.
 *
 * When a Signal DM (or any opted-in channel) message body is a BARE URL
 * (whitespace-only padding, no other content), the URL gets filed
 * automatically to the knowledge-intake sprite at
 *   POST https://knowledge-intake-bmal2.sprites.app/intake
 * and the agent is NOT dispatched. The sprite fetches the page, classifies
 * via Claude, and writes a vault-compatible markdown file to
 * agents/curator/extractions/, syncing back through Syncthing.
 *
 * This replaces the older bookmark-extractor sprite path (deprecated in
 * joi-1l51 follow-up 2026-05-06). The previous src/bookmarks.ts module
 * pointed at localhost:9999 → bookmark-extractor; that whole flow is gone.
 *
 * The opt-in is per-channel via the YAML field `auto_url_intake: true`.
 * Default is OFF — only signal-joi-dm has it enabled today.
 *
 * Auth: INTAKE_API_KEY loaded from credentials.env (same file the
 * amplifier-remote runner uses; just one more key).
 *
 * @added 2026-05-06 for joi-k1x9 prompt-chain redesign + bare-URL rule
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { URL } from 'url';

import { logger } from './logger.js';

// ────────────────────────────────────────────────────────────────────────────
// Bare-URL detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return the URL if the entire trimmed message body is a single http(s) URL,
 * else null. "Bare URL" = whitespace + URL + whitespace, nothing else.
 *
 * Examples:
 *   "https://x.com/foo/status/123" → "https://x.com/foo/status/123"
 *   "  https://example.com  "      → "https://example.com"
 *   "check this https://x.com"     → null  (extra text)
 *   "https://x.com extra text"     → null  (extra text)
 *   ""                              → null
 */
export function detectBareUrl(body: string): string | null {
  if (!body) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  // Strict: the trimmed body must start with http(s):// and have NO whitespace.
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return trimmed;
}

// ────────────────────────────────────────────────────────────────────────────
// Sprite client
// ────────────────────────────────────────────────────────────────────────────

const SPRITE_URL = 'https://knowledge-intake-bmal2.sprites.app';
const DEFAULT_INTAKE_TIMEOUT_MS = 90_000;

interface IntakeResponse {
  status?: string;
  file_path?: string;
  title?: string;
  classification?: string;
  error?: string;
  [k: string]: unknown;
}

interface IntakeCreds {
  apiKey: string;
}

let _intakeCredsCache: IntakeCreds | null = null;
const DEFAULT_CREDS_PATH = path.join(os.homedir(), '.config', 'amplifierd', 'credentials.env');

/** Test-only: clear the in-process intake creds cache. */
export function resetIntakeCredsCache(): void {
  _intakeCredsCache = null;
}

/**
 * Load INTAKE_API_KEY from the same credentials file the amplifier-remote
 * runner uses. Cached for the process lifetime.
 *
 * Throws when the key is missing — the caller should treat absence as
 * "auto-intake unavailable", warn, and proceed without filing.
 */
export function loadIntakeCreds(credsPath: string = DEFAULT_CREDS_PATH): IntakeCreds {
  if (_intakeCredsCache) return _intakeCredsCache;
  let raw: string;
  try {
    raw = fs.readFileSync(credsPath, 'utf-8');
  } catch (err) {
    throw new Error(`url-intake: failed to read ${credsPath}: ${(err as Error).message}`);
  }
  let apiKey: string | undefined;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'INTAKE_API_KEY') apiKey = val;
  }
  if (!apiKey) {
    throw new Error(`url-intake: INTAKE_API_KEY not found in ${credsPath}`);
  }
  _intakeCredsCache = { apiKey };
  return _intakeCredsCache;
}

interface HttpResult {
  status: number;
  body: string;
}

/**
 * POST JSON to the knowledge-intake sprite over HTTPS.
 * Uses node:https with a fresh Agent (no shared keep-alive pool) — matches
 * the pattern from amplifier-remote/client.ts that fixed the long-running
 * NanoClaw process undici-pool corruption.
 */
function postJson(
  pathSuffix: string,
  bodyObj: unknown,
  apiKey: string,
  timeoutMs: number = DEFAULT_INTAKE_TIMEOUT_MS,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(SPRITE_URL + pathSuffix);
    const body = JSON.stringify(bodyObj);
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
      },
      agent: new https.Agent({ keepAlive: false }),
      timeout: timeoutMs,
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
      });
      res.on('error', (err) => reject(err));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`knowledge-intake request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      reject(new Error(`${err.message}${code ? ` [${code}]` : ''}`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * File a URL to the knowledge-intake sprite.
 *
 * Returns the parsed sprite response. On any error, returns
 * { error: 'message' } rather than throwing — callers can surface
 * partial results and avoid blocking the message handler.
 */
export async function intakeUrl(
  url: string,
  options?: { hint?: string; domain?: string; timeoutMs?: number },
): Promise<IntakeResponse> {
  let creds: IntakeCreds;
  try {
    creds = loadIntakeCreds();
  } catch (err) {
    return { error: (err as Error).message };
  }
  const body: Record<string, string> = { url };
  if (options?.hint) body.hint = options.hint;
  if (options?.domain) body.domain = options.domain;

  let result: HttpResult;
  try {
    result = await postJson('/intake', body, creds.apiKey, options?.timeoutMs);
  } catch (err) {
    return { error: `knowledge-intake network error: ${(err as Error).message}` };
  }
  if (result.status < 200 || result.status >= 300) {
    return { error: `knowledge-intake HTTP ${result.status}: ${result.body.slice(0, 300)}` };
  }
  try {
    return JSON.parse(result.body) as IntakeResponse;
  } catch {
    return { error: `knowledge-intake returned non-JSON: ${result.body.slice(0, 200)}` };
  }
}

/**
 * Format a brief Signal-friendly confirmation reply from the sprite response.
 * Used by the message handler when a bare URL is auto-filed.
 */
export function formatIntakeReply(response: IntakeResponse, url: string): string {
  if (response.error) {
    return `Couldn't auto-file URL: ${response.error.slice(0, 200)}`;
  }
  const title = response.title || '(untitled)';
  const cls = response.classification ? ` [${response.classification}]` : '';
  const path = response.file_path ? `\n→ ${response.file_path}` : '';
  return `Filed${cls}: ${title}${path}`;
}
