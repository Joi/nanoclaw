---
name: process-email
description: Trigger on-demand email classification via Syncthing. Writes a trigger file, waits for the desktop pipeline to run, reads the result, and replies. Use when user says "process email", "process emails", "check email", "run email pipeline".
---

# Process Email

## What This Does

Triggers the email classification pipeline on Joi's desktop via a Syncthing trigger file. The desktop runs the pipeline (fetches starred Gmail, classifies with AI, generates drafts, updates the tracker). **This machine does NOT have Gmail access** — it only writes a trigger and waits for the result.

Round-trip time: ~30-60 seconds (two Syncthing hops + pipeline time).

## Steps

### 1. Check the ops directory is mounted

```bash
test -d /workspace/extra/switchboard/ops || echo "ERROR: switchboard not mounted — contact jibot admin"
```

If the directory is missing, stop and report the error.

### 2. Write the trigger file

```bash
REQUEST_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > /workspace/extra/switchboard/ops/email-trigger.json << EOF
{
  "action": "process",
  "requested_at": "$TIMESTAMP",
  "request_id": "$REQUEST_ID",
  "status": "pending"
}
EOF

echo "request_id=$REQUEST_ID"
```

Then send an interim message to the user:
> "Trigger sent. Waiting for desktop pipeline (~30-60 seconds)..."

Use `mcp__nanoclaw__send_message` for the interim message if available, otherwise continue to the polling step.

### 3. Poll for result (up to 5 minutes)

```bash
REQUEST_ID="<the value from step 2>"

TIMEOUT=300
INTERVAL=5
ELAPSED=0

while [ $ELAPSED -lt $TIMEOUT ]; do
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))

    STATUS=$(python3 -c "
import json, sys
try:
    d = json.load(open('/workspace/extra/switchboard/ops/email-trigger.json'))
    if d.get('request_id') == '$REQUEST_ID':
        print(d.get('status', 'unknown'))
    else:
        print('wrong_id')
except Exception as e:
    print('read_error')
" 2>/dev/null)

    if [ "$STATUS" = "complete" ] || [ "$STATUS" = "error" ]; then
        break
    fi
done

echo "final_status=$STATUS"
```

### 4. Read and report the result

```bash
python3 -c "
import json
try:
    d = json.load(open('/workspace/extra/switchboard/ops/email-trigger.json'))
    status = d.get('status', 'unknown')
    if status == 'complete':
        print(d.get('summary', 'Pipeline completed (no summary available)'))
    elif status == 'error':
        print('Pipeline error: ' + d.get('error', 'unknown error'))
    elif status == 'pending':
        print('Pipeline did not respond within 5 minutes. Desktop may be asleep or offline.')
    else:
        print('Unexpected status: ' + status)
except Exception as e:
    print('Could not read trigger file: ' + str(e))
"
```

Reply to the user with this output.

## Important

- Do NOT attempt to run gog, access Gmail, or call the Anthropic API from this machine
- The entire email pipeline runs on the DESKTOP, not here
- If the desktop is asleep, the trigger will sit pending until it wakes up (Syncthing syncs when it reconnects)
- The trigger file is at `/workspace/extra/switchboard/ops/email-trigger.json` in the container
