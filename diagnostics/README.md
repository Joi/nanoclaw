# send-file hang diagnostics

Standalone scripts to investigate the production hang on `WhatsAppChannel.sendFile` and
`SlackChannel.sendFile` (beads `jibot-code-tel`). These are forensic / read-only —
they create no new state, modify no production files, and live entirely outside the
main `src/` tree. Safe to keep in tree on a side branch, or rm at end of investigation.

## Pre-flight

These run on **jibotmac** (where the production auth state and Slack tokens live).
Copy this directory to jibotmac first:

```bash
# from your laptop:
rsync -avz ~/repos/nanoclaw/diagnostics/ jibotmac:~/nanoclaw/diagnostics/
```

On jibotmac, **stop NanoClaw before running either script**. WhatsApp permits only
one active Web session per device — if NanoClaw is still running we'll either kick
it off or get kicked off ourselves, and the run will be unrepresentative.

```bash
ssh jibotmac 'launchctl bootout gui/$(id -u)/com.jibot.nanoclaw'
```

After the diagnostic run, restart NanoClaw:

```bash
ssh jibotmac 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jibot.nanoclaw.plist'
```

## Experiment 1: standalone Baileys document send

Goal: **falsify or confirm hypothesis H1-A** — that the hang is in Baileys 6.7.21 itself
(stale account state vs. current WhatsApp Web protocol), independent of NanoClaw's
IPC, concurrency, or deps glue.

Script: `baileys-doc-send.mjs`

The script:

