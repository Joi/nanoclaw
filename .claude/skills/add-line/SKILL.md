---
name: add-line
description: Add LINE Messaging API channel via native adapter. Webhook-driven inbound, push-message outbound.
---

# Add LINE Channel

Adds LINE messaging support via a native adapter (no Chat SDK bridge — `@chat-adapter/line` does not exist upstream). Inbound is webhook-driven (LINE pushes events to a HTTP server NanoClaw runs); outbound uses LINE's push-message endpoint at `api.line.me/v2/bot/message/push`.

The adapter is a 2.0 reimplementation of the joi/jibot LINE adapter (originally 1.x commits 380f4e8, ff5c939, f194607, ced3f95). The platform-ID scheme is symmetric — `line:user:{userId}` for DMs, `line:group:{groupId}` for groups, `line:room:{roomId}` for rooms — chosen here rather than the asymmetric 1.x scheme because there is no DB carryover from 1.x to anchor.

## Prerequisites

A LINE Messaging API channel:

1. Create a [LINE Developers](https://developers.line.biz/) account (free).
2. Create a Provider, then a Messaging API channel under it.
3. Note the **Channel access token** (long-lived) and the **Channel secret** from the channel settings.
4. Webhook delivery: LINE needs a publicly reachable HTTPS endpoint. Options:
   - Production: front the bot's HTTP listener with a reverse proxy / ingress that has TLS and a real DNS name (the LINE webhook can't talk to a self-signed cert).
   - Development: a tunnel (ngrok, cloudflared, etc.) pointing at the local listener.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/line.ts` and `src/channels/line.test.ts` exist
- `src/channels/index.ts` contains `import './line.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Adapter is in trunk

Unlike the upstream channels that come from the `channels` branch, LINE was authored directly in this fork (no upstream skill exists). The adapter at `src/channels/line.ts` and tests at `src/channels/line.test.ts` are part of the merged tree — nothing to copy.

### 2. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './line.js';
```

### 3. Build

```bash
npm run build
```

No npm packages to install — the adapter uses only Node.js builtins (`http`, `crypto`) plus the global `fetch` for outbound calls.

## Credentials

Add to `.env`:

```bash
LINE_CHANNEL_ACCESS_TOKEN=...   # required
LINE_CHANNEL_SECRET=...         # required (for webhook signature verification)
```

### Optional settings

```bash
LINE_WEBHOOK_PORT=10280         # default 10280
LINE_WEBHOOK_PATH=/webhook      # default /webhook
```

The HTTP listener binds to `0.0.0.0` on `LINE_WEBHOOK_PORT`. Ingress / TLS termination is your reverse proxy's job.

### Restart

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Wiring

### DMs

After the service starts and the LINE webhook is reachable, message your bot from a personal LINE account. The router auto-creates a `messaging_groups` row. Then:

```bash
sqlite3 data/v2.db \
  "SELECT id, platform_id FROM messaging_groups WHERE channel_type='line' ORDER BY created_at DESC LIMIT 5"
```

Pass the `id` to `/init-first-agent` or `/manage-channels` to wire it to an agent group.

### Groups / rooms

Add the LINE bot to a group from a phone, send a message, then wire the resulting row the same way. Group platformIds look like `line:group:Cxxxx…`; rooms look like `line:room:Rxxxx…`.

## Channel Info

- **type**: `line`
- **terminology**: LINE has DMs ("user"), groups, and rooms (an older multi-user chat format)
- **supports-threads**: no
- **platform-id-format**:
  - DM: `line:user:{userId}` (userId starts with `U`)
  - Group: `line:group:{groupId}` (groupId starts with `C`)
  - Room: `line:room:{roomId}` (roomId starts with `R`)
- **5000-char per-message ceiling**: outbound text is split on the limit and posted as multiple push messages.
- **non-text messages**: only text events are processed inbound; sticker/image/voice events are dropped silently. Outbound is text-only too.
