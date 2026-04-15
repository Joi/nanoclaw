/**
 * Join community sub-groups by fetching each one's invite code,
 * then using groupAcceptInvite (the same reliable method that joined
 * the main AGI group).
 *
 * Global 55s timeout. Per-group 10s timeout.
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

const SUB_GROUPS = [
  { id: '120363423489158859', name: 'Intros' },
  { id: '120363423586241469', name: '#ai-oss' },
  { id: '120363404884359195', name: 'Off-topic' },
  { id: '120363405031435395', name: 'Presentation AGI' },
  { id: '120363422375530994', name: 'futures and scenarios AGI' },
  { id: '120363422365802165', name: 'Marketing and Content AGI' },
  { id: '120363403558923320', name: 'Applied Business AGI' },
  { id: '120363406306168518', name: 'Personal Agents' },
  { id: '120363399876069532', name: 'The vibez' },
  { id: '120363407846248426', name: 'audio intelligence' },
  { id: '120363422956052150', name: 'Security' },
  { id: '120363407141776161', name: 'Personal workflows' },
  { id: '120363406725972088', name: 'Decentralized AI' },
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

  // Global timeout
  setTimeout(() => { console.log('\n[GLOBAL TIMEOUT]'); sock.end(undefined); process.exit(0); }, 55000);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('Connected\n');

      try {
        await delay(2000);

        const allGroups = await sock.groupFetchAllParticipating();
        const memberJids = new Set(Object.keys(allGroups));
        const alreadyIn = SUB_GROUPS.filter(g => memberJids.has(`${g.id}@g.us`));
        const toJoin = SUB_GROUPS.filter(g => !memberJids.has(`${g.id}@g.us`));

        console.log(`Already member of: ${alreadyIn.map(g => g.name).join(', ') || 'none'}`);
        console.log(`Need to join: ${toJoin.length} groups\n`);

        let joined = 0, failed = 0;

        for (const sg of toJoin) {
          const jid = `${sg.id}@g.us`;
          process.stdout.write(`${sg.name}... `);

          // Try Method A: get invite code, then accept it
          try {
            const code = await withTimeout(sock.groupInviteCode(jid), 8000);
            if (code) {
              await withTimeout(sock.groupAcceptInvite(code), 8000);
              console.log('OK (invite)');
              joined++;
              await delay(2000);
              continue;
            }
          } catch (e) {
            // not admin, can't get invite code - try next method
          }

          // Try Method B: community accept IQ (single group)
          try {
            await withTimeout(
              sock.query({
                tag: 'iq',
                attrs: { type: 'set', xmlns: 'w:g2', to: COMMUNITY_JID },
                content: [{ tag: 'accept', attrs: {}, content: [{ tag: 'group', attrs: { id: sg.id } }] }],
              }),
              8000,
            );
            console.log('OK (community)');
            joined++;
            await delay(2000);
            continue;
          } catch (e) {
            // try next
          }

          // Try Method C: groupAcceptInviteV4 (community context)
          try {
            await withTimeout(
              sock.groupAcceptInviteV4(sock.user.id, jid, COMMUNITY_JID),
              8000,
            );
            console.log('OK (v4)');
            joined++;
            await delay(2000);
            continue;
          } catch (e) {
            // last resort failed
          }

          console.log('FAILED');
          failed++;
        }

        console.log(`\n--- Results ---`);
        console.log(`Already in: ${alreadyIn.length}`);
        console.log(`Joined: ${joined}`);
        console.log(`Failed: ${failed}`);

        // Final membership check
        await delay(2000);
        const final = await sock.groupFetchAllParticipating();
        const finalCommunity = Object.entries(final).filter(([_, m]) => m.linkedParent === COMMUNITY_JID);
        console.log(`\nTotal AGI community groups now: ${finalCommunity.length}`);
        for (const [jid, meta] of finalCommunity) {
          console.log(`  - ${meta.subject}`);
        }

      } catch (err) {
        console.error('Error:', err.message);
      }

      setTimeout(() => { sock.end(undefined); process.exit(0); }, 2000);
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) console.error('Logged out');
      process.exit(1);
    }
  });
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
