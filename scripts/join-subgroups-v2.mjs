/**
 * Join community sub-groups using batch accept IQ.
 * Sends a single request with all sub-group IDs at once.
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
  '120363425349759884', // Show and Tell (already joined)
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
  '120363425483919054', // AGI (default, already joined)
  '120363422956052150', // Security
  '120363407141776161', // Personal workflows
  '120363406725972088', // Decentralized AI
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

  const done = () => { setTimeout(() => { sock.end(undefined); process.exit(0); }, 2000); };

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('Connected\n');

      try {
        await delay(3000);

        // Check current memberships
        const allGroups = await sock.groupFetchAllParticipating();
        const memberJids = new Set(Object.keys(allGroups));
        console.log(`Currently in ${memberJids.size} groups`);

        // Filter to only sub-groups we need to join
        const toJoin = SUB_GROUP_IDS.filter(id => !memberJids.has(`${id}@g.us`));
        console.log(`Need to join: ${toJoin.length} sub-groups\n`);

        if (toJoin.length === 0) {
          console.log('Already in all sub-groups!');
          done();
          return;
        }

        // Try batch accept - all groups in one IQ
        console.log('Sending batch accept request...');
        try {
          const result = await sock.query({
            tag: 'iq',
            attrs: {
              type: 'set',
              xmlns: 'w:g2',
              to: COMMUNITY_JID,
            },
            content: [{
              tag: 'accept',
              attrs: {},
              content: toJoin.map(id => ({
                tag: 'group',
                attrs: { id },
              })),
            }],
          });
          console.log('Batch accept result:', JSON.stringify(result, null, 2));
        } catch (e) {
          console.log(`Batch accept error: ${e.message}`);
          console.log('Trying individual joins...\n');

          // Fall back to individual joins with timeout per attempt
          for (const id of toJoin) {
            const jid = `${id}@g.us`;
            console.log(`Joining ${id}...`);
            try {
              const result = await Promise.race([
                sock.query({
                  tag: 'iq',
                  attrs: { type: 'set', xmlns: 'w:g2', to: COMMUNITY_JID },
                  content: [{ tag: 'accept', attrs: {}, content: [{ tag: 'group', attrs: { id } }] }],
                }),
                delay(8000).then(() => { throw new Error('timeout'); }),
              ]);
              console.log(`  -> OK`);
            } catch (e) {
              console.log(`  -> ${e.message}`);
            }
            await delay(1000);
          }
        }

        // Verify by re-checking memberships
        await delay(2000);
        const updatedGroups = await sock.groupFetchAllParticipating();
        console.log(`\nNow in ${Object.keys(updatedGroups).length} groups`);

        const communityGroups = [];
        for (const [jid, meta] of Object.entries(updatedGroups)) {
          if (meta.linkedParent === COMMUNITY_JID) {
            communityGroups.push(meta.subject);
          }
        }
        console.log(`AGI community sub-groups: ${communityGroups.length}`);
        for (const name of communityGroups) console.log(`  - ${name}`);

      } catch (err) {
        console.error('Error:', err.message);
      }

      done();
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.error('Logged out');
      }
      process.exit(1);
    }
  });

  // Global timeout
  setTimeout(() => { console.log('\nGlobal timeout reached'); sock.end(undefined); process.exit(0); }, 60000);
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
