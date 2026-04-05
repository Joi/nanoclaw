# Slack App Scope Update (Knowledge System Redesign)

For each workspace (henkaku, cit, gidc), update the Slack app:

## New Bot Token Scopes

Add these under "OAuth & Permissions" > "Scopes" > "Bot Token Scopes":

- `users:read.email` — needed for self-registration matching (get user email for Senzing)
- `channels:manage` — needed for banned user enforcement (kick from public channels)
- `groups:write` — needed for banned user enforcement (kick from private channels)

## New Event Subscriptions

Add these under "Event Subscriptions" > "Subscribe to bot events":

- `member_joined_channel` — triggers floor recalculation and new member identification
- `member_left_channel` — triggers floor recalculation

## After Adding

1. Click "Reinstall to Workspace" to activate new scopes
2. Verify events are received: `tail -20 /tmp/nanoclaw.log | grep member_`

## Workspace Checklist

- [ ] henkaku
- [ ] cit
- [ ] gidc
