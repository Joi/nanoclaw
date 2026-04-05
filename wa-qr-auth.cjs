const { makeWASocket, Browsers, DisconnectReason, makeCacheableSignalKeyStore, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");

const logger = pino({ level: "warn" });
let attempt = 0;

async function connect() {
  attempt++;
  const { state, saveCreds } = await useMultiFileAuthState("./store/auth");

  if (state.creds.registered) {
    console.log("ALREADY_AUTHENTICATED");
    process.exit(0);
  }

  console.log(`[attempt ${attempt}] Connecting (QR mode)...`);
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS("Chrome"),
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      fs.writeFileSync("./store/qr-data.txt", qr);
      console.log("QR_READY (saved to store/qr-data.txt)");
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
