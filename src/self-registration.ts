/**
 * Self-Registration System for NanoClaw
 *
 * Detects registration intent, parses claimed names, looks up
 * the identity index, and creates claim YAML files.
 */
import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { logger } from './logger.js';

export interface IdentityEntry {
  name: string;
  tier: string;
  domains: string[];
}

export interface RegistrationContext {
  senderJid: string;
  displayName: string;
  claimedName: string | null;
  platformEmail: string | null;
  matchedIdentity: IdentityEntry | null;
  channel: string;
  workspace: string;
}

export interface ClaimData {
  platform: string;
  workspace: string;
  user_id: string;
  display_name: string;
  claimed_identity: string | null;
  matched_people_file: string | null;
  platform_email: string | null;
  conversation_log: string;
  channel: string;
}

// Patterns that indicate registration intent
const REGISTRATION_PATTERNS = [
  /\badd\s+me\b/i,
  /\bregister\s+me\b/i,
  /\bi['\u2019]m\s+\w/i,
  /\bi\s+am\s+\w/i,
];

/**
 * Check if a message expresses registration intent.
 */
export function isRegistrationIntent(text: string): boolean {
  const cleaned = text.replace(/@\w+\s*/g, '').trim();
  return REGISTRATION_PATTERNS.some((pattern) => pattern.test(cleaned));
}

/**
 * Extract a claimed name from "I'm [Name]" or "I am [Name]" patterns.
 * Returns null if no name claim is found.
 */
export function parseClaimedName(text: string): string | null {
  const cleaned = text.replace(/@\w+\s*/g, '').trim();
  const match = cleaned.match(/i['\u2019]m\s+(.+)/i) || cleaned.match(/i\s+am\s+(.+)/i);
  if (!match) return null;
  return match[1].replace(/\s+/g, ' ').trim() || null;
}

/**
 * Look up a JID or email key in the identity index.
 * Returns the matched identity entry, or null if not found.
 */
export function lookupIdentity(
  key: string,
  indexPath: string,
): IdentityEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    logger.warn({ indexPath }, 'self-registration: cannot read identity index');
    return null;
  }

  let index: Record<string, IdentityEntry>;
  try {
    index = JSON.parse(raw);
  } catch {
    logger.warn({ indexPath }, 'self-registration: invalid JSON in identity index');
    return null;
  }

  return index[key] ?? null;
}

/**
 * Write a claim YAML file to the claims directory.
 * Returns the full path to the created file.
 */
export function writeClaimFile(claim: ClaimData, claimsDir: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `${dateStr}-${claim.platform}-${claim.workspace}-${claim.user_id}.yaml`;
  const filePath = path.join(claimsDir, filename);

  const doc = {
    platform: claim.platform,
    workspace: claim.workspace,
    user_id: claim.user_id,
    display_name: claim.display_name,
    claimed_identity: claim.claimed_identity,
    matched_people_file: claim.matched_people_file,
    platform_email: claim.platform_email,
    conversation_log: claim.conversation_log,
    status: 'pending_review',
    created: now.toISOString(),
    channel: claim.channel,
  };

  fs.mkdirSync(claimsDir, { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(doc));

  logger.info({ filePath, userId: claim.user_id }, 'self-registration: claim file created');
  return filePath;
}
