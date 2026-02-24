import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SIGNAL_CLI_URL',
  'SIGNAL_ACCOUNT',
  'SIGNAL_ONLY',
  'SIGNAL_DEFAULT_TIER',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_2_BOT_TOKEN',
  'SLACK_2_APP_TOKEN',
  'SLACK_2_SIGNING_SECRET',
  'SLACK_2_NAMESPACE',
  'MAIN_GROUP_FOLDER',
  'VOICE_API_PORT',
  'VOICE_API_TOKEN',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
// Signal configuration
export const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || envConfig.SIGNAL_CLI_URL || 'http://127.0.0.1:8080';
export const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || envConfig.SIGNAL_ACCOUNT || '';
export const SIGNAL_ONLY = (process.env.SIGNAL_ONLY || envConfig.SIGNAL_ONLY) === 'true';
// Template folder for auto-registering unknown Signal DM contacts (e.g. 'assistant-dm')
export const SIGNAL_DEFAULT_TIER = process.env.SIGNAL_DEFAULT_TIER || envConfig.SIGNAL_DEFAULT_TIER || '';
// Slack configuration
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || envConfig.SLACK_BOT_TOKEN || '';
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || envConfig.SLACK_APP_TOKEN || '';
export const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || envConfig.SLACK_SIGNING_SECRET || '';
// Second Slack workspace (e.g. CIT Administration)
export const SLACK_2_BOT_TOKEN = process.env.SLACK_2_BOT_TOKEN || envConfig.SLACK_2_BOT_TOKEN || '';
export const SLACK_2_APP_TOKEN = process.env.SLACK_2_APP_TOKEN || envConfig.SLACK_2_APP_TOKEN || '';
export const SLACK_2_SIGNING_SECRET = process.env.SLACK_2_SIGNING_SECRET || envConfig.SLACK_2_SIGNING_SECRET || '';
export const SLACK_2_NAMESPACE = process.env.SLACK_2_NAMESPACE || envConfig.SLACK_2_NAMESPACE || '';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = process.env.MAIN_GROUP_FOLDER || envConfig.MAIN_GROUP_FOLDER || 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '300000',
  10,
); // 5min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Email intake (forwarded email → bookmark pipeline)
export const EMAIL_INTAKE_ENABLED =
  (process.env.EMAIL_INTAKE_ENABLED || 'true') === 'true';
export const EMAIL_INTAKE_POLL_INTERVAL = parseInt(
  process.env.EMAIL_INTAKE_POLL_INTERVAL || '300000', 10); // 5 min
export const EMAIL_INTAKE_ACCOUNT = 'jibot@ito.com';
export const EMAIL_INTAKE_FROM_FILTER = 'joi@ito.com';
export const GOG_BIN = '/opt/homebrew/bin/gog';
export const GOG_KEYRING_PASSWORD = 'gogjibot';
export const BOOKMARK_RELAY_URL = 'http://localhost:9999';

// Voice API (HTTP endpoint for iOS voice bridge)
export const VOICE_API_PORT = parseInt(
  process.env.VOICE_API_PORT || envConfig.VOICE_API_PORT || '3200', 10);
export const VOICE_API_TOKEN =
  process.env.VOICE_API_TOKEN || envConfig.VOICE_API_TOKEN || '';
