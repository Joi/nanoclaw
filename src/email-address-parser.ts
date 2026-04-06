/**
 * Email address parsing utilities for the NanoClaw email channel.
 * Handles jibot alias detection and sender email extraction.
 */

const JIBOT_LOCAL = 'jibot';
const JIBOT_DOMAIN = 'ito.com';
const KNOWN_ALIASES = new Set(['action', 'intake']);

export type EmailAlias = 'action' | 'intake' | 'plain' | 'unknown';

/**
 * Parse a jibot email address to determine the alias.
 * Returns null if the address is not a jibot address.
 *
 * Examples:
 *   jibot+action@ito.com → 'action'
 *   jibot+intake@ito.com → 'intake'
 *   jibot@ito.com         → 'plain'
 *   jibot+foo@ito.com     → 'unknown'
 *   alice@example.com     → null
 */
export function parseEmailAlias(address: string): EmailAlias | null {
  const lower = address.toLowerCase().trim();
  const match = lower.match(/^([^@+]+)(?:\+([^@]+))?@(.+)$/);
  if (!match) return null;

  const [, local, plus, domain] = match;
  if (local !== JIBOT_LOCAL || domain !== JIBOT_DOMAIN) return null;

  if (!plus) return 'plain';
  if (KNOWN_ALIASES.has(plus)) return plus as EmailAlias;
  return 'unknown';
}

/**
 * Extract a normalized email address from a From header value.
 * Handles "Name <email>" and bare "email" formats.
 * Always returns lowercase.
 */
export function extractSenderEmail(from: string): string {
  if (!from) return '';
  const match = from.match(/<([^>]+)>/);
  const email = match ? match[1] : from.trim();
  return email.toLowerCase();
}

/**
 * Check if an email address is any jibot address (with or without alias).
 */
export function isJibotAddress(address: string): boolean {
  return parseEmailAlias(address) !== null;
}
