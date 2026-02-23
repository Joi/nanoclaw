---
name: gog-calendar
description: Access Google Calendar and Gmail via the gog CLI. Use for checking schedules, creating/updating/deleting events, searching emails, and any Google Workspace task.
allowed-tools: Bash(gog:*)
---

# Google Workspace CLI (gog)

## Authentication

gog is pre-authenticated as jibot@ito.com. Joi's calendar data lives under a different account:
- **Calendar:** ALWAYS use `joi@ito.com` as the calendar ID, never `primary`
- **Gmail:** ALWAYS use `--account jibot@ito.com`

## Calendar Commands

### List today's events
```bash
gog calendar events joi@ito.com --today
```

### List events for a date range
```bash
gog calendar events joi@ito.com --from "2026-02-23" --to "2026-02-24"
```

### List tomorrow's events
```bash
gog calendar events joi@ito.com --tomorrow
```

### List this week's events
```bash
gog calendar events joi@ito.com --week
```

### List next N days
```bash
gog calendar events joi@ito.com --days 7
```

### Search events
```bash
gog calendar search "meeting" --from today --days 30
```

### Get event details
```bash
gog calendar event joi@ito.com <eventId>
```

### Create an event
```bash
gog calendar create joi@ito.com \
  --summary "Meeting with Alice" \
  --from "2026-02-24T10:00:00+09:00" \
  --to "2026-02-24T11:00:00+09:00" \
  --description "Discuss project roadmap" \
  --location "Office" \
  --attendees "alice@example.com"
```

### Create all-day event
```bash
gog calendar create joi@ito.com \
  --summary "Team offsite" \
  --from "2026-03-01" \
  --to "2026-03-02" \
  --all-day
```

### Update an event
```bash
gog calendar update joi@ito.com <eventId> \
  --summary "New title" \
  --from "2026-02-24T14:00:00+09:00"
```

### Delete an event
```bash
gog calendar delete joi@ito.com <eventId> --force
```

### Check conflicts
```bash
gog calendar conflicts --from today --days 7
```

## Gmail Commands

### List recent emails
```bash
gog gmail list --account jibot@ito.com --max 10
```

### Search emails
```bash
gog gmail list --account jibot@ito.com --query "from:someone@example.com subject:invoice"
```

### Read an email
```bash
gog gmail get --account jibot@ito.com <messageId>
```

## Tips

- Always include timezone offset (+09:00 for JST) in datetime values
- Use `--json` flag for machine-readable output when processing results
- Use `--plain` for stable parseable text (TSV format)
- For recurring events, use `--scope single|future|all` when updating/deleting
- Use `--force` to skip confirmation prompts on destructive operations
