# Post-cutover migration plan

The 1.x → 2.0.33 cutover landed on 2026-05-06. The main daemon, CLI, Signal,
Telegram, and primary Slack are working bidirectionally. This doc covers
everything still on the table.

**Run from**: `~/nanoclaw-merge` on jibotmac (the active 2.0 prod checkout).

**How to drive this with Claude Code**: `cd ~/nanoclaw-merge && claude`,
then paste:

> Read `_legacy/POST-CUTOVER-MIGRATION.md`. Walk me through each section in
> order. For each section, ask whether I want to do it, skip it, or come
> back later. Pause and confirm before any destructive moves (touching
> launchd, restarting daemons, modifying running services, force-pushing,
> writing to production DBs). Verify each section's acceptance criteria
> before moving on. When you're done or stuck, summarize what landed and
> what didn't.

## State as of 2026-05-06 (after cutover commit `3d31749`)

- 2.0 main daemon: `com.jibot.nanoclaw` running from `~/nanoclaw-merge`,
  data at `~/nanoclaw-merge/data/v2.db`.
- signal-cli: TCP JSON-RPC on `127.0.0.1:7583`, `--receive-mode on-start`.
- OneCLI cloud account active, key in `.env` as `ONECLI_API_KEY`.
- Colima docker daemon: MTU 1100. Persistent `nanoclaw` network exists.
- Container-runner pinned to the `nanoclaw` network (committed `3d31749`).
- Channels live: CLI, Signal `+817085315049`, Telegram `@joiitobot`,
  Slack primary workspace (bot `U0A82QC5464`).
- Channels deferred: Slack workspaces 2/3/4 (cit/gidc/joiito), LINE,
  Discord, WhatsApp.
- DB is fresh — schema-only migration. 1.x rows are NOT carried forward.
- Per-group memory: 9 groups migrated `CLAUDE.md` → `CLAUDE.local.md` at
  first boot (gidc-admin, gidc-general, 4× gidc-template-*, joiito-jibot,
  joiito-joi, main). `groups/global/` was removed.
- The auto-created cutover-test agent group is `dm-with-joi`
  (`ag-1778053157724-drungy`). Signal/Telegram/Slack are wired to it.
