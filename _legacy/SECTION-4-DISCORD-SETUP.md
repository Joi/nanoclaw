# Section 4 — Discord (do at desktop)

Status as of 2026-05-06 14:28: deferred until you have access to the
Discord Developer Portal at desktop.

The Discord adapter ships with the daemon but is not currently starting
(missing `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID`). 1.x didn't
have these — Discord requires them only when handling interactions
(slash commands + button clicks), and 2.0 always wires interactions.

## Prerequisites

- A Discord application + bot already exist for jibot. If not, do
  Section 4-prereq below first.
- Section 3 done (named cloudflared tunnel) — so you can reuse the
  same tunnel infra for the Discord webhook. If Section 3 is still
  pending, do that first; it's the gating step.

## Step 1 — Pull credentials from Discord Developer Portal

1. Open https://discord.com/developers/applications → your app.
2. **General Information** → copy the **Application ID**.
3. Same page → reveal and copy the **Public Key** (NOT the Bot Token —
   that's `DISCORD_BOT_TOKEN`, already in `.env` if Discord ever ran).

## Step 2 — Write env vars

Edit `~/nanoclaw-merge/.env`:

```
DISCORD_APPLICATION_ID=<paste>
DISCORD_PUBLIC_KEY=<paste>
```

Mirror into the container env (some channels read this dir at spawn):

```bash
cp ~/nanoclaw-merge/.env ~/nanoclaw-merge/data/env/env
```

## Step 3 — Add a second tunnel route

In `~/.cloudflared/jibot-line.yml` (created in Section 3), extend the
ingress to also forward `/webhook/discord` to the daemon's unified
webhook server on port 3000:

```yaml
tunnel: jibot-line
credentials-file: /Users/jibot/.cloudflared/<UUID>.json

ingress:
  - hostname: <HOSTNAME>
    path: /webhook/discord
    service: http://127.0.0.1:3000
  - hostname: <HOSTNAME>
    service: http://127.0.0.1:10280
  - service: http_status:404
```

(Path-prefixed rule MUST come before the catch-all LINE rule — the
LINE adapter listens on 10280, the Discord/unified webhook on 3000.)

Reload the launchd unit:

```bash
launchctl kickstart -k gui/$(id -u)/com.jibot.cloudflared-line
```

If you'd rather keep tunnels per-channel, run a separate
`cloudflared` for Discord with its own hostname pointing at port 3000.
Either is fine — one tunnel is cheaper.

## Step 4 — Set the Interactions Endpoint URL in Discord

1. Discord Developer Portal → your app → **General Information**.
2. **Interactions Endpoint URL** → paste
   `https://<HOSTNAME>/webhook/discord` → **Save Changes**.

Discord verifies the URL on save by sending a signed PING. If anything
is misconfigured (wrong public key, daemon down, tunnel not routing
the path), the save fails with a red banner. The error message is
usually clear enough to point at which side is wrong.

## Step 5 — Reload daemon

```bash
launchctl kickstart -k gui/$(id -u)/com.jibot.nanoclaw
```

Expect in `/tmp/nanoclaw.stdout.log`:

```
Channel adapter started channel="discord" type="discord"
```

Instead of any `publicKey is required` error.

## Step 6 — Test inbound

DM your Discord bot. Watch:

```bash
tail -f /tmp/nanoclaw.stdout.log | grep -i discord
```

Expect `Inbound DM received adapter="discord"` plus the
channel-registration card.

## Step 7 — Wire the agent

```bash
cd ~/nanoclaw-merge
npx tsx scripts/init-first-agent.ts \
  --channel discord \
  --user-id "discord:<your-discord-userid>" \
  --platform-id "discord:@me:<your-channel-id>" \
  --display-name "Joi" --agent-name "jibot" --role owner
```

You'll find your Discord user ID by looking at the inbound log line
from step 6.

## Acceptance criteria

A DM to the Discord bot gets a welcome reply from jibot.

## Section 4-prereq — if there's no Discord app yet

1. https://discord.com/developers/applications → **New Application**.
2. Add a Bot under the **Bot** tab. Copy the **Bot Token** →
   `DISCORD_BOT_TOKEN` in `.env`.
3. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`
   → required permissions (read messages, send messages, etc.) →
   visit the generated URL to invite the bot to your server.

Then resume from Step 1 above.

## If something goes sideways

| Symptom | Fix |
|---|---|
| Save in Discord Portal fails with "could not validate" | Daemon isn't running, tunnel doesn't route /webhook/discord, or the public key in `.env` doesn't match the app. |
| Daemon logs `publicKey is required` | DISCORD_PUBLIC_KEY missing or mistyped. |
| Daemon logs `Invalid signature` on inbound | Public key is wrong (likely copied a different value). |
| `Inbound DM received` doesn't fire on a real DM | Bot was never invited to a guild OR the bot lacks the Direct Messages intent in the Bot tab → Privileged Gateway Intents. |

## Rollback

Remove the two env vars and restart the daemon. Discord adapter
returns to "not starting" — the rest of the channels are unaffected.
