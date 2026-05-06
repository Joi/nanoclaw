# Cutover runbook: NanoClaw 1.x → 2.0.33

How to flip jibotmac's production NanoClaw from the 1.x deployment in
`~/nanoclaw` to the 2.0 build on `chore/upstream-merge-2026-05`.
Written 2026-05-06 after Phase A of the upstream merge landed.

## Architecture changes that affect cutover

**Schema is fresh, not migrated.** 2.0 uses `data/v2.db` with a new schema
(messaging_groups, agent_groups, sessions, user_roles, …). The 1.x
`data/messages.db` / `nanoclaw.db` / `chats.db` files are not consumed.
Existing 1.x rows (per-chat config, sender allowlist, learned facts) do
not transfer automatically — channels register fresh, owners grant their
own access on first message, and any per-chat opt-ins (e.g. URL intake)
are reapplied via env vars (`INTAKE_ENABLED_PLATFORM_IDS`) or new admin
flows.

**Container layout is different.** 1.x ran the agent inside Docker via a
Node + tsc entrypoint. 2.0 runs it via Bun directly with a session-DB
poll loop. The image needs rebuilding (`./container/build.sh`) for the
hardening + setuid strip layers to land. Per-session state lives in
`<DATA_DIR>/v2-sessions/<session_id>/{inbound,outbound}.db`.

**signal-cli mode.** 1.x runs signal-cli in REST mode at
`http://127.0.0.1:8080`. 2.0 wants TCP JSON-RPC mode at `127.0.0.1:7583`.
Single-instance lock means stop-and-restart at cutover.

**Auxiliary services.** Other launchd units in production
(`com.nanoclaw.iblai-router`, `com.nanoclaw.telegram-relay`,
`com.nanoclaw.qmd-reindex`, `com.nanoclaw.learned-facts`,
`com.jibot.nanoclaw-watchdog`) live alongside the main daemon. They are
not part of this cutover; verify each still works against the 2.0 main
daemon, but expect them to be unaffected since the scripts they wrap
survived the merge intact.

## Pre-cutover validation (in the worktree, before touching production)

Run these in `~/nanoclaw-merge` on jibotmac. Every step must pass.

### 1. Build + test green

```bash
cd ~/nanoclaw-merge
git status                      # should be clean on chore/upstream-merge-2026-05
npm install                     # picks up @chat-adapter/* + Baileys + qrcode + pino
npm run build                   # tsc clean
npm test                        # 571 passing, 4 skipped, 1 file skipped
```

### 2. Container rebuild + AF_ALG smoke test

```bash
./container/build.sh
# image rebuild — verifies the setuid-strip RUN layer's `&& ! command -v su` assertion
docker images | grep nanoclaw-agent

./scripts/test-af-alg-block.sh
# expects: AF_ALG → EPERM, AF_INET → ok
```

### 3. Bun-side runner tests

The amplifier-remote provider's actual HTTP behavior, retry, and prompt
cap are exercised by 18 `bun:test` cases in
`container/agent-runner/src/providers/amplifier-remote.test.ts`. Run them
either inside the container or with bun installed on the host:

```bash
brew install bun     # if not present
cd container/agent-runner
bun install
bun test             # all 18 should pass
```

### 4. signal-cli daemon mode verification

Production signal-cli runs in REST mode (`SIGNAL_CLI_URL=http://127.0.0.1:8080`).
2.0 wants TCP JSON-RPC. Test the new mode without committing yet:

```bash
# Stop the REST daemon (verify it's running first)
launchctl list | grep signal-cli   # adjust unit name if needed
# Note where signal-cli was launched from so you can restore it

# Start in TCP mode in a separate terminal — leave it running
signal-cli -a +817085315049 daemon --tcp 127.0.0.1:7583

# In another shell, verify it's listening
nc -zv 127.0.0.1 7583
# Connection should succeed.

# Stop the TCP daemon (Ctrl-C the foreground shell). Don't leave it running
# alongside the REST daemon — signal-cli's data-dir lock is exclusive.
```

If the TCP daemon starts cleanly, the cutover-time switch will work. If it
fails (lock contention, missing config), fix before continuing.

## Cutover procedure

Do these steps in order. Each command is run on jibotmac.

### Step 1. Snapshot production state

In case rollback is needed:

```bash
# Tag the production checkout's current commit so we can return to it
cd ~/nanoclaw
git rev-parse HEAD > /tmp/nanoclaw-pre-cutover-sha.txt
cat /tmp/nanoclaw-pre-cutover-sha.txt

# Backup the running .env (production credentials)
cp ~/nanoclaw/.env ~/nanoclaw-prod-env-backup-$(date +%Y%m%d).bak
chmod 600 ~/nanoclaw-prod-env-backup-*.bak

# Snapshot the live data dir — small, fast, and irreplaceable if we lose it
tar czf ~/nanoclaw-prod-data-$(date +%Y%m%d-%H%M).tgz -C ~/nanoclaw data/
```

### Step 2. Stop the running NanoClaw daemon

