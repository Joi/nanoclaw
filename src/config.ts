import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
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
  'SLACK_3_BOT_TOKEN',
  'SLACK_3_APP_TOKEN',
  'SLACK_3_SIGNING_SECRET',
  'SLACK_3_NAMESPACE',
  'SLACK_4_BOT_TOKEN',
  'SLACK_4_APP_TOKEN',
  'SLACK_4_SIGNING_SECRET',
  'SLACK_4_NAMESPACE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ONLY',
  'DISCORD_BOT_TOKEN',
  'CONFIDENTIAL_ROOT',
  'EMAIL_CHANNEL_ENABLED',
  'EMAIL_INTAKE_ACCOUNT',
  'GOG_KEYRING_PASSWORD',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'jibot';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Signal configuration
export const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || envConfig.SIGNAL_CLI_URL || 'http://127.0.0.1:8080';
export const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || envConfig.SIGNAL_ACCOUNT || '';
export const SIGNAL_ONLY = (process.env.SIGNAL_ONLY || envConfig.SIGNAL_ONLY) === 'true';
export const SIGNAL_DEFAULT_TIER = process.env.SIGNAL_DEFAULT_TIER || envConfig.SIGNAL_DEFAULT_TIER || '';

// Slack configuration (first workspace)
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || envConfig.SLACK_BOT_TOKEN || '';
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || envConfig.SLACK_APP_TOKEN || '';
export const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || envConfig.SLACK_SIGNING_SECRET || '';

// Second Slack workspace
export const SLACK_2_BOT_TOKEN = process.env.SLACK_2_BOT_TOKEN || envConfig.SLACK_2_BOT_TOKEN || '';
export const SLACK_2_APP_TOKEN = process.env.SLACK_2_APP_TOKEN || envConfig.SLACK_2_APP_TOKEN || '';
export const SLACK_2_SIGNING_SECRET = process.env.SLACK_2_SIGNING_SECRET || envConfig.SLACK_2_SIGNING_SECRET || '';
export const SLACK_2_NAMESPACE = process.env.SLACK_2_NAMESPACE || envConfig.SLACK_2_NAMESPACE || '';

// Telegram configuration
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY = (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';

// Discord configuration
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || envConfig.DISCORD_BOT_TOKEN || '';

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
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

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
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// Email intake configuration
export const EMAIL_INTAKE_ENABLED =
  (process.env.EMAIL_INTAKE_ENABLED || '') === 'true';
export const EMAIL_INTAKE_ACCOUNT =
  process.env.EMAIL_INTAKE_ACCOUNT || envConfig.EMAIL_INTAKE_ACCOUNT || '';
export const EMAIL_INTAKE_FROM_FILTER =
  process.env.EMAIL_INTAKE_FROM_FILTER || '';
export const EMAIL_INTAKE_POLL_INTERVAL = parseInt(
  process.env.EMAIL_INTAKE_POLL_INTERVAL || '300000',
  10,
); // 5 min default

// Email channel v2 configuration
export const EMAIL_CHANNEL_ENABLED =
  (process.env.EMAIL_CHANNEL_ENABLED || envConfig.EMAIL_CHANNEL_ENABLED || '') === 'true';
export const EMAIL_CHANNEL_POLL_INTERVAL = parseInt(
  process.env.EMAIL_CHANNEL_POLL_INTERVAL || '120000',
  10,
); // 2 min default
export const EMAIL_ALIAS_MAP_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'email-alias-map.json',
);
export const EMAIL_IDENTITY_INDEX_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'identity-index.json',
);
// Calendar ID for event creation (Joi's calendar, shared as writer to jibot)
export const EMAIL_CALENDAR_ID =
  process.env.EMAIL_CALENDAR_ID || 'joi@ito.com';
export const GOG_BIN = process.env.GOG_BIN || 'gog';
export const GOG_KEYRING_PASSWORD =
  process.env.GOG_KEYRING_PASSWORD || envConfig.GOG_KEYRING_PASSWORD || '';
export const BOOKMARK_RELAY_URL =
  process.env.BOOKMARK_RELAY_URL || 'http://localhost:3131';

// Voice API configuration
export const VOICE_API_PORT = parseInt(
  process.env.VOICE_API_PORT || '3200',
  10,
);
export const VOICE_API_TOKEN = process.env.VOICE_API_TOKEN || '';

// Main group folder (used by voice API, email routing, etc.)
export const MAIN_GROUP_FOLDER =
  process.env.MAIN_GROUP_FOLDER || '';

// Third Slack workspace (GIDC)
export const SLACK_3_BOT_TOKEN = process.env.SLACK_3_BOT_TOKEN || envConfig.SLACK_3_BOT_TOKEN || '';
export const SLACK_3_APP_TOKEN = process.env.SLACK_3_APP_TOKEN || envConfig.SLACK_3_APP_TOKEN || '';
export const SLACK_3_SIGNING_SECRET = process.env.SLACK_3_SIGNING_SECRET || envConfig.SLACK_3_SIGNING_SECRET || '';
export const SLACK_3_NAMESPACE = process.env.SLACK_3_NAMESPACE || envConfig.SLACK_3_NAMESPACE || '';

// Fourth Slack workspace (joiito)
export const SLACK_4_BOT_TOKEN = process.env.SLACK_4_BOT_TOKEN || envConfig.SLACK_4_BOT_TOKEN || '';
export const SLACK_4_APP_TOKEN = process.env.SLACK_4_APP_TOKEN || envConfig.SLACK_4_APP_TOKEN || '';
export const SLACK_4_SIGNING_SECRET = process.env.SLACK_4_SIGNING_SECRET || envConfig.SLACK_4_SIGNING_SECRET || '';
export const SLACK_4_NAMESPACE = process.env.SLACK_4_NAMESPACE || envConfig.SLACK_4_NAMESPACE || '';

// Confidential root directory for intake files
export const CONFIDENTIAL_ROOT =
  process.env.CONFIDENTIAL_ROOT ||
  envConfig.CONFIDENTIAL_ROOT ||
  path.join(os.homedir(), 'switchboard', 'confidential');
