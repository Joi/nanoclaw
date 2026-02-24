---
name: meeting-prep
description: Prepare briefing notes for upcoming meetings. Uses the meeting-prep sprite to search joi@ito.com Gmail for context, plus jibrain knowledge base for attendee info.
allowed-tools: Bash(gog:*), Bash(meeting-prep:*), Bash(grep:*), Bash(find:*), Bash(cat:*), Bash(mkdir:*)
---

# Meeting Prep

Prepare briefing notes for upcoming meetings by gathering calendar, email, and knowledge base context.

## Tools

### `meeting-prep` command

Calls a remote sprite that searches **joi@ito.com Gmail** (last 30 days) for meeting-relevant context and returns a synthesized prep document. Raw email content never leaves the sprite — you get a markdown summary.

```bash
# Pipe gog calendar output directly
gog calendar events joi@ito.com -a jibot@ito.com --today --json | meeting-prep

# Or pass specific meetings
echo '{"meetings":[{"title":"Board Meeting","start":"2026-02-25T10:00:00+09:00","attendees":["ceo@example.com"],"description":"Quarterly review"}]}' | meeting-prep

# Or from a file
meeting-prep /tmp/meetings.json
```

The command automatically converts gog calendar event format to the sprite's API format (handles `summary` → `title`, `start.dateTime` → `start`, etc).

### `gog` command

Use gog for **calendar access** (via jibot@ito.com delegated access to joi@ito.com) and **jibot@ito.com email** searches.

```bash
# Calendar (joi@ito.com via jibot@ito.com delegation)
gog calendar events joi@ito.com -a jibot@ito.com --today --json
gog calendar event joi@ito.com <eventId> -a jibot@ito.com --json

# jibot@ito.com email (for jibot's own correspondence)
gog gmail list --account jibot@ito.com --query "from:<email>" --max 5
```

**Important:** Do NOT use gog for joi@ito.com Gmail — use `meeting-prep` instead.

## Workflow

### 1. Fetch calendar events

```bash
# Today's meetings
gog calendar events joi@ito.com -a jibot@ito.com --today --json

# Tomorrow's meetings
gog calendar events joi@ito.com -a jibot@ito.com --tomorrow --json
```

The user may ask for a specific day or range — adjust flags accordingly (`--from`, `--to`, `--days`).

### 2. Get email context via meeting-prep sprite

Pipe the calendar events to `meeting-prep` for joi@ito.com email context:

```bash
gog calendar events joi@ito.com -a jibot@ito.com --today --json | meeting-prep
```

This returns a markdown document with email context, talking points, and action items for each meeting. Use this as the primary source of email context.

### 3. Supplement with jibrain knowledge base

Look up attendees and topics in the knowledge base:

```bash
# Search for people by name
grep -ril "<attendee name>" /workspace/extra/jibrain/atlas/people/
grep -ril "<attendee name>" /workspace/extra/jibrain/atlas/organizations/

# Search for meeting topics
grep -ril "<topic>" /workspace/extra/jibrain/atlas/
grep -ril "<topic>" /workspace/extra/jibrain/domains/
```

Read any matching files for relevant context.

### 4. Create people entities for new attendees

For each attendee who does NOT already have a file in `atlas/people/` or `intake/`, create a draft person entity. Use what you know from the calendar event, the meeting-prep sprite response, and any jibrain context.

Write to `/workspace/extra/jibrain/intake/<kebab-case-name>.md`:

```markdown
---
type: person
source: meeting
source_meeting: "YYYY-MM-DD <meeting summary>"
source_date: YYYY-MM-DD
tags: [<relevant tags>]
status: draft
agent: meeting-prep
---

# <Full Name>

> <One-line description: role, organization, relationship to Joi>

## Context

- <What you know from the calendar event (role, why they're meeting)>
- <What the meeting-prep sprite found in email threads>
- <Any organizational affiliation>

## Connections

- [[<related atlas entity>]] - <relationship>
```

**Guidelines for people entities:**
- Only create for attendees you can identify (skip generic emails like `noreply@`, distribution lists)
- Check both `atlas/people/` AND `intake/` before creating — don't duplicate
- Use kebab-case filenames matching the person's name (e.g., `alice-smith.md`)
- Keep the description factual — only what's evident from calendar/email data
- Tag with relevant domains (e.g., `ai`, `policy`, `media`, `japan`, `startups`)
- Link to existing atlas entities where relevant (organizations, concepts)
- If you already found a person in jibrain during step 3, skip — they don't need a new entry

### 5. Write prep notes

**Note:** If a prep file already exists for this date, append to it rather than overwriting.

Write a prep file to jibrain intake:

```bash
mkdir -p /workspace/extra/jibrain/intake
```

Write to `/workspace/extra/jibrain/intake/meeting-prep-YYYY-MM-DD.md` with this format:

```markdown
---
type: meeting-extract
source: manual
source_date: YYYY-MM-DD
tags: [meeting-prep]
status: draft
agent: meeting-prep
---

# Meeting Prep — YYYY-MM-DD

## Meeting: <summary> (<time>)
**Attendees:** ...
**Context:** <what you found from sprite + jibrain>
**Key points:**
- ...
**Suggested questions/topics:**
- ...

## Meeting: <next meeting> (<time>)
...
```

### 6. Send briefing

Send a concise summary via `send_message`. Keep it scannable:

```
Meeting Prep — Feb 24

1. 10:00 Design Review with Alice, Bob
   → Last email: discussed new mockups (Feb 20)
   → jibrain: Alice is at MIT Media Lab

2. 14:00 Board Sync with Carol
   → Pending action items from last meeting
   → No recent emails

New people added to jibrain: Alice (MIT Media Lab)
Full notes saved to jibrain/intake/meeting-prep-2026-02-24.md
```

## Guidelines

- **Be concise** — the briefing should be scannable in 30 seconds
- **Prioritize actionable context** — pending action items, recent threads, open questions
- **Skip noise** — don't mention routine calendar metadata, focus on what helps prepare
- **Handle missing data gracefully** — if no emails or jibrain entries exist for an attendee, just note "no recent context" and move on
- **Respect time** — if there are 10+ meetings, summarize the top 5 most important and list the rest briefly
- **Timezone** — Joi is in JST (+09:00). Display times in local time.
- **Use meeting-prep for joi@ito.com email** — never try to access joi@ito.com Gmail directly via gog
