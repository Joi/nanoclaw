# Handoff: amplifierd `/sessions/{id}/execute` returns HTTP 500

Saved 2026-05-06 from a phone-side debugging session. Hand to whoever
has SSH/console access to macazbd to investigate amplifierd's logs.

## Where this is running
- amplifierd HTTP API on macazbd, port 8410.
- Reverse-tunneled to jibotmac at `127.0.0.1:8410` (LaunchAgent
  referenced in creds file: `com.amplifier.reverse-tunnel`).
- Client: jibot 2.0 NanoClaw container, group `dm-with-joi`,
  provider `amplifier-remote`. Provider is intentionally left set —
  jibot will stay silent on Signal/Telegram/Slack until the
  amplifierd 500 is fixed (Joi will fix on macazbd when next at
  home; opted to wait rather than fall back to claude).

## Symptom
`POST /sessions/{id}/execute` returns **HTTP 500, body:
`Internal Server Error`** after **~32s** every time. No detail in
the response body.

Reproduced cleanly with curl from the jibot container at 2026-05-06
~14:06 JST:

```
=== createSession ===  -> 200, returns valid session_id (bundle=joi)
=== execute (90s timeout) ===
Internal Server Error
--- status: 500 time: 32.056659s ---
```

## What's already verified working
- `GET /health` → 200
- `POST /sessions` with
  `{"bundle":"joi","working_dir":"/Users/joi/workspaces/jibot"}` →
  200, returns:
  ```json
  {"session_id":"...","status":"idle","bundle_name":"joi",
   "working_dir":"/Users/joi/workspaces/jibot",
   "created_at":"2026-05-06T08:06:03.879449+00:00"}
  ```
- Bearer auth via `AMPLIFIERD_API_KEY` is accepted.
- TCP path from jibotmac container → host.docker.internal:8410 →
  reverse tunnel → macazbd:amplifierd is intact.

## What to investigate on macazbd

1. **amplifierd stderr / log at the moment of an `/execute` call.**
   The 500 has no detail in the body — the actual stack trace will
   be in amplifierd's logs. Most direct lead.

2. **Working dir on macazbd**: does `/Users/joi/workspaces/jibot`
   exist on macazbd, and does amplifierd's process have read/write
   permission? (Note: path says "joi" — the macazbd-side username —
   while jibotmac side uses "jibot". If amplifierd chdirs into
   this path, a missing dir or perms issue could throw before any
   model call.)

3. **Bundle "joi"**: verify the bundle is healthy. Does
   `executePrompt` need a model/runner that's currently down or
   misconfigured (Claude API key expired, local model not loaded,
   etc.)?

4. **Upstream timeout**: 32s is suspiciously close to a default
   upstream timeout. Whatever amplifierd dispatches the prompt to
   may be hanging and getting wrapped as a 500.

5. **Recent change**: creds file header says
   "Updated 2026-05-06 05:02:44 +06 on macazbd". If anything else
   changed around that time on the amplifierd side (bundle config,
   working dir, model deployment), that's the prime suspect.

## Repro command (run from any reachable host with the API key)

```bash
KEY=<AMPLIFIERD_API_KEY>
URL=http://<amplifierd-host>:8410
SESS=$(curl -s -X POST "$URL/sessions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"bundle":"joi","working_dir":"/Users/joi/workspaces/jibot"}')
SID=$(echo "$SESS" | grep -oE '"session_id":"[^"]+"' | cut -d\" -f4)
curl -s -w '\n--- %{http_code} %{time_total}s ---\n' \
  --max-time 90 -X POST "$URL/sessions/$SID/execute" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"say ok"}'
```

## NanoClaw-side fixes already landed (not the cause of the 500)

For context, three real bugs were fixed in NanoClaw 2.0 to even get
this far. The 500 is strictly server-side once execute starts.

- `groups/dm-with-joi/container.json` is set to
  `"provider": "amplifier-remote"` (host's `ensureRuntimeFields`
  doesn't sync provider from the DB into container.json — separate
  bug worth a follow-up). Left as-is intentionally; do not flip to
  claude.
- `src/providers/amplifier-remote.ts` rewrites
  `127.0.0.1`/`localhost` → `host.docker.internal` in
  `AMPLIFIERD_BASE_URL` (1.x ran on host, 2.0 in container).
  Committed as `38966e4`.
- Same provider sets `NO_PROXY=host.docker.internal,127.0.0.1,localhost`
  so OneCLI gateway's `HTTPS_PROXY` doesn't tunnel the amplifierd
  call through `gateway.onecli.sh`. Same commit.

## Verify after the macazbd-side fix

amplifier-remote is already wired on the jibot side, so once
amplifierd's `/execute` stops 500ing there's nothing to flip — just
send a test DM. Daemon log should show:

- `Starting v2 agent-runner (provider: amplifier-remote)`
- a normal `[poll-loop] Result: ...` instead of an ECONNRESET / 500.

If amplifier-remote ever needs to be removed (e.g. abandoning that
provider entirely), the toggles are:

```bash
# 1. drop the provider line from groups/dm-with-joi/container.json
# 2. drop the agent_groups row's provider:
sqlite3 ~/nanoclaw-merge/data/v2.db \
  "UPDATE agent_groups SET agent_provider=NULL WHERE folder='dm-with-joi'"
# 3. kick in-flight containers:
docker ps --filter name=nanoclaw-v2-dm-with-joi --format '{{.Names}}' \
  | xargs -r docker rm -f
```
