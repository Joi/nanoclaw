#!/usr/bin/env node
/**
 * Standalone Slack filesUploadV2 diagnostic — WebClient-direct edition.
 *
 * Tests `client.filesUploadV2({ channel_id, file: createReadStream, filename, initial_comment? })`
 * using @slack/web-api WebClient directly (no Bolt App, no socket-mode connect).
 *
 * Why WebClient and not Bolt App: in production NanoClaw, `this.app.client.filesUploadV2`
 * resolves to a WebClient instance — the App wrapper just provides socket-mode for
 * inbound events, which `filesUploadV2` (3 outbound Web-API calls) doesn't use.
 * Skipping socket-mode means this diagnostic does NOT need NanoClaw stopped — the
 * existing socket-mode connection in the running process is untouched.
 *
 * Heartbeat: a setInterval(1s) appends to a tmp log throughout the run. If the
 * heartbeat count matches wall-clock during the upload → event loop is alive;
 * the original "filesUploadV2 wedges the entire Node event loop" report can be
 * decisively explained as correlated log-flush silence, not a real block.
 *
 * Usage:
 *   node diagnostics/slack-file-upload.mjs \
 *     --channel C030BV6SM \
 *     --file ~/Downloads/test.pdf \
 *     [--comment "..."] \
 *     [--token-env SLACK_4_BOT_TOKEN]    # default: SLACK_BOT_TOKEN
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebClient } from '@slack/web-api';

// ---------- arg parsing ----------
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1];
}

const CHANNEL = arg('channel');
const FILE = arg('file');
const COMMENT = arg('comment');
const TOKEN_ENV = arg('token-env', 'SLACK_BOT_TOKEN');

if (!CHANNEL || !FILE) {
  console.error('Usage: node slack-file-upload.mjs --channel <C...> --file <path> [--comment "..."] [--token-env SLACK_4_BOT_TOKEN]');
  process.exit(2);
}

const FILE_PATH = path.resolve(FILE.replace(/^~/, os.homedir()));
if (!fs.existsSync(FILE_PATH)) {
  console.error(`File not found: ${FILE_PATH}`);
  process.exit(2);
}
const FILE_SIZE = fs.statSync(FILE_PATH).size;
const FILENAME = path.basename(FILE_PATH);

// ---------- timestamped logging ----------
const t0 = Date.now();
function elapsed() {
  return ((Date.now() - t0) / 1000).toFixed(2) + 's';
}
function step(msg, extra) {
  console.log(`[+${elapsed()}] ${msg}`, extra ?? '');
}

// ---------- env loading from ~/nanoclaw/.env ----------
const ENV_FILE = path.join(os.homedir(), 'nanoclaw/.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
  step(`Loaded env from ${ENV_FILE}`);
}

const TOKEN = process.env[TOKEN_ENV];

if (!TOKEN) {
  console.error(`${TOKEN_ENV} missing. Source ~/nanoclaw/.env first or pass --token-env <ENV_VAR>.`);
  process.exit(2);
}

// ---------- version banner ----------
const webApiPkg = JSON.parse(
  fs.readFileSync(path.resolve('node_modules/@slack/web-api/package.json'), 'utf-8'),
);
step(`@slack/web-api version: ${webApiPkg.version}`);
step(`Node version: ${process.version}`);
step(`File: ${FILENAME} (${FILE_SIZE} bytes)`);
step(`Channel: ${CHANNEL}`);
step(`Token env: ${TOKEN_ENV} (${TOKEN.slice(0, 12)}...)`);

// ---------- heartbeat: proves event loop is alive ----------
const HEARTBEAT_LOG = path.join(os.tmpdir(), `slack-diag-heartbeat-${process.pid}.log`);
let heartbeatCount = 0;
const heartbeat = setInterval(() => {
  heartbeatCount += 1;
  // append-only — synchronous write but to a tiny line; if THIS blocks for >1s the loop is wedged
  fs.appendFileSync(HEARTBEAT_LOG, `${new Date().toISOString()} hb=${heartbeatCount} elapsed=${elapsed()}\n`);
}, 1000);
heartbeat.unref();
step(`Heartbeat started; tail with: tail -f ${HEARTBEAT_LOG}`);

// ---------- main ----------
const HARD_TIMEOUT_MS = 180_000;
const overallTimer = setTimeout(() => {
  step(`HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s — script exiting`);
  step(`Heartbeats logged: ${heartbeatCount} (expect ~${HARD_TIMEOUT_MS / 1000})`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

(async () => {
  step('Constructing WebClient (no Bolt App, no socket-mode — does NOT conflict with running NanoClaw)...');
  const client = new WebClient(TOKEN);

  step(`Calling client.filesUploadV2 (heartbeat count at this point: ${heartbeatCount})...`);
  const uploadBegin = Date.now();
  const heartbeatAtStart = heartbeatCount;

  try {
    const result = await client.filesUploadV2({
      channel_id: CHANNEL,
      file: fs.createReadStream(FILE_PATH),
      filename: FILENAME,
      ...(COMMENT && { initial_comment: COMMENT }),
    });
    const wall = ((Date.now() - uploadBegin) / 1000).toFixed(2);
    const hbDelta = heartbeatCount - heartbeatAtStart;
    const expectedHb = Math.floor(parseFloat(wall));
    step(`filesUploadV2 RESOLVED in ${wall}s. ok=${result?.ok}`);
    step(`Heartbeats during upload: ${hbDelta} (expected ~${expectedHb})`);
    if (hbDelta < expectedHb - 2) {
      step(`!!! Heartbeat gap of ${expectedHb - hbDelta} — event loop WAS partially blocked`);
    } else {
      step(`Event loop NOT wedged — heartbeats matched wall time. The production "wedge" was correlated silence, not a real block.`);
    }
    step(`Files: ${JSON.stringify(result?.files?.[0]?.files?.[0]?.id ?? result?.files)}`);
  } catch (err) {
    const wall = ((Date.now() - uploadBegin) / 1000).toFixed(2);
    step(`filesUploadV2 FAILED after ${wall}s: ${err.message}`);
    step(`Heartbeats during upload: ${heartbeatCount - heartbeatAtStart}`);
    if (err.data) step(`Slack error data: ${JSON.stringify(err.data)}`);
  } finally {
    clearTimeout(overallTimer);
    clearInterval(heartbeat);
    step(`Done. Total wall: ${elapsed()}. Heartbeats total: ${heartbeatCount}`);
    step(`Heartbeat log: ${HEARTBEAT_LOG}`);
    process.exit(0);
  }
})().catch((err) => {
  step(`Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => { step('SIGINT'); process.exit(130); });
process.on('SIGTERM', () => { step('SIGTERM'); process.exit(143); });