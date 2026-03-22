import fs from 'fs';

import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
};

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG, chats: {} };
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return { ...DEFAULT_CONFIG, chats: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return { ...DEFAULT_CONFIG, chats: {} };
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return { ...DEFAULT_CONFIG, chats: {} };
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  return {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

export function saveSenderAllowlist(
  cfg: SenderAllowlistConfig,
  pathOverride?: string,
): void {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;
  const json = JSON.stringify(cfg, null, 2) + '\n';
  // let fs errors propagate to caller
  fs.writeFileSync(filePath, json, 'utf-8');
  logger.info({ path: filePath }, 'sender-allowlist: config saved');
}

export function addAllowlistEntry(
  jid: string,
  entry: ChatAllowlistEntry,
  pathOverride?: string,
): void {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;
  const cfg = loadSenderAllowlist(filePath);
  cfg.chats[jid] = entry;
  saveSenderAllowlist(cfg, filePath);
  logger.info({ jid, path: filePath }, 'sender-allowlist: entry added');
}

export function removeAllowlistEntry(
  jid: string,
  pathOverride?: string,
): boolean {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;
  const cfg = loadSenderAllowlist(filePath);
  if (!(jid in cfg.chats)) return false;
  delete cfg.chats[jid];
  saveSenderAllowlist(cfg, filePath);
  logger.info({ jid, path: filePath }, 'sender-allowlist: entry removed');
  return true;
}

export function listAllowlistEntries(
  pathOverride?: string,
): Record<string, ChatAllowlistEntry> {
  const cfg = loadSenderAllowlist(pathOverride);
  return cfg.chats;
}
