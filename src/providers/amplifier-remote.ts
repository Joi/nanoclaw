/**
 * Amplifier-remote host-side container config.
 *
 * Reads `~/.config/amplifierd/credentials.env` on the host and ferries the
 * values into the container as -e flags. The credentials file is kept
 * separate from the repo's `.env` (per the original 1.x design — see
 * jibotmac deployment notes; rotation: re-run the macazbd-side helper).
 *
 * The in-container side is `container/agent-runner/src/providers/amplifier-remote.ts`,
 * which reads these same env vars and implements the AgentProvider interface.
 *
 * @added 2026-05 ported from src/runners/amplifier-remote/client.ts (1.x)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const CREDS_PATH = path.join(os.homedir(), '.config', 'amplifierd', 'credentials.env');

const FORWARDED_KEYS = [
  'AMPLIFIERD_API_KEY',
  'AMPLIFIERD_BASE_URL',
  'AMPLIFIERD_BUNDLE',
  'AMPLIFIERD_WORKING_DIR',
  'AMPLIFIERD_MAX_PROMPT_BYTES',
  'AMPLIFIERD_TIMEOUT_MS',
] as const;

function parseCredsFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val) out[key] = val;
  }
  return out;
}

registerProviderContainerConfig('amplifier-remote', () => {
  let content: string;
  try {
    content = fs.readFileSync(CREDS_PATH, 'utf-8');
  } catch (err) {
    log.warn('amplifier-remote: credentials file unreadable — provider will fail at first turn', {
      credsPath: CREDS_PATH,
      err: (err as Error).message,
    });
    return {};
  }

  const parsed = parseCredsFile(content);
  const env: Record<string, string> = {};
  for (const key of FORWARDED_KEYS) {
    if (parsed[key]) env[key] = parsed[key];
  }
  return { env };
});

// Internal export for unit tests.
export const __test = { parseCredsFile, FORWARDED_KEYS, CREDS_PATH };
