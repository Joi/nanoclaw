#!/usr/bin/env python3
"""
Review and compact learned facts in NanoClaw CLAUDE.md files.
When compacting, prioritizes recent facts over older ones.

Usage:
  python3 review-learned-facts.py [--compact] [--group <folder>]
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime

COMPACT = "--compact" in sys.argv
TARGET_GROUP = None
for i, arg in enumerate(sys.argv):
    if arg == "--group" and i + 1 < len(sys.argv):
        TARGET_GROUP = sys.argv[i + 1]

HOME = os.path.expanduser("~")
GROUPS_DIR = os.path.join(HOME, "nanoclaw/groups")
NANOCLAW_ENV = os.path.join(HOME, "nanoclaw/.env")

API_KEY = None
if os.path.exists(NANOCLAW_ENV):
    for line in open(NANOCLAW_ENV):
        if line.startswith("ANTHROPIC_API_KEY="):
            API_KEY = line.strip().split("=", 1)[1]
            break
if not API_KEY:
    API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")


def find_groups_with_facts():
    groups = []
    if not os.path.isdir(GROUPS_DIR):
        return groups
    for folder in os.listdir(GROUPS_DIR):
        claude_md = os.path.join(GROUPS_DIR, folder, "CLAUDE.md")
        if os.path.exists(claude_md):
            with open(claude_md) as f:
                content = f.read()
            if "## Learned Facts" in content:
                groups.append((folder, claude_md, content))
    return groups


def extract_facts_section(content):
    marker = "## Learned Facts"
    idx = content.find(marker)
    if idx == -1:
        return "", idx, -1
    section_start = idx
    rest = content[idx:]
    next_heading = rest.find("\n## ", len(marker))
    section_end = idx + next_heading if next_heading != -1 else len(content)
    section = content[section_start:section_end]
    return section, section_start, section_end


def count_facts(section):
    return len([l for l in section.split("\n") if l.strip().startswith("- ")])


def compact_facts(facts_section, group_name):
    if not API_KEY:
        return None

    prompt = f"""Compact these learned facts from the "{group_name}" chat group.

RULES:
1. MERGE duplicates into a single, more complete entry
2. REMOVE facts that are clearly stale or transient (debugging sessions, temporary plans that have passed)
3. KEEP durable facts: preferences, relationships, commitments, key dates, decisions
4. PRIORITIZE RECENT facts (later dates) over older ones -- if two facts conflict, keep the newer one
5. Preserve date context only for time-sensitive facts (deadlines, events, trips)
6. Output as clean bullet points starting with "- "
7. NO date headers (### YYYY-MM-DD) -- just a flat list of deduplicated facts
8. If everything is stale, output "SECTION_EMPTY"

{facts_section}

Compacted facts (flat bullet list, no date headers):"""

    data = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 2048,
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
    return result.get("content", [{}])[0].get("text", "").strip()


def main():
    groups = find_groups_with_facts()
    if TARGET_GROUP:
        groups = [(f, p, c) for f, p, c in groups if f == TARGET_GROUP]

    if not groups:
        print("No groups with learned facts found.")
        return

    print(f"=== NanoClaw Learned Facts Review ({len(groups)} groups) ===\n")

    total_before = 0
    total_after = 0

    for folder, claude_md, content in sorted(groups):
        section, start, end = extract_facts_section(content)
        n = count_facts(section)
        if n == 0:
            continue

        total_before += n
        print(f"### {folder} ({n} facts)")
        print(section.strip())
        print()

        if COMPACT:
            print(f"  Compacting {n} facts...")
            compacted = compact_facts(section, folder)

            if not compacted or compacted == "SECTION_EMPTY":
                new_section = "## Learned Facts\n\n*No durable facts retained after compaction.*\n"
                new_n = 0
            else:
                # Clean up: ensure flat list
                lines = [l.strip() for l in compacted.split("\n") if l.strip().startswith("- ")]
                new_section = "## Learned Facts\n\n" + "\n".join(lines) + "\n"
                new_n = len(lines)

            total_after += new_n

            # Rewrite the section in the file
            before = content[:start]
            after = content[end:]
            new_content = before + new_section + after

            with open(claude_md, "w") as f:
                f.write(new_content)

            print(f"  {n} -> {new_n} facts\n")
        else:
            total_after += n

    if COMPACT:
        print(f"=== Compaction complete: {total_before} -> {total_after} facts ===")
    else:
        print(f"=== {total_before} total facts across {len(groups)} groups ===")


if __name__ == "__main__":
    main()
