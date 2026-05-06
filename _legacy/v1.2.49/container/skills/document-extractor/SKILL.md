---
name: document-extractor
description: Process documents (PDFs, images) dropped into chat. Extract text, OCR if needed, create a jibrain knowledge base entry, and store the original file.
allowed-tools: Bash(pdftotext:*), Bash(tesseract:*), Bash(pdfinfo:*), Bash(file:*), Bash(cp:*), Bash(mkdir:*), Bash(cat:*), Bash(wc:*)
---

# Document Extractor

When the user drops a file into chat, it arrives as a message with an `[Attached: ...]` annotation indicating the file path at `/workspace/ipc/input/<filename>`.

## Context notes

The user often sends a text note alongside the file, e.g.:

- `from Dave Morin about the investment memo`
- `Audrey Tang sent this - policy brief on AI governance`
- `MIT Media Lab annual report`

Parse this note to extract:
- **Who sent it** (`source_from`) — the person who provided the document
- **What it's about** (`source_context`) — brief description of why it was shared
- **Any tags** — people, organizations, topics mentioned in the note

If there's no note, infer what you can from the document itself.

## Supported formats

| Format | Tool | Command |
|--------|------|---------|
| PDF | pdftotext (poppler-utils) | `pdftotext /path/to/file.pdf -` |
| Image (jpg, png, etc.) | tesseract | `tesseract /path/to/image.png stdout` |

## Workflow

### 1. Identify the file

```bash
file /workspace/ipc/input/<filename>
```

### 2. Extract text

**PDF:**
```bash
# Get page count and metadata
pdfinfo /workspace/ipc/input/<filename>

# Extract all text
pdftotext /workspace/ipc/input/<filename> -
```

If `pdftotext` returns little or no text (scanned PDF), fall back to OCR:
```bash
# Convert PDF pages to images, then OCR (one page at a time)
# For large PDFs, focus on the first ~10 pages
pdftotext /workspace/ipc/input/<filename> /tmp/extracted.txt
wc -w /tmp/extracted.txt
# If word count is very low relative to page count, it's likely scanned
```

**Image:**
```bash
tesseract /workspace/ipc/input/<filename> stdout
```

### 3. Store original file in jibrain

Copy the original file to a `documents/` subdirectory in jibrain intake:

```bash
mkdir -p /workspace/extra/jibrain/intake/documents
cp /workspace/ipc/input/<filename> /workspace/extra/jibrain/intake/documents/<clean-name>
```

Use a clean, descriptive filename (keep original name if sensible, otherwise kebab-case).

### 4. Create jibrain extraction

Write a markdown extraction to `/workspace/extra/jibrain/intake/<kebab-case-title>.md`:

```markdown
---
type: reference
source: document
source_file: documents/<clean-name>
source_from: <person who sent/shared it, if mentioned in the note>
source_context: <why it was shared, from the note>
source_date: YYYY-MM-DD
tags: [<relevant tags — include person names, org names, topics>]
status: draft
agent: document-extractor
---

# <Document Title>

> <One-line summary of the document>

## Provenance

- **From:** <who sent it> (or "unknown" if no note)
- **Context:** <why it was shared / what it's about>

## Key Points

- <Main takeaway 1>
- <Main takeaway 2>
- ...

## Full Text

<Extracted text, cleaned up for readability. Remove headers/footers/page numbers.
For very long documents (>5000 words), summarize with key sections rather than
including everything verbatim.>
```

### 5. Respond to the user

Send a brief summary:
```
Processed: <filename> (from <person>, re: <context>)
- <page count> pages, <word count> words extracted
- Saved to jibrain/intake/<extraction-name>.md
- Original stored at jibrain/intake/documents/<clean-name>

Key points:
- <2-3 sentence summary of what the document is about>
```

## Guidelines

- **Be concise in the response** — the full extraction is in jibrain, just give highlights
- **Classify with tags** — use tags that match jibrain conventions (topics, domains, people mentioned)
- **Handle failures gracefully** — if OCR produces garbage, note it and store what you can
- **Large documents** — for PDFs over 20 pages, extract and summarize rather than including full text
- **Link to atlas** — if the document or note mentions people/orgs already in jibrain atlas, note the connections
- **Create person entities** — if `source_from` names someone not already in jibrain, create a draft person entity at `intake/<kebab-case-name>.md` (same format as meeting-prep skill)
- **source_file path** — use relative path from intake/ (e.g., `documents/annual-report-2025.pdf`)
