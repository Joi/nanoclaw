#!/usr/bin/env node
/**
 * Standalone Baileys documentMessage diagnostic.
 *
 * Tests `sock.sendMessage(jid, { document: ..., fileName, mimetype, caption })`
 * against the production auth state, with NanoClaw stopped, isolated from any
 * NanoClaw IPC / concurrency / deps glue. Mirrors NanoClaw's exact
 * `makeWASocket` config so we test "Baileys as NanoClaw uses it" — not vanilla.
 *
 * Read-only: copies ~/nanoclaw/store/auth/ to a temp dir before opening the
 * socket. Baileys `useMultiFileAuthState` writes creds back to the dir it was
 * given, so we never want to point it at production.
 *
 * Usage:
 *   node diagnostics/baileys-doc-send.mjs \
 *     --jid 120363426828757598@g.us \
 *     --file ~/Downloads/test.pdf \
 *     [--caption "..."] \
 *     [--no-query-timeout]   # set defaultQueryTimeoutMs: undefined
 *     [--buffer]             # use Buffer form instead of {url} form
 *
 * Pre-req: NanoClaw stopped on this machine.
 *   launchctl bootout gui/$(id -u)/com.jibot.nanoclaw
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import pino from 'pino';

import {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

// ---------- arg parsing ----------
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1];
}
function flag(name) {
  return args.includes(`--${name}`);
}

const JID = arg('jid');
const FILE = arg('file');
const CAPTION = arg('caption');
const USE_BUFFER = flag('buffer');
const NO_QUERY_TIMEOUT = flag('no-query-timeout');

if (!JID || !FILE) {
  console.error('Usage: node baileys-doc-send.mjs --jid <jid> --file <path> [--caption "..."] [--no-query-timeout] [--buffer]');
  process.exit(2);
}

const FILE_PATH = path.resolve(FILE.replace(/^~/, os.homedir()));
if (!fs.existsSync(FILE_PATH)) {
  console.error(`File not found: ${FILE_PATH}`);
  process.exit(2);
}
const FILE_SIZE = fs.statSync(FILE_PATH).size;
const FILENAME = path.basename(FILE_PATH);
const MIME = FILENAME.toLowerCase().endsWith('.pdf')
  ? 'application/pdf'
  : 'application/octet-stream';

// ---------- logger with timestamps ----------
const logger = pino({
  level: process.env.PINO_LEVEL || 'debug',
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});

const t0 = Date.now();
function elapsed() {
  return ((Date.now() - t0) / 1000).toFixed(2) + 's';
}
function step(msg, extra) {
  console.log(`[+${elapsed()}] ${msg}`, extra ?? '');
}

// ---------- version banner ----------
const baileysPkg = JSON.parse(
  fs.readFileSync(
    path.resolve('node_modules/@whiskeysockets/baileys/package.json'),
    'utf-8',
  ),
);
step(`Baileys version: ${baileysPkg.version}`);
step(`Node version: ${process.version}`);
step(`File: ${FILENAME} (${FILE_SIZE} bytes, ${MIME})`);
step(`JID: ${JID}`);
step(`Form: ${USE_BUFFER ? 'Buffer' : '{url}'} | defaultQueryTimeoutMs: ${NO_QUERY_TIMEOUT ? 'undefined' : '60_000 (default)'}`);

// ---------- copy auth state to temp dir (read-only against production) ----------
const PROD_AUTH = path.join(os.homedir(), 'nanoclaw/store/auth');
if (!fs.existsSync(PROD_AUTH)) {
  console.error(`Auth dir missing: ${PROD_AUTH}`);
  console.error(`This script is meant to run on jibotmac where NanoClaw lives.`);
  process.exit(2);
}
const TMP_AUTH = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-diag-auth-'));
execFileSync('cp', ['-R', PROD_AUTH + '/.', TMP_AUTH]);
step(`Auth state copied: ${PROD_AUTH} -> ${TMP_AUTH}`);

// ---------- fetch current WA Web version (mirrors src/whatsapp-auth.ts) ----------
function fetchWaVersion() {
  const url = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json';
  return new Promise((resolve) => {
    https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).version); } catch { resolve(undefined); }
      });
    }).on('error', () => resolve(undefined));
  });
}

// ---------- main ----------
const HARD_TIMEOUT_MS = 150_000;        // overall script timeout
const SEND_TIMEOUT_MS = 90_000;         // sendMessage timeout

const overallTimer = setTimeout(() => {
  step(`HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s — script exiting`);
  cleanup();
  process.exit(1);
}, HARD_TIMEOUT_MS);

function cleanup() {
  try { fs.rmSync(TMP_AUTH, { recursive: true, force: true }); } catch {}
}

(async () => {
  step('Loading auth state...');
  const { state, saveCreds } = await useMultiFileAuthState(TMP_AUTH);
  step(`Auth loaded. registered=${!!state.creds.registered} me=${state.creds.me?.id ?? '<none>'} lid=${state.creds.me?.lid ?? '<none>'}`);

  // NOTE: NanoClaw connects successfully even with registered=false (137 successful
  // "WhatsApp channel connected" log lines in production). The registered flag is
  // a Baileys 6.x initial-pairing-handshake marker; once `me.id` is set and signal
  // session files exist (309 files in store/auth/), the account is functional.
  // We rely on connection.update to detect QR-needed vs successful-connect.
  if (!state.creds.me?.id) {
    step('No me.id in auth state — never paired. Re-pair via /setup first.');
    cleanup();
    process.exit(1);
  }

  step('Fetching current WA Web version...');
  const version = await fetchWaVersion();
  step(`WA version: ${version ? version.join('.') : '<fetch failed, will use Baileys default>'}`);

  step('Creating socket (mirrors src/channels/whatsapp.ts:80)...');
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    ...(version && { version }),
    ...(NO_QUERY_TIMEOUT && { defaultQueryTimeoutMs: undefined }),
  });

  let connectionOpen = false;
  let initQueriesTimedOut = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    step(`connection.update: ${JSON.stringify({ connection, qr: qr ? '<qr present>' : undefined, reason: lastDisconnect?.error?.output?.statusCode })}`);

    if (qr) {
      step('QR code requested — auth state is invalid. Aborting.');
      cleanup();
      process.exit(1);
    }

    if (connection === 'open') {
      connectionOpen = true;
      step('CONNECTION OPEN — proceeding to sendMessage in 2s (let init queries fire)...');
      setTimeout(attemptSend, 2000);
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        step('Logged out. Auth invalid.');
        cleanup();
        process.exit(1);
      }
      step(`Connection closed (reason=${reason}). Not auto-reconnecting in diagnostic.`);
    }
  });

  // Watch for "init queries Timed Out" log line via pino transport
  // (Baileys logs this through the logger we pass in, level 'error')
  const origError = logger.error.bind(logger);
  logger.error = function patchedError(...a) {
    const txt = JSON.stringify(a);
    if (txt.includes('init queries Timed Out')) {
      initQueriesTimedOut = true;
      step('!!! init queries Timed Out fired (matches generics.js:131 promiseTimeout)');
    }
    return origError(...a);
  };

  async function attemptSend() {
    if (!connectionOpen) {
      step('attemptSend called but connection not open. Aborting.');
      cleanup();
      process.exit(1);
    }

    let documentField;
    if (USE_BUFFER) {
      const buf = fs.readFileSync(FILE_PATH);  // sync — we want to know if THIS is the wedge
      documentField = buf;
      step(`Buffer form: loaded ${buf.length} bytes into memory`);
    } else {
      documentField = { url: FILE_PATH };
      step(`URL form: passing { url: "${FILE_PATH}" }`);
    }

    const sendStart = Date.now();
    step(`Calling sock.sendMessage(${JID}, { document })...`);

    const sendPromise = sock.sendMessage(JID, {
      document: documentField,
      fileName: FILENAME,
      mimetype: MIME,
      ...(CAPTION && { caption: CAPTION }),
    });

    const sendTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`sendMessage hung past ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS),
    );

    try {
      const result = await Promise.race([sendPromise, sendTimeout]);
      const wall = ((Date.now() - sendStart) / 1000).toFixed(2);
      step(`sendMessage RESOLVED in ${wall}s. messageID=${result?.key?.id ?? '<unknown>'}`);
      step(`SUCCESS — initQueriesTimedOut=${initQueriesTimedOut} during this run`);
      clearTimeout(overallTimer);
      cleanup();
      process.exit(0);
    } catch (err) {
      const wall = ((Date.now() - sendStart) / 1000).toFixed(2);
      step(`sendMessage FAILED after ${wall}s: ${err.message}`);
      step(`Diagnosis: initQueriesTimedOut=${initQueriesTimedOut}`);
      step('If initQueriesTimedOut=true AND send hung → H1-A confirmed. Re-pair or upgrade Baileys.');
      step('If initQueriesTimedOut=false AND send hung → look at media-upload + post-fetch IQ phase.');
      clearTimeout(overallTimer);
      cleanup();
      process.exit(1);
    }
  }
})().catch((err) => {
  step(`Fatal error: ${err.stack || err.message}`);
  cleanup();
  process.exit(1);
});

// ensure cleanup on Ctrl+C
process.on('SIGINT', () => { step('SIGINT'); cleanup(); process.exit(130); });
process.on('SIGTERM', () => { step('SIGTERM'); cleanup(); process.exit(143); });