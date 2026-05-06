# Section 8 — selectively bring 1.x data forward (done 2026-05-06)

The post-cutover plan's data-triage outcome. The 1.x snapshot
`~/nanoclaw-prod-data-20260506-1249.tgz` was extracted to
`/tmp/nanoclaw-1x-extract/` for inspection.

## What the doc anticipated vs what was actually there

The doc described a `nanoclaw.db` with sender allowlists, per-chat
config, learned facts to triage table-by-table. **The four DBs
(`nanoclaw.db`, `messages.db`, `chats.db`, `nanoclaw.sqlite`) were
all 0 bytes in the snapshot.** The 381 MB tar size is in `ipc/`
(306 MB) and `sessions/` (146 MB), neither of which has a clean
import path.

## Decisions

| Item | Action | Why |
|---|---|---|
| `recipients.json` (476 entries) | **Ported** to `~/nanoclaw-merge/data/recipients.json`, `scripts/send-message.py` REGISTRY_PATH updated | Hand-curated alias registry. Survives future `~/nanoclaw` cleanup. |
| `wa-participants.json` (352 KB) | **Defer** | Only useful once Section 5 (WhatsApp) is wired; can re-extract from the tar then. |
| `sessions/` (146 MB) | **Skip** | No clean import path into 2.0's per-session `data/v2-sessions/<sid>/{inbound,outbound}.db` shape. Tar is the archive. |
| `ipc/` (306 MB) | **Skip** | Operational scratch, not historical data. |
| 1.x `data/env/env` | **Skip** | 1.x-specific knobs (`MAIN_GROUP_FOLDER`, `IDLE_TIMEOUT`, `SIGNAL_DEFAULT_TIER`, `SIGNAL_ONLY`, `MEETING_PREP_*`, `VOICE_API_*`). 2.0 either renamed or moved into config files. The carefully reconstructed 2.0 `.env` from cutover is authoritative. |
| `learned-facts-state.json` | **Skip** | Pipeline retired in Section 6. |
| `clawcon-compressed.mp3` | **Skip** | Unrelated audio. |
| `nanoclaw.db`, `messages.db`, `chats.db`, `nanoclaw.sqlite` | **Skip** | All 0 bytes in the snapshot. |

## send-message.py status

After the port, `python3 scripts/send-message.py list` and
`python3 scripts/send-message.py resolve <query>` work against the
ported recipients. The `send` and `init` actions still depend on
`IPC_BASE` (1.x scratch path) and `DB_PATH` (1.x DB) which point at
`~/nanoclaw/`. Those code paths need a separate 2.0 port — out of
scope for Section 8.

## Tar retention

Keep `~/nanoclaw-prod-data-20260506-1249.tgz` indefinitely as
archeology. Re-extract with:

```bash
tar xzf ~/nanoclaw-prod-data-20260506-1249.tgz -C /tmp/nanoclaw-1x-extract
```
