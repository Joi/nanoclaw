# Design: NanoClaw IPC sendFile

**Status:** Approved
**Date:** 2026-04-30
**Beads:** `jibot-code-0ps` — *NanoClaw IPC: wire sendFile through JSON IPC so jibot can send document attachments (WhatsApp / Slack / etc.)*
**Author:** Joi (with Amplifier/jibot)

## Problem

NanoClaw's channel layer exposes `IpcDeps.sendFile(jid, filePath, filename)`, and `SlackChannel` implements it. But the JSON IPC dispatcher in `src/ipc.ts` only handles `data.type === 'message'` (text). There is no IPC `type` that triggers `deps.sendFile`, so `scripts/send-message.py` and any agent using it can only send text.

Discovered 2026-04-30 while sending the Bhutan Tea onboarding PDF to the "Joi / Haruna / Yoko" WhatsApp group. Worked around by sending the PDF's Drive folder path in a text message — both recipients have Drive access, so it landed — but a true document attachment is the right primitive.

## Goal

Add a `type: "file"` IPC variant that lets agents send local files (PDFs, etc.) as proper document attachments through any channel that implements `sendFile`. WhatsApp gets a new `sendFile` implementation; Slack gets a small extension to accept an optional caption.

## Architecture

Three-layer change, mirroring the existing `"message"` flow exactly:

```
Caller (jibot agent / CLI)
  └─ scripts/send-message.py send-file <recipient> <path> [caption] [--as <name>]
       └─ writes JSON to ~/nanoclaw/data/ipc/<group>/messages/{ts}-{uuid}.json
            { type: "file", chatJid, filePath, filename, mimetype, caption? }
  └─ src/ipc.ts watcher picks up the file
       └─ same authorization check as "message": isMain || targetGroup.folder === sourceGroup
       └─ deps.sendFile(jid, filePath, filename, mimetype, caption?)
            ├─ src/channels/whatsapp.ts → sock.sendMessage(jid, {document:{url:filePath}, fileName, mimetype, caption})
            └─ src/channels/slack.ts    → filesUploadV2({channel_id, file:createReadStream(...), filename, initial_comment:caption})
```

## Components

### 1. IPC payload typing (`src/ipc.ts`)

Today `data` is treated as untyped. With a second variant arriving, type discrimination earns its keep:

```ts
interface MessageIpcPayload { type: "message"; chatJid: string; text: string; }

interface FileIpcPayload {
  type: "file";
  chatJid: string;
  filePath: string;     // absolute path on jibotmac
  filename: string;     // display name; CLI defaults to basename
  mimetype: string;     // CLI infers via Python mimetypes
  caption?: string;     // optional; forwarded to both channels
}

type IpcPayload = MessageIpcPayload | FileIpcPayload;
```

### 2. `IpcDeps.sendFile` contract (`src/ipc.ts:17`)

| | Old | New |
|---|---|---|
| Signature | `(jid, filePath, filename) => Promise<void>` | `(jid, filePath, filename, mimetype, caption?) => Promise<void>` |
| Implementers today | Slack only | Slack (extended) + WhatsApp (new) |

Backward-compatible additions: WhatsApp needs `mimetype`; both channels benefit from `caption`. Slack ignores `mimetype` (its API auto-detects). Both channels accept the same shape so the dispatcher stays clean.

### 3. IPC dispatcher branch (`src/ipc.ts`, after the existing `"message"` block ~line 100)

```ts
} else if (
  data.type === "file" &&
  data.chatJid && data.filePath && data.filename && data.mimetype
) {
  const targetGroup = registeredGroups[data.chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
    await deps.sendFile(data.chatJid, data.filePath, data.filename, data.mimetype, data.caption);
    logger.info(
      { chatJid: data.chatJid, filename: data.filename, sourceGroup },
      "IPC file sent",
    );
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      "Unauthorized IPC file attempt blocked",
    );
  }
}
```

### 4. WhatsApp `sendFile` (`src/channels/whatsapp.ts`)

```ts
async sendFile(
  jid: string,
  filePath: string,
  filename: string,
  mimetype: string,
  caption?: string,
): Promise<void> {
  if (!this.connected) {
    throw new Error("WhatsApp disconnected; cannot send file");
  }
  try {
    await this.sock.sendMessage(jid, {
      document: { url: filePath },   // Baileys streams from disk
      fileName: filename,
      mimetype,
      caption,
    });
    logger.info({ jid, filename, mimetype, captionLen: caption?.length }, "WA file sent");
  } catch (err) {
    logger.error({ jid, filename, err }, "Failed to send WA file");
    throw err;
  }
}
```

Decisions baked in:

- **Stream via `{url: filePath}`** rather than `fs.readFileSync` — file payloads can be MB-scale; Baileys handles disk streaming.
- **Fail fast on disconnect** rather than queueing. The existing `outgoingQueue` for `sendMessage` is text-only by design; queueing files in memory across reconnects is bad form. Caller retries.
- **No assistant-name prefix.** `sendMessage` prepends "jibot:" on shared-number setups; `sendFile` does NOT — the document carries its own context, and the optional `caption` is the right place for any prose.

