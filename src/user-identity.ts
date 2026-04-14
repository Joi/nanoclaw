import fs from 'fs';

import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

// --- User identity types (per-user, not per-channel) ---

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

/**
 * User identity config -- loaded from sender-allowlist.json.
 * Only the user/workstream/group sections are used.
 * Per-chat modes have moved to channel YAML configs (sender_policy field).
 */
export interface UserIdentityConfig {
  logDenied: boolean;
  users?: Record<string, AllowlistUser>;
  workstreams?: Record<string, WorkstreamInfo>;
  groups?: Record<string, AllowlistGroup>;
}

const DEFAULT_CONFIG: UserIdentityConfig = {
  logDenied: true,
};

export function loadUserIdentity(
  pathOverride?: string,
): UserIdentityConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'user-identity: cannot read config',
    );
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'user-identity: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;

  return {
    logDenied: obj.logDenied !== false,
    users: obj.users as Record<string, AllowlistUser> | undefined,
    workstreams: obj.workstreams as Record<string, WorkstreamInfo> | undefined,
    groups: obj.groups as Record<string, AllowlistGroup> | undefined,
  };
}

// --- Backward compatibility aliases ---
// These keep existing code working during migration.
export type SenderAllowlistConfig = UserIdentityConfig;
export const loadSenderAllowlist = loadUserIdentity;

/**
 * Check if a sender is allowed to trigger the agent in a chat.
 * This is identity-level: "is this person recognized?"
 * Channel-level policy (allow/trigger/drop) is in YAML sender_policy.
 */
export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: UserIdentityConfig,
): boolean {
  // With YAML-first architecture, all senders are allowed through.
  // Per-chat mode filtering is handled by YAML sender_policy.
  // This function now only checks if the sender is a known user.
  return true;
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: UserIdentityConfig,
): boolean {
  return true;  // Sender gating moved to YAML sender_policy
}

export interface ResolvedUser {
  name: string;
  user: AllowlistUser;
}

export function resolveUser(
  jid: string,
  cfg: UserIdentityConfig,
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
  cfg: UserIdentityConfig,
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
  cfg: UserIdentityConfig,
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

export function resolveGroupMembers(
  groupJid: string,
  cfg: UserIdentityConfig,
): string[] {
  if (!cfg.groups || !cfg.users) return [];
  const group = cfg.groups[groupJid];
  if (!group) return [];

  const jids: string[] = [];
  for (const memberName of group.members) {
    const user = cfg.users[memberName];
    if (user && user.jids.length > 0) {
      jids.push(user.jids[0]);
    }
  }
  return jids;
}

export function computePermittedScope(
  senderJid: string,
  chatJid: string,
  cfg: UserIdentityConfig,
): PermittedScope | null {
  if (!cfg.users || !cfg.workstreams) return null;

  let resolved: ResolvedWorkstream[];

  if (cfg.groups && cfg.groups[chatJid]) {
    const memberJids = resolveGroupMembers(chatJid, cfg);
    if (memberJids.length === 0) return null;
    resolved = getGroupWorkstreams(memberJids, cfg);
  } else {
    const user = resolveUser(senderJid, cfg);
    if (!user) return null;
    resolved = getUserWorkstreams(user.user, cfg);
  }

  if (resolved.length === 0) return null;

  return {
    workstreams: resolved.map((w) => w.name).join(','),
    qmdCollections: resolved.map((w) => w.info.qmd_collection).join(','),
    mountPaths: resolved.map((w) => w.info.mount_path).join(','),
    workstreamNames: resolved.map((w) => w.name).join(', '),
  };
}
