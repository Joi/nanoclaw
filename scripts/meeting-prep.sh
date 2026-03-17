#!/bin/bash
# meeting-prep — call the meeting-prep sprite from inside a container.
# Accepts meeting data as JSON on stdin OR as a file path argument.
# Also handles gog calendar JSON output (transforms event format automatically).
# Automatically batches large meeting lists (>4) to avoid sprite timeouts.
#
# Usage:
#   gog calendar events joi@ito.com --today --json | meeting-prep
#   echo '{"meetings":[...]}' | meeting-prep
#   meeting-prep /path/to/meetings.json
#
# Env vars (set by container runner):
#   MEETING_PREP_URL   — sprite base URL
#   MEETING_PREP_TOKEN — bearer token

set -euo pipefail

BATCH_SIZE=4
MAX_RETRIES=3
RETRY_DELAY=5

if [ -z "${MEETING_PREP_URL:-}" ] || [ -z "${MEETING_PREP_TOKEN:-}" ]; then
    echo "Error: MEETING_PREP_URL and MEETING_PREP_TOKEN must be set" >&2
    exit 1
fi

# --- Warm up the sprite (Fly.io VMs auto-stop when idle) ---
echo "Warming up sprite..." >&2
for i in 1 2 3; do
    warmup_code=$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' "${MEETING_PREP_URL}/health" 2>/dev/null || echo "000")
    if [ "$warmup_code" = "200" ]; then
        echo "Sprite ready." >&2
        break
    fi
    if [ "$i" -lt 3 ]; then
        echo "Sprite not ready (HTTP $warmup_code), waiting ${RETRY_DELAY}s..." >&2
        sleep "$RETRY_DELAY"
    else
        echo "Warning: sprite warmup failed after 3 attempts (HTTP $warmup_code), proceeding anyway..." >&2
    fi
done

# Read input from file arg or stdin
if [ $# -ge 1 ] && [ -f "$1" ]; then
    raw=$(cat "$1")
else
    raw=$(cat)
fi

if [ -z "$raw" ]; then
    echo "Error: no input provided. Pipe JSON or pass a file path." >&2
    exit 1
fi

# Transform input to API format and split into batches.
# Outputs one JSON object per line, each with up to BATCH_SIZE meetings.
batches=$(python3 -c "
import json, sys

BATCH_SIZE = int(sys.argv[1])
raw = json.loads(sys.stdin.read())

# Already in API format
if isinstance(raw, dict) and 'meetings' in raw:
    meetings = raw['meetings']
else:
    # gog calendar wraps in {events: [...]} or could be a plain array
    if isinstance(raw, dict) and 'events' in raw:
        events = raw['events']
    elif isinstance(raw, list):
        events = raw
    else:
        events = [raw]
    meetings = []
    for ev in events:
        attendees = [a.get('email','') for a in ev.get('attendees', []) if a.get('email')]
        start = ev.get('start', {})
        start_time = start.get('dateTime') or start.get('date', '')
        if not start_time:
            continue
        meetings.append({
            'title': ev.get('summary', 'Untitled'),
            'start': start_time,
            'attendees': attendees,
            'description': ev.get('description', ''),
        })

if not meetings:
    print(json.dumps({'error': 'No meetings found in input'}), file=sys.stderr)
    sys.exit(1)

# Output one batch per line
for i in range(0, len(meetings), BATCH_SIZE):
    batch = meetings[i:i+BATCH_SIZE]
    print(json.dumps({'meetings': batch}))
" "$BATCH_SIZE" <<< "$raw")

# --- Call sprite with retry logic ---
call_sprite() {
    local body="$1"
    local attempt=0
    local http_code content response

    while [ "$attempt" -lt "$MAX_RETRIES" ]; do
        attempt=$((attempt + 1))

        response=$(curl -s --max-time 120 -w '\n%{http_code}' \
            -X POST "${MEETING_PREP_URL}/meeting-prep" \
            -H "Authorization: Bearer ${MEETING_PREP_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$body")

        http_code=$(echo "$response" | tail -1)
        content=$(echo "$response" | sed '$d')

        if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
            echo "$content"
            return 0
        fi

        # Retry on 502 (bad gateway / cold start) and 503 (service unavailable)
        if [ "$http_code" = "502" ] || [ "$http_code" = "503" ] || [ "$http_code" = "000" ]; then
            if [ "$attempt" -lt "$MAX_RETRIES" ]; then
                echo "Sprite returned HTTP $http_code (attempt $attempt/$MAX_RETRIES), retrying in ${RETRY_DELAY}s..." >&2
                sleep "$RETRY_DELAY"
                continue
            fi
        fi

        # Non-retryable error or retries exhausted
        echo "Error: sprite returned HTTP $http_code (attempt $attempt/$MAX_RETRIES)" >&2
        echo "$content" >&2
        return 1
    done
}

# Call the sprite for each batch and concatenate results
all_content=""
batch_num=0
total_batches=$(echo "$batches" | wc -l | tr -d ' ')

while IFS= read -r batch_body; do
    batch_num=$((batch_num + 1))

    if [ "$total_batches" -gt 1 ]; then
        echo "Processing batch $batch_num/$total_batches..." >&2
    fi

    content=$(call_sprite "$batch_body") || exit 1

    if [ -n "$all_content" ]; then
        all_content="$all_content

$content"
    else
        all_content="$content"
    fi
done <<< "$batches"

echo "$all_content"
