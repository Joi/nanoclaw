---
name: email-status
description: Quick read-only check of pending emails from the synced tracker. No pipeline trigger, no waiting. Use when user says "email status", "how many emails", "email count", "email summary", "pending emails".
---

# Email Status

## What This Does

Reads the email tracker file (synced from the desktop via Syncthing) and reports current counts. Instant — no pipeline trigger, no waiting. Just reads what's already there.

## Steps

### 1. Read the tracker and report

```bash
python3 << 'PYEOF'
import json
from pathlib import Path

tracker_path = Path('/workspace/extra/switchboard/email-tracker.json')

if not tracker_path.exists():
    print('No email tracker found. The desktop pipeline may not have run yet.')
    print('Say "process email" to trigger it.')
    exit(0)

try:
    data = json.loads(tracker_path.read_text())
except json.JSONDecodeError:
    print('Email tracker file is unreadable.')
    exit(0)

emails = data.get('emails', [])
pending = [e for e in emails if e.get('status') != 'done']
done = [e for e in emails if e.get('status') == 'done']

if not pending:
    last_sync = data.get('last_sync', 'unknown')
    print(f'No pending emails. {len(done)} done. Last sync: {last_sync}')
    exit(0)

# Count by category
counts = {}
for e in pending:
    cat = e.get('category', 'unknown')
    counts[cat] = counts.get(cat, 0) + 1

# Count high priority
high_count = sum(1 for e in pending if e.get('priority') == 'high')

# Count with drafts
with_drafts = sum(1 for e in pending if e.get('draft_preview'))

total = len(pending)
print(f'{total} pending emails:')
for cat in ['auto-approve', 'thoughtful-reply', 'quick-action', 'forward', 'read-only']:
    if counts.get(cat, 0) > 0:
        print(f'  {cat}: {counts[cat]}')
if counts.get('unknown', 0) > 0:
    print(f'  other: {counts["unknown"]}')
if high_count > 0:
    print(f'  ({high_count} high priority)')
if with_drafts > 0:
    print(f'  {with_drafts} have draft replies ready')
print(f'{len(done)} done')
last_sync = data.get('last_sync', 'unknown')
print(f'Last sync: {last_sync}')
PYEOF
```

Reply to the user with the output.

## Important

- This is READ-ONLY — never modifies any files
- The tracker is synced from the desktop; it may be a few seconds stale
- For fresh data, the user should say "process email" first
