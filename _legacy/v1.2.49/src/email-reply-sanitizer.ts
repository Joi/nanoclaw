/**
 * Email Reply Recipient Sanitizer for NanoClaw email channel.
 * Computes safe reply recipients:
 *   recognized internal recipients + the original requester
 *   MINUS unknown/external recipients and jibot addresses.
 */

import { extractSenderEmail, isJibotAddress } from './email-address-parser.js';
import { logger } from './logger.js';

/**
 * Compute the sanitized list of reply recipients.
 *
 * @param requesterFrom - The original sender (From header value)
 * @param threadRecipients - All email addresses from To/Cc of the thread
 * @param knownEmails - Set of recognized internal email addresses (lowercase)
 * @returns Array of email addresses to reply to (lowercase, deduplicated)
 */
export function sanitizeReplyRecipients(
  requesterFrom: string,
  threadRecipients: string[],
  knownEmails: Set<string>,
): string[] {
  const requesterEmail = extractSenderEmail(requesterFrom);
  const seen = new Set<string>();
  const result: string[] = [];

  function add(email: string): void {
    const normalized = extractSenderEmail(email);
    if (!normalized) return;
    if (seen.has(normalized)) return;
    if (isJibotAddress(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  }

  // Always include the requester
  add(requesterEmail);

  // Add recognized internal recipients
  for (const recipient of threadRecipients) {
    const normalized = extractSenderEmail(recipient);
    if (knownEmails.has(normalized)) {
      add(recipient);
    }
  }

  logger.debug(
    { requesterEmail, totalThread: threadRecipients.length, sanitized: result.length },
    'email-reply: sanitized recipients',
  );

  return result;
}
