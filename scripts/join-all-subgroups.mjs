/**
 * Join all sub-groups of the AGI community.
 * We already have the sub-group list from the community query.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

const AUTH_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'store', 'auth');
const WA_VERSION_URL = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json';
const COMMUNITY_JID = '120363424488257353@g.us';

// All sub-groups from the community query
const SUB_GROUPS = [
  { id: '120363425349759884', subject: 'Show and Tell' },
  { id: '120363423489158859', subject: 'Intros <-- start here' },
  { id: '120363423586241469', subject: '#ai-oss' },
  { id: '120363404884359195', subject: 'Off-topic' },
  { id: '120363405031435395', subject: 'Presentation AGI' },
  { id: '120363422375530994', subject: 'futures and scenarios AGI' },
  { id: '120363422365802165', subject: 'Marketing and Content AGI' },
  { id: '120363403558923320', subject: 'Applied Business AGI' },
  { id: '120363406306168518', subject: 'Personal Agents' },
  { id: '120363399876069532', subject: 'The vibez (code code code)' },
  { id: '120363407846248426', subject: 'audio intelligence' },
  { id: '120363425483919054', subject: 'AGI (default)' },
  { id: '120363422956052150', subject: 'Security' },
  { id: '120363407141776161', subject: 'Personal workflows' },
  { id: '120363406725972088', subject: 'Decentralized AI' },
];

const logger = pino({ level: 'warn' });

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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = await fetchWaVersion();

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    ...(version && { version }),
  });

  sock.ev.on('creds.update', saveCreds);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 45000);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        clearTimeout(timeout);
        console.log('Connected to WhatsApp\n');

        try {
          await delay(3000);

          // Check which groups we're already in
          const allGroups = await sock.groupFetchAllParticipating();
          const memberOf = new Set(Object.keys(allGroups));
          console.log(`Currently in ${memberOf.size} groups\n`);

          let joined = 0, alreadyIn = 0, failed = 0;

          for (const sg of SUB_GROUPS) {
            const jid = `${sg.id}@g.us`;
            if (memberOf.has(jid)) {
              console.log(`[ALREADY IN] ${sg.subject}`);
              alreadyIn++;
              continue;
            }

            console.log(`[JOINING]    ${sg.subject} (${jid})...`);

            // Method 1: Try community sub-group join via IQ
            try {
              await sock.query({
                tag: 'iq',
                attrs: {
                  type: 'set',
                  xmlns: 'w:g2',
                  to: COMMUNITY_JID,
                },
                content: [{
                  tag: 'accept',
                  attrs: {},
                  content: [{
                    tag: 'group',
                    attrs: { id: sg.id },
                  }],
                }],
              });
              console.log(`             -> Joined via community accept!`);
              joined++;
              await delay(1500); // rate limit
              continue;
            } catch (e) {
              // Try next method
            }

            // Method 2: Try groupJoinApprovalRequest if available
            try {
              if (typeof sock.groupRequestParticipantsList === 'function') {
                await sock.groupJoin?.(jid);
                console.log(`             -> Joined via groupJoin!`);
                joined++;
                await delay(1500);
                continue;
              }
            } catch (e) {
              // Try next method
            }

            // Method 3: Try the subscribe approach
            try {
              await sock.query({
                tag: 'iq',
                attrs: {
                  type: 'set',
                  xmlns: 'w:g2',
                  to: jid,
                },
                content: [{
                  tag: 'subscribe',
                  attrs: {},
                }],
              });
              console.log(`             -> Subscribed!`);
              joined++;
              await delay(1500);
              continue;
            } catch (e) {
              console.log(`             -> Failed: ${e.message}`);
              failed++;
            }
          }

          console.log(`\n--- Summary ---`);
          console.log(`Already in: ${alreadyIn}`);
          console.log(`Joined: ${joined}`);
          console.log(`Failed: ${failed}`);

        } catch (err) {
          console.error('Error:', err.message);
        }

        setTimeout(() => {
          sock.end(undefined);
          process.exit(0);
        }, 2000);
        resolve();
      }

      if (connection === 'close') {
        clearTimeout(timeout);
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) reject(new Error('Logged out'));
        process.exit(1);
      }
    });
  });
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
