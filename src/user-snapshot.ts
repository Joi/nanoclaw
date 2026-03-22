/**
 * Users snapshot module for NanoClaw containers.
 * Builds and writes a JSON snapshot of current GIDC users to the IPC directory
 * so agents can read the current user list without an IPC round-trip.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface UserSnapshotEntry {
  slackUserId: string;
  jid: string;
  name: string;
  tier: 'owner' | 'assistant' | 'staff';
  addedAt: string;
  remindersAccess: boolean;
  calendarAccess: boolean;
}

export interface UsersSnapshot {
  namespace: string;
  generatedAt: string;
  users: UserSnapshotEntry[];
}

/**
 * Infer user tier from the group folder name.
 * Returns 'owner', 'assistant', or 'staff' based on folder string.
 */
export function inferTier(
  group: RegisteredGroup,
): 'owner' | 'assistant' | 'staff' {
  if (group.folder.includes('owner')) return 'owner';
  if (group.folder.includes('assistant')) return 'assistant';
  return 'staff';
}

/**
 * Build a snapshot of current users for a given namespace.
 * Filters registered groups by `slack:{namespace}:` prefix,
 * skips channel JIDs (those containing ':channel:'),
 * and extracts the slackUserId from the JID suffix.
 */
export function buildUsersSnapshot(
  registeredGroups: Record<string, RegisteredGroup>,
  namespace: string,
): UsersSnapshot {
  const prefix = `slack:${namespace}:`;
  const users: UserSnapshotEntry[] = [];

  for (const [jid, group] of Object.entries(registeredGroups)) {
    // Filter by namespace prefix
    if (!jid.startsWith(prefix)) continue;
    // Skip channel JIDs
    if (jid.includes(':channel:')) continue;

    // Extract slackUserId from JID suffix (after the namespace prefix)
    const slackUserId = jid.slice(prefix.length);

    users.push({
      slackUserId,
      jid,
      name: group.name,
      tier: inferTier(group),
      addedAt: group.added_at,
      remindersAccess: !!group.remindersAccess,
      calendarAccess: !!group.calendarAccess,
    });
  }

  return {
    namespace,
    generatedAt: new Date().toISOString(),
    users,
  };
}

/**
 * Write users snapshot JSON for a group's IPC directory.
 * The container can read this to get the current user list without an IPC round-trip.
 */
export function writeUsersSnapshot(
  groupFolder: string,
  registeredGroups: Record<string, RegisteredGroup>,
  namespace: string,
  dataDir: string = DATA_DIR,
): void {
  const ipcDir = path.join(dataDir, 'ipc', groupFolder);
  fs.mkdirSync(ipcDir, { recursive: true });

  const snapshot = buildUsersSnapshot(registeredGroups, namespace);
  const snapshotPath = path.join(ipcDir, 'users_snapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  logger.info(
    { groupFolder, namespace, userCount: snapshot.users.length },
    '[user-snapshot] wrote users snapshot',
  );
}
