#!/bin/bash
# ipc-lifecycle.sh — nightly archive sweep for NanoClaw IPC input folders
# Moves files >AGE_DAYS old from data/ipc/<group>/input/ → data/ipc/<group>/input/.archive/YYYY-MM/
# Prevents unbounded accumulation flagged by daily security audit.

set -u
AGE_DAYS="${IPC_LIFECYCLE_AGE_DAYS:-7}"
IPC_ROOT="$HOME/nanoclaw/data/ipc"
LOG_DIR="$HOME/nanoclaw/logs"
LOG="$LOG_DIR/ipc-lifecycle.log"
MONTH=$(date '+%Y-%m')

mkdir -p "$LOG_DIR"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') ipc-lifecycle starting (age_days=${AGE_DAYS}) ===" >> "$LOG"

if [ ! -d "$IPC_ROOT" ]; then
    echo "  ERROR: IPC root does not exist: $IPC_ROOT" >> "$LOG"
    exit 1
fi

TOTAL_ARCHIVED=0
GROUPS_TOUCHED=0

for group_dir in "$IPC_ROOT"/*/; do
    [ ! -d "$group_dir" ] && continue
    group=$(basename "$group_dir")
    input="$group_dir/input"
    [ ! -d "$input" ] && continue

    # Count files eligible for archive (top-level only — don't recurse into .archive)
    count=$(find "$input" -maxdepth 1 -type f -mtime +${AGE_DAYS} 2>/dev/null | wc -l | tr -d ' ')
    [ "$count" -eq 0 ] && continue

    archive_dir="$input/.archive/$MONTH"
    mkdir -p "$archive_dir"

    # Move files, capture any errors
    moved=0
    while IFS= read -r -d '' f; do
        if mv "$f" "$archive_dir/" 2>>"$LOG"; then
            moved=$((moved + 1))
        fi
    done < <(find "$input" -maxdepth 1 -type f -mtime +${AGE_DAYS} -print0 2>/dev/null)

    if [ "$moved" -gt 0 ]; then
        size=$(du -sh "$archive_dir" 2>/dev/null | cut -f1)
        echo "  [$group] archived $moved file(s) to .archive/$MONTH (${size})" >> "$LOG"
        TOTAL_ARCHIVED=$((TOTAL_ARCHIVED + moved))
        GROUPS_TOUCHED=$((GROUPS_TOUCHED + 1))
    fi
done

echo "=== done: $TOTAL_ARCHIVED file(s) archived across $GROUPS_TOUCHED group(s) ===" >> "$LOG"

# Rotate log if >10MB
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    mv "$LOG" "$LOG.1"
fi
