#!/usr/bin/env python3
"""send-message.py - Send messages through NanoClaw IPC.

Commands:
    send  "<recipient>" "<message>"  - Send a message to a recipient
    email "<to>" "<subject>" "<body>" - Send email via gog CLI
    resolve "<query>"                - Fuzzy search recipients
    list                             - List all known recipients
    init                             - Auto-discover recipients from DB/groups

Uses ~/nanoclaw/data/recipients.json as the recipient registry.
Routes messages to the correct IPC group directory based on recipient config.
"""

import json
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

# Paths
HOME = Path.home()
NANOCLAW = HOME / "nanoclaw"
REGISTRY_PATH = NANOCLAW / "data" / "recipients.json"
IPC_BASE = NANOCLAW / "data" / "ipc"
DEFAULT_IPC_GROUP = "joi-dm"
DB_PATH = NANOCLAW / "store" / "messages.db"
GROUPS_DIR = NANOCLAW / "groups"


def err(msg):
    print(msg, file=sys.stderr)


def ok(data):
    print(json.dumps(data, indent=2))
    sys.exit(0)


def fail(msg):
    err(f"ERROR: {msg}")
    sys.exit(1)


def load_registry():
    """Load recipients.json, return dict or empty structure."""
    if REGISTRY_PATH.exists():
        try:
            with open(REGISTRY_PATH) as f:
                data = json.load(f)
            return data.get("recipients", {})
        except (json.JSONDecodeError, IOError) as e:
            err(f"Warning: failed to load registry: {e}")
    return {}


def save_registry(recipients):
    """Write recipients.json."""
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(REGISTRY_PATH, "w") as f:
        json.dump({"recipients": recipients}, f, indent=2)
        f.write("\n")


def resolve_ipc_group(key, entry):
    """Determine the correct IPC group directory for a recipient.

    Resolution order:
    1. Explicit ipc_group field in recipient entry
    2. Recipient key matches an existing IPC directory name
    3. Fallback to joi-dm (correct for Signal DMs)

    Warns if a non-Signal message would route through joi-dm, since
    joi-dm only has Signal connections and will silently drop other channels.
    """
    # 1. Explicit override
    ipc_group = entry.get("ipc_group")
    if ipc_group:
        ipc_dir = IPC_BASE / ipc_group / "messages"
        if not ipc_dir.parent.exists():
            err(f"Warning: ipc_group '{ipc_group}' directory does not exist, creating it")
            ipc_dir.mkdir(parents=True, exist_ok=True)
        return ipc_group

    # 2. Recipient key matches an IPC directory
    if (IPC_BASE / key).is_dir():
        return key

    # 3. Fallback to joi-dm with safety warning for non-Signal
    channel = entry.get("channel", "unknown")
    if channel != "signal":
        err(f"Warning: routing {channel} message through joi-dm (Signal-only group).")
        err(f"  This message may be silently dropped by NanoClaw.")
        err(f"  Fix: add 'ipc_group' to the '{key}' entry in recipients.json")
        err(f"  Available IPC groups: {', '.join(sorted(d.name for d in IPC_BASE.iterdir() if d.is_dir()))}")
    return DEFAULT_IPC_GROUP


