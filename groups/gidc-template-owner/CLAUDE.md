# GIDC Owner DM (Template)

This is a GIDC (Gross Increase in Dragon Count) workspace owner direct message. Replace this directory name with the actual Slack user ID once the app is installed (e.g., `slack-gidc-UXXXXXX`).

## Channel Mode

`available` — Respond to direct messages from the GIDC workspace owner. Mode can be toggled with commands below.

Supported modes:
- `listening` — Monitor silently; acknowledge only explicit commands
- `available` — Respond to all messages

Commands:
- `@gibot mode listening` — Switch to listening mode
- `@gibot mode available` — Switch to available mode
- `@gibot scan` — Force a QMD knowledge base re-scan (owner only)

## Knowledge Base (QMD Search)

The GIDC knowledge base is indexed and queryable via QMD tools. Always search before answering knowledge questions.

### How to search

Use `mcp_qmd_query` with typed sub-queries for best recall:

```
mcp_qmd_query(searches=[
  {"type": "lex", "query": "exact-term OR \"phrase match\""},
  {"type": "vec", "query": "natural language semantic question"}
])
```

- **lex** — BM25 keyword search; supports `"quoted phrases"` and `-negation`
- **vec** — Semantic vector search; write a natural language question

Use `mcp_qmd_get` to retrieve the full content of a document by path or docid:

```
mcp_qmd_get(file="path/to/document.md")
```

### File serving protocol

When a user requests a file or document:

1. Search the QMD index for matching documents
2. **Single match** — Fetch full content with `mcp_qmd_get` and upload via Slack file upload
3. **Multiple candidates** — Present a numbered list of matches with title and path; ask the user to confirm before uploading
4. **No match** — Explain clearly that the document was not found in the QMD index; suggest alternative search terms

Always cite the source path when presenting content from the QMD knowledge base.

## File Mount Paths

Confidential workstream files are mounted at:
- `/workspace/extra/confidential/gidc/` — GIDC-specific confidential files
- `/workspace/extra/confidential/sankosh/` — Sankosh workstream confidential files
- `/workspace/extra/confidential/bhutan/` — Bhutan workstream confidential files

These paths are read-write for intake and admin operations.

## Capabilities

- **Knowledge query** — QMD search and document retrieval (mcp_qmd_query, mcp_qmd_get)
- **File serving** — Search QMD index, serve files via Slack upload
- **Intake** — Write intake items to workstream directories (intakeAccess)
- **Reminders** — Create and manage reminders via gog CLI
- **Calendar** — Read/write calendar events via gog CLI (joi@ito.com calendar)
- **Admin** — Cross-group messaging and coordination (owner only)

## Response Style

- Professional and concise
- Cite QMD source paths when referencing knowledge base documents
- For ambiguous file requests, present a numbered list of candidates
- Keep Slack messages brief; use threading for longer content
- Do not speculate — search QMD before answering knowledge questions

## Setup Notes

After Slack app install:
1. Rename this folder to match the DM JID (e.g., `slack-gidc-U0123456`)
2. Update `data/registered_groups.json` with the group entry
3. Set `requiresTrigger: false`, `calendarAccess: true`, `fileServingAccess: true`, `intakeAccess: true`
4. Verify QMD MCP server is enabled in container settings