- 1.x prod backup artifacts (don't delete):
  - `/tmp/nanoclaw-pre-cutover-sha.txt` → `e0c70c7…`
  - `~/nanoclaw-prod-env-backup-20260506.bak`
  - `~/nanoclaw-prod-data-20260506-1249.tgz` (381 MB)
  - `~/Library/LaunchAgents/com.jibot.nanoclaw.plist.bak-pre-2.0`
  - `~/Library/LaunchAgents/com.jibot.signal-cli.plist.bak-pre-tcp`

---

## Section 1 — Decide what to do with the `joi-dm` agent group

**Question for the operator:** the cutover wired Signal/Telegram/Slack to
a fresh `dm-with-joi` agent group, not the historical `joi-dm` from 1.x.
Two paths:

- **A. Keep `dm-with-joi` (recommended unless you actively want the old
  history).** 1.x had been broken for ~17 hours before cutover anyway;
  conversation continuity is already discontinuous. The agent will rebuild
  memory in `dm-with-joi/CLAUDE.local.md` from this point forward.
- **B. Re-point the wirings to a recreated `joi-dm`.** Brings 1.x's
  `groups/joi-dm/` content (CLAUDE.local.md, conversations, skills) into
  the new daemon's purview. Steps below.

### If choosing B

1. Find 1.x `joi-dm` content. May be in `~/nanoclaw/groups/joi-dm/` or
   already extractable from `~/nanoclaw-prod-data-20260506-1249.tgz`.
   ```bash
   ls -la ~/nanoclaw/groups/joi-dm/ 2>/dev/null
   tar tzf ~/nanoclaw-prod-data-20260506-1249.tgz | grep joi-dm | head -20
   ```
2. Copy into the 2.0 groups tree (preserves attrs):
   ```bash
   cp -a ~/nanoclaw/groups/joi-dm ~/nanoclaw-merge/groups/joi-dm
   ```
3. Rename `CLAUDE.md` → `CLAUDE.local.md` if not already done:
   ```bash
   [ -f ~/nanoclaw-merge/groups/joi-dm/CLAUDE.md ] && \
     mv ~/nanoclaw-merge/groups/joi-dm/CLAUDE.md \
        ~/nanoclaw-merge/groups/joi-dm/CLAUDE.local.md
   ```
4. Insert the agent_group row + re-point wirings in DB:
   ```sql
   -- in sqlite3 ~/nanoclaw-merge/data/v2.db
   INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
     VALUES ('ag-joi-dm', 'jibot', 'joi-dm', 'amplifier-remote', datetime('now'));
   UPDATE messaging_group_agents
     SET agent_group_id = 'ag-joi-dm'
     WHERE agent_group_id = 'ag-1778053157724-drungy';
   -- (then drop the empty dm-with-joi)
   DELETE FROM agent_groups WHERE id = 'ag-1778053157724-drungy';
   ```
5. Restart container path: kill any in-flight `nanoclaw-v2-dm-with-joi-*`
   containers (`docker rm -f`), then send a test message in any wired
   channel. The next spawn should build a `nanoclaw-v2-joi-dm-*` container
   and the agent should respond using `joi-dm/CLAUDE.local.md`.
6. Once verified, remove the orphaned `groups/dm-with-joi/` dir.

**Acceptance criteria:** Signal/Telegram/Slack messages get a reply that
references something the agent learned in 1.x history.

---

## Section 2 — Restore the other Slack workspaces (cit, gidc, joiito)

1.x ran four Slack bots concurrently. 2.0's `@chat-adapter/slack` is
one-bot-per-instance. Two paths:

- **A. Quick-and-rough**: when you need to triage in cit/gidc/joiito,
  swap `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`/`SLACK_SIGNING_SECRET` in `.env`
  to that workspace's tokens, restart daemon. Crude. No code changes.
- **B. Hand-roll multi-instance** (~2–3 hrs).

### If choosing B

1. Extend `src/channels/slack.ts` to register one channel adapter per
   workspace, namespaced by `SLACK_NAMESPACE`. Read `SLACK_2_*`,
   `SLACK_3_*`, `SLACK_4_*` env vars from `.env`. Each adapter registers
   under a distinct `channel_type`: `slack-cit`, `slack-gidc`,
   `slack-joiito`.
2. Make sure `compactSlackMentions` is parameterized by namespace so the
   identity index lookup uses the right workspace's user IDs (1.x had
   per-workspace identity indexes; check `_legacy/v1.2.49/` for shape).
3. Decide where in the router multi-channel-type Slack adapters live —
   `getChannelAdapter` keys on `channel_type`, so the natural shape is
   one entry per namespace.
4. Wire each workspace's first DM via `init-first-agent.ts` with the
   appropriate `--channel slack-cit` etc.
5. Restore `SLACK_2/3/4_*` env vars from
   `~/nanoclaw-prod-env-backup-20260506.bak`.

**Acceptance criteria:** sending a DM to the bot in each workspace
produces a `Inbound DM received adapter="slack-<namespace>"` log line and
auto-creates a messaging group.

**Tip:** before writing code, audit which workspaces you actually use
daily. Maybe only one of the three is worth the engineering time.

---

## Section 3 — LINE webhook tunnel

The LINE adapter listens on `127.0.0.1:10280/webhook` but LINE's servers
need a public URL to deliver inbound. Steps:

1. Install cloudflared:
   ```bash
   brew install cloudflared
   ```
2. Choose between an ad-hoc URL (regenerated every restart) or a named
   tunnel (stable, requires a domain you control via Cloudflare).
   - **Ad-hoc**: `cloudflared tunnel --url http://localhost:10280`
   - **Named tunnel**: follow Cloudflare's docs to authenticate, create a
     tunnel, point a hostname like `line.jibot.example` at
     `localhost:10280`, then run `cloudflared tunnel run <name>`.
3. Set up a launchd unit for cloudflared so it restarts on reboot. A
   reasonable label: `com.jibot.cloudflared-line`. Reference the existing
   `com.jibot.signal-cli.plist` for shape.
4. In LINE Developers Console → your channel → Messaging API:
   - Set **Webhook URL** to `https://<your-tunnel>/webhook`
   - Click **Verify** — should return 200.
   - Toggle **Use webhook** ON.
   - Optionally disable **Auto-reply messages** so only the agent replies.
