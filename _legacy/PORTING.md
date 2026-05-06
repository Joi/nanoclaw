# Porting plan: NanoClaw 1.2.49 → 2.0.33

Generated 2026-05-06 during Phase 3 of the upstream-merge work. Captures
everything needed to re-port the fork's custom features onto 2.0's
module-based architecture.

## What just happened

Upstream `qwibitai/nanoclaw` shipped a major rewrite between our last sync
and 2026-04. The `/update` skill applied it cleanly (no merge conflicts,
because the skills system was uninitialized so `.nanoclaw/base/ == current`
made every 3-way merge resolve straight to upstream). Net effect:

- 162 files replaced with 2.0 versions
- 122 files **deleted** unconditionally
- `npm run build` clean
- `npm test` → 420 passing, 4 skipped (test count is upstream's own)

The fork's 1.x customizations are not in the new tree. They are preserved
verbatim in the locations below.

## Where the old code lives

| Artifact | Location | Purpose |
|---|---|---|
| Pre-merge tag | `pre-2.0-merge` (commit `e0c70c7`) | git-show / git-checkout reference for any pre-update file |
| Snapshot tree | `_legacy/v1.2.49/` (141 files, 1.3 MB) | Browse pre-update source directly without git gymnastics |
| Fork-delta patch | `_legacy/meta/fork-delta.patch` (43k lines) | Single diff of all 236 fork commits since merge-base `226b520` (last upstream sync point) |
| Full commit list | `_legacy/meta/fork-commits.txt` (236 lines) | Every fork commit with date and subject — for cherry-pick selection |
| Filtered commit list | `_legacy/meta/fork-commits-touching-deleted.txt` (119 lines) | Subset that touches files 2.0 deleted/changed |
| Snapshot commit | `d4ac463` | The commit where the snapshot landed, immediately before the merge |
| Merge commit | (HEAD~1) | The 1.2.49 → 2.0.33 application |

## Architectural delta — what changed at the structural level

| Concern | 1.x | 2.0 |
|---|---|---|
| Channel impls | All in `src/channels/{signal,slack,whatsapp,...}.ts` (ship in main) | Only `src/channels/cli.ts` ships. Other channels live on a `channels` branch upstream, pulled in via `/add-<name>` skills |
| Channel interface | Ad-hoc per file | `ChannelAdapter` in `src/channels/adapter.ts` (`onInbound`, `onMetadata`, `onAction`) + Chat SDK bridge for SDK-backed adapters |
| Feature wiring | Direct imports in `src/index.ts` | Self-registering modules in `src/modules/*` (approvals, interactive, permissions, scheduling, agent-to-agent, self-mod, mount-security, typing) |
| DB | Single `src/db.ts` | `src/db/{connection,schema,sessions,messaging-groups,...}.ts` + numbered migrations in `src/db/migrations/` |
| IPC | `src/ipc.ts` watcher + `src/agent-api.ts` | `src/webhook-server.ts` + module-installed handlers; `src/delivery.ts` for outbound polls |
| Container runtime | `src/container-runner.ts` | `src/container-runtime.ts` (lifecycle) + `src/container-runner.ts` (spawn) + `src/container-config.ts` |
| Agent runner | Bun script with Claude SDK | `container/agent-runner/` with provider abstraction (`providers/{claude,mock}`), MCP tool tier (`mcp-tools/{core,interactive,scheduling,agents,self-mod}`) |
| Skills surface | `container/skills/{capabilities,document-extractor,gog-calendar,meeting-prep,process-email,...}` | Slimmer set: `frontend-engineer`, `self-customize`, `vercel-cli`, `welcome` |

## Custom features to port — by priority

Each entry: **what it does**, **legacy location**, **commits**, **2.0 target**, **difficulty**.

### Tier 1 — recently shipped, business-critical

#### 1. amplifier-remote runner (PR #3, joi-1l51 series)
- **What:** NanoClaw → remote Amplifier pipe. Lets the agent dispatch sessions to a remote `amplifierd` daemon over SSH-tunneled HTTP, with retry/recovery, working-dir isolation per session, 256KB prompt cap, node:http transport.
- **Legacy:** `_legacy/v1.2.49/src/runners/amplifier-remote/{client,index,safety}.ts` (+ `.test.ts` siblings)
- **Commits to port:** `32e682d` (initial feat), `51c7e0f` (stale-session recovery), `08ff14f` (node:http), `1e9a7b4` (256KB cap), `f5649d9` (per-session WORKING_DIR), `cac1453` (intake bare-URL piece intersects)
- **2.0 target:** Likely `src/providers/amplifier-remote.ts` alongside `src/providers/claude.ts`. The 2.0 provider abstraction is the natural seam — `src/providers/claude.ts` already exists, and the agent runner has its own `providers/` tier inside `container/agent-runner/src/providers/`. Decide whether amplifier-remote belongs at the orchestrator level (host-side) or the runner level (in-container).
- **Difficulty:** Medium-high. The provider interface is new; signatures will need adapting. Tests are pre-written and should give a good shape to mirror.

#### 2. Bare-URL auto-intake (joi-k1x9, cac1453)
- **What:** When a message contains nothing but a URL, route it to the knowledge-intake sprite for auto-summary into the workstream.
- **Legacy:** `_legacy/v1.2.49/src/intake.ts`, `_legacy/v1.2.49/src/url-intake.ts`, `_legacy/v1.2.49/src/intake-routing.ts`
- **Commit:** `cac1453`
- **2.0 target:** Likely a new module `src/modules/intake/`. The 2.0 module pattern (`agent.md` + `project.md` + `index.ts`) is the right shape. No exact upstream equivalent — port idiomatically.
- **Difficulty:** Medium. Logic is self-contained; just needs new wiring.

#### 3. executePrompt 256KB cap (1e9a7b4) and node:http transport (08ff14f)
- **What:** Reject prompts > 256KB at the runner boundary; use `node:http` instead of `globalThis.fetch` in the amplifier-remote client.
- **Legacy:** Embedded in `_legacy/v1.2.49/src/runners/amplifier-remote/{client,safety}.ts`
- **2.0 target:** Whatever the new amplifier-remote port becomes (see #1).
- **Difficulty:** Trivial once #1 is in flight.

### Tier 2 — channel customizations (most should go to the `channels` branch)

In 2.0 each non-CLI channel is its own skill installable via `/add-<name>`. Channel-internal fixes should live in the channel module on the upstream `channels` branch, not in main. Strategy: install each channel via the new skill, then port the relevant fix into the installed adapter file.

| Feature | Commits | Legacy file | 2.0 path after `/add-<channel>` |
|---|---|---|---|
| WhatsApp Baileys 120s init-query timeout | `de21888` | `_legacy/v1.2.49/src/channels/whatsapp.ts` | `src/channels/whatsapp.ts` (after `/add-whatsapp`) |
| WhatsApp `@lid` JID handling | `c511bad` | same | same |
| Signal mention expansion | (older) | `_legacy/v1.2.49/src/channels/signal.ts` | `src/channels/signal.ts` (after `/add-signal`) |
| Signal groups not classified as DMs | `bd1b470` | `_legacy/v1.2.49/src/access-control.ts` | Likely `src/modules/permissions/` |
| Slack multi-alias handle resolution | `a3128a7` | `_legacy/v1.2.49/src/channels/slack.ts` | `src/channels/slack.ts` (after `/add-slack`) |
| Slack outgoing @mentions | `ef171d6` | same | same |
| Telegram isDm for group chats | `5854bc7` | `_legacy/v1.2.49/src/channels/telegram.ts` | `src/channels/telegram.ts` (after `/add-telegram`) |
| LINE channel (whole) | `380f4e8`, `ff5c939`, `f194607`, `ced3f95` | `_legacy/v1.2.49/src/channels/line.ts` | New: needs `/add-line` skill or contribution to upstream `channels` branch |
| Discord @mentions in-place + JID handling | `542b0a9`, `d8a9cbb`, `fe3bd7c` | `_legacy/v1.2.49/src/channels/discord.ts` | `src/channels/discord.ts` (after `/add-discord`) |

### Tier 3 — email pipeline

The fork has ~20 email-related files (intake, intent resolver, identity resolver, alias map, attachment filter, calendar/reminder adapters, receipt, reply sanitizer, thread session/failure tracker, policy adapter, address parser, approval gate). 2.0 deleted all of them and ships no email.

- **Legacy:** `_legacy/v1.2.49/src/email-*.ts` (all in one place)
- **Commits:** `7d1ac8c` (circuit breaker), `4c489ab` (poll interval), plus older email work
- **2.0 target:** Almost certainly belongs in a new `/add-gmail` flow + `src/modules/email/` or similar. The available `/add-gmail` skill (in this repo's skills list) suggests upstream has a Gmail integration path — start there.
- **Difficulty:** High. Big surface area. Recommend treating as a follow-up project rather than blocking the merge.

### Tier 4 — container security hardening

Must be re-applied to `container/Dockerfile` and `container/entrypoint.sh` (both replaced by 2.0 versions). All three are seccomp/capability/setuid hardening — review the new files first to see what 2.0 already does, then layer on what's missing.

- `8c02b82` — block AF_ALG via seccomp (CVE-2026-31431)
- `aa63434` — strip `su` and other setuid bins (CVE-2026-31431)
- `d4c952e` — drop all Linux capabilities from agent spawn
- `bb1a449` — seccomp test pinning EPERM, abs-path regex
- **Legacy:** `_legacy/v1.2.49/container/` and the `scripts/test-af-alg-block.sh` script (still in `scripts/`, not deleted)
- **2.0 target:** `container/Dockerfile`, `container/entrypoint.sh`, possibly `src/modules/mount-security/` (which 2.0 already has — review first)

### Tier 5 — orchestrator-level customizations

- **GIDC commands** (`gidc-commands.ts`, intake routing): no obvious 2.0 equivalent. Probably `src/modules/gidc/`.
- **sender-allowlist** (`sender-allowlist.ts`): 2.0 has `src/modules/permissions/` with channel-approval and sender-approval tables. Likely already covers this — review before porting.
- **agent-api** (port 3200, `agent-api.ts`): 2.0 has `src/webhook-server.ts`. Different model — agent-api might be obsolete or fold into webhook-server.
- **self-registration name validation** (`b9fdf5a`): port the regex into wherever 2.0 handles user-name capture.
- **Listening modes** (`listening-modes.ts`, commit `32a1e05`): 2.0 has `src/db/migrations/010-engage-modes.ts` — review first; may already be covered.
- **People context, observations, moderation, reminders, remote-control, user-snapshot, workstream-routing**: all deleted in 2.0. Each needs an evaluate-then-port-or-drop call. Many may be obsolete given the new module model.

### Tier 6 — script-level features (mostly preserved as scripts)

These were not affected by the merge (still present in `scripts/` and `container/scripts/`). No port needed; just verify they still work against 2.0:

- `scripts/qmd-*` (fleet, reindex)
- `scripts/bookmark-relay.py`
- `scripts/extract-*.py`, `scripts/review-learned-facts.py`
- `scripts/reminders-bridge.py`
- `scripts/telegram-relay`
- `scripts/generate-groups-review.py`
- `scripts/audit-access.mjs`

## Custom commits index

`_legacy/meta/fork-commits.txt` lists all 236 fork commits.
`_legacy/meta/fork-commits-touching-deleted.txt` is the 119-commit subset that touched files 2.0 deleted or changed — the most relevant for porting decisions.

To inspect any commit: `git show <sha>` (commits remain in history because no rebase happened).

To produce a focused diff of just one feature surface:
```bash
git log --oneline 226b520..pre-2.0-merge -- src/runners/
git diff 226b520..pre-2.0-merge -- src/runners/
```

## Recommended porting sequence

1. **amplifier-remote** (Tier 1 #1+3) — most recent, most valuable, smallest surface. Get `src/providers/amplifier-remote.ts` working with tests passing. Establishes the porting pattern.
2. **bare-URL intake** (Tier 1 #2) — exercises the new module shape.
3. **container hardening** (Tier 4) — small focused diffs against 2.0's Dockerfile.
4. **install needed channels via `/add-<name>`** then port channel-internal fixes (Tier 2).
5. **email pipeline** (Tier 3) — large project, schedule separately.
6. **orchestrator-level survivors** (Tier 5) — evaluate each against 2.0 first.

## Production cutover

Production NanoClaw still runs from `~/nanoclaw` (on `main`, untouched).
This worktree is `~/nanoclaw-merge` on `chore/upstream-merge-2026-05`.
Cutover should not happen until **at minimum Tiers 1 and 4 are ported** —
without amplifier-remote, the existing automation breaks; without container
hardening, you regress security posture.