```bash
# Main daemon — adjust the unit name to whatever's in launchctl list | grep nano
launchctl unload ~/Library/LaunchAgents/com.jibot.nanoclaw.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.jibot.nanoclaw-watchdog.plist 2>/dev/null || true

# Verify nothing's running
ps aux | grep -E "(nanoclaw|tsx.*src/index)" | grep -v grep
# Should be empty (or only the auxiliary scripts, not the main daemon).
```

Auxiliary services (`com.nanoclaw.iblai-router`, `com.nanoclaw.telegram-relay`,
etc.) can stay running — they don't share state with the main daemon's
session DBs, and stopping them adds risk. If any of them break against
2.0 once cutover is complete, restart them then.

### Step 3. Switch signal-cli to TCP mode

```bash
# Stop the existing REST mode daemon (whatever launchd unit owns it)
# launchctl unload ~/Library/LaunchAgents/<signal-cli-unit>.plist

# Start in TCP mode under launchd. Easiest: edit the existing plist's
# ProgramArguments to swap `--rest` for `--tcp 127.0.0.1:7583`, then
# launchctl load it again.
#
# If you previously verified TCP mode in pre-flight, just re-run the same
# launchd config that started the foreground daemon you tested.

# Verify
nc -zv 127.0.0.1 7583
```

### Step 4. Replace `~/nanoclaw` with the merge branch

The cleanest path is to point the launchd unit at `~/nanoclaw-merge`
directly. The alternative (rebase ~/nanoclaw onto the merge branch) is
fine too if you prefer that layout — pick one.

**Option A: Point launchd at the worktree (zero data move).**

Edit `~/Library/LaunchAgents/com.jibot.nanoclaw.plist`:
- `WorkingDirectory` → `/Users/jibot/nanoclaw-merge`
- `ProgramArguments` → adjust `tsx`/`node` invocation to match 2.0's entry
  point. 2.0 uses `npm start` (which runs `tsx src/index.ts`).
- `EnvironmentVariables` → set DATA_DIR to wherever production's data
  should live going forward (probably `/Users/jibot/nanoclaw/data/v2`
  to keep it co-located with the existing data tree, or
  `/Users/jibot/nanoclaw-merge/data` for full isolation).

**Option B: Move the worktree's HEAD into ~/nanoclaw.**

```bash
# Inside ~/nanoclaw, fast-forward main to the merge branch's HEAD
cd ~/nanoclaw
git fetch origin chore/upstream-merge-2026-05
git checkout main
git merge --ff-only origin/chore/upstream-merge-2026-05
# Or the merge can land via PR; this is the manual path.

# Re-install deps fresh (1.x deps are very different from 2.0)
rm -rf node_modules
npm install

# Build
npm run build
```

Option B keeps the `~/nanoclaw` path the existing launchd config and
auxiliary services already reference. Option A keeps the production
checkout untouched until you're confident. Pick A if you want a
reversible cutover.

### Step 5. Migrate `.env`

2.0's runtime needs a different env-var set than 1.x. Check what's in
production:

```bash
diff <(sort ~/nanoclaw/.env) <(sort ~/nanoclaw-merge/.env 2>/dev/null || true)
```

The vars you almost certainly need to ferry forward:

| 1.x env var | 2.0 status | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Same | container reads it |
| `SIGNAL_ACCOUNT` | Same | adapter still expects it |
| `SIGNAL_CLI_URL` | **Drop** — 2.0 uses TCP, not REST URL |
| (new) `SIGNAL_TCP_HOST` | Add (default 127.0.0.1) | only set if non-default |
| (new) `SIGNAL_TCP_PORT` | Add (default 7583) | only set if non-default |
| `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` | Same | bridge reads them |
| `TELEGRAM_BOT_TOKEN` | Same | bridge reads it |
| `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_CHANNEL_SECRET` | Same | adapter reads them |
| (new) `LINE_WEBHOOK_PORT` | Default 10280 | only set if you want a different port |
| `DISCORD_BOT_TOKEN` (+ public key + app ID) | Same | bridge reads them |
| `EMAIL_*`, `GOG_KEYRING_PASSWORD` | **Drop** — Tier 3 not ported |
| `AGENT_API_PORT`, `AGENT_API_TOKEN` | **Drop** — agent-api Tier 5 deferred |
| (new) `INTAKE_ENABLED_PLATFORM_IDS` | Add to enable URL auto-intake | e.g. `sig:user:+817085315049` |
| (new) `INTAKE_API_KEY` | Already in `~/.config/amplifierd/credentials.env` | no change |
| `MAX_CONCURRENT_CONTAINERS`, `IDLE_TIMEOUT`, `TZ`, `ASSISTANT_NAME` | Same | core runtime tunables |
| `SIGNAL_ONLY`, `SIGNAL_DEFAULT_TIER` | **Drop** — 2.0 has channel-by-channel registration |
| `MAIN_GROUP_FOLDER` | **Drop** — 2.0 uses agent_groups table |

Build the 2.0 `.env` from this table. Don't blanket-copy 1.x's `.env`
forward — leftover vars don't break anything but they confuse the next
person who reads the file.