- Copies `~/nanoclaw/store/auth/` to a temp dir so production state is never written
  through. (Baileys `useMultiFileAuthState` writes creds back; we don't want that.)
- Mirrors NanoClaw's exact `makeWASocket` config — no `defaultQueryTimeoutMs`,
  no `fireInitQueries`, same browser, same version-fetch.
- Logs every `connection.update` event with timestamps so we can see if/when
  `init queries Timed Out` fires.
- Calls `sock.sendMessage(jid, { document: { url: filePath }, fileName, mimetype, caption })`
  with the URL form (Baileys-recommended).
- Hard wall-clock timeout: 150 s overall, 90 s on the sendMessage call itself.
- Optional second pass: re-runs with `defaultQueryTimeoutMs: undefined` to test
  whether the timeout is the bottleneck or the underlying query is genuinely stuck.

### Run

```bash
ssh jibotmac
cd ~/nanoclaw

# Default: send to bhutan-tea-wa group
node diagnostics/baileys-doc-send.mjs \
  --jid '120363426828757598@g.us' \
  --file ~/Downloads/2026-04-30-cowork-onboarding-haruna-yoko.pdf \
  --caption 'Diagnostic test — please ignore'

# Repeat with timeout disabled (does the underlying query ever resolve?)
node diagnostics/baileys-doc-send.mjs \
  --jid '120363426828757598@g.us' \
  --file ~/Downloads/2026-04-30-cowork-onboarding-haruna-yoko.pdf \
  --no-query-timeout

# Optional: send to a 1:1 chat first to isolate group device-list resolution
node diagnostics/baileys-doc-send.mjs \
  --jid '<your_personal_number>@s.whatsapp.net' \
  --file ~/Downloads/test-1kb.txt
```

### Decision tree

| Outcome | Means | Next step |
|---|---|---|
| Init queries succeed AND doc send completes <30 s | Standalone Baileys works → bug is in NanoClaw deps glue / concurrency | Read `src/index.ts:1645-1660` carefully; compare `findChannel` for `slack:` vs `whatsapp:` JIDs; look at `Promise.all` at line 1659. Possibly Slack-waits-on-WA shaped issue. |
| `init queries Timed Out` fires AND doc send hangs | H1-A confirmed at the protocol level | Try re-pair (delete `store/auth/` + `/setup`). If it works → ship PR #1 as-is (URL form). If it doesn't → upgrade Baileys. |
| Init queries succeed BUT doc send hangs after `fetched media stream` | H3-A: per-recipient device-list resolution is the bottleneck | Try 1:1 send. If 1:1 works, group fails → confirms group device-list path. |
| `--no-query-timeout` lets it eventually complete (>60 s) | Underlying IQ is slow, not stuck | Likely network / Meta server-side; bump `defaultQueryTimeoutMs` in production config. |
| `--no-query-timeout` still hangs forever | Underlying IQ is genuinely never replied to | Likely auth-state / LID protocol mismatch. Re-pair or upgrade Baileys. |

## Experiment 2: standalone Slack `filesUploadV2`

Goal: **falsify or confirm hypothesis H1-B** — that the "Slack event-loop wedge" was
actually Slack waiting on a wedged Baileys send earlier in the await chain, not a
real Slack/Bolt SDK bug.

Script: `slack-file-upload.mjs`

The script:

- Loads `~/nanoclaw/.env` for `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_SIGNING_SECRET`.
- Initializes `@slack/bolt` `App` in socket mode (same as NanoClaw).
- Calls `app.client.filesUploadV2({ channel_id, file: fs.createReadStream(filePath), filename, initial_comment? })`.
- Logs phase-by-phase wall-clock (init → connect → resolve channel → upload start → upload done).
- Tails its own log to a separate file so we can prove the event loop is NOT wedged
  during the upload — a `setInterval(() => fs.appendFileSync(...), 1000)` heartbeat
  runs in parallel; if it stops printing, the loop *is* genuinely blocked.
- Hard wall-clock timeout: 180 s.

### Run

```bash
ssh jibotmac
cd ~/nanoclaw

# Send to joiito-jibot Slack channel (resolves channel ID from JID via Slack API)
node diagnostics/slack-file-upload.mjs \
  --channel '<C... id, see below>' \
  --file ~/Downloads/2026-04-30-cowork-onboarding-haruna-yoko.pdf \
  --comment 'Diagnostic test — please ignore'
```

(Channel ID for `joiito-jibot`: look it up via `sqlite3 ~/nanoclaw/store/messages.db
'select jid from chats where name like "%jibot%"'` — the slack: prefix is stripped
by the script.)

### Decision tree

| Outcome | Means | Next step |
|---|---|---|
| Upload completes < 30 s, heartbeats logged throughout | H1-B confirmed: there is no Slack wedge. The production "wedge" was Slack waiting on a wedged Baileys await chain. | Fixing Baileys also fixes the Slack-wedge symptom. No Slack-side work needed. |
| Upload takes 30–90 s, heartbeats logged throughout | Normal slow upload (S3 PUT speed). Not a wedge. | Same as above. Possibly add a per-channel timeout in production code, but no SDK bug. |
| Heartbeats stop logging during upload | Real event-loop block | Add `node --inspect` and capture CPU profile during the wedge; check for `pdf-parse` / `readFileSync` / sync-pino frames. |
| Upload itself hangs > 180 s | Slack-side stall (S3/CloudFront 504s seen in StackOverflow Jan 2026 reports) | Retry; if reproducible, file SDK ticket with reproduction. |
| Hangs at `app.start()` (never reaches upload) | Bolt socket-mode is broken on jibotmac | Separate problem; out of scope for this issue. |

## Combined experiment: WhatsApp + Slack in same process (reproduce the wedge)

If experiments 1 and 2 both work in isolation, run them back-to-back in the same
process to try to reproduce the production wedge:

```bash
node diagnostics/combined-send.mjs   # (write only if 1+2 both pass standalone)
```

Skipping for now — only worth writing if isolation passes.

## What I'm NOT doing in these scripts

- Not modifying production auth state.
- Not retrying or queuing on failure (we *want* the hang to be visible).
- Not parsing PDFs (no `pdf-parse` import — keeps Slack outbound path clean).
- Not touching any `src/` file or any production config.
- Not running on Joi's laptop — only on jibotmac (where the bug reproduces).