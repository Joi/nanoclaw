#!/usr/bin/env node
/**
 * audit-access.mjs — Phase 3 drift audit for NanoClaw access control
 *
 * Compares sender-allowlist.json workstream membership against:
 *   - Actual Slack channel membership (via Slack API)
 *   - Drive folder permissions (STUB — not yet configured)
 *
 * Exit codes:
 *   0 — no drift found
 *   1 — drift found
 *   2 — fatal error (missing token, file not found, etc.)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

// ─── Config ─────────────────────────────────────────────────────────────────

const BOT_USER_ID   = 'U0ANFTA9FFT'; // jibot's own Slack UID — excluded from comparisons
const SLACK_NS      = 'gidc';         // workspace namespace for SLACK_3_BOT_TOKEN

const ALLOWLIST_PATH = path.join(os.homedir(), '.config/nanoclaw/sender-allowlist.json');
const AUDIT_DIR      = path.join(os.homedir(), 'nanoclaw/audit');
const ENV_PATH       = path.join(os.homedir(), 'nanoclaw/.env');

// ─── .env loader ────────────────────────────────────────────────────────────

function loadEnv(envPath) {
  const env = {};
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

// ─── Slack API helpers ───────────────────────────────────────────────────────

async function slackGet(token, method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error (${method}): ${data.error}`);
  return data;
}

/** Returns all member UIDs for a channel, paginating automatically. */
async function getChannelMembers(token, channelId) {
  const members = [];
  let cursor = '';
  do {
    const params = { channel: channelId, limit: 200 };
    if (cursor) params.cursor = cursor;
    const data = await slackGet(token, 'conversations.members', params);
    members.push(...data.members);
    cursor = data.response_metadata?.next_cursor ?? '';
  } while (cursor);
  return members;
}

// ─── JID parsers ─────────────────────────────────────────────────────────────

/**
 * Extracts a Slack user UID from a gidc-namespace JID.
 * e.g.  "slack:gidc:U0ACGPDA50Q"  →  "U0ACGPDA50Q"
 *       "slack:gidc:channel:C123"  →  null  (channel JID, skip)
 *       "sig:+819048411965"        →  null  (not a Slack JID)
 */
function extractGidcUid(jid) {
  const prefix = `slack:${SLACK_NS}:`;
  if (!jid.startsWith(prefix)) return null;
  const rest = jid.slice(prefix.length);
  return rest.includes(':') ? null : rest; // reject channel JIDs
}

/**
 * Extracts a Slack channel ID from a channel JID.
 * e.g.  "slack:sankosh:channel:C0AMDUXLXCG"  →  "C0AMDUXLXCG"
 */
function extractChannelId(channelJid) {
  const parts = channelJid.split(':');
  return parts.length >= 4 && parts[2] === 'channel' ? parts[3] : null;
}

