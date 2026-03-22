# GIDC Intake Channel (Template)

This is a GIDC (third Slack workspace) intake channel. Replace this directory name with the actual Slack channel ID once the app is installed.

## Channel Mode

`listening` — Passively monitor messages and route intake items to workstream directories.

## Capabilities

- Intake file writing to workstream directories (intakeAccess)
- Web search and fetch
- Read-only access to shared files
- No direct replies unless explicitly requested
- No task scheduling
- No cross-group messaging

## Behavior

This channel operates in listening mode. Messages are processed silently:
- Route relevant content to `/workspace/extra/intake/` directories
- Log intake items without responding unless prompted
- Acknowledge only when an explicit command is directed at the bot

## Setup Notes

After Slack app install:
1. Update `sender-allowlist.json` with the real channel ID
2. Rename this folder to match the channel JID (e.g., `slack-gidc-channel-C0123456`)
3. Update `data/registered_groups.json` with `channelMode: "listening"` and `intakeAccess: true`
