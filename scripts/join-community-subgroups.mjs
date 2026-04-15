/**
 * Discover and join all sub-groups of a WhatsApp community.
 * Temporarily stops NanoClaw's WA connection (it auto-reconnects).
 *
 * Usage: node join-community-subgroups.mjs <community-jid>
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

const communityJid = process.argv[2];
if (!communityJid) {
  console.error('Usage: node join-community-subgroups.mjs <community-jid>');
  process.exit(1);
}

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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Auth dir: ${AUTH_DIR}`);
  console.log(`Community JID: ${communityJid}`);

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
        console.log('\n--- Connected to WhatsApp ---\n');

        try {
          // Wait for initial sync to complete
          console.log('Waiting for initial sync (5s)...');
          await delay(5000);

          // Get all groups we're in
          console.log('Fetching all participating groups...');
          const allGroups = await sock.groupFetchAllParticipating();
          console.log(`Total groups: ${Object.keys(allGroups).length}\n`);

          // Find community sub-groups
          const subGroups = [];
          const memberOf = new Set();
          for (const [jid, meta] of Object.entries(allGroups)) {
            memberOf.add(jid);
            if (meta.linkedParent === communityJid) {
              subGroups.push({ jid, subject: meta.subject, size: meta.size });
            }
          }

          console.log(`Community sub-groups found: ${subGroups.length}`);
          for (const g of subGroups) {
            console.log(`  [MEMBER] ${g.subject} (${g.jid}, ${g.size} members)`);
          }

          // Now try to get community metadata to find ALL sub-groups (including ones we're not in)
          console.log('\nFetching community metadata...');
          try {
            const communityMeta = await sock.groupMetadata(communityJid);
            console.log(`Community: ${communityMeta.subject}`);
            console.log(`Participants: ${communityMeta.participants?.length}`);
            
            // Check if there's a subGroupJidList or similar
            if (communityMeta.subGroupJids) {
              console.log(`\nSub-group JIDs from metadata: ${communityMeta.subGroupJids.length}`);
              for (const subJid of communityMeta.subGroupJids) {
                const isMember = memberOf.has(subJid);
                const name = allGroups[subJid]?.subject || '(unknown)';
                console.log(`  ${isMember ? '[MEMBER]' : '[NOT IN]'} ${name} (${subJid})`);
                
                if (!isMember) {
                  console.log(`    -> Joining ${subJid}...`);
                  try {
                    await sock.groupAcceptInviteV4(communityJid, subJid);
                    console.log(`    -> Joined!`);
                  } catch (e1) {
                    // Try alternative join method
                    try {
                      // For community sub-groups, you can subscribe
                      await sock.groupSubscribe(subJid);
                      console.log(`    -> Subscribed!`);
                    } catch (e2) {
                      console.log(`    -> Could not join: ${e1.message}`);
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.log(`Could not get community metadata: ${err.message}`);
          }

          // Alternative: Try getGroupMetadata on the community announcement group
          console.log('\nTrying to list newsletter/community channels...');
          try {
            // Baileys v6+ has getNewsletterList or similar
            if (typeof sock.getNewsletterList === 'function') {
              const newsletters = await sock.getNewsletterList();
              console.log(`Newsletters: ${JSON.stringify(newsletters)}`);
            }
          } catch (err) {
            // Not available
          }

          // Try the community metadata approach from Baileys v6
          try {
            console.log('\nQuerying community sub-groups via groupQuery...');
            const result = await sock.query({
              tag: 'iq',
              attrs: {
                type: 'get',
                xmlns: 'w:g2',
                to: communityJid,
              },
              content: [{ tag: 'sub_groups', attrs: {} }],
            });
            console.log('Community query result:', JSON.stringify(result, null, 2));
          } catch (err) {
            console.log(`Community query failed: ${err.message}`);
          }

          console.log('\n--- Done ---');
        } catch (err) {
          console.error('Error:', err.message || err);
        }

        // Disconnect
        setTimeout(() => {
          sock.end(undefined);
          process.exit(0);
        }, 2000);

        resolve();
      }

      if (connection === 'close') {
        clearTimeout(timeout);
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          reject(new Error('Logged out'));
        }
        process.exit(1);
      }
    });
  });
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
