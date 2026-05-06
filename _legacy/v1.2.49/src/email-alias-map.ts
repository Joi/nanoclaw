/**
 * Email alias map — maps alternate email addresses to NanoClaw identities.
 * Loaded from ~/.config/nanoclaw/email-alias-map.json.
 *
 * Format:
 * {
 *   "alt-email@example.com": { "identity": "sig:+819048411965", "name": "Joi", "tier": "owner" },
 *   "work@company.com":      { "identity": "sig:+819048411965", "name": "Joi", "tier": "owner" }
 * }
 */

import fs from 'fs';

import { logger } from './logger.js';

export interface AliasEntry {
  identity: string;
  name: string;
  tier?: string;
}

/**
 * Load the email alias map from a JSON file.
 * Returns a Map keyed by lowercase email address.
 */
export function loadEmailAliasMap(filePath: string): Map<string, AliasEntry> {
  const map = new Map<string, AliasEntry>();

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ filePath }, 'email-alias-map: file not found, using empty map');
      return map;
    }
    logger.warn({ err, filePath }, 'email-alias-map: cannot read file');
    return map;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ filePath }, 'email-alias-map: invalid JSON');
    return map;
  }

  if (!parsed || typeof parsed !== 'object') return map;

  for (const [email, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = entry as Record<string, unknown>;
    if (e.identity && typeof e.identity === 'string' && e.name && typeof e.name === 'string') {
      map.set(email.toLowerCase(), {
        identity: e.identity as string,
        name: e.name as string,
        tier: typeof e.tier === 'string' ? e.tier : undefined,
      });
    } else {
      logger.warn({ email }, 'email-alias-map: skipping invalid entry');
    }
  }

  logger.info({ count: map.size, filePath }, 'email-alias-map: loaded');
  return map;
}

/**
 * Resolve an email address against the alias map.
 * Returns the alias entry or null if not found.
 * Case-insensitive.
 */
export function resolveEmailAlias(
  email: string,
  map: Map<string, AliasEntry>,
): AliasEntry | null {
  return map.get(email.toLowerCase()) ?? null;
}
