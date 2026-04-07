import fs from 'fs';

import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop' | 'allow';
}

export interface AllowlistUser {
  tier: 'owner' | 'admin' | 'staff';
  emails: string[];
  jids: string[];
  workstreams: string[];
}

export interface WorkstreamInfo {
  qmd_collection: string;
  drive_folder_id: string | null;
  slack_channels: string[];
  mount_path: string;
}

export interface AllowlistGroup {
  members: string[];
}

export interface PermittedScope {
  workstreams: string;
  qmdCollections: string;
  mountPaths: string;
  workstreamNames: string;
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
  users?: Record<string, AllowlistUser>;
  workstreams?: Record<string, WorkstreamInfo>;
  groups?: Record<string, AllowlistGroup>;
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
  const validMode = e.mode === 'trigger' || e.mode === 'drop' || e.mode === 'allow';
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return DEFAULT_CONFIG;
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
    users: obj.users as Record<string, AllowlistUser> | undefined,
    workstreams: obj.workstreams as Record<string, WorkstreamInfo> | undefined,
    groups: obj.groups as Record<string, AllowlistGroup> | undefined,
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

export function addAllowlistEntry(
  chatJid: string,
  entry: ChatAllowlistEntry,
  pathOverride?: string,
): void {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;
  const config = loadSenderAllowlist(pathOverride);
  config.chats[chatJid] = entry;
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  logger.info({ chatJid }, 'sender-allowlist: entry added');
}

export function removeAllowlistEntry(
  chatJid: string,
  pathOverride?: string,
): void {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;
  const config = loadSenderAllowlist(pathOverride);
  delete config.chats[chatJid];
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  logger.info({ chatJid }, 'sender-allowlist: entry removed');
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

export interface ResolvedUser {
  name: string;
  user: AllowlistUser;
}

export function resolveUser(
  jid: string,
  cfg: SenderAllowlistConfig,
): ResolvedUser | null {
  if (!cfg.users || typeof cfg.users !== 'object') return null;
  for (const [name, user] of Object.entries(cfg.users)) {
    if (Array.isArray(user?.jids) && user.jids.includes(jid)) {
      return { name, user };
    }
  }
  return null;
}

export interface ResolvedWorkstream {
  name: string;
  info: WorkstreamInfo;
}

export function getUserWorkstreams(
  user: AllowlistUser,
  cfg: SenderAllowlistConfig,
): ResolvedWorkstream[] {
  if (!cfg.workstreams) return [];
  if (!Array.isArray(user?.workstreams)) return [];

  const results: ResolvedWorkstream[] = [];
  for (const name of user.workstreams) {
    const info = cfg.workstreams[name];
    if (info) {
      results.push({ name, info });
    }
  }
  return results;
}
export function getGroupWorkstreams(
  memberJids: string[],
  cfg: SenderAllowlistConfig,
): ResolvedWorkstream[] {
  if (memberJids.length === 0 || !cfg.users || !cfg.workstreams) return [];

  const memberWorkstreamSets: Set<string>[] = [];
  for (const jid of memberJids) {
    const resolved = resolveUser(jid, cfg);
    if (!resolved) return [];
    if (!Array.isArray(resolved.user.workstreams)) return [];
    memberWorkstreamSets.push(new Set(resolved.user.workstreams));
  }

  let intersection = memberWorkstreamSets[0];
  for (let i = 1; i < memberWorkstreamSets.length; i++) {
    const nextSet = memberWorkstreamSets[i];
    intersection = new Set([...intersection].filter((ws) => nextSet.has(ws)));
  }

  const results: ResolvedWorkstream[] = [];
  for (const name of intersection) {
    const info = cfg.workstreams[name];
    if (info) {
      results.push({ name, info });
    }
  }
  return results;
}

/**
 * Resolve a group JID to the JIDs of its members.
 * Returns member JIDs for getGroupWorkstreams(), or empty array if group not found.
 */
export function resolveGroupMembers(
  groupJid: string,
  cfg: SenderAllowlistConfig,
): string[] {
  if (!cfg.groups || !cfg.users) return [];
  const group = cfg.groups[groupJid];
  if (!group) return [];

  // Map member names to their first JID
  const jids: string[] = [];
  for (const memberName of group.members) {
    const user = cfg.users[memberName];
    if (user && user.jids.length > 0) {
      jids.push(user.jids[0]);
    }
  }
  return jids;
}
