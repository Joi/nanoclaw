#!/usr/bin/env bash
# QMD confidential reindex -- triggered by launchd WatchPaths on ~/switchboard/confidential
# Debounced: waits 10s for rapid writes to settle, then reindexes once.
set -euo pipefail

LOCKFILE="/tmp/qmd-confidential-reindex.lock"
LOGFILE="$HOME/.amplifier/logs/qmd-confidential-reindex.log"

mkdir -p "$(dirname "$LOGFILE")"

# If another reindex is already running/waiting, skip
if [ -f "$LOCKFILE" ]; then
    pid=$(cat "$LOCKFILE" 2>/dev/null || echo "")
    if kill -0 "$pid" 2>/dev/null; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) SKIP: reindex already in progress (pid=$pid)" >> "$LOGFILE"
        exit 0
    else
        rm -f "$LOCKFILE"
    fi
fi

# Acquire lock
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# Wait for writes to settle (Syncthing may deliver multiple files)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) TRIGGERED: waiting 10s for writes to settle..." >> "$LOGFILE"
sleep 10

# Reindex
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) REINDEXING: qmd update" >> "$LOGFILE"
OUTPUT=$(/opt/homebrew/bin/qmd --index confidential update 2>&1) || true

# Log summary
echo "$OUTPUT" | grep -iE "indexed|collection|files|updated|error" >> "$LOGFILE" 2>/dev/null || true

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DONE" >> "$LOGFILE"
