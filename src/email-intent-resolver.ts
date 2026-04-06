/**
 * Email Intent Resolver for NanoClaw email channel.
 * Determines intent (action/intake/clarify) from alias and message content.
 * Also classifies action subtypes (general/calendar/reminder).
 */

import { logger } from './logger.js';
import { EmailAlias } from './email-address-parser.js';

export type EmailIntent = 'action' | 'intake' | 'clarify';
export type ActionSubtype = 'general' | 'calendar' | 'reminder';

export interface IntentResult {
  intent: EmailIntent;
  actionSubtype?: ActionSubtype;
  reason?: string;
  confidence: 'high' | 'medium' | 'low';
}

// Patterns for detecting action-oriented content
const ACTION_PATTERNS = [
  /\b(please|can you|could you|would you)\b.*\b(schedule|create|send|set up|book|arrange|organize)\b/i,
  /\bschedule\s+(a|the|this)\b/i,
  /\bremind\s+me\b/i,
  /\bcreate\s+(a|an|the)\s+(meeting|event|appointment|reminder)\b/i,
  /\bset\s+(a|an)\s+(reminder|meeting)\b/i,
  /\bbook\s+(a|an|the)\b/i,
];

// Patterns for detecting scheduling/calendar content
const CALENDAR_PATTERNS = [
  /\bschedule\b/i,
  /\b(meeting|event|appointment|call)\b.*\b(with|for|at|on)\b/i,
  /\b(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b/i,
  /\bcalendar\b/i,
  /\binvite\b/i,
  /\bbook\s+(a|an|the)\s+(meeting|call|room)\b/i,
];

// Patterns for detecting reminder content
const REMINDER_PATTERNS = [
  /\bremind\s+me\b/i,
  /\bset\s+(a\s+)?reminder\b/i,
  /\bdon'?t\s+(let\s+me\s+)?forget\b/i,
  /\bfollow\s+up\b.*\b(on|by|before)\b/i,
];

// Patterns that suggest content is informational/intake rather than action
const INTAKE_PATTERNS = [
  /\b(fyi|for your info|for your information|for reference|for the record)\b/i,
  /\b(attached|here is|here are|see below|notes from)\b/i,
  /\b(update on|status of|regarding)\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function hasActionSignals(text: string): boolean {
  return matchesAny(text, ACTION_PATTERNS);
}

function hasIntakeSignals(text: string): boolean {
  return matchesAny(text, INTAKE_PATTERNS);
}

function classifyActionSubtype(text: string): ActionSubtype {
  if (matchesAny(text, REMINDER_PATTERNS)) return 'reminder';
  if (matchesAny(text, CALENDAR_PATTERNS)) return 'calendar';
  return 'general';
}

/**
 * Resolve the email intent from alias, sender tier, and message body.
 *
 * Rules:
 * - +action → always action (subtype from content)
 * - +intake + non-action content → intake
 * - +intake + action-like content → clarify (do NOT silently upgrade)
 * - plain + clear action request → action (if confidence is high)
 * - plain + clear intake request → intake
 * - plain + ambiguous + owner → clarify (ask by email)
 * - plain + ambiguous + admin/staff → intake (downgrade)
 */
export function resolveEmailIntent(
  alias: EmailAlias | 'unknown',
  senderTier: string,
  bodyText: string,
): IntentResult {
  const text = bodyText.trim();

  // +action: always action
  if (alias === 'action') {
    const subtype = classifyActionSubtype(text);
    logger.debug({ alias, subtype }, 'email-intent: explicit action');
    return { intent: 'action', actionSubtype: subtype, confidence: 'high' };
  }

  // +intake: intake unless content looks action-oriented
  if (alias === 'intake') {
    if (hasActionSignals(text)) {
      logger.debug({ alias }, 'email-intent: intake with action content → clarify');
      return {
        intent: 'clarify',
        reason: 'Message was sent to +intake but contains action-like content. Did you mean to send this to +action?',
        confidence: 'medium',
      };
    }
    return { intent: 'intake', confidence: 'high' };
  }

  // Plain address: infer from content and tier
  const isActionLike = hasActionSignals(text);
  const isIntakeLike = hasIntakeSignals(text);

  // Clear action signal
  if (isActionLike && !isIntakeLike) {
    const subtype = classifyActionSubtype(text);
    logger.debug({ subtype, tier: senderTier }, 'email-intent: inferred action from plain address');
    return { intent: 'action', actionSubtype: subtype, confidence: 'medium' };
  }

  // Clear intake signal
  if (isIntakeLike && !isActionLike) {
    return { intent: 'intake', confidence: 'medium' };
  }

  // Ambiguous: tier-dependent
  if (senderTier === 'owner') {
    logger.debug('email-intent: ambiguous content from owner → clarify');
    return {
      intent: 'clarify',
      reason: 'Could not determine intent. Would you like me to act on this or capture it for reference?',
      confidence: 'low',
    };
  }

  // Admin/staff ambiguity → downgrade to intake
  logger.debug({ tier: senderTier }, 'email-intent: ambiguous content from non-owner → intake');
  return { intent: 'intake', confidence: 'low' };
}
