#!/usr/bin/env python3
"""
Extract learned facts from NanoClaw session transcripts and append to CLAUDE.md.
Tracks last scan time per group to avoid reprocessing and duplicate extraction.

State file: ~/nanoclaw/data/learned-facts-state.json
  {group_folder: {last_scan_ts: ISO, last_jsonl: filename, last_jsonl_size: bytes}}

Usage:
  python3 extract-learned-facts.py [--dry-run] [--group <folder>] [--force]
"""
import json
import os
import sys
import glob
from datetime import datetime
from pathlib import Path

DRY_RUN = "--dry-run" in sys.argv
FORCE = "--force" in sys.argv
TARGET_GROUP = None
for i, arg in enumerate(sys.argv):
    if arg == "--group" and i + 1 < len(sys.argv):
        TARGET_GROUP = sys.argv[i + 1]

HOME = os.path.expanduser("~")
SESSIONS_DIR = os.path.join(HOME, "nanoclaw/data/sessions")
GROUPS_DIR = os.path.join(HOME, "nanoclaw/groups")
NANOCLAW_ENV = os.path.join(HOME, "nanoclaw/.env")
STATE_FILE = os.path.join(HOME, "nanoclaw/data/learned-facts-state.json")

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


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def find_session_jsonls(folder):
    session_dir = os.path.join(SESSIONS_DIR, folder)
    pattern = os.path.join(session_dir, ".claude/projects/*/*.jsonl")
    # Exclude subagent sessions
    return sorted([p for p in glob.glob(pattern) if "/subagents/" not in p])


def needs_scan(folder, jsonls, state):
    """Check if this group has new session data since last scan."""
    if FORCE:
        return True
    if folder not in state:
        return True
    s = state[folder]
    if not jsonls:
        return False
    latest = jsonls[-1]
    latest_size = os.path.getsize(latest)
    # Scan if the latest JSONL is different or has grown
    return (
        s.get("last_jsonl") != os.path.basename(latest)
        or s.get("last_jsonl_size", 0) != latest_size
    )


def extract_conversation_text(jsonl_path, max_chars=15000):
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
    return text[:max_chars]


def read_existing_facts(claude_md_path):
    if not os.path.exists(claude_md_path):
        return ""
    with open(claude_md_path) as f:
        content = f.read()
    marker = "## Learned Facts"
    idx = content.find(marker)
    if idx == -1:
        return ""
    section = content[idx + len(marker):]
    next_heading = section.find("\n## ")
    if next_heading != -1:
        section = section[:next_heading]
    return section.strip()


def extract_facts_via_claude(conversation_text, group_name, existing_facts):
    import urllib.request

    existing_context = ""
    if existing_facts:
        existing_context = f"""

ALREADY KNOWN FACTS (do NOT repeat these):
{existing_facts}
"""

    prompt = f"""Review this conversation from the "{group_name}" chat group.
Extract NEW key facts, preferences, decisions, and commitments not already known.

Rules:
- Only extract facts that are DURABLE (relevant weeks/months later)
- Skip small talk, greetings, debugging, transient info
- Focus on: personal preferences, decisions, commitments, relationships, plans, key dates
- Each fact as a single concise "- " bullet
- If no new durable facts, output "NO_NEW_FACTS"
- Maximum 10 facts
- Do NOT repeat anything from the already-known list{existing_context}

Conversation:
{conversation_text}

New facts only (or "NO_NEW_FACTS"):"""

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
    return result.get("content", [{}])[0].get("text", "NO_NEW_FACTS").strip()


def append_facts(claude_md_path, new_facts):
    with open(claude_md_path) as f:
        content = f.read()

    date_stamp = datetime.now().strftime("%Y-%m-%d")
    facts_block = f"\n### {date_stamp}\n" + "\n".join(new_facts) + "\n"

    marker = "## Learned Facts"
    if marker in content:
        idx = content.find(marker) + len(marker)
        while idx < len(content) and content[idx] == "\n":
            idx += 1
        content = content[:idx] + "\n" + facts_block + "\n" + content[idx:]
    else:
        content = content.rstrip() + "\n\n" + marker + "\n" + facts_block

    if not DRY_RUN:
        with open(claude_md_path, "w") as f:
            f.write(content)


def process_group(folder, state):
    jsonls = find_session_jsonls(folder)
    if not jsonls:
        return

    if not needs_scan(folder, jsonls, state):
        return

    claude_md = os.path.join(GROUPS_DIR, folder, "CLAUDE.md")
    if not os.path.exists(claude_md):
        return

    existing_facts = read_existing_facts(claude_md)
    latest_jsonl = jsonls[-1]
    conversation = extract_conversation_text(latest_jsonl)

    if not conversation or len(conversation) < 100:
        # Update state even if no content (avoid re-scanning empty sessions)
        state[folder] = {
            "last_scan_ts": datetime.now().isoformat(),
            "last_jsonl": os.path.basename(latest_jsonl),
            "last_jsonl_size": os.path.getsize(latest_jsonl),
        }
        return

    print(f"Processing: {folder} ({len(conversation)} chars)")

    facts_text = extract_facts_via_claude(conversation, folder, existing_facts)

    # Update state
    state[folder] = {
        "last_scan_ts": datetime.now().isoformat(),
        "last_jsonl": os.path.basename(latest_jsonl),
        "last_jsonl_size": os.path.getsize(latest_jsonl),
    }

    if "NO_NEW_FACTS" in facts_text:
        print(f"  No new facts")
        return

    new_facts = [l.strip() for l in facts_text.split("\n") if l.strip().startswith("- ")]
    if not new_facts:
        print(f"  No parseable facts")
        return

    tag = "[DRY] " if DRY_RUN else ""
    print(f"  {tag}Appended {len(new_facts)} facts")
    append_facts(claude_md, new_facts)


def main():
    state = load_state()

    if TARGET_GROUP:
        folders = [TARGET_GROUP]
    else:
        folders = [
            d for d in os.listdir(SESSIONS_DIR)
            if os.path.isdir(os.path.join(SESSIONS_DIR, d))
            and os.path.exists(os.path.join(GROUPS_DIR, d, "CLAUDE.md"))
        ]

    print(f"Scanning {len(folders)} groups (last run state tracked for {len(state)} groups)...")

    for folder in sorted(folders):
        try:
            process_group(folder, state)
        except Exception as e:
            print(f"  ERROR {folder}: {e}")

    if not DRY_RUN:
        save_state(state)
        print(f"\nState saved to {STATE_FILE}")

    print("Done.")


if __name__ == "__main__":
    main()
