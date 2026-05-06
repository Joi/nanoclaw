# Section 6 — auxiliary launchd audit (done 2026-05-06)

Result of the read-only audit of NanoClaw-adjacent launchd units after
the 2.0 cutover. All "retired" units have their plists moved to
`~/Library/LaunchAgents/disabled/`. Their target scripts are left in
place as manual tools.

## Kept

| Unit | Why |
|---|---|
| `com.nanoclaw.iblai-router` | External Anthropic-API HTTP router on port 8402, channel-agnostic. Independent of the daemon. Still reads `~/nanoclaw/.env` for `ANTHROPIC_API_KEY` — fine for now, reconsider if 1.x's `.env` rots. |
| `com.jibot.reap-signal-zombies` | Reaps stale signal-cli child processes every 30 min; verified reaping live at 14:33 on cutover day. signal-cli on TCP can still leak. |

## Retired (plists in `~/Library/LaunchAgents/disabled/`)

| Unit | Reason |
|---|---|
| `com.nanoclaw.telegram-relay` | 2.0's Telegram adapter (grammY + Chat SDK) handles inbound directly; the 1.x Telethon relay is redundant. |
| `com.nanoclaw.qmd-reindex` | Replaced by `com.jibot.qmd-fleet` and the per-domain `com.jibot.qmd-*` units, which are healthy. |
| `com.nanoclaw.learned-facts` | 1.x feature reading `~/nanoclaw/data/sessions/`. 2.0's per-group memory shape is `CLAUDE.local.md`; no equivalent extractor yet. Last automatic run: 2026-05-06 03:30 (~9h before cutover). 1.x had been broken ~17h before that, so nothing newer to extract. |
| `com.jibot.nanoclaw-watchdog` | 1.x activity-based liveness check (no inbound for 15 min → restart). 2.0's chat-sdk channels self-reconnect with backoff and the daemon has its own host-sweep + heartbeat machinery; 1.x's model produces false positives any time the user simply isn't messaging. The path/pattern fix landed in `~/scripts/nanoclaw-watchdog.sh` (commit `32d30f5`) anyway, so reviving it is a `launchctl load` away. |

## To revive any of the retired units

```bash
mv ~/Library/LaunchAgents/disabled/<plist> ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/<plist>
```

For the watchdog specifically: rethink the failure-detection model
before reviving — activity-based detection isn't a fit for 2.0.

## Final extraction note for `learned-facts`

If you want one last sweep of 1.x sessions before forgetting about
that pipeline:

```bash
/usr/bin/python3 ~/nanoclaw/scripts/extract-learned-facts.py
```

Reads `~/nanoclaw/data/sessions/`, calls Claude API, writes to
`~/nanoclaw/groups/<folder>/CLAUDE.md`. Costs whatever the API call
costs for the residual delta since 03:30 on cutover day.
