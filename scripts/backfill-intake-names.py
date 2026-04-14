#!/usr/bin/env python3
"""
Backfill sender_name and channel_name into existing NanoClaw intake files.
No external dependencies (no PyYAML needed -- parses simple YAML with regex).
Idempotent -- skips files that already have both fields.

Usage:
  python3 backfill-intake-names.py [--dry-run] [--verbose]
"""
import json
import os
import re
import sys

DRY_RUN = "--dry-run" in sys.argv
VERBOSE = "--verbose" in sys.argv

HOME = os.path.expanduser("~")
ALLOWLIST_PATH = os.path.join(HOME, ".config/nanoclaw/sender-allowlist.json")
CHANNELS_DIR = os.path.join(HOME, "switchboard/ops/jibot/channels")
CONFIDENTIAL_ROOT = os.path.join(HOME, "switchboard/confidential")

def load_users():
    with open(ALLOWLIST_PATH) as f:
        return json.load(f).get("users", {})

def resolve_sender(sender_id, users):
    if not sender_id:
        return None
    for name, user in users.items():
        jids = user.get("jids", [])
        if sender_id in jids:
            return name
        for jid in jids:
            if jid.endswith(":" + sender_id) or jid == sender_id:
                return name
    return None

def load_channel_configs():
    configs = {}
    if not os.path.isdir(CHANNELS_DIR):
        return configs
    for fname in os.listdir(CHANNELS_DIR):
        if not fname.endswith((".yaml", ".yml")) or fname.startswith("_"):
            continue
        fpath = os.path.join(CHANNELS_DIR, fname)
        try:
            with open(fpath) as f:
                text = f.read()
            # Simple regex parsing for the fields we need
            cid_m = re.search(r'^channel_id:\s*["\']?(.+?)["\']?\s*$', text, re.M)
            cn_m = re.search(r'^channel_name:\s*["\']?(.+?)["\']?\s*$', text, re.M)
            gn_m = re.search(r'^group_name:\s*["\']?(.+?)["\']?\s*$', text, re.M)
            pl_m = re.search(r'^platform:\s*(\S+)', text, re.M)
            ws_m = re.search(r'^workspace:\s*(\S+)', text, re.M)
            if not cid_m:
                continue
            cid = cid_m.group(1)
            platform = pl_m.group(1) if pl_m else ""
            display = (gn_m.group(1) if gn_m else cn_m.group(1)) if cn_m else fname
            # Build JID like NanoClaw does
            if platform in ("whatsapp", "signal", "email"):
                jid = cid
            else:
                ws = ws_m.group(1) if ws_m else platform
                jid = f"{platform}:{ws}:channel:{cid}"
            configs[jid] = display
            configs[cid] = display  # fallback by raw ID
        except Exception:
            pass
    return configs

def resolve_channel(source, configs):
    if not source:
        return None
    return configs.get(source) or configs.get(source.strip('"'))

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)

def process_file(fpath, users, channels):
    with open(fpath, "r", encoding="utf-8") as f:
        content = f.read()
    m = FRONTMATTER_RE.match(content)
    if not m:
        return False, "no frontmatter"
    fm_text = m.group(1)
    body = content[m.end():]
    has_sender_name = "sender_name:" in fm_text
    has_channel_name = "channel_name:" in fm_text
    if has_sender_name and has_channel_name:
        return False, "already enriched"

    sender_id = None
    source = None
    for line in fm_text.split("\n"):
        if line.startswith("sender_id:"):
            sender_id = line.split(":", 1)[1].strip().strip('"')
        if line.startswith("source:"):
            source = line.split(":", 1)[1].strip().strip('"')

    changes = []
    if not has_sender_name and sender_id:
        name = resolve_sender(sender_id, users)
        if name:
            changes.append(("sender_name", name))
    if not has_channel_name and source:
        ch_name = resolve_channel(source, channels)
        if ch_name:
            changes.append(("channel_name", ch_name))
    if not changes:
        return False, "no resolution"

    # Insert after sender_id or author line
    new_lines = []
    fm_lines = fm_text.split("\n")
    inserted = False
    insert_after = "sender_id:" if sender_id else "author:"
    for line in fm_lines:
        new_lines.append(line)
        if not inserted and line.startswith(insert_after):
            for field, value in changes:
                new_lines.append(f'{field}: "{value}"')
            inserted = True
    if not inserted:
        final = []
        for line in new_lines:
            if line.startswith("date:") and not inserted:
                for field, value in changes:
                    final.append(f'{field}: "{value}"')
                inserted = True
            final.append(line)
        new_lines = final

    new_content = "---\n" + "\n".join(new_lines) + "\n---" + body
    if not DRY_RUN:
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(new_content)
    return True, ", ".join(f"{f}={v}" for f, v in changes)

def main():
    users = load_users()
    channels = load_channel_configs()
    print(f"Loaded {len(users)} users, {len(channels)} channel configs")

    intake_files = []
    for root, dirs, files in os.walk(CONFIDENTIAL_ROOT):
        if "/intake" not in root:
            continue
        for fname in files:
            if fname.endswith(".md") and not fname.startswith("_"):
                intake_files.append(os.path.join(root, fname))
    print(f"Found {len(intake_files)} intake files")

    enriched = skipped = no_match = 0
    for fpath in sorted(intake_files):
        changed, reason = process_file(fpath, users, channels)
        if changed:
            enriched += 1
            if VERBOSE or DRY_RUN:
                print(f"  {'[DRY] ' if DRY_RUN else ''}enriched: {os.path.relpath(fpath, CONFIDENTIAL_ROOT)} ({reason})")
        elif reason == "already enriched":
            skipped += 1
        else:
            no_match += 1

    action = "Would enrich" if DRY_RUN else "Enriched"
    print(f"\n{action} {enriched} files, skipped {skipped} (already done), {no_match} unresolvable")

if __name__ == "__main__":
    main()
