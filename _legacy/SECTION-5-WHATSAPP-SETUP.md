# Section 5 — WhatsApp (do at desktop with phone in hand)

Status as of 2026-05-06 14:29: deferred until you're back at the
desktop with your phone available for QR scan / pairing-code entry.

1.x prod did not have WhatsApp creds. There is no migration — it's a
fresh add. The repo ships a `/add-whatsapp` skill that handles the
whole Baileys-side flow.

## Prerequisites

- Phone with WhatsApp installed and authenticated as your normal account.
- Desktop with terminal open in `~/nanoclaw-merge`.

## Step 1 — Run the skill

From a Claude Code session in `~/nanoclaw-merge`:

```
/add-whatsapp
```

The skill will:
- Prompt for QR-code pairing OR pairing-code authentication. Pairing
  code is friendlier on a phone — you punch a 6-digit code into
  WhatsApp → Linked Devices instead of scanning a QR. Either works.
- Write `WHATSAPP_PHONE_NUMBER` to `.env` once paired.
- Persist Baileys session state under `data/whatsapp/`. This dir is
  what keeps the connection alive across daemon restarts — back it
  up if you reinstall.

## Step 2 — Restart daemon

```bash
launchctl kickstart -k gui/$(id -u)/com.jibot.nanoclaw
```

Watch:
```bash
tail -f /tmp/nanoclaw.stdout.log | grep -i whatsapp
```

Expect `Channel adapter started channel="whatsapp"`. If you see
auth-loop errors, the session in `data/whatsapp/` is stale — delete
it and re-run `/add-whatsapp`.

## Step 3 — Send a test DM

Send any message from your normal WhatsApp to your linked-device
account. The daemon should log:
- `Inbound DM received adapter="whatsapp"`
- `Auto-created messaging group ... channelType="whatsapp"`
- `Channel registration card delivered`

Note your WhatsApp jid from the log — it looks like
`<digits>@s.whatsapp.net` or similar.

## Step 4 — Wire the agent

```bash
cd ~/nanoclaw-merge
npx tsx scripts/init-first-agent.ts \
  --channel whatsapp \
  --user-id "whatsapp:<your-jid>" \
  --platform-id "whatsapp:<your-jid>" \
  --display-name "Joi" --agent-name "jibot" --role owner
```

## Acceptance criteria

A WhatsApp DM to your linked-device account gets a reply from jibot.

## If something goes sideways

| Symptom | Fix |
|---|---|
| QR code in terminal won't scan | Resize the terminal so the whole grid fits without wrapping. Tiny terminals corrupt the QR. |
| Pairing code rejected by WhatsApp | Codes expire fast (≈1 min) — re-run `/add-whatsapp` and use the fresh code immediately. |
| Daemon logs `Connection Closed` repeatedly | Baileys session is stuck. Stop daemon, `rm -rf data/whatsapp/` (caution: forces a fresh pair), restart. |
| Bot stops receiving messages a few hours later | Phone went offline. Baileys is a multi-device link, not an independent client — the linked phone has to be reachable. |

## Rollback

```bash
rm -rf data/whatsapp/
# remove WHATSAPP_PHONE_NUMBER from .env
launchctl kickstart -k gui/$(id -u)/com.jibot.nanoclaw
```

The WhatsApp linked device on your phone will eventually time out and
disappear from Linked Devices — or you can revoke it manually.
