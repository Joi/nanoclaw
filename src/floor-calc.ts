/**
 * Floor recalculation for NanoClaw access control.
 * Calculates the minimum access tier across all members of a group,
 * used to determine the "floor" permission level.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export type AccessTier =
  | 'owner'
  | 'admin'
  | 'staff'
  | 'guest'
  | 'blocked'
  | 'banned';

export interface FloorChangeEvent {
  timestamp: string;
  previousFloor: AccessTier;
  newFloor: AccessTier;
  reason?: string;
  [key: string]: unknown;
}

const TIER_RANK: Record<AccessTier, number> = {
  owner: 4,
  admin: 3,
  staff: 2,
  guest: 1,
  blocked: 1,
  banned: 0,
};

/**
 * Map a numeric rank back to a tier name.
 * 0 or 1 -> guest, 2 -> staff, 3 -> admin, 4 -> owner.
 */
function rankToTier(rank: number): AccessTier {
  if (rank >= 4) return 'owner';
  if (rank >= 3) return 'admin';
  if (rank >= 2) return 'staff';
  return 'guest';
}

/**
 * Calculate the floor access tier for a group.
 * Returns the minimum tier across all members.
 * Empty member set returns 'guest'.
 */
export function calculateFloor(
  members: Record<string, { tier: AccessTier }>,
): AccessTier {
  const entries = Object.values(members);
  if (entries.length === 0) return 'guest';

  let minRank = Infinity;
  for (const member of entries) {
    const rank = TIER_RANK[member.tier] ?? 1;
    if (rank < minRank) minRank = rank;
  }

  return rankToTier(minRank);
}

/**
 * Append a floor change event to floor-changes.jsonl in the triage directory.
 */
export function logFloorChange(
  event: FloorChangeEvent,
  triageDir: string,
): void {
  const filePath = path.join(triageDir, 'floor-changes.jsonl');
  fs.mkdirSync(triageDir, { recursive: true });

  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');

  logger.info(
    {
      previousFloor: event.previousFloor,
      newFloor: event.newFloor,
      filePath,
    },
    '[floor-calc] logged floor change',
  );
}
