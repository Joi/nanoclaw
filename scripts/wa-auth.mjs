// One-shot WhatsApp auth via Baileys — terminal QR.
// Run from repo root: node scripts/wa-auth.mjs
// Stores creds in store/auth/ (relative to cwd).
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { pino } from 'pino';
import fs from 'fs';

// Don't wipe existing creds — if a previous pairing partially succeeded,
// store/auth/creds.json holds the registration state and we want to resume
// the handshake rather than make the user re-scan. To force fresh pairing,
// delete store/auth/ manually before running.
fs.mkdirSync('store/auth', { recursive: true });

const log = pino({ level: 'silent' });
const { state, saveCreds } = await useMultiFileAuthState('store/auth');
const { version } = await fetchLatestWaWebVersion({});

let lastQR = null;

function connect() {
  const sock = makeWASocket({
    auth: state,
    logger: log,
    browser: Browsers.macOS('Desktop'),
    version,
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.qr && u.qr !== lastQR) {
      lastQR = u.qr;
      console.log('\n--- WhatsApp → Settings → Linked Devices → Link a Device → scan ---');
      QRCode.toString(u.qr, { type: 'terminal', small: true }, (e, s) => {
        if (s) console.log(s);
      });
    }
    if (u.connection === 'open') {
      console.log('\n✓ WhatsApp authenticated. Creds saved to store/auth/');
      process.exit(0);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('✗ Logged out — re-run');
        process.exit(1);
      }
      if (code === 515) {
        // Pairing OK but stream errored before registration finished.
        // Baileys' documented recovery: drop the socket and reconnect with
        // the same auth state.
        console.log('… handshake reconnect');
        sock.end(undefined);
        connect();
        return;
      }
      // Other transient close — try once more.
      console.log(`… connection closed (code=${code}), retrying`);
      sock.end(undefined);
      setTimeout(connect, 1000);
    }
  });
}

connect();
