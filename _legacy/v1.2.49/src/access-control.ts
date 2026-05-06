/**
 * DM access control for NanoClaw.
 * Determines whether a sender is allowed to have direct conversations
 * based on their identity in identity-index.json.
 */

import fs from 'fs';

import { logger } from './logger.js';

export const GUEST_REDIRECT_MESSAGE =
  'I can only have direct conversations with registered members. An admin can get you set up, or you can say "@jibot add me" in a channel.';

export interface DmAccessResult {
  allowed: boolean;
  tier?: string;
  name?: string;
  domains?: string[];
  redirectMessage?: string;
}

interface IdentityEntry {
  tier: string;
  name?: string;
  domains?: string[];
}

/**
 * Returns true if the JID represents a direct message (no ':channel:' segment).
 */
export function isDmJid(jid: string): boolean {
  // Discord: DMs use dc:dm:userId; server channels use dc:guildId:channelId (no ':channel:' either)
  if (jid.startsWith('dc:')) return jid.includes(':dm:');
  // Signal: groups are sig:group:<base64>=, DMs are sig:<phone-or-uuid>
  // (per src/channels/signal.ts:672 -- the canonical NanoClaw discriminator)
  if (jid.startsWith('sig:')) return !jid.startsWith('sig:group:');
  // WhatsApp / Slack: DMs lack ':channel:'
  return !jid.includes(':channel:');
}

/**
 * Check whether a sender is allowed to DM the bot.
 * Reads identity-index.json from the given path.
 * Staff, admin, and owner tiers are allowed; all others are blocked.
 */
export function checkDmAccess(
  senderJid: string,
  indexPath: string,
): DmAccessResult {
  const ALLOWED_TIERS = new Set(['staff', 'admin', 'owner']);

  let index: Record<string, IdentityEntry> = {};
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    index = JSON.parse(raw) as Record<string, IdentityEntry>;
  } catch {
    logger.warn(
      { indexPath },
      '[access-control] could not read identity-index.json',
    );
    return { allowed: false, redirectMessage: GUEST_REDIRECT_MESSAGE };
  }

  const entry = index[senderJid];
  if (!entry || !ALLOWED_TIERS.has(entry.tier)) {
    return { allowed: false, redirectMessage: GUEST_REDIRECT_MESSAGE };
  }

  return {
    allowed: true,
    tier: entry.tier,
    name: entry.name,
    domains: entry.domains,
  };
}