### Step 6. Initialize the 2.0 database + seed first agent

2.0's DB is created by the runtime on first start. Before bringing the
service up:

```bash
# Sync .env into the host -> container env file
mkdir -p ~/nanoclaw-merge/data/env
cp ~/nanoclaw-merge/.env ~/nanoclaw-merge/data/env/env

# Initialize the agent-group folder with CLAUDE.md, etc.
# 2.0 ships a /init-first-agent flow — run it once with the CLI channel
# (which is always-on) before bringing the messaging channels online,
# so there's an agent_group ready to wire to.
#
# Easiest path: start the daemon, talk to it via `npm run chat` (the CLI
# adapter's local socket), and run /init-first-agent there.
```

### Step 7. Start the 2.0 daemon

```bash
launchctl load ~/Library/LaunchAgents/com.jibot.nanoclaw.plist

# Watch the logs
tail -f ~/Library/Logs/nanoclaw-stderr.log
# Or wherever the plist's StandardErrorPath points.
```

The 2.0 startup sequence logs (in order):
- "Container runtime already running" (Docker/Colima)
- "Migrations: ran N migrations" (first start materializes the schema)
- "Webhook server started" (LINE / Slack / Discord webhook listener)
- "Channel adapter registered" (one per non-CLI channel that has creds)
- "Active delivery poll started" + "Sweep delivery poll started"
- "Host sweep started"

Any error here is the cutover blocker. Note the last good log line and
the failing line.

### Step 8. Smoke tests

In order:

1. **CLI**: `npm run chat` → say "hi" → agent responds. Confirms core
   orchestrator + container spawn works.
2. **Signal DM**: send a DM from your personal Signal to the bot
   number. Logs should show `Auto-created messaging group ... channel_type=signal`.
   Then grant yourself access:
   ```bash
   sqlite3 data/v2.db
   SELECT id, platform_id FROM messaging_groups WHERE channel_type='signal';
   -- copy the id and the userId from the platform_id (the part after sig:user:)
   INSERT OR REPLACE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
     VALUES ('signal:UUID', 'owner', NULL, 'system', datetime('now'));
   ```
   Send another DM — agent responds.
3. **WhatsApp**: same flow, platform_id prefix `whatsapp:`.
4. **Slack**: send a DM in your registered workspace. Verify the
   `transformOutboundText` mention compaction works by writing a reply
   that includes `@<someone in the identity index>`.
5. **Telegram / Discord / LINE**: spot-check inbound + outbound on each.
6. **Container hardening**: spawn a container, exec into it, confirm
   `command -v su` returns nonzero and `socket(AF_ALG, ...)` errors out.
   `./scripts/test-af-alg-block.sh` automates the AF_ALG check.

If all six pass, cutover is complete.

## Rollback

If anything in step 7 or 8 fails and you can't fix it within ~15 minutes:

```bash
# Stop the 2.0 daemon
launchctl unload ~/Library/LaunchAgents/com.jibot.nanoclaw.plist

# Restore 1.x signal-cli daemon (REST mode)
launchctl unload <2.0 signal-cli TCP unit>
# Edit the plist back to --rest mode, or load the original 1.x signal-cli unit
launchctl load <1.x signal-cli REST unit>

# Restore the launchd plist if you edited it (Option A) — git-checkout
# the previous version from your backup, or revert to whatever
# WorkingDirectory + ProgramArguments it had before.

# If Option B (~/nanoclaw merged forward), reset to the snapshot
cd ~/nanoclaw
git reset --hard $(cat /tmp/nanoclaw-pre-cutover-sha.txt)
rm -rf node_modules
npm install   # 1.x deps

# Restart the 1.x daemon
launchctl load ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
```

The merge branch in `~/nanoclaw-merge` is unaffected by the rollback — fix
whatever broke, validate again, retry the cutover.

The pre-cutover tag (`pre-2.0-merge`) and the snapshot dir
(`_legacy/v1.2.49/`) are durable references; even if the production
checkout's git state gets twisted, the source of every 1.x file is
recoverable from the merge branch.

## Post-cutover follow-ups (not blocking)

These are the deferred items from PORTING.md. None blocks the cutover;
revisit when the user requests them or when 2.0 is stable enough to
schedule discrete projects:

- **Slack PDF text extraction** — Tier 2; needs an upstream bridge hook
  for inbound attachment content. Workaround: live without it (the
  agent receives messages without PDF body text).
- **Discord outbound mention compaction** — Tier 2; verify against a
  live Discord server. If `@PersonName` renders as plain text, mirror
  `slack-mentions.ts` into a `discord-mentions.ts` and wire via
  `transformOutboundText`.
- **Email pipeline** (Tier 3) — large project. Production currently
  runs 1.x's email pipeline; 2.0 doesn't have one. Disable the email
  inputs / channel during cutover; revive when ready.
- **Voice bridge / agent-api**, **self-registration**, **people-context**,
  **reminders**, **remote-control** — Tier 5 deferred niches.