def resolve_recipient(query, recipients):
    """Resolve a query to a recipient entry. Returns (key, entry) or (None, None).

    Resolution order:
    1. Exact match on name (case-insensitive)
    2. Exact match on alias (case-insensitive)
    3. Substring match on name/aliases
    4. Fallback: scan DB chats table
    """
    q = query.lower().strip()

    # 1. Exact name match
    for key, entry in recipients.items():
        if key.lower() == q:
            return key, entry

    # 2. Exact alias match
    for key, entry in recipients.items():
        aliases = [a.lower() for a in entry.get("aliases", [])]
        if q in aliases:
            return key, entry

    # 3. Substring match on name/aliases
    matches = []
    for key, entry in recipients.items():
        searchable = [key.lower()] + [a.lower() for a in entry.get("aliases", [])]
        if entry.get("description"):
            searchable.append(entry["description"].lower())
        for s in searchable:
            if q in s:
                matches.append((key, entry))
                break

    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        # Return first match but warn
        err(f"Multiple matches for {query}: {[m[0] for m in matches]}")
        err(f"Using first match: {matches[0][0]}")
        return matches[0]

    # 4. Fallback: scan DB
    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH))
            cursor = conn.execute(
                "SELECT jid, name, channel, is_group FROM chats WHERE LOWER(name) LIKE ?",
                (f"%{q}%",),
            )
            rows = cursor.fetchall()
            conn.close()
            if len(rows) == 1:
                jid, name, channel, is_group = rows[0]
                entry = {
                    "jid": jid,
                    "aliases": [],
                    "channel": channel or "unknown",
                    "type": "group" if is_group else "dm",
                    "description": f"Auto-resolved from DB: {name}",
                }
                return name or jid, entry
            if len(rows) > 1:
                err(f"Multiple DB matches for {query}:")
                for jid, name, channel, is_group in rows:
                    err(f"  {name or jid} ({channel}, {'group' if is_group else 'dm'})")
                return None, None
        except sqlite3.Error as e:
            err(f"DB lookup failed: {e}")

    return None, None


def cmd_send(args):
    """send "<recipient>" "<message>" """
    if len(args) < 2:
        fail("Usage: send <recipient> <message>")

    query, message = args[0], args[1]
    recipients = load_registry()
    key, entry = resolve_recipient(query, recipients)

    if not entry:
        fail(f"No recipient found for {query}. Try: resolve \"{query}\"")

    jid = entry["jid"]
    channel = entry.get("channel", "unknown")

    # Route to correct IPC group
    ipc_group = resolve_ipc_group(key, entry)
    ipc_dir = IPC_BASE / ipc_group / "messages"
    ipc_dir.mkdir(parents=True, exist_ok=True)

    msg_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    msg_file = ipc_dir / f"{msg_id}.json"

    ipc_msg = {
        "type": "message",
        "chatJid": jid,
        "text": message,
    }

    with open(msg_file, "w") as f:
        json.dump(ipc_msg, f, indent=2)
        f.write("\n")

    ok({
        "status": "sent",
        "recipient": key,
        "jid": jid,
        "channel": channel,
        "ipc_group": ipc_group,
        "ipc_file": str(msg_file),
        "message_preview": message[:100] + ("..." if len(message) > 100 else ""),
    })


def cmd_email(args):
    """email "<to>" "<subject>" "<body>" """
    if len(args) < 3:
        fail("Usage: email <to> <subject> <body>")

    to, subject, body = args[0], args[1], args[2]

    cmd = [
        "gog", "gmail", "send",
        "-a", "jibot@ito.com",
        "--to", to,
        "--subject", subject,
        "--body", body,
        "--force",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            ok({
                "status": "sent",
                "to": to,
                "subject": subject,
                "method": "gog",
                "stdout": result.stdout.strip(),
            })
        else:
            err(f"gog send failed (exit {result.returncode}): {result.stderr.strip()}")
            fail(f"Email send failed. Manual command:\n  gog gmail send -a jibot@ito.com --to {to} --subject \"{subject}\" --body \"{body}\"")
    except FileNotFoundError:
        fail(f"gog not found. Manual command:\n  gog gmail send -a jibot@ito.com --to {to} --subject \"{subject}\" --body \"{body}\"")
    except subprocess.TimeoutExpired:
        fail("gog send timed out after 30s")


def cmd_resolve(args):
    """resolve "<query>" - show matching recipients."""
    if not args:
        fail("Usage: resolve <query>")

    query = args[0]
    q = query.lower().strip()
    recipients = load_registry()
    matches = []

    for key, entry in recipients.items():
        searchable = [key.lower()] + [a.lower() for a in entry.get("aliases", [])]
        if entry.get("description"):
            searchable.append(entry["description"].lower())
        for s in searchable:
            if q in s:
                ipc_group = resolve_ipc_group(key, entry)
                matches.append({
                    "name": key,
                    "jid": entry["jid"],
                    "channel": entry.get("channel", "unknown"),
                    "type": entry.get("type", "unknown"),
                    "ipc_group": ipc_group,
                    "aliases": entry.get("aliases", []),
                    "description": entry.get("description", ""),
                })
                break

    # Also check DB
    db_matches = []
    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH))
            cursor = conn.execute(
                "SELECT jid, name, channel, is_group FROM chats WHERE LOWER(name) LIKE ?",
                (f"%{q}%",),
            )
            for jid, name, channel, is_group in cursor.fetchall():
                # Skip if already in registry matches
                if not any(m["jid"] == jid for m in matches):
                    db_matches.append({
                        "name": name or jid,
                        "jid": jid,
                        "channel": channel or "unknown",
                        "type": "group" if is_group else "dm",
                        "source": "database",
                    })
            conn.close()
        except sqlite3.Error:
            pass

    ok({
        "query": query,
        "registry_matches": matches,
        "db_matches": db_matches,
        "total": len(matches) + len(db_matches),
    })