// ─── Date helper ─────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const today = todayStr();

  console.log(`Access Audit — ${today}`);
  console.log('=============================');

  // Load secrets
  const env   = loadEnv(ENV_PATH);
  const token = env['SLACK_3_BOT_TOKEN'];
  if (!token) {
    console.error('ERROR: SLACK_3_BOT_TOKEN not found in .env');
    process.exit(2);
  }

  // Load allowlist
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  const { users, workstreams } = allowlist;

  // Ensure audit directory exists
  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const report = {
    date: today,
    workstreams_checked: 0,
    drift_found: false,
    checks: {},
    summary: '',
  };

  let totalDrift = 0;

  for (const [wsName, wsDef] of Object.entries(workstreams)) {
    const channelJids = (wsDef.slack_channels || []).filter(Boolean);
    const hasDrive    = !!wsDef.drive_folder_id;

    // Only audit workstreams that have Slack channels configured
    if (channelJids.length === 0) continue;

    report.workstreams_checked++;
    console.log(`\nWorkstream: ${wsName}`);

    // Build expected member set for this workstream:
    // all users whose `workstreams` array includes wsName, mapped to their gidc Slack UID.
    const expectedUsers = Object.entries(users)
      .filter(([, u]) => (u.workstreams || []).includes(wsName))
      .map(([username, u]) => ({
        username,
        slackUid: (u.jids || []).map(extractGidcUid).find(uid => uid !== null) ?? null,
      }));

    const expectedUidSet = new Set(
      expectedUsers.filter(u => u.slackUid).map(u => u.slackUid)
    );

    let wsOverPermissioned  = [];
    let wsUnderPermissioned = [];
    let wsSlackOk           = true;
    let firstChannelId      = null;

    for (const channelJid of channelJids) {
      const channelId = extractChannelId(channelJid);
      if (!channelId) {
        console.log(`  WARNING: could not parse channel JID: ${channelJid}`);
        continue;
      }
      if (!firstChannelId) firstChannelId = channelId;

      // Fetch actual Slack channel members, excluding the bot itself
      let actualMembers;
      try {
        const raw = await getChannelMembers(token, channelId);
        actualMembers = raw.filter(uid => uid !== BOT_USER_ID);
      } catch (err) {
        console.log(`  Slack channel ${channelId}: ERROR — ${err.message}`);
        wsSlackOk = false;
        continue;
      }

      const actualUidSet = new Set(actualMembers);

      // Over-permissioned: in allowlist for this workstream but NOT in Slack channel
      const overPermissioned = expectedUsers
        .filter(u => u.slackUid && !actualUidSet.has(u.slackUid))
        .map(u => ({ user: u.username, reason: 'in allowlist but not in Slack channel' }));

      // Under-permissioned: in Slack channel but NOT mapped to any allowlist workstream member
      const underPermissioned = actualMembers
        .filter(uid => !expectedUidSet.has(uid))
        .map(uid => ({ slack_uid: uid, reason: 'in Slack channel but not in allowlist' }));

      const driftCount = overPermissioned.length + underPermissioned.length;
      totalDrift += driftCount;
      if (driftCount > 0) wsSlackOk = false;

      wsOverPermissioned.push(...overPermissioned);
      wsUnderPermissioned.push(...underPermissioned);

      // Print channel result
      if (driftCount === 0) {
        console.log(`  Slack channel ${channelId}: OK (${actualMembers.length} members match)`);
      } else {
        console.log(`  Slack channel ${channelId}: DRIFT`);
        for (const o of overPermissioned) {
          console.log(`    Over-permissioned: ${o.user} (in allowlist but not in Slack)`);
        }
        for (const u of underPermissioned) {
          console.log(`    Under-permissioned: ${u.slack_uid} (in Slack but not in allowlist)`);
        }
      }
    }

    // Drive stub
    if (hasDrive) {
      console.log(`  Drive folder: check not configured`);
    }

    report.checks[wsName] = {
      slack_channel:     firstChannelId,
      slack_ok:          wsSlackOk,
      drive_ok:          null,
      over_permissioned:  wsOverPermissioned,
      under_permissioned: wsUnderPermissioned,
      drive_status:      hasDrive ? 'not_configured' : null,
    };
  }

  // Finalise report
  report.drift_found = totalDrift > 0;

  const summaryMsg = totalDrift === 0
    ? 'No drift found.'
    : `${totalDrift} drift issue${totalDrift !== 1 ? 's' : ''} found.`;

  report.summary = summaryMsg;

  // Write JSON report (overwrites same-day report — idempotent)
  const reportPath = path.join(AUDIT_DIR, `access-audit-${today}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log(`\nSummary: ${summaryMsg}`);
  console.log(`Report written to: ${reportPath}`);

  // Alert owner via NanoClaw IPC when drift is found
  if (report.drift_found) {
    try {
      const alertText =
        `Access Audit Alert: ${totalDrift} drift issue${totalDrift !== 1 ? 's' : ''} found on ${today}. ` +
        `See ~/nanoclaw/audit/access-audit-${today}.json`;
      const result = spawnSync(
        'python3',
        [path.join(os.homedir(), 'nanoclaw/scripts/send-message.py'), 'send', 'joi', alertText],
        { encoding: 'utf8', timeout: 15000 },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr?.trim() || 'send-message.py exited non-zero');
      console.log('DM alert sent to Joi via NanoClaw IPC.');
    } catch (alertErr) {
      console.error(`WARNING: Failed to send DM alert: ${alertErr.message}`);
      // Don't fail the audit itself due to alert failure
    }
  }

  process.exit(totalDrift > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