5. Send a DM to the LINE bot. Watch for
   `Inbound DM received adapter="line"` in `/tmp/nanoclaw.stdout.log`.
6. Wire it via `init-first-agent.ts`:
   ```bash
   npx tsx scripts/init-first-agent.ts \
     --channel line \
     --user-id "line:<your-line-userid>" \
     --platform-id "line:user:<your-line-userid>" \
     --display-name "Joi" --agent-name "jibot" --role owner
   ```
   (You can find your LINE user ID by looking at the `Inbound DM received`
   log line for your test message.)

**Acceptance criteria:** sending a DM to the LINE bot gets a welcome
reply from jibot.

---

## Section 4 — Discord

Two prereqs Discord doesn't share with 1.x:
- `DISCORD_PUBLIC_KEY` (signature verification for interactions)
- `DISCORD_APPLICATION_ID`
- Public webhook URL (Discord posts here for slash commands and DMs)

Steps:

1. From https://discord.com/developers/applications/<app>/general copy
   the **Application ID** and the **Public Key**.
2. Add both to `~/nanoclaw-merge/.env`:
   ```
   DISCORD_PUBLIC_KEY=<paste>
   DISCORD_APPLICATION_ID=<paste>
   ```
3. Mirror to container env: `cp .env data/env/env`
4. Set up a second cloudflared tunnel (or reuse the LINE one with a
   different path) pointing at port `3000` (the unified webhook server).
5. In Discord Developer Portal → Interactions Endpoint URL: set to
   `https://<your-tunnel>/webhook/discord` and Save (Discord verifies on
   save — this WILL fail if anything is misconfigured).
6. Reload daemon: `launchctl kickstart -k gui/$(id -u)/com.jibot.nanoclaw`.
   The Discord adapter should now start without the `publicKey is
   required` error.
7. DM the bot, then wire via `init-first-agent.ts`:
   ```bash
   npx tsx scripts/init-first-agent.ts \
     --channel discord \
     --user-id "discord:<your-discord-userid>" \
     --platform-id "discord:@me:<your-channel-id>" \
     --display-name "Joi" --agent-name "jibot" --role owner
   ```

**Acceptance criteria:** sending a DM to the Discord bot gets a welcome
reply.

---

## Section 5 — WhatsApp via `/add-whatsapp` skill

1.x prod didn't have WhatsApp creds — there's no migration here, just a
fresh add. The repo ships `/add-whatsapp` for this:

1. Run from inside Claude Code in `~/nanoclaw-merge`:
   ```
   /add-whatsapp
   ```
2. The skill walks through QR-code pairing or pairing-code authentication
   via Baileys, writes `WHATSAPP_PHONE_NUMBER` to `.env`, and persists
   session state in `data/whatsapp/`.
3. Restart daemon, watch for `Channel adapter started channel="whatsapp"`.
4. Wire via `init-first-agent.ts`:
   ```bash
   npx tsx scripts/init-first-agent.ts \
     --channel whatsapp \
     --user-id "whatsapp:<your-jid>" \
     --platform-id "whatsapp:<your-jid>" \
     --display-name "Joi" --agent-name "jibot" --role owner
   ```

**Acceptance criteria:** WhatsApp DM to the bot lands in the daemon log
and gets a reply.

---

## Section 6 — Audit auxiliary launchd units

These were not part of the cutover. They still point at `~/nanoclaw`.
Some may already be inert against 2.0. Verify each:

```bash
launchctl list | grep -E "(nanoclaw|jibot)"
```

For each unit, check:
- Is the script it runs still present in `~/nanoclaw/`?
- Does it write to a path 2.0 reads, or vice versa?
- Are there errors in its stderr log since cutover?