def cmd_list(args):
    """list - show all known recipients."""
    recipients = load_registry()
    entries = []
    for key, entry in sorted(recipients.items()):
        ipc_group = resolve_ipc_group(key, entry)
        entries.append({
            "name": key,
            "jid": entry["jid"],
            "channel": entry.get("channel", "unknown"),
            "type": entry.get("type", "unknown"),
            "ipc_group": ipc_group,
            "aliases": entry.get("aliases", []),
            "description": entry.get("description", ""),
        })

    ok({
        "count": len(entries),
        "recipients": entries,
    })


def cmd_init(args):
    """init - auto-discover recipients from DB and group folders."""
    recipients = load_registry()
    added = []
    existing_jids = {e["jid"] for e in recipients.values()}

    # 1. Scan DB chats table
    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH))
            cursor = conn.execute("SELECT jid, name, channel, is_group FROM chats")
            for jid, name, channel, is_group in cursor.fetchall():
                if jid in existing_jids:
                    continue
                if not name:
                    continue
                # Generate key: lowercase, spaces to hyphens, strip non-alphanum
                key = re.sub(r"[^a-z0-9-]", "", name.lower().replace(" ", "-"))
                key = re.sub(r"-+", "-", key).strip("-")
                if not key:
                    key = re.sub(r"[^a-z0-9-]", "", jid.lower().replace(":", "-"))
                # Avoid duplicates
                if key in recipients:
                    key = f"{key}-{channel or 'unknown'}"
                if key in recipients:
                    continue

                entry = {
                    "jid": jid,
                    "aliases": [],
                    "channel": channel or "unknown",
                    "type": "group" if is_group else "dm",
                    "description": f"Auto-discovered: {name}",
                }
                recipients[key] = entry
                existing_jids.add(jid)
                added.append({"key": key, "source": "database", "jid": jid})
            conn.close()
        except sqlite3.Error as e:
            err(f"DB scan error: {e}")

    # 2. Scan group folders
    if GROUPS_DIR.exists():
        for group_dir in sorted(GROUPS_DIR.iterdir()):
            if not group_dir.is_dir():
                continue
            folder_name = group_dir.name
            # Skip template/global dirs
            if folder_name in ("global",) or folder_name.startswith("gidc-template"):
                continue
            # Check if already tracked by folder name
            if folder_name in recipients:
                continue

            description = f"Group folder: {folder_name}"
            claude_md = group_dir / "CLAUDE.md"
            if claude_md.exists():
                try:
                    first_line = claude_md.read_text().strip().split("\n")[0]
                    # Strip markdown heading prefix
                    first_line = re.sub(r"^#+\s*", "", first_line).strip()
                    if first_line:
                        description = first_line
                except IOError:
                    pass

            entry = {
                "jid": f"group:{folder_name}",
                "aliases": [],
                "channel": "unknown",
                "type": "group",
                "description": description,
            }
            recipients[folder_name] = entry
            added.append({"key": folder_name, "source": "groups_folder", "description": description})

    save_registry(recipients)

    ok({
        "status": "init_complete",
        "total_recipients": len(recipients),
        "newly_added": len(added),
        "added": added,
    })


