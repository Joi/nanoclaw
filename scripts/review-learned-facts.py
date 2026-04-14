#!/usr/bin/env python3
"""
Review and compact learned facts across all NanoClaw group CLAUDE.md files.

For each group with a ## Learned Facts section:
1. Display all facts for human review
2. Use Claude to suggest which facts to keep/merge/remove
3. Output a summary for the weekly review

Usage:
  python3 review-learned-facts.py [--compact] [--group <folder>]

Without --compact: display-only mode (for weekly review reading)
With --compact: use Claude to merge/deduplicate facts and rewrite section
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

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
    """Find all groups that have a ## Learned Facts section."""
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
    """Extract just the learned facts section."""
    marker = "## Learned Facts"
    idx = content.find(marker)
    if idx == -1:
        return ""
    section = content[idx:]
    next_heading = section.find("\n## ", len(marker))
    if next_heading != -1:
        section = section[:next_heading]
    return section


def compact_facts(facts_section, group_name):
    """Use Claude to merge/deduplicate/remove stale facts."""
    if not API_KEY:
        print("  SKIP compact: no API key")
        return None

    prompt = f"""Review these learned facts from the "{group_name}" chat group. 
Compact them by:
1. Removing facts that are likely stale or no longer relevant
2. Merging duplicate/overlapping facts into single entries
3. Keeping facts that are durable preferences, relationships, or decisions
4. Preserving date context where useful

Output the compacted facts as bullet points starting with "- ".
If all facts should be kept as-is, output them unchanged.
If all facts are stale, output "SECTION_EMPTY".

Current facts:
{facts_section}

Compacted facts:"""

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

    for folder, claude_md, content in sorted(groups):
        facts = extract_facts_section(content)
        if not facts.strip() or facts.strip() == "## Learned Facts":
            continue

        # Count facts
        fact_lines = [l for l in facts.split("\n") if l.strip().startswith("- ")]

        print(f"### {folder} ({len(fact_lines)} facts)")
        print(facts.strip())
        print()

        if COMPACT and fact_lines:
            print("  Compacting...")
            compacted = compact_facts(facts, folder)
            if compacted and compacted != "SECTION_EMPTY":
                # Rewrite the section
                before = content[:content.find("## Learned Facts")]
                after_section = content[content.find("## Learned Facts"):]
                next_heading = after_section.find("\n## ", len("## Learned Facts"))
                remainder = after_section[next_heading:] if next_heading != -1 else ""

                new_content = before + "## Learned Facts\n\n" + compacted + "\n" + remainder
                with open(claude_md, "w") as f:
                    f.write(new_content)

                new_count = len([l for l in compacted.split("\n") if l.strip().startswith("- ")])
                print(f"  Compacted: {len(fact_lines)} -> {new_count} facts\n")
            elif compacted == "SECTION_EMPTY":
                print("  All facts stale -- section cleared\n")
            else:
                print("  No changes needed\n")

    print("=== End Review ===")


if __name__ == "__main__":
    main()
