#!/usr/bin/env python3
"""
Extract learned facts from NanoClaw session transcripts and append to CLAUDE.md.

Reads recent session JSONLs, uses Claude API to extract key facts/preferences/
decisions, and appends them under "## Learned Facts" in each group's CLAUDE.md.

Usage:
  python3 extract-learned-facts.py [--dry-run] [--group <folder>]

Runs as part of weekly review, or standalone after a busy conversation day.
"""
import json
import os
import sys
import glob
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

DRY_RUN = "--dry-run" in sys.argv
TARGET_GROUP = None
for i, arg in enumerate(sys.argv):
    if arg == "--group" and i + 1 < len(sys.argv):
        TARGET_GROUP = sys.argv[i + 1]

HOME = os.path.expanduser("~")
SESSIONS_DIR = os.path.join(HOME, "nanoclaw/data/sessions")
GROUPS_DIR = os.path.join(HOME, "nanoclaw/groups")
NANOCLAW_ENV = os.path.join(HOME, "nanoclaw/.env")

# Load ANTHROPIC_API_KEY from nanoclaw .env
API_KEY = None
if os.path.exists(NANOCLAW_ENV):
    for line in open(NANOCLAW_ENV):
        if line.startswith("ANTHROPIC_API_KEY="):
            API_KEY = line.strip().split("=", 1)[1]
            break

if not API_KEY:
    API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

if not API_KEY:
    print("ERROR: No ANTHROPIC_API_KEY found")
    sys.exit(1)


def find_session_jsonls(folder):
    """Find all session JSONL files for a group folder."""
    session_dir = os.path.join(SESSIONS_DIR, folder)
    pattern = os.path.join(session_dir, ".claude/projects/*/*.jsonl")
    return sorted(glob.glob(pattern))


def extract_conversation_text(jsonl_path, max_chars=15000):
    """Extract human-readable conversation text from a session JSONL."""
    lines = []
    try:
        with open(jsonl_path) as f:
            for raw_line in f:
                try:
                    entry = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue

                msg_type = entry.get("type", "")
                if msg_type == "human":
                    content = entry.get("message", {}).get("content", "")
                    if isinstance(content, list):
                        content = " ".join(
                            p.get("text", "") for p in content if isinstance(p, dict)
                        )
                    if content:
                        lines.append(f"USER: {content[:500]}")
                elif msg_type == "assistant":
                    content = entry.get("message", {}).get("content", "")
                    if isinstance(content, list):
                        content = " ".join(
                            p.get("text", "") for p in content if isinstance(p, dict)
                        )
                    if content:
                        lines.append(f"ASSISTANT: {content[:500]}")
    except Exception:
        pass

    text = "\n".join(lines)
    return text[:max_chars] if len(text) > max_chars else text


def extract_facts_via_claude(conversation_text, group_name):
    """Call Claude API to extract key facts from a conversation."""
    import urllib.request

    prompt = f"""You are reviewing a conversation transcript from the "{group_name}" chat group with jibot. 
Extract key facts, preferences, decisions, and commitments that should be remembered for future conversations.

Rules:
- Only extract facts that are DURABLE (will still be relevant weeks/months later)
- Skip small talk, greetings, debugging sessions, and transient information
- Focus on: personal preferences, decisions made, commitments, relationships, plans, key dates
- Each fact should be a single concise line
- If there are no durable facts worth remembering, output "NO_NEW_FACTS"
- Format each fact as a bullet point starting with "- "
- Include the approximate date if relevant
- Maximum 10 facts per extraction

Conversation:
{conversation_text}

Extract durable facts (or "NO_NEW_FACTS"):"""

    data = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=data,
        headers={
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )

    resp = urllib.request.urlopen(req, timeout=30)
    result = json.loads(resp.read())
    text = result.get("content", [{}])[0].get("text", "NO_NEW_FACTS")
    return text.strip()


def read_existing_facts(claude_md_path):
    """Read existing learned facts from CLAUDE.md."""
    if not os.path.exists(claude_md_path):
        return []
    with open(claude_md_path) as f:
        content = f.read()
    # Find the ## Learned Facts section
    marker = "## Learned Facts"
    idx = content.find(marker)
    if idx == -1:
        return []
    facts_section = content[idx + len(marker):]
    # Stop at next ## heading or end of file
    next_heading = facts_section.find("\n## ")
    if next_heading != -1:
        facts_section = facts_section[:next_heading]
    return [
        line.strip()
        for line in facts_section.strip().split("\n")
        if line.strip().startswith("- ")
    ]


def append_facts(claude_md_path, new_facts, group_name):
    """Append new facts to the ## Learned Facts section of CLAUDE.md."""
    if not os.path.exists(claude_md_path):
        print(f"  SKIP: {claude_md_path} not found")
        return

    with open(claude_md_path) as f:
        content = f.read()

    date_stamp = datetime.now().strftime("%Y-%m-%d")
    facts_block = f"\n### {date_stamp}\n" + "\n".join(new_facts) + "\n"

    marker = "## Learned Facts"
    if marker in content:
        # Append after the marker line
        idx = content.find(marker) + len(marker)
        # Skip any newlines right after the marker
        while idx < len(content) and content[idx] == "\n":
            idx += 1
        content = content[:idx] + "\n" + facts_block + "\n" + content[idx:]
    else:
        # Add section at the end
        content = content.rstrip() + "\n\n" + marker + "\n" + facts_block

    if not DRY_RUN:
        with open(claude_md_path, "w") as f:
            f.write(content)

    print(f"  {'[DRY] ' if DRY_RUN else ''}Appended {len(new_facts)} facts to {group_name}")


def process_group(folder):
    """Process one group's sessions and extract facts."""
    jsonls = find_session_jsonls(folder)
    if not jsonls:
        return

    claude_md = os.path.join(GROUPS_DIR, folder, "CLAUDE.md")
    if not os.path.exists(claude_md):
        return

    # Read existing facts to avoid duplicates
    existing = read_existing_facts(claude_md)
    existing_text = "\n".join(existing)

    # Get conversation text from the most recent session
    latest_jsonl = jsonls[-1]
    conversation = extract_conversation_text(latest_jsonl)

    if not conversation or len(conversation) < 100:
        return

    print(f"Processing: {folder} ({len(conversation)} chars from session)")

    # Extract facts via Claude
    facts_text = extract_facts_via_claude(conversation, folder)

    if "NO_NEW_FACTS" in facts_text:
        print(f"  No new facts for {folder}")
        return

    # Parse facts
    new_facts = [
        line.strip()
        for line in facts_text.split("\n")
        if line.strip().startswith("- ")
    ]

    if not new_facts:
        print(f"  No parseable facts for {folder}")
        return

    # Filter out facts that are already in CLAUDE.md (rough dedup)
    novel_facts = [f for f in new_facts if f not in existing_text]

    if not novel_facts:
        print(f"  All facts already known for {folder}")
        return

    append_facts(claude_md, novel_facts, folder)


def main():
    # Find all groups with sessions
    if TARGET_GROUP:
        folders = [TARGET_GROUP]
    else:
        folders = [
            d for d in os.listdir(SESSIONS_DIR)
            if os.path.isdir(os.path.join(SESSIONS_DIR, d))
            and os.path.exists(os.path.join(GROUPS_DIR, d, "CLAUDE.md"))
        ]

    print(f"Scanning {len(folders)} groups for learned facts...")

    for folder in sorted(folders):
        try:
            process_group(folder)
        except Exception as e:
            print(f"  ERROR processing {folder}: {e}")

    print("\nDone.")


if __name__ == "__main__":
    main()
