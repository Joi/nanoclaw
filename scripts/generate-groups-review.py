#!/usr/bin/env python3
"""
Generate ~/switchboard/ops/jibot/nanoclaw-groups-review.md
Combines all group CLAUDE.md files + learned facts into a single reviewable page.
"""
import os
import sqlite3
from datetime import datetime

GROUPS_DIR = "/Users/jibot/nanoclaw/groups"
DB_PATH = "/Users/jibot/nanoclaw/store/messages.db"
OUTPUT = os.path.expanduser("~/switchboard/ops/jibot/nanoclaw-groups-review.md")

def get_group_info():
    """Get platform and mode info from DB for each folder."""
    info = {}
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute("""
            SELECT folder, name,
                CASE
                    WHEN jid LIKE 'line:%' THEN 'LINE'
                    WHEN jid LIKE 'dc:%' THEN 'Discord'
                    WHEN jid LIKE 'sig:%' THEN 'Signal'
                    WHEN jid LIKE 'slack:%' THEN 'Slack'
                    WHEN jid LIKE '%@g.us' OR jid LIKE '%@lid' OR jid LIKE '%@s.whatsapp%' THEN 'WhatsApp'
                    WHEN jid LIKE 'tg:%' THEN 'Telegram'
                    WHEN jid LIKE 'email:%' THEN 'Email'
                    ELSE 'Other'
                END,
                CASE WHEN requires_trigger = 0 THEN 'active'
                     WHEN log_triggered_only = 1 THEN 'silent'
                     ELSE 'attentive' END,
                CASE WHEN reminders_access=1 THEN 'R' ELSE '.' END ||
                CASE WHEN calendar_access=1 THEN 'C' ELSE '.' END ||
                CASE WHEN email_access=1 THEN 'E' ELSE '.' END ||
                CASE WHEN file_serving_access=1 THEN 'F' ELSE '.' END ||
                CASE WHEN intake_access=1 THEN 'I' ELSE '.' END
            FROM registered_groups ORDER BY folder
        """).fetchall()
        conn.close()
        for folder, name, platform, mode, flags in rows:
            if folder not in info:
                info[folder] = {"name": name, "platform": platform, "mode": mode, "flags": flags}
            else:
                # Multiple JIDs for same folder -- note the platforms
                existing = info[folder]
                if platform not in existing["platform"]:
                    existing["platform"] += f" + {platform}"
    except Exception as e:
        print(f"DB error: {e}")
    return info

def count_facts(content):
    marker = "## Learned Facts"
    idx = content.find(marker)
    if idx == -1:
        return 0
    section = content[idx:]
    return len([l for l in section.split("\n") if l.strip().startswith("- ")])

def extract_section(content, header):
    """Extract content under a specific ## header, stopping at next ## or end."""
    idx = content.find(f"## {header}")
    if idx == -1:
        return None
    start = content.find("\n", idx) + 1
    rest = content[start:]
    end = rest.find("\n## ")
    return rest[:end].strip() if end != -1 else rest.strip()

def main():
    db_info = get_group_info()
    groups = sorted([d for d in os.listdir(GROUPS_DIR) if os.path.isdir(os.path.join(GROUPS_DIR, d))])

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        "---",
        'description: "NanoClaw group directory with agent personas and learned facts. Auto-generated during weekly review."',
        "tags: [nanoclaw, jibot, operational, auto-generated]",
        "---",
        "# NanoClaw Group Directory",
        "",
        f"> Last updated: {now}",
        "> Update: run `ssh jibotmac 'python3 ~/nanoclaw/scripts/generate-groups-review.py'`",
        "",
    ]

    # Summary table
    lines.append("## Summary\n")
    lines.append("| Group | Platform | Mode | Flags | Facts |")
    lines.append("|-------|----------|------|-------|-------|")

    group_contents = []
    for folder in groups:
        claude_md = os.path.join(GROUPS_DIR, folder, "CLAUDE.md")
        if not os.path.exists(claude_md):
            continue
        with open(claude_md) as f:
            content = f.read()

        info = db_info.get(folder, {"name": folder, "platform": "?", "mode": "?", "flags": "....."})
        n_facts = count_facts(content)
        lines.append(f"| [[#{folder}\\|{info['name']}]] | {info['platform']} | {info['mode']} | `{info['flags']}` | {n_facts} |")
        group_contents.append((folder, info, content, n_facts))

    lines.append(f"\n**{len(group_contents)} groups** total.\n")

    # Individual group sections
    for folder, info, content, n_facts in group_contents:
        lines.append("---")
        lines.append(f"## {folder}")
        lines.append(f"**{info['name']}** | {info['platform']} | {info['mode']} | `{info['flags']}`")
        lines.append("")

        # Indent all CLAUDE.md content headers by one level (## -> ###, ### -> ####)
        indented = []
        for line in content.split("\n"):
            if line.startswith("## "):
                indented.append("###" + line[2:])
            elif line.startswith("### "):
                indented.append("####" + line[3:])
            else:
                indented.append(line)
        lines.append("\n".join(indented))
        lines.append("")

    output = "\n".join(lines)
    with open(OUTPUT, "w") as f:
        f.write(output)
    print(f"Generated: {len(group_contents)} groups, {n_facts} total facts, {len(output)} chars")
    print(f"Saved to: {OUTPUT}")

if __name__ == "__main__":
    main()
