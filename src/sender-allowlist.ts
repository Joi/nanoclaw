/**
 * DEPRECATED: This file is a backward-compatibility shim.
 * All functionality has moved to user-identity.ts.
 * Per-chat modes have moved to channel YAML configs (sender_policy field).
 *
 * This re-export allows existing imports to keep working during migration.
 */
export {
  type SenderAllowlistConfig,
  type UserIdentityConfig,
  type AllowlistUser,
  type WorkstreamInfo,
  type AllowlistGroup,
  type PermittedScope,
  type ResolvedUser,
  type ResolvedWorkstream,
  loadSenderAllowlist,
  loadUserIdentity,
  isSenderAllowed,
  isTriggerAllowed,
  resolveUser,
  getUserWorkstreams,
  getGroupWorkstreams,
  resolveGroupMembers,
  computePermittedScope,
} from "./user-identity.js";

// Deprecated: addAllowlistEntry/removeAllowlistEntry are no longer needed.
// Per-chat modes now live in channel YAML configs.
export function addAllowlistEntry(chatJid: string, entry: unknown, pathOverride?: string): void {
  // No-op: per-chat modes moved to YAML
}

export function removeAllowlistEntry(chatJid: string, pathOverride?: string): void {
  // No-op: per-chat modes moved to YAML
}

// Deprecated: shouldDropMessage is no longer needed.
// Use getSenderPolicy() from channel-config.ts instead.
export function shouldDropMessage(): boolean {
  return false;
}
