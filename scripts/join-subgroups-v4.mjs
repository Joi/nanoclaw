/**
 * Join community sub-groups using the correct WhatsApp protocol:
 * subscribe within sub_groups IQ sent to the community JID.
 */
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

const SUB_GROUP_IDS = [
  '120363423489158859', // Intros
  '120363423586241469', // #ai-oss
  '120363404884359195', // Off-topic
  '120363405031435395', // Presentation AGI
  '120363422375530994', // futures and scenarios AGI
  '120363422365802165', // Marketing and Content AGI
  '120363403558923320', // Applied Business AGI
  '120363406306168518', // Personal Agents
  '120363399876069532', // The vibez
  '120363407846248426', // audio intelligence
  '120363422956052150', // Security
  '120363407141776161', // Personal workflows
  '120363406725972088', // Decentralized AI
  '120363425349759884', // Show and Tell
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
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

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
  setTimeout(() => { console.log('\n[GLOBAL TIMEOUT]'); sock.end(undefined); process.exit(0); }, 120000);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('Connected\n');
      try {
        await delay(3000);

        // Check current memberships
        const allGroups = await sock.groupFetchAllParticipating();
        const memberJids = new Set(Object.keys(allGroups));
        const toJoin = SUB_GROUP_IDS.filter(id => !memberJids.has(`${id}@g.us`));
        console.log(`In ${memberJids.size} groups. Need to join ${toJoin.length} sub-groups.\n`);

        // Method A: Batch subscribe via sub_groups IQ
        console.log('=== Method A: Batch sub_groups subscribe ===');
        try {
          const result = await withTimeout(sock.query({
            tag: 'iq',
            attrs: { type: 'set', xmlns: 'w:g2', to: COMMUNITY_JID },
            content: [{
              tag: 'sub_groups',
              attrs: {},
              content: [{
                tag: 'subscribe',
                attrs: {},
                content: toJoin.map(id => ({ tag: 'group', attrs: { id } })),
              }],
            }],
          }), 15000);
          console.log('Result:', JSON.stringify(result, null, 2));
        } catch (e) {
          console.log(`Failed: ${e.message}`);
        }

        await delay(2000);

        // Method B: Try individual subscribe per sub-group (different IQ format)
        const stillNeeded = toJoin.filter(id => {
          // Re-check after batch attempt
          return true; // Can't re-check easily, try all
        });

        if (stillNeeded.length > 0) {
          console.log('\n=== Method B: Individual sub_groups subscribe ===');
          for (const id of stillNeeded.slice(0, 3)) { // Try first 3 only
            process.stdout.write(`  ${id}... `);
            try {
              const r = await withTimeout(sock.query({
                tag: 'iq',
                attrs: { type: 'set', xmlns: 'w:g2', to: COMMUNITY_JID },
                content: [{
                  tag: 'sub_groups',
                  attrs: {},
                  content: [{
                    tag: 'subscribe',
                    attrs: {},
                    content: [{ tag: 'group', attrs: { id } }],
                  }],
                }],
              }), 10000);
              console.log(JSON.stringify(r?.attrs || r));
            } catch (e) {
              console.log(e.message);
            }
            await delay(2000);
          }
        }

        // Method C: Try "join" tag instead of "subscribe"
        console.log('\n=== Method C: sub_groups join ===');
        try {
          const r = await withTimeout(sock.query({
            tag: 'iq',
            attrs: { type: 'set', xmlns: 'w:g2', to: COMMUNITY_JID },
            content: [{
              tag: 'sub_groups',
              attrs: {},
              content: [{
                tag: 'join',
                attrs: {},
                content: toJoin.slice(0, 3).map(id => ({ tag: 'group', attrs: { id } })),
              }],
            }],
          }), 15000);
          console.log('Result:', JSON.stringify(r, null, 2));
        } catch (e) {
          console.log(`Failed: ${e.message}`);
        }

        // Method D: Direct add self as participant to each sub-group
        console.log('\n=== Method D: groupParticipantsUpdate (add self) ===');
        const myJid = sock.user?.id;
        console.log(`My JID: ${myJid}`);
        if (myJid) {
          for (const id of toJoin.slice(0, 2)) {
            const jid = `${id}@g.us`;
            process.stdout.write(`  ${id}... `);
            try {
              const r = await withTimeout(
                sock.groupParticipantsUpdate(jid, [myJid], 'add'),
                10000
              );
              console.log(JSON.stringify(r));
            } catch (e) {
              console.log(e.message);
            }
            await delay(2000);
          }
        }

        // Final check
        await delay(3000);
        const finalGroups = await sock.groupFetchAllParticipating();
        const finalCommunity = Object.entries(finalGroups)
          .filter(([_, m]) => m.linkedParent === COMMUNITY_JID);
        console.log(`\n--- Final: ${finalCommunity.length} AGI sub-groups ---`);
        for (const [jid, meta] of finalCommunity) console.log(`  ${meta.subject}`);

      } catch (err) {
        console.error('Error:', err.message);
      }
      setTimeout(() => { sock.end(undefined); process.exit(0); }, 2000);
    }

    if (connection === 'close') {
      process.exit(1);
    }
  });
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
