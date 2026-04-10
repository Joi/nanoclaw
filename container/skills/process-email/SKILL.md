---
name: process-email
description: On-demand email triage — fetch starred emails from joi@ito.com Gmail, classify by action type, draft replies, update ~/switchboard/email-tracker.json, and report a summary. Use when user says "process email", "check my email", "email triage", or similar.
allowed-tools: Bash(/workspace/extra/tools/gog-run:*), Read, Write, Glob
---

# /process-email — On-Demand Email Triage

Process Joi's starred Gmail emails: classify, draft selectively, update tracker, report summary.

## Environment Check

First verify the mounts are present:

```bash
test -f /workspace/extra/tools/gog-run && echo "gog-run: OK" || echo "ERROR: tools not mounted — restart nanoclaw after updating joi-dm containerConfig"
test -d /workspace/extra/switchboard && echo "switchboard: OK" || echo "ERROR: switchboard not mounted"
```

If either fails, stop and report the missing mount to the user.

### Check gog auth for joi@ito.com

```bash
/workspace/extra/tools/gog-run gmail search "is:starred" --account joi@ito.com --max 1 --no-input -j 2>&1
```

If this returns `No auth for gmail joi@ito.com`, show the user this setup instruction and stop:

```
⚠️ Gmail auth for joi@ito.com is not configured.

To set it up, run this on jibotmac:

  /Users/jibot/tools/gog-run auth add joi@ito.com --services gmail

A browser will open to authorize access. After completing auth, run "process email" again.
```

## Step 1 — Fetch Starred Threads

```bash
/workspace/extra/tools/gog-run gmail search "is:starred" --account joi@ito.com --max 50 --no-input -j
```

This returns a JSON object with a `threads` array. Each thread has an `id` field. Save the list of thread IDs.

## Step 2 — Load Existing Tracker

```bash
cat /workspace/extra/switchboard/email-tracker.json 2>/dev/null
```

If the file doesn't exist, start with an empty tracker:
```json
{"last_processed": null, "emails": []}
```

Parse the `emails` array. Each entry has a `thread_id` field.

## Step 3 — Detect Cleared Stars

Any email in the tracker with `status != "done"` whose `thread_id` is NOT in the current starred list has been unstarred by Joi → mark it done:
- Set `status = "done"`
- Set `done_at = <current ISO timestamp>`

This means Joi dealt with it in Mail.app (replied, archived, unsubscribed, etc.).

## Step 4 — Identify New Emails

New emails are thread IDs returned by Step 1 that are NOT already in the tracker.

For each new thread, fetch the full content:

```bash
/workspace/extra/tools/gog-run gmail thread get <threadId> --account joi@ito.com --full --no-input -j
```

Extract from the latest message in the thread:
- `from` — sender name and email
- `subject` — email subject line
- `date` — received date (ISO format)
- `snippet` — first 200 chars of body
- `message_id` — the RFC 2822 `Message-ID` header value (looks like `<abc123@example.com>`)

**If fetching a thread fails**, skip it and continue with the remaining threads. Note the skip in your reply.

## Step 5 — Classify Each New Email

For each new email, assign one category based on subject, sender, and snippet:

| Category | When to use |
|----------|-------------|
| `auto-approve` | Routine confirmations, acceptances, simple yes/no responses where the answer is obvious from context |
| `thoughtful-reply` | Substantive questions, proposals, requests that require real thinking or Joi's judgment |
| `read-only` | Newsletters, FYIs, system notifications, receipts — no response needed |
| `forward` | Things that should go to someone else on Joi's team or delegation candidates |
| `quick-action` | Unsubscribe links, one-click forms, event RSVPs, simple approvals in external systems |

Use your judgment. When in doubt between `thoughtful-reply` and `read-only`, choose `thoughtful-reply`.

## Step 6 — Draft Replies for Action Categories

For emails categorized as `auto-approve` or `thoughtful-reply`, generate a draft reply preview:

- **auto-approve**: Write a short, direct confirmation reply (2-4 sentences). Match Joi's style: concise, warm, no unnecessary formality.
- **thoughtful-reply**: Write a starter draft that addresses the key question or request (3-8 sentences). Flag any missing information Joi would need to complete the reply.
- **Other categories**: Set `draft_preview` to `null`.

## Step 7 — Build Mail.app Links

For each email, construct the Mail.app deep link using the Message-ID header:

```python
import urllib.parse
message_id = "<abc123@mail.example.com>"  # raw Message-ID header value
mail_link = "message://" + urllib.parse.quote(message_id, safe="")
```

Use Python inline:
```bash
python3 -c "import urllib.parse; print('message://' + urllib.parse.quote('<abc123@mail.example.com>', safe=''))"
```

## Step 8 — Update Tracker

Write the updated tracker to `/workspace/extra/switchboard/email-tracker.json`.

Format:
```json
{
  "last_processed": "2026-04-10T03:00:00Z",
  "emails": [
    {
      "thread_id": "18f123abc456",
      "message_id": "<abc123@mail.example.com>",
      "from": "Alice Smith <alice@example.com>",
      "subject": "Re: Q2 budget review",
      "date": "2026-04-09T14:23:00Z",
      "category": "thoughtful-reply",
      "status": "pending",
      "draft_preview": "Thanks for sending this over. A few thoughts...",
      "mail_link": "message://%3Cabc123%40mail.example.com%3E",
      "added_at": "2026-04-10T03:00:00Z"
    }
  ]
}
```

Merge: keep existing entries (updating cleared-star ones), add new ones at the top.

Set `last_processed` to the current UTC ISO timestamp.

Write with:
```bash
cat > /workspace/extra/switchboard/email-tracker.json << 'ENDOFJSON'
{...}
ENDOFJSON
```

## Step 9 — Report Summary

Send a concise summary. Example format:

```
Done. 6 pending emails:
• 2 auto-approve — quick replies ready
• 3 thoughtful-reply — need your thinking
• 1 read-only — no action needed

2 emails marked done (star removed).
```

If there are no new emails:
```
No new starred emails. Tracker is up to date.
(2 emails already pending from last run)
```

If gog auth was missing or there were errors, describe what happened instead of the summary.

## Guidelines

- **Don't be chatty** — the summary is the entire reply. No preamble.
- **Process everything** — don't skip emails just because there are many. Max 50 per run.
- **Preserve existing entries** — never drop pending emails from the tracker.
- **Use UTC for timestamps** — always ISO 8601 with Z suffix.
- **status flow**: `pending` → (Joi opens it) → `in-progress` → (Joi completes it) → `done`. Set new emails to `pending`. Only set `done` for cleared-star detection.

## email-status (quick check)

If the user says "email status" or "how many emails", just read the tracker and report without running the pipeline:

```bash
cat /workspace/extra/switchboard/email-tracker.json 2>/dev/null
```

Count pending (non-done) emails by category and report:
```
Email tracker: 5 pending
• 2 auto-approve • 2 thoughtful-reply • 1 read-only
Last processed: Apr 9 at 9:00 PM
```
