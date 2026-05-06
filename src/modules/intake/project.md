## Intake module

URL auto-intake. Lives in `src/modules/intake/`.

When an enabled channel receives a message that is *only* a single http(s) URL — whitespace + URL + whitespace, no other text — the URL is filed to the knowledge-intake sprite (`https://knowledge-intake-bmal2.sprites.app/intake`) and the agent is **not** engaged. The host replies on the same channel with a one-line confirmation: title, classification, and the path the sprite wrote into the vault.

Everything else (multi-line messages, URLs with surrounding text, system cards) falls through to normal routing.

### Wiring

The module registers a single hook: `setInboundContentFilter` (in `src/router.ts`). The filter runs after the messageInterceptor (owned by the permissions module for approval-reply capture) but before messaging-group resolution. Returning true consumes the message; routing stops.

### Configuration

| Env var | Purpose |
|---|---|
| `INTAKE_ENABLED_PLATFORM_IDS` | Comma-separated `<channelType>:<platformId>` allowlist. Empty / unset → module is dormant. |
| `INTAKE_SPRITE_URL` | Sprite base URL. Default `https://knowledge-intake-bmal2.sprites.app`. |

### Credentials

`INTAKE_API_KEY` lives in `~/.config/amplifierd/credentials.env` — the same file the amplifier-remote provider reads. Adding intake doesn't add a new file to manage; just one extra key:

```
INTAKE_API_KEY=<32-byte hex>
```

The key is loaded on the host (not inside the container — intake runs entirely in the orchestrator), cached for the process lifetime; restart the host to pick up rotation.

### Future: per-channel opt-in via DB

The 1.x version used a YAML field `auto_url_intake: true` on per-channel config. 2.0 has no equivalent table yet, so the env-var allowlist is the bridge. The proper home is a column on `messaging_groups` plus a small admin command to flip it. Migration outline (not yet shipped):

1. Numbered migration adds `auto_url_intake INTEGER NOT NULL DEFAULT 0` to `messaging_groups`.
2. `isEnabledForEvent` reads the column instead of the env var.
3. A `/intake on|off` slash command toggles the column.

### Why a host module rather than a provider

The intake action does not run an LLM turn — it's a content classifier + outbound fetch + canned reply. Modeling it as an `AgentProvider` would force a container spawn for each URL, which is wasteful and adds latency. Host-side gives us cheap, synchronous handling and a fast confirmation reply.