### 5. Slack `sendFile` extension (`src/channels/slack.ts:127`)

Three meaningful changes: signature gains `mimetype` and `caption`, and `initial_comment` is forwarded when the caption is present.

```ts
async sendFile(
  jid: string,
  filePath: string,
  filename: string,
  _mimetype: string, // accepted for signature symmetry; Slack auto-detects
  caption?: string,
): Promise<void> {
  const channelId = await this.resolveChannelId(jid);
  try {
    await this.app.client.filesUploadV2({
      channel_id: channelId,
      file: fs.createReadStream(filePath),
      filename,
      ...(caption ? { initial_comment: caption } : {}),
    });
    logger.info({ jid, filename, captionLen: caption?.length }, "Slack file uploaded");
  } catch (err) {
    logger.error({ jid, filename, err }, "Failed to upload Slack file");
    throw err;
  }
}
```

### 6. `send-message.py cmd_send_file` (`scripts/send-message.py`)

Argument shape:

```
send-file "<recipient>" "<file-path>" ["<caption>"] [--as "<filename>"]
```

`caption` is positional and optional (matches the `send` pattern where the second arg is text). `--as` overrides the display filename; default is `os.path.basename(filePath)`.

Validation order:

1. `os.path.isfile(filePath)` — file must exist and be a regular file.
2. `os.access(filePath, os.R_OK)` — file must be readable by the current user (jibot).
3. `resolve_recipient(query, recipients)` — recipient must resolve via the existing flow.
4. `mimetypes.guess_type(filename)` — falls back to `application/octet-stream` if unknown.
5. `resolve_ipc_group(key, entry)` — same dispatch as `cmd_send`.

Output JSON shape (matches §1):

```json
{
  "type": "file",
  "chatJid": "<jid>",
  "filePath": "<absolute path>",
  "filename": "<display name>",
  "mimetype": "<inferred or octet-stream>",
  "caption": "<text>"
}
```

`caption` field omitted entirely when not provided (cleaner than emitting `null`).

Success output (stdout JSON, matching `cmd_send`):

```json
{
  "status": "sent",
  "recipient": "<key>",
  "jid": "<jid>",
  "channel": "<channel>",
  "ipc_group": "<group>",
  "ipc_file": "<path>",
  "filename": "<display name>",
  "mimetype": "<mimetype>",
  "caption_preview": "<truncated>"
}
```

### 7. `jibot-messaging` skill (`~/dotfiles-private/amplifier/skills/jibot-messaging/SKILL.md`)

- Add `send-file` row to the **Commands** table (next to `send`, `email`).
- Add a **Sending Files** subsection with the smoke-test invocation.
- Add an example for the Bhutan Tea use case (`bhutan-tea-wa`).

## Test plan (TDD-respecting)

NanoClaw uses **vitest** (`npm run test`). Existing channel-mocking patterns are in `src/channels/whatsapp.test.ts` and `src/channels/slack.test.ts`. For the Python CLI, current tests live (or will live) under `scripts/` or a dedicated `tests/` directory — to be confirmed during planning.

| Layer | Test surface | Approach |
|---|---|---|
| **send-file CLI** | path missing → exit 1 + clear error; unreadable → exit 1; recipient unresolvable → exit 1; happy path writes correct IPC JSON to right `ipc_group` directory | pytest with `tmp_path` + monkeypatched `IPC_BASE` and `REGISTRY_PATH` |
| **IPC dispatcher** | `"file"` branch: auth pass → `deps.sendFile` invoked with `(jid, filePath, filename, mimetype, caption)`; auth fail → blocked, warned; missing required field → file consumed (`unlinkSync`) without sending, matching the existing `"message"` handler behavior | vitest, mocked `IpcDeps`; new or extended `src/ipc.test.ts` (verify in planning whether file exists) |
| **WhatsApp sendFile** | Calls `sock.sendMessage(jid, {document:{url}, fileName, mimetype, caption})` shape; throws when disconnected | Extend `src/channels/whatsapp.test.ts`, mock `sock` |
| **Slack sendFile** | `initial_comment` included when caption provided, omitted when not; mimetype param accepted but unused | Extend `src/channels/slack.test.ts`, mock `app.client.filesUploadV2` |
| **End-to-end (acceptance)** | Bhutan Tea onboarding PDF → `bhutan-tea-wa` group → recipient sees a real document attachment, not a text path | Manual smoke test post-merge after `launchctl kickstart -k gui/$(id -u)/com.jibot.nanoclaw` |

**TDD order** (writing-plans will turn this into bite-sized tasks):

1. RED → GREEN: Python `cmd_send_file` happy path (writes correct IPC JSON)
2. RED → GREEN: Python validation (missing file, unreadable, unresolved recipient)
3. RED → GREEN: vitest `WhatsAppChannel.sendFile` happy path + disconnect throw
4. RED → GREEN: vitest dispatcher `"file"` branch (allow + deny)
5. RED → GREEN: vitest Slack caption forwarding (with + without caption)
6. `npm run build` → `launchctl kickstart` → smoke-test the Bhutan Tea PDF → observe in WhatsApp

