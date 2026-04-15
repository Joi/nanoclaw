/**
 * Join a WhatsApp group (or community + sub-groups) via invite code.
 * Uses the running NanoClaw auth state. Will briefly disconnect NanoClaw
 * (it auto-reconnects).
 *
 * Usage: node join-group.mjs <invite-code>
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

const inviteCode = process.argv[2];
if (!inviteCode) {
  console.error('Usage: node join-group.mjs <invite-code>');
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

async function main() {
  console.log(`Auth dir: ${AUTH_DIR}`);
  console.log(`Invite code: ${inviteCode}`);

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
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 30000);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        clearTimeout(timeout);
        console.log('\n--- Connected to WhatsApp ---\n');

        try {
          // Step 1: Get invite info first
          console.log('Fetching group info for invite code...');
          let inviteInfo;
          try {
            inviteInfo = await sock.groupGetInviteInfo(inviteCode);
            console.log(`Group: ${inviteInfo.subject}`);
            console.log(`Description: ${inviteInfo.desc || '(none)'}`);
            console.log(`Size: ${inviteInfo.size} members`);
            console.log(`JID: ${inviteInfo.id}`);
            console.log(`Is community: ${inviteInfo.isCommunity || false}`);
            console.log(`Is community announce: ${inviteInfo.isCommunityAnnounce || false}`);
            console.log('');
          } catch (err) {
            console.log(`Could not fetch invite info (may already be a member): ${err.message}`);
          }

          // Step 2: Accept the invite
          console.log('Accepting invite...');
          let groupJid;
          try {
            groupJid = await sock.groupAcceptInvite(inviteCode);
            console.log(`Joined group: ${groupJid}`);
          } catch (err) {
            if (err.message?.includes('already') || err.data === 409) {
              console.log('Already a member of this group.');
              groupJid = inviteInfo?.id;
            } else {
              throw err;
            }
          }

          // Step 3: If it's a community, fetch and join sub-groups
          if (groupJid || inviteInfo?.id) {
            const communityJid = groupJid || inviteInfo.id;
            console.log(`\nChecking for community sub-groups in ${communityJid}...`);

            try {
              // Try to get community metadata which includes sub-groups
              const metadata = await sock.groupMetadata(communityJid);
              console.log(`Group metadata: ${metadata.subject}, participants: ${metadata.participants?.length}`);

              if (metadata.linkedParent) {
                console.log(`This group has a linked parent: ${metadata.linkedParent}`);
              }

              // Try to fetch groups that are part of this community
              // In Baileys, communities expose sub-groups via groupFetchAllParticipating
              // or via the community announcement group metadata
              const allGroups = await sock.groupFetchAllParticipating();
              const communityGroups = [];

              for (const [jid, meta] of Object.entries(allGroups)) {
                if (meta.linkedParent === communityJid) {
                  communityGroups.push({ jid, subject: meta.subject });
                }
              }

              if (communityGroups.length > 0) {
                console.log(`\nFound ${communityGroups.length} community sub-groups:`);
                for (const g of communityGroups) {
                  console.log(`  - ${g.subject} (${g.jid})`);
                }
                console.log('\nNote: You are automatically added to community sub-groups.');
              } else {
                console.log('No community sub-groups found (or not a community).');

                // Try an alternative: check if there are sub-groups via community metadata
                try {
                  if (typeof sock.getCommunityMetadata === 'function') {
                    const communityMeta = await sock.getCommunityMetadata(communityJid);
                    console.log('Community metadata:', JSON.stringify(communityMeta, null, 2));
                  }
                } catch (e) {
                  // Not available in this Baileys version
                }
              }
            } catch (err) {
              console.log(`Could not fetch community sub-groups: ${err.message}`);
            }
          }

          console.log('\n--- Done ---');
        } catch (err) {
          console.error('Error:', err.message || err);
        }

        // Disconnect after a brief delay
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
          reject(new Error('Logged out - need to re-authenticate'));
        }
        // For other disconnects, just exit
        process.exit(1);
      }
    });
  });
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
