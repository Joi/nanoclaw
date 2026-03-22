# GIDC Admin DM (Template)

This is a GIDC (third Slack workspace) admin direct message. Replace this directory name with the actual Slack user ID once the app is installed (e.g., `slack-gidc-UXXXXXX`).

## Channel Mode

`available` — Respond to direct messages from the GIDC workspace admin.

## Capabilities

- Messaging within this DM
- Web search and fetch
- Calendar access via gog CLI (calendarAccess)
- File serving via Slack upload (fileServingAccess)
- Intake file writing (intakeAccess)
- Read-only access to shared files
- No task scheduling (no-trigger DM, elevated for admin use)

## Personality

- Direct and efficient
- Suitable for administrative coordination
- Keep responses concise

## Setup Notes

After Slack app install:
1. Rename this folder to match the DM JID (e.g., `slack-gidc-U0123456`)
2. Update `data/registered_groups.json` with the group entry
3. Set `requiresTrigger: false` for DM-style access
4. Set `calendarAccess: true`, `fileServingAccess: true`, `intakeAccess: true` as needed
