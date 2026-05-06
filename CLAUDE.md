# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to multiple channels (WhatsApp, Signal, Slack, Telegram, Email), routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation, GIDC wiring |
| `src/channels/whatsapp.ts` | WhatsApp connection (baileys v6), auth, media download |
| `src/channels/signal.ts` | Signal via signal-cli REST API, mention expansion |
| `src/channels/slack.ts` | Slack via Bolt SDK, PDF extraction |
| `src/channels/telegram.ts` | Telegram via grammY |
| `src/channels/email.ts` | Email channel via gog CLI |
| `src/channels/registry.ts` | Channel factory registry (upstream pattern) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/format.ts` | Markdown-to-Signal and Markdown-to-Slack formatting |
| `src/config.ts` | Trigger pattern, paths, intervals, channel tokens |
| `src/container-runner.ts` | Spawns agent containers with mounts, QMD MCP config |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/sender-allowlist.ts` | Per-chat sender allowlist with add/remove |
| `src/intake.ts` | GIDC intake file writing to workstream dirs |
| `src/gidc-commands.ts` | GIDC slash commands (mode, scan) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Agent skills synced into containers |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.jibot.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
