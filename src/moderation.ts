/**
 * Moderation enforcement for NanoClaw.
 * Checks sender tiers and logs blocked/banned activity.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export type ModerationActionType = 'allow' | 'block' | 'ban';

export interface ModerationAction {
  type: ModerationActionType;
  tier?: string;
}

export interface ModerationEvent {
  timestamp: string;
  senderJid: string;
  chatJid?: string;
  reason?: string;
  [key: string]: unknown;
}

interface IdentityEntry {
  tier: string;
  [key: string]: unknown;
}

/**
 * Check whether a sender should be allowed, blocked, or banned.
 * Reads identity-index.json from the given path.
 *
 * - unknown/guest/staff/admin/owner -> allow
 * - blocked -> block
 * - banned -> ban
 */
export function checkModeration(
  senderJid: string,
  indexPath: string,
): ModerationAction {
  let index: Record<string, IdentityEntry> = {};
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    index = JSON.parse(raw) as Record<string, IdentityEntry>;
  } catch {
    logger.warn(
      { indexPath },
      '[moderation] could not read identity-index.json',
    );
    return { type: 'allow' };
  }

  const entry = index[senderJid];
  if (!entry) {
    return { type: 'allow' };
  }

  if (entry.tier === 'banned') {
    return { type: 'ban', tier: 'banned' };
  }
  if (entry.tier === 'blocked') {
    return { type: 'block', tier: 'blocked' };
  }

  return { type: 'allow', tier: entry.tier };
}

/**
 * Append a moderation event to the appropriate JSONL log file.
 * - 'block' -> blocked-activity.jsonl
 * - 'ban' -> banned-activity.jsonl
 * - 'allow' -> no-op
 */
export function logModerationEvent(
  actionType: ModerationActionType,
  event: ModerationEvent,
  triageDir: string,
): void {
  if (actionType === 'allow') return;

  const filename =
    actionType === 'block'
      ? 'blocked-activity.jsonl'
      : 'banned-activity.jsonl';

  const filePath = path.join(triageDir, filename);
  fs.mkdirSync(triageDir, { recursive: true });

  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');

  logger.info(
    { actionType, senderJid: event.senderJid, filePath },
    '[moderation] logged moderation event',
  );
}
