const { makeWASocket, Browsers, DisconnectReason, makeCacheableSignalKeyStore, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");

const logger = pino({ level: "warn" });
const AUTH_DIR = "./store/auth";
const PHONE = "817085315049";
let pairingCodeSent = false;
let attempt = 0;

async function connect() {
  attempt++;
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  
  if (state.creds.registered) {
    console.log("ALREADY_AUTHENTICATED");
    process.exit(0);
  }

  console.log(`[attempt ${attempt}] Connecting...`);
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS("Chrome"),
  });

  if (!pairingCodeSent) {
    setTimeout(async () => {
      try {
        console.log("Requesting pairing code...");
        const code = await sock.requestPairingCode(PHONE);
        pairingCodeSent = true;
        console.log("========================================");
        console.log("  PAIRING CODE: " + code);
        console.log("========================================");
        console.log("Enter this in WhatsApp on the phone:");
        console.log("  Settings > Linked Devices > Link a Device");
        console.log("  > Link with phone number instead");
        console.log("Waiting for confirmation...");
      } catch (err) {
        console.error("Pairing code error:", err.message || err);
      }
    }, 4000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      console.log("\n=== AUTHENTICATED - WhatsApp linked! ===");
      fs.writeFileSync("./store/auth-status.txt", "authenticated");
      setTimeout(() => process.exit(0), 2000);
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`[attempt ${attempt}] Disconnected (reason=${reason})`);
      if (reason === 401) {
        console.log("Logged out - cannot continue");
        process.exit(1);
      }
      if (attempt < 20) {
        const delay = Math.min(2000 + (attempt * 1000), 8000);
        console.log(`Reconnecting in ${delay/1000}s...`);
        setTimeout(() => connect().catch(e => { console.error(e); process.exit(1); }), delay);
      } else {
        console.log("Max attempts reached");
        process.exit(1);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

connect().catch(e => { console.error(e); process.exit(1); });
setTimeout(() => { console.log("GLOBAL_TIMEOUT_3min"); process.exit(1); }, 180000);
