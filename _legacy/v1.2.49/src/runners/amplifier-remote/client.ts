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
import http from 'http';
import os from 'os';
import path from 'path';
import { URL } from 'url';

import { logger } from '../../logger.js';

// ────────────────────────────────────────────────────────────────────────────
// Credential loading (with cache)
// ────────────────────────────────────────────────────────────────────────────

export interface AmplifierdCreds {
  apiKey: string;
  baseUrl: string;
  /**
   * Optional starting working_dir for sessions created against this amplifierd.
   * Set via AMPLIFIERD_WORKING_DIR in credentials.env. When omitted, amplifierd
   * uses its default (HOME on the amplifierd host).
   *
   * Note: this is a string sent verbatim to the remote amplifierd. It refers
   * to a path on the amplifierd HOST, not on jibotmac. Tools like the joi
   * bundle's bash tool will run with this as cwd.
   */
  workingDir?: string;
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
  const workingDir = parsed['AMPLIFIERD_WORKING_DIR']; // optional

  if (!apiKey) {
    throw new Error(`AMPLIFIERD_API_KEY not found in ${credsPath}`);
  }
  if (!baseUrl) {
    throw new Error(`AMPLIFIERD_BASE_URL not found in ${credsPath}`);
  }

  _credsCache = workingDir ? { apiKey, baseUrl, workingDir } : { apiKey, baseUrl };
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

/**
 * Hard cap on prompt size. Defends against:
 *   - Accidental runaway loops dumping huge transcripts as prompts
 *   - Abuse via maliciously-crafted long messages (token cost amplification)
 *   - Memory pressure on amplifierd (the joi bundle has heavy MCP backends)
 *
 * 256KB ≈ 64K tokens at typical text density — well above any normal Signal
 * DM batch (Signal max-message-size is 8KB and NanoClaw caps batch sizes)
 * but bounded enough to keep runaway prompts from crashing amplifierd.
 *
 * Set MAX_PROMPT_BYTES env var to override at deploy time (rarely needed).
 */
const DEFAULT_MAX_PROMPT_BYTES = 256 * 1024;
function maxPromptBytes(): number {
  const env = process.env.AMPLIFIERD_MAX_PROMPT_BYTES;
  if (!env) return DEFAULT_MAX_PROMPT_BYTES;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PROMPT_BYTES;
}

interface HttpResult {
  status: number;
  body: string;
}

/**
 * POST JSON to amplifierd. Uses node:http directly (NOT globalThis.fetch)
 * because the long-running NanoClaw process surfaced "fetch failed" errors
 * from undici's shared keep-alive pool getting into a bad state. node:http
 * with a fresh ad-hoc Agent eliminates that class of issue. Same idiom as
 * src/agent-api.ts uses for its existing HTTP server.
 */
function postJson(
  pathSuffix: string,
  bodyObj: unknown,
  creds: AmplifierdCreds,
  timeoutMs: number = 90_000,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(creds.baseUrl + pathSuffix);
    const body = JSON.stringify(bodyObj);
    const opts: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
      },
      // Fresh Agent — no shared connection pool state across calls.
      agent: new http.Agent({ keepAlive: false }),
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const respBody = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode ?? 0, body: respBody });
      });
      res.on('error', (err) => reject(err));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`amplifierd request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      // Surface the FULL error including code (ECONNREFUSED, ENETUNREACH, EHOSTUNREACH, etc.)
      const code = (err as NodeJS.ErrnoException).code;
      reject(new Error(`${err.message}${code ? ` [${code}]` : ''}`));
    });
    req.write(body);
    req.end();
  });
}

function extractErrorDetail(body: string, fallback: string): string {
  if (!body) return fallback;
  try {
    const json = JSON.parse(body);
    if (typeof json.detail === 'string') return json.detail;
    if (json.detail && typeof json.detail === 'object') {
      // RFC 7807 Problem Details from amplifierd
      if (typeof json.detail.detail === 'string') return json.detail.detail;
      if (typeof json.detail.title === 'string') return json.detail.title;
    }
    if (typeof json.error === 'string') return json.error;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
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
  if (creds.workingDir) body.working_dir = creds.workingDir;
  if (metadata) body.metadata = metadata;

  let result: HttpResult;
  try {
    result = await postJson('/sessions', body, creds, 30_000);
  } catch (err) {
    throw new Error(`amplifierd network error on createSession: ${(err as Error).message}`);
  }

  if (result.status < 200 || result.status >= 300) {
    const detail = extractErrorDetail(result.body, `HTTP ${result.status}`);
    throw new Error(`amplifierd ${result.status} on createSession: ${detail}`);
  }

  let data: CreateSessionResponse;
  try {
    data = JSON.parse(result.body) as CreateSessionResponse;
  } catch {
    throw new Error(`amplifierd createSession returned non-JSON: ${result.body.slice(0, 200)}`);
  }
  if (!data.session_id) {
    throw new Error(`amplifierd createSession returned no session_id (response shape: ${result.body.slice(0, 200)})`);
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
  // Defense: cap prompt size BEFORE any network call
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  const maxBytes = maxPromptBytes();
  if (promptBytes > maxBytes) {
    throw new Error(
      `amplifierd executePrompt: prompt size ${promptBytes} bytes exceeds limit ${maxBytes} bytes (set AMPLIFIERD_MAX_PROMPT_BYTES to raise)`,
    );
  }

  const creds = loadAmplifierdCreds();
  const timeoutMs = opts.timeoutMs ?? 90_000;

  let result: HttpResult;
  try {
    result = await postJson(
      `/sessions/${encodeURIComponent(sessionId)}/execute`,
      { prompt },
      creds,
      timeoutMs,
    );
  } catch (err) {
    throw new Error(`amplifierd network error on executePrompt: ${(err as Error).message}`);
  }

  if (result.status < 200 || result.status >= 300) {
    const detail = extractErrorDetail(result.body, `HTTP ${result.status}`);
    throw new Error(`amplifierd ${result.status} on executePrompt: ${detail}`);
  }

  let data: ExecuteResponse;
  try {
    data = JSON.parse(result.body) as ExecuteResponse;
  } catch {
    throw new Error(`amplifierd executePrompt returned non-JSON: ${result.body.slice(0, 200)}`);
  }
  if (typeof data.response !== 'string') {
    throw new Error(`amplifierd executePrompt returned unexpected shape (no 'response' field): ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { response: data.response };
}
