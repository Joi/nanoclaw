#!/usr/bin/env tsx
/**
 * Populate identity-index.json with Slack user entries.
 *
 * Calls users.list for each configured workspace and adds/updates
 * slack:{workspace}:{userId} entries without deleting existing ones
 * (the index also contains 1600+ email-keyed entries that must be preserved).
 *
 * Usage:
 *   npx tsx scripts/populate-identity-index.ts
 *
 * Env vars (from NanoClaw .env):
 *   IDENTITY_INDEX_PATH   – override the identity-index.json path
 *   SLACK_4_BOT_TOKEN     – bot token for "joiito" workspace
 *   SLACK_3_BOT_TOKEN     – bot token for "gidc" workspace
 *   SLACK_2_BOT_TOKEN     – bot token for "cit" workspace
 */
import { WebClient } from '@slack/web-api';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IDENTITY_INDEX_PATH =
  process.env.IDENTITY_INDEX_PATH ||
  path.join(os.homedir(), 'switchboard', 'ops', 'jibot', 'identity-index.json');

interface WorkspaceConfig {
  workspace: string;
  tokenEnvVar: string;
}

const WORKSPACES: WorkspaceConfig[] = [
  { workspace: 'joiito', tokenEnvVar: 'SLACK_4_BOT_TOKEN' },
  { workspace: 'gidc',   tokenEnvVar: 'SLACK_3_BOT_TOKEN' },
  { workspace: 'cit',    tokenEnvVar: 'SLACK_2_BOT_TOKEN' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdentityEntry {
  name: string;
  tier: string;
  domains: string[];
  display_name: string;
  email: string;
}

type IdentityIndex = Record<string, IdentityEntry | unknown>;

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function loadIndex(filePath: string): IdentityIndex {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as IdentityIndex;
  } catch {
    console.warn(`Warning: Could not read identity index at ${filePath}. Starting fresh.`);
    return {};
  }
}

/** Write atomically: write to .tmp then rename */
function writeIndex(filePath: string, index: IdentityIndex): void {
  const tmpPath = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Workspace processing
// ---------------------------------------------------------------------------

interface WorkspaceResult {
  added: number;
  updated: number;
  skipped: number;
}

async function processWorkspace(
  ws: WorkspaceConfig,
  index: IdentityIndex,
): Promise<WorkspaceResult> {
  const token = process.env[ws.tokenEnvVar];
  if (!token) {
    console.warn(`  Warning: ${ws.tokenEnvVar} not set — skipping workspace "${ws.workspace}".`);
    return { added: 0, updated: 0, skipped: 0 };
  }

  const client = new WebClient(token);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let cursor: string | undefined;

  do {
    const response = await client.users.list({ cursor, limit: 200 });
    const members = response.members ?? [];

    for (const user of members) {
      // Skip bots, deleted users, and the built-in Slackbot
      if (user.is_bot || user.deleted || user.id === 'USLACKBOT') {
        skipped++;
        continue;
      }

      const key = `slack:${ws.workspace}:${user.id}`;
      const name =
        user.real_name ||
        user.profile?.display_name ||
        user.name ||
        user.id!;

      const entry: IdentityEntry = {
        name,
        tier: 'guest',
        domains: [],
        display_name: user.profile?.display_name ?? '',
        email: user.profile?.email ?? '',
      };

      if (key in index) {
        updated++;
      } else {
        added++;
      }
      index[key] = entry;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { added, updated, skipped };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Identity index: ${IDENTITY_INDEX_PATH}`);
  const index = loadIndex(IDENTITY_INDEX_PATH);
  const initialCount = Object.keys(index).length;

  let totalAdded = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const ws of WORKSPACES) {
    console.log(`\nProcessing workspace: ${ws.workspace} (token var: ${ws.tokenEnvVar})`);
    const { added, updated, skipped } = await processWorkspace(ws, index);
    console.log(`  Added: ${added}, Updated: ${updated}, Skipped: ${skipped} bots/deleted`);
    totalAdded += added;
    totalUpdated += updated;
    totalSkipped += skipped;
  }

  writeIndex(IDENTITY_INDEX_PATH, index);

  const finalCount = Object.keys(index).length;
  console.log('\nSummary:');
  console.log(
    `  Added ${totalAdded} new, updated ${totalUpdated} existing, skipped ${totalSkipped} bots/deleted.`,
  );
  console.log(`  Total: ${finalCount} entries (was ${initialCount}).`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