| Unit | Where it points | Is it useful in 2.0? |
|---|---|---|
| `com.nanoclaw.iblai-router` | `~/nanoclaw/router/server.cjs` | Probably yes — it's an external HTTP router, channel-agnostic. Smoke-test by hitting whatever it serves. |
| `com.nanoclaw.telegram-relay` | `~/nanoclaw/scripts/telegram-relay/relay.py` | 2.0 has its own Telegram adapter — likely redundant. Confirm what 1.x relay did, then either retire or keep. |
| `com.nanoclaw.qmd-reindex` | `~/nanoclaw/scripts/qmd-fleet.py` | QMD/MCP indexing job. 2.0 may or may not consume the index. Audit. |
| `com.nanoclaw.learned-facts` | `~/nanoclaw/scripts/extract-learned-facts.py` | 1.x feature. 2.0 has different per-group memory shape (`CLAUDE.local.md`). Probably retire after one final extraction run. |
| `com.jibot.nanoclaw-watchdog` | watchdog over `com.jibot.nanoclaw` | Should still work. Verify it can detect 2.0 daemon up/down. |
| `com.jibot.reap-signal-zombies` | signal-cli zombie reaper | Still useful (signal-cli on TCP can still leak processes). |

For anything you decide to retire: `launchctl unload <plist>` + move
plist to `~/Library/LaunchAgents/disabled/` (don't delete — the script
they wrap may still be useful as a manual tool).

---

## Section 7 — Fix `yaml` dep so `/update` skill engine works

The 2.0.33 upstream merge dropped `yaml` from `package.json`, but local
`skills-engine/` still imports it. 18 test files in
`skills-engine/__tests__/` fail to load, and `/update` (the
upstream-merger skill) doesn't run.

Fix:
```bash
cd ~/nanoclaw-merge
npm install --save-dev yaml@^2
npm test  # should now show ~571 passing instead of 398
```

Commit the result.

---

## Section 8 — Selectively bring 1.x data forward

The data tar (`~/nanoclaw-prod-data-20260506-1249.tgz`) has 1.x's full
state. 2.0 doesn't read it. Specific things you might want to extract:

- **`data/nanoclaw.db`** — sender allowlist, per-chat config, learned
  facts. To see what's in there:
  ```bash
  mkdir /tmp/nanoclaw-1x-extract && \
    tar xzf ~/nanoclaw-prod-data-20260506-1249.tgz -C /tmp/nanoclaw-1x-extract
  sqlite3 /tmp/nanoclaw-1x-extract/data/nanoclaw.db ".tables"
  ```
  For each table, decide if it's worth porting. Most won't matter — the
  new approval flow is fine for go-forward. The exception is anything
  with hand-curated state (e.g. allowlists for shared groups).

- **`data/messages.db`** / **`data/chats.db`** — message history. 2.0
  doesn't have a unified history table; per-session histories live in
  `data/v2-sessions/<session>/inbound.db`/`outbound.db`. There's no clean
  import path. Keep the tar for archeology.

- **Per-group `CLAUDE.md` content** — already migrated by the daemon at
  first boot. Skip.

---

## Section 9 — Commit the operational state changes

The plist edits, OneCLI account, Colima MTU, and `nanoclaw` docker
network aren't in git. They're operational state. Capture them in
`_legacy/CUTOVER.md` (or here) so the next person can replay:

```bash
# In ~/nanoclaw-merge/_legacy/CUTOVER.md add a "Post-cutover state" section noting:
# - Colima docker daemon MTU: 1100 (in /etc/docker/daemon.json inside the lima VM)
# - Persistent docker network: nanoclaw (mtu 1100) — `docker network create --opt com.docker.network.driver.mtu=1100 nanoclaw`
# - launchd plist additions: TMPDIR=/Users/jibot/nanoclaw-merge/data/tmp
# - signal-cli plist: --tcp 127.0.0.1:7583, --receive-mode on-start
# - OneCLI account: app.onecli.sh (joi@ito.com), key lives in .env
```

---

## Rollback (still available)

The 1.x snapshot is intact. To revert:

```bash
launchctl unload ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
cp ~/Library/LaunchAgents/com.jibot.nanoclaw.plist.bak-pre-2.0 \
   ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
cp ~/Library/LaunchAgents/com.jibot.signal-cli.plist.bak-pre-tcp \
   ~/Library/LaunchAgents/com.jibot.signal-cli.plist
launchctl unload ~/Library/LaunchAgents/com.jibot.signal-cli.plist
launchctl load   ~/Library/LaunchAgents/com.jibot.signal-cli.plist
cd ~/nanoclaw && npm rebuild better-sqlite3   # crucial — 1.x was broken without this
launchctl load   ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
```

The 2.0 daemon's data dir (`~/nanoclaw-merge/data/`) survives the
rollback intact, so re-cutover later is just re-pointing the plist.
