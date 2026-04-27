#!/usr/bin/env bash
# QMD multi-index reindex -- triggered by launchd WatchPaths
# Debounced: waits 10s for rapid writes to settle, then reindexes affected indexes.
set -euo pipefail

LOCKFILE="/tmp/qmd-reindex-all.lock"
LOGFILE="$HOME/.amplifier/logs/qmd-reindex-all.log"

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

# Reindex all indexes that have source data
for index in public confidential domain-gidc domain-sankosh domain-bhutan domain-gmc crm domain-jp-ai-agent-startup; do
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) REINDEXING: qmd --index $index update" >> "$LOGFILE"
    OUTPUT=$(/opt/homebrew/bin/qmd --index "$index" update 2>&1) || true
    echo "$OUTPUT" | grep -iE "indexed|collection|files|updated|error" >> "$LOGFILE" 2>/dev/null || true
done

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DONE" >> "$LOGFILE"