def cmd_send_file(args):
    """send-file "<recipient>" "<file-path>" ["<caption>"] [--as "<name>"]

    Sends a local file as a document attachment through any channel that
    implements sendFile (WhatsApp, Slack). The caption is optional.
    --as overrides the display filename; the default is basename of the path.
    """
    # Parse --as option out of args first
    filename_override = None
    positional = []
    i = 0
    while i < len(args):
        if args[i] == "--as" and i + 1 < len(args):
            filename_override = args[i + 1]
            i += 2
        else:
            positional.append(args[i])
            i += 1

    if len(positional) < 2:
        fail("Usage: send-file <recipient> <file-path> [<caption>] [--as <name>]")

    query = positional[0]
    file_path_str = positional[1]
    caption = positional[2] if len(positional) > 2 else None

    # Validate file exists and is readable
    if not os.path.isfile(file_path_str):
        fail(f"File not found or not a regular file: {file_path_str}")
    if not os.access(file_path_str, os.R_OK):
        fail(f"File is not readable: {file_path_str}")

    abs_path = os.path.abspath(file_path_str)
    filename = filename_override or os.path.basename(abs_path)

    # Infer mimetype from display filename; fall back to octet-stream
    mime_type, _ = mimetypes.guess_type(filename)
    mimetype = mime_type or "application/octet-stream"

    # Resolve recipient
    recipients = load_registry()
    key, entry = resolve_recipient(query, recipients)
    if not entry:
        fail(f"No recipient found for {query}. Try: resolve \"{query}\"")

    jid = entry["jid"]
    channel = entry.get("channel", "unknown")

    # Route to correct IPC group
    ipc_group = resolve_ipc_group(key, entry)
    ipc_dir = IPC_BASE / ipc_group / "messages"
    ipc_dir.mkdir(parents=True, exist_ok=True)

    msg_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    msg_file = ipc_dir / f"{msg_id}.json"

    ipc_msg = {
        "type": "file",
        "chatJid": jid,
        "filePath": abs_path,
        "filename": filename,
        "mimetype": mimetype,
    }
    if caption:
        ipc_msg["caption"] = caption

    with open(msg_file, "w") as f:
        json.dump(ipc_msg, f, indent=2)
        f.write("\n")

    result = {
        "status": "sent",
        "recipient": key,
        "jid": jid,
        "channel": channel,
        "ipc_group": ipc_group,
        "ipc_file": str(msg_file),
        "filename": filename,
        "mimetype": mimetype,
    }
    if caption:
        result["caption_preview"] = caption[:100] + ("..." if len(caption) > 100 else "")

    ok(result)


def main():
    if len(sys.argv) < 2:
        err("Usage: send-message.py <command> [args...]")
        err("Commands: send, send-file, email, resolve, list, init")
        sys.exit(1)

    command = sys.argv[1].lower()
    args = sys.argv[2:]

    commands = {
        "send": cmd_send,
        "send-file": cmd_send_file,
        "email": cmd_email,
        "resolve": cmd_resolve,
        "list": cmd_list,
        "init": cmd_init,
    }

    if command not in commands:
        cmds = ", ".join(commands)
        fail(f"Unknown command: {command}. Use: {cmds}")

    try:
        commands[command](args)
    except Exception as e:
        fail(f"Unexpected error: {e}")


if __name__ == "__main__":
    main()