## Files touched

Repo: **`~/repos/nanoclaw`** (origin: `git@github-nanoclaw:Joi/nanoclaw.git`). Skill update lives in **`~/dotfiles-private/amplifier/skills/`**.

| Path | Change |
|---|---|
| `src/ipc.ts` | Add `IpcPayload` discriminated union; extend `IpcDeps.sendFile` signature; add `"file"` dispatcher branch |
| `src/channels/whatsapp.ts` | Implement `sendFile` |
| `src/channels/slack.ts` | Extend `sendFile` to accept `mimetype` + `caption`, forward `caption` as `initial_comment` |
| `src/channels/whatsapp.test.ts` | Add `sendFile` happy-path + disconnect tests |
| `src/channels/slack.test.ts` | Add `sendFile` caption-forwarding tests |
| `src/ipc.test.ts` *(new or extended — TBD)* | Add `"file"` dispatcher branch test |
| `scripts/send-message.py` | Add `cmd_send_file` |
| `tests/test_send_message.py` *(new or extended — TBD)* | Add `cmd_send_file` tests |
| `~/dotfiles-private/amplifier/skills/jibot-messaging/SKILL.md` | Document the new command |

## Resilience: timeout protection

Both channels' `sendFile` wrap their underlying transport call (Baileys `sock.sendMessage` for WhatsApp; `app.client.filesUploadV2` for Slack) in `Promise.race` with a 60-second timeout. On timeout, an `Error` is thrown with a descriptive message including the JID and filename, allowing the caller (`startIpcWatcher` and any direct invokers in `index.ts`) to log and skip rather than wedge the watcher loop.

This was added in response to beads `jibot-code-tel`, where production NanoClaw exhibited apparent "wedges" on file sends that could not be reproduced in isolation. Diagnostic work showed:

- **Standalone Baileys** sends the same PDF to the same group with the same auth state in 1.98 s.
- **Standalone Slack `filesUploadV2`** completes in 2.65 s with no event-loop blocking.
- **Production NanoClaw** is the only environment where the hang reproduces, and the hang point shifts (sometimes mid-Baileys-encryption, sometimes silently early in the Slack pipeline).

The leading hypothesis is event-loop pressure from concurrent NanoClaw work — most prominently a hot retry loop in the email channel (`Email channel: failed to get thread` firing every 2 minutes lifetime). Those underlying causes are tracked separately in beads `jibot-code-r8y` (email retry loop) and `jibot-code-5m2` (Baileys init queries intermittent timeout). The timeout-wrap here doesn't fix the root cause — it makes the symptom recoverable instead of catastrophic.

60 s is comfortable for typical document sizes (<5 MB) over residential broadband. Larger files or worse networks may require revisiting; if so, parameterize via channel constructor opts.

## Out of scope

Per the originating beads issue:

- **Inbound media handling** — already works (`whatsapp.ts:230-267`).
- **Image / video / audio sends** — same Baileys mechanism would extend, but document/PDF is the immediate need.
- **Drive → WhatsApp upload pipeline** — orthogonal; this design covers local-path → channel only.

## Risks & things to verify in planning

1. **Test file existence** — saw `access-control.test.ts`, `db.test.ts`, channel tests in the listing, but no `ipc.test.ts` or `tests/test_send_message.py`. Planning will confirm and create as needed.
2. **Husky pre-commit hooks** — `package.json` shows `prepare: husky` plus eslint/prettier scripts. All tests + lint must pass before commit lands. The repo also enables `eslint-plugin-no-catch-all`, which constrains how exception handlers are written.
3. **mimetype unknowns** — `mimetypes.guess_type` returns `(None, None)` for unrecognized extensions; the `application/octet-stream` fallback works for Baileys but renders less nicely in WhatsApp UI. Acceptable for v1; future work can ship a curated mimetype map if it matters.
4. **File reachability from jibotmac** — the IPC payload references an absolute path, which must be readable by the `jibot` user at the time the dispatcher picks it up. Files outside common shared paths need to be staged via `scp` or pulled via the configured `joi-drive:` rclone remote first. The `send-file` CLI runs on jibotmac, so the path it sees is jibotmac-local.
5. **WhatsApp connection state at smoke-test time** — Baileys can be disconnected; `sendFile` will throw. Smoke test should verify connection health first (or just retry once).

## Acceptance criteria (from beads issue `jibot-code-0ps`)

- [ ] `send-file` subcommand sends a PDF to a WhatsApp group and the recipient sees it as a document, not a text path.
- [ ] Authorization check applies: a group cannot send files to chatJids it doesn't own (matching the existing `"message"` policy).
- [ ] Slack `send-file` continues to work (existing `slack.ts` `sendFile` still functions; `initial_comment` is forwarded when caption provided).
- [ ] `jibot-messaging` skill updated with the new command.
- [ ] Test target: send `2026-04-30-cowork-onboarding-haruna-yoko.pdf` to `bhutan-tea-wa` as a real document attachment.
