const { makeWASocket, Browsers, DisconnectReason, makeCacheableSignalKeyStore, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const https = require("https");

const logger = pino({ level: "warn" });
let attempt = 0;

const WA_VERSION_URL = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json';

function fetchWaVersion() {
  return new Promise((resolve) => {
    https.get(WA_VERSION_URL, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).version); } catch { resolve(undefined); }
      });
    }).on('error', () => resolve(undefined));
  });
}

async function connect() {
  attempt++;
  const { state, saveCreds } = await useMultiFileAuthState("./store/auth");

  if (state.creds.registered) {
    console.log("ALREADY_AUTHENTICATED");
    process.exit(0);
  }

  // Fetch current WhatsApp Web version so the server doesn't reject us (405)
  const version = await fetchWaVersion();
  if (version) {
    console.log(`Using WA version: ${version.join('.')}`);
  }

  console.log(`[attempt ${attempt}] Connecting (QR mode)...`);
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: true,
    logger,
    browser: Browsers.macOS("Chrome"),
    ...(version && { version }),
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      fs.writeFileSync("./store/qr-data.txt", qr);
      console.log("\nScan the QR code above with jibot's WhatsApp > Linked Devices > Link a Device\n");
    }

    if (connection === "open") {
      console.log("=== AUTHENTICATED ===");
      fs.writeFileSync("./store/auth-status.txt", "authenticated");
      setTimeout(() => process.exit(0), 2000);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`Disconnected (reason=${reason})`);
      if (reason === 401) process.exit(1);
      if (attempt < 20) {
        setTimeout(() => connect().catch(e => { console.error(e); process.exit(1); }), 3000);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

connect().catch(e => { console.error(e); process.exit(1); });
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 300000);
