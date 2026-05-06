/**
 * Email Policy Adapter for NanoClaw email channel.
 * Applies tier-based permissions to email-originated requests.
 * Wraps the same permission model used by other channels.
 */

import { logger } from './logger.js';
import { ActionSubtype, EmailIntent } from './email-intent-resolver.js';

const ALLOWED_TIERS = new Set(['owner', 'admin', 'staff']);

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a sender's tier permits the resolved intent and action subtype.
 *
 * Tier permissions:
 * - owner: full action/tool surface + scheduling + reminders + intake
 * - admin: jibot-native actions + approved scheduling/reminders + intake
 * - staff: jibot-native actions + approved scheduling/reminders + intake
 * - unknown/guest: blocked from everything
 */
export function checkEmailPolicy(
  tier: string,
  intent: EmailIntent,
  actionSubtype?: ActionSubtype,
): PolicyResult {
  if (!ALLOWED_TIERS.has(tier)) {
    logger.debug({ tier, intent, actionSubtype }, 'email-policy: blocked — tier not allowed');
    return {
      allowed: false,
      reason: `Sender tier "${tier}" does not have permission for email ${intent}`,
    };
  }

  // All allowed tiers can use intake
  if (intent === 'intake') {
    return { allowed: true };
  }

  // All allowed tiers can use clarify (it's just a reply asking for clarification)
  if (intent === 'clarify') {
    return { allowed: true };
  }

  // Action: all allowed tiers can use all v1 action subtypes
  // (owner gets full surface, admin/staff get jibot-native — but the
  //  distinction is enforced at execution time by the container runner,
  //  not here. This gate only checks tier vs intent.)
  return { allowed: true };
}
