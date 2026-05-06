# Section 3 — LINE webhook tunnel (do at desktop)

Status as of 2026-05-06 14:27: deferred until you're at the desktop.

The LINE channel adapter is already running on jibotmac and listening at
`127.0.0.1:10280/webhook` (confirmed in the daemon startup log). What's
left is a public tunnel + LINE Developer Console wiring.

You picked **named tunnel** (stable hostname, more durable than ad-hoc).

## What you need before you start

- A domain managed in your Cloudflare account (i.e. nameservers point
  at Cloudflare so a CNAME can be added). Pick a hostname now and
  remember it — examples: `line.example.com`, `jibot-line.example.com`.
  Replace `<HOSTNAME>` with that string everywhere below.
- About 15 minutes of focused desktop time. The Cloudflare auth flow
  opens a browser and the LINE console verify step needs the daemon
  reachable when you click Verify.

## Step 1 — Install cloudflared

```bash
brew install cloudflared
```

## Step 2 — Authenticate to Cloudflare

```bash
cloudflared tunnel login
```
Browser opens. Pick the zone (your domain) you'll attach the tunnel
to. Writes a cert to `~/.cloudflared/cert.pem`.

## Step 3 — Create the tunnel

```bash
cloudflared tunnel create jibot-line
```
Records the tunnel UUID + writes `~/.cloudflared/<UUID>.json`
credentials. Note the UUID — you'll see it in step 4.

## Step 4 — Map a hostname to the tunnel

Pick `<HOSTNAME>` (e.g. `line.example.com`). Run:

```bash
cloudflared tunnel route dns jibot-line <HOSTNAME>
```

This creates a CNAME in Cloudflare DNS pointing `<HOSTNAME>` at
`<UUID>.cfargotunnel.com`.

## Step 5 — Write the tunnel config

```bash
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/jibot-line.yml <<EOF
tunnel: jibot-line
credentials-file: $HOME/.cloudflared/$(cloudflared tunnel list 2>/dev/null | awk '/jibot-line/ {print $1}').json

ingress:
  - hostname: <HOSTNAME>
    service: http://127.0.0.1:10280
  - service: http_status:404
EOF
```

Replace `<HOSTNAME>` in the file (sed or your editor). Verify:

```bash
cloudflared tunnel --config ~/.cloudflared/jibot-line.yml ingress validate
```

## Step 6 — Smoke-test the tunnel manually

```bash
cloudflared tunnel --config ~/.cloudflared/jibot-line.yml run
```
Then in another terminal:
```bash
curl -i https://<HOSTNAME>/webhook
```
Expect a 405 or some non-error response from the LINE adapter (it
rejects GETs but proves the path is reachable). Stop with Ctrl-C
when satisfied — step 7 starts it under launchd.

## Step 7 — launchd unit so it survives reboot

Save as `~/Library/LaunchAgents/com.jibot.cloudflared-line.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jibot.cloudflared-line</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>/Users/jibot/.cloudflared/jibot-line.yml</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/cloudflared-line.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cloudflared-line.stderr.log</string>
</dict>
</plist>
```

Load:
```bash
launchctl load ~/Library/LaunchAgents/com.jibot.cloudflared-line.plist
launchctl list | grep cloudflared-line   # expect a numeric PID, exit 0
```

If it doesn't stay up, `tail -f /tmp/cloudflared-line.stderr.log`.

## Step 8 — LINE Developer Console wiring

1. Open https://developers.line.biz/console/ → your provider →
   your channel (Messaging API).
2. **Webhook URL** → paste `https://<HOSTNAME>/webhook` → Update.
3. Click **Verify** — should return 200. If it fails: tunnel down,
   wrong hostname, or 10280 unreachable on jibotmac.
4. Toggle **Use webhook** ON.
5. Optionally toggle **Auto-reply messages** OFF so only jibot
   replies (LINE's default canned auto-reply will otherwise fight
   for the conversation).

## Step 9 — Send a test DM

Send any message to your LINE bot. On jibotmac:

```bash
tail -f /tmp/nanoclaw.stdout.log | grep -i line
```

Expect `Inbound DM received adapter="line"` plus channel-registration
card delivery. Note the LINE user ID printed in the log — you'll
need it in step 10.

## Step 10 — Wire the agent

```bash
cd ~/nanoclaw-merge
npx tsx scripts/init-first-agent.ts \
  --channel line \
  --user-id "line:<your-line-userid>" \
  --platform-id "line:user:<your-line-userid>" \
  --display-name "Joi" --agent-name "jibot" --role owner
```

## Acceptance criteria

A DM to the LINE bot from your account gets a welcome reply from
jibot.

## If something goes sideways

| Symptom | Fix |
|---|---|
| `cloudflared tunnel login` opens but shows no zones | Domain isn't on Cloudflare yet — change nameservers and wait. |
| Tunnel runs but `curl https://<HOSTNAME>/webhook` returns 530 | DNS hasn't propagated — wait or run `dig <HOSTNAME>`. |
| LINE Verify returns "could not establish connection" | jibotmac is offline, daemon isn't running, or 10280 isn't actually open. |
| `Inbound DM received` doesn't fire | Likely `Use webhook` not toggled on after Verify, OR Auto-reply still intercepting. |

## Rollback

`launchctl unload` the plist and revert the LINE console webhook URL.
The daemon's LINE adapter will keep listening on 10280 with no
external traffic — harmless.
