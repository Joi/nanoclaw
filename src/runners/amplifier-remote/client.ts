/**
 * HTTP client for amplifierd (Microsoft Amplifier daemon).
 *
 * amplifierd exposes amplifier-core sessions over REST + SSE.
 * This module wraps two endpoints used by the amplifier-remote runner:
 *   - POST /sessions             → create a new session
 *   - POST /sessions/{id}/execute → run a single turn
 *
 * Credentials live in ~/.config/amplifierd/credentials.env on jibotmac
 * (NOT in NanoClaw's <repo>/.env — kept separate per the user's
 * "minimum on jibotmac" intent). Format:
 *   AMPLIFIERD_API_KEY=<32-byte hex>
 *   AMPLIFIERD_BASE_URL=http://172.27.158.235:8410
 *
 * The file is created on jibotmac via SSH from macazbd. Rotation: re-run
 * the macazbd-side helper. Mode 600. Beads joi-1l51.6 tracks 1Password
 * migration.
 *
 * @added 2026-05-05 for joi-1l51 (NanoClaw → remote Amplifier session pipe)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../../logger.js';

// ────────────────────────────────────────────────────────────────────────────
// Credential loading (with cache)
// ────────────────────────────────────────────────────────────────────────────

export interface AmplifierdCreds {
  apiKey: string;
  baseUrl: string;
}

/** Default location on jibotmac. Tests override via fs mocking. */
const DEFAULT_CREDS_PATH = path.join(os.homedir(), '.config', 'amplifierd', 'credentials.env');

let _credsCache: AmplifierdCreds | null = null;

/** Test-only: clear the in-process creds cache. */
export function resetCredsCache(): void {
  _credsCache = null;
}

/**
 * Load and parse ~/.config/amplifierd/credentials.env.
 * Caches the result for the process lifetime — call resetCredsCache() in tests.
 *
 * Throws when:
 *   - File is unreadable (ENOENT, permissions)
 *   - AMPLIFIERD_API_KEY is missing
 *   - AMPLIFIERD_BASE_URL is missing
 */
export function loadAmplifierdCreds(credsPath: string = DEFAULT_CREDS_PATH): AmplifierdCreds {
  if (_credsCache) return _credsCache;

  let raw: string;
  try {
    raw = fs.readFileSync(credsPath, 'utf-8');
  } catch (err) {
    const msg = `Failed to read amplifierd credentials at ${credsPath}: ${(err as Error).message}`;
    logger.error({ credsPath, err }, 'amplifier-remote: credentials file unreadable');
    throw new Error(msg);
  }

  const parsed: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double)
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    parsed[key] = val;
  }

  const apiKey = parsed['AMPLIFIERD_API_KEY'];
  const baseUrl = parsed['AMPLIFIERD_BASE_URL'];

  if (!apiKey) {
    throw new Error(`AMPLIFIERD_API_KEY not found in ${credsPath}`);
  }
  if (!baseUrl) {
    throw new Error(`AMPLIFIERD_BASE_URL not found in ${credsPath}`);
  }

  _credsCache = { apiKey, baseUrl };
  return _credsCache;
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP wrappers
// ────────────────────────────────────────────────────────────────────────────

interface CreateSessionResponse {
  session_id: string;
  status: string;
  bundle_name: string;
  working_dir?: string;
  created_at?: string;
}

interface ExecuteResponse {
  response: string;
  usage?: unknown;
  tool_calls?: unknown;
  finish_reason?: string | null;
}

interface ExecuteOptions {
  /** Per-call timeout in ms. Default 90_000 (90s). */
  timeoutMs?: number;
}

async function authedFetch(
  pathSuffix: string,
  init: RequestInit,
  creds: AmplifierdCreds,
): Promise<Response> {
  const url = `${creds.baseUrl}${pathSuffix}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.apiKey}`,
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(url, { ...init, headers });
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      if (typeof json.detail === 'string') return json.detail;
      if (typeof json.error === 'string') return json.error;
    } catch {
      /* not JSON, fall through */
    }
    return body || res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * Create a new amplifierd session bound to the given bundle.
 * Returns the session_id (UUID).
 */
export async function createSession(
  bundleName: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const creds = loadAmplifierdCreds();
  const body: Record<string, unknown> = { bundle_name: bundleName };
  if (metadata) body.metadata = metadata;

  let res: Response;
  try {
    res = await authedFetch('/sessions', { method: 'POST', body: JSON.stringify(body) }, creds);
  } catch (err) {
    throw new Error(`amplifierd network error on createSession: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const detail = await readErrorMessage(res);
    throw new Error(`amplifierd ${res.status} on createSession: ${detail}`);
  }

  const data = (await res.json()) as CreateSessionResponse;
  if (!data.session_id) {
    throw new Error(`amplifierd createSession returned no session_id (response shape: ${JSON.stringify(data)})`);
  }
  logger.debug({ sessionId: data.session_id, bundleName }, 'amplifier-remote: session created');
  return data.session_id;
}

/**
 * Execute a single turn against an existing session.
 * Returns { response: string }.
 */
export async function executePrompt(
  sessionId: string,
  prompt: string,
  opts: ExecuteOptions = {},
): Promise<{ response: string }> {
  const creds = loadAmplifierdCreds();
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await authedFetch(
      `/sessions/${encodeURIComponent(sessionId)}/execute`,
      {
        method: 'POST',
        body: JSON.stringify({ prompt }),
        signal: ctrl.signal,
      },
      creds,
    );
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`amplifierd network error on executePrompt: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = await readErrorMessage(res);
    throw new Error(`amplifierd ${res.status} on executePrompt: ${detail}`);
  }

  const data = (await res.json()) as ExecuteResponse;
  if (typeof data.response !== 'string') {
    throw new Error(`amplifierd executePrompt returned unexpected shape (no 'response' field): ${JSON.stringify(data)}`);
  }
  return { response: data.response };
}
