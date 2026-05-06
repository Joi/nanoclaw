# Section 3 — LINE webhook tunnel (resolved 2026-05-06)

LINE is fully wired end-to-end. DMs from `line:user:U1f27398cad1ee44d...`
hit the daemon, route to `dm-with-joi`, and replies are pushed back via
the LINE push-message API. Verified live with two roundtrips
(~15s each, normal for amplifier-remote).

## How it actually came together

The setup-checklist plan (named tunnel + new launchd unit) was
sidestepped — Joi reused the existing `jibot-voice` cloudflared tunnel
on jibotmac (under `com.cloudflare.jibot-voice-tunnel`) by adding a
third ingress rule:

```yaml
ingress:
  - hostname: voice.ito.com
    service: http://localhost:3200
  - hostname: relay.ito.com
    service: http://localhost:9999
  - hostname: line.ito.com
    service: http://localhost:10280   # ← added for jibot
  - service: http_status:404
```

DNS: `line.ito.com` → CNAME to the same tunnel UUID
(`f892451a-f371-478d-955b-6e485d2be8e6.cfargotunnel.com`).

LINE Developer Console webhook URL: **`https://line.ito.com/webhook`**.

## Bugs fixed during wire-up

1. **`src/channels/line.ts` did not set `isMention` on DMs.** The router
   at `router.ts:209` short-circuits with `if (!isMention) return`, so
   every LINE DM was silently dropped as plain chatter. Fix matches
   the signal/whatsapp pattern: `isMention: !isGroup ? true : undefined`.
   Committed as `6463ae3`.

2. **Approval cards can't render on native Signal adapter.** The
   `Channel registration` and `Unknown sender approval` cards are
   `ask_question` cards (title/question/options), but
   `signal.ts:900-907` only handles plain-text content — the ask_question
   shape has no `.text` field, so Signal silently drops the card. The
   chat-sdk channels (Telegram/Slack/Discord) render these correctly.
   Workaround applied: dropped `signal:+819048411965` from `user_roles`
   so future approval cards land on Telegram first. Same gap likely
   affects native LINE/WhatsApp adapters; future fix is to teach the
   native adapters to render ask_question as numbered text and parse
   matching inbound replies into `onAction`.

## Operational state changes (post-cutover, not in git)

These changes were made via direct DB writes after the cutover-day
flow had no working approval surface for `cli:local`:

- `agent_groups.agent_provider='amplifier-remote'` on `dm-with-joi`
  — done earlier today (separate from this section).
- `messaging_group_agents` row inserted for LINE
  (`mg-1778066717177-c3ga5d` → `dm-with-joi`,
  engage_mode=pattern, regex='.', sender_scope=all, drop) —
  same shape `init-first-agent.ts` writes for new wirings.
- `user_roles` cleanup:
  - removed `cli:local` (was the default approver, but the CLI
    native adapter doesn't render approval cards).
  - removed `signal:+819048411965` (Signal native adapter doesn't
    render ask_question cards either).
- `pending_channel_approvals` row for the LINE messaging group
  cleared after wiring (the registration card had been delivered to
  CLI and never actioned).

## Approver chain after this section

In order from `pickApprover`:

1. `telegram:2017226080` — chat-sdk, full ask_question card support
2. `slack:U02GY1YS33Q` — chat-sdk, full ask_question card support

Future channel registrations and unknown-sender approvals will arrive
on Telegram first; if Telegram is unreachable, Slack second.

## CLI channel adapter — kept

The CLI adapter (`src/channels/cli.ts`, `npm run chat`) is left
running. Useful for terminal pings, admin transports
(`init-first-agent.ts`, etc.). Not a problem now that it's no longer
the default approver target.

## Filed gap: native-adapter approval card rendering

Native channels (Signal, LINE, WhatsApp, CLI) silently drop
ask_question cards. Worth ~30 min to teach each native adapter to:
- Render card as `title\n\nquestion\n\n1. opt1\n2. opt2` plain text
- Parse next inbound text matching a number, dispatch `config.onAction(questionId, optionValue, userId)`

Until then, owners need a chat-sdk channel as their primary identity
for approvals. Telegram and Slack both work today.
