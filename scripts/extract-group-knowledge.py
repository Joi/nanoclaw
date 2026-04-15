#!/usr/bin/env python3
"""Extract knowledge-worthy content from NanoClaw WhatsApp group messages.

Reads messages from the NanoClaw SQLite DB, extracts URLs, discussion threads,
and notable concepts, then writes jibrain intake markdown files.

Usage:
    python3 extract-group-knowledge.py --group vibez --since 24h
    python3 extract-group-knowledge.py --group vibez --since 7d
    python3 extract-group-knowledge.py --group vibez --since 2026-04-01
    python3 extract-group-knowledge.py --group vibez --since 24h --dry-run
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

# --- Configuration ---
NANOCLAW_HOME = Path.home() / "nanoclaw"
DB_PATH = NANOCLAW_HOME / "store" / "messages.db"
RECIPIENTS_PATH = NANOCLAW_HOME / "data" / "recipients.json"
EXTRACTIONS_BASE = NANOCLAW_HOME / "data" / "extractions"

# Threading: messages within this many seconds form a conversation thread
THREAD_GAP_SECONDS = 300  # 5 minutes

# Minimum messages for a discussion thread to be considered "notable"
MIN_DISCUSSION_MESSAGES = 5

# URL pattern
URL_PATTERN = re.compile(
    r'https?://[^\s<>\"\'\)\]]+',
    re.IGNORECASE
)

# Domains to skip (not knowledge-worthy)
SKIP_URL_DOMAINS = {
    'web.whatsapp.com', 'whatsapp.com',
    'giphy.com', 'tenor.com',
    'facebook.com', 'instagram.com',
}


def parse_since(since_str):
    """Parse --since argument into a UTC datetime.

    Accepts:
        24h, 48h  -> hours ago
        7d, 30d   -> days ago
        2026-04-01 -> absolute date
    """
    now = datetime.now(timezone.utc)

    # Hours
    m = re.match(r'^(\d+)h$', since_str)
    if m:
        return now - timedelta(hours=int(m.group(1)))

    # Days
    m = re.match(r'^(\d+)d$', since_str)
    if m:
        return now - timedelta(days=int(m.group(1)))

    # Absolute date
    try:
        dt = datetime.strptime(since_str, '%Y-%m-%d')
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        pass

    # Absolute datetime
    try:
        dt = datetime.strptime(since_str, '%Y-%m-%dT%H:%M:%S')
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        pass

    raise ValueError(f"Cannot parse --since '{since_str}'. Use 24h, 7d, or YYYY-MM-DD")


def resolve_group(group_arg):
    """Resolve --group argument to (jid, group_folder, group_display_name).

    Checks recipients.json first, then treats as literal JID.
    """
    # Try recipients.json
    if RECIPIENTS_PATH.exists():
        with open(RECIPIENTS_PATH) as f:
            data = json.load(f)
        recipients = data.get("recipients", {})

        # Direct key match
        if group_arg in recipients:
            r = recipients[group_arg]
            return r["jid"], group_arg, r.get("description", group_arg)

        # Alias match
        for name, r in recipients.items():
            aliases = r.get("aliases", [])
            if group_arg.lower() in [a.lower() for a in aliases]:
                return r["jid"], name, r.get("description", name)

    # Fall back to literal JID
    # Generate a folder name from the JID
    folder = re.sub(r'[^a-zA-Z0-9]', '-', group_arg).strip('-')[:40]
    return group_arg, folder, group_arg


def fetch_messages(db_path, jid, since):
    """Fetch messages from the NanoClaw SQLite DB."""
    since_iso = since.strftime('%Y-%m-%dT%H:%M:%S')

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute(
            """SELECT id, chat_jid, sender, sender_name, content, timestamp,
                      is_from_me, is_bot_message,
                      reply_to_message_id, reply_to_sender_name, reply_to_message_content
               FROM messages
               WHERE chat_jid = ? AND timestamp >= ?
               ORDER BY timestamp ASC""",
            (jid, since_iso)
        )
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def parse_timestamp(ts):
    """Parse an ISO timestamp from the DB."""
    ts = ts.rstrip('Z')
    if '+' in ts[10:]:
        ts = ts[:ts.index('+', 10)]
    for fmt in ('%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S'):
        try:
            return datetime.strptime(ts, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(f"Cannot parse timestamp: {ts}")


def group_into_threads(messages):
    """Group messages into conversation threads based on time gaps."""
    if not messages:
        return []

    threads = []
    current_thread = [messages[0]]
    last_time = parse_timestamp(messages[0]['timestamp'])

    for msg in messages[1:]:
        msg_time = parse_timestamp(msg['timestamp'])
        gap = (msg_time - last_time).total_seconds()

        if gap > THREAD_GAP_SECONDS:
            threads.append(current_thread)
            current_thread = [msg]
        else:
            current_thread.append(msg)
        last_time = msg_time

    if current_thread:
        threads.append(current_thread)

    return threads


def extract_urls(text):
    """Extract knowledge-worthy URLs from message text."""
    if not text:
        return []
    urls = URL_PATTERN.findall(text)
    # Clean trailing punctuation
    cleaned = []
    for url in urls:
        url = url.rstrip('.,;:!?)>]')
        try:
            parsed = urlparse(url)
            domain = parsed.netloc.lower()
            if domain.startswith('www.'):
                domain = domain[4:]
            if domain in SKIP_URL_DOMAINS:
                continue
            cleaned.append(url)
        except Exception:
            continue
    return cleaned


def slug_from_url(url):
    """Generate a file slug from a URL."""
    parsed = urlparse(url)
    domain = parsed.netloc.lower().replace('www.', '')
    path = parsed.path.strip('/')

    # Use domain + last path segment
    if path:
        segments = [s for s in path.split('/') if s]
        slug_parts = [domain.split('.')[0]] + segments[-2:]
    else:
        slug_parts = [domain.replace('.', '-')]

    slug = '-'.join(slug_parts)
    # Clean up
    slug = re.sub(r'[^a-zA-Z0-9-]', '-', slug)
    slug = re.sub(r'-+', '-', slug).strip('-').lower()
    return slug[:60]


def slug_from_text(text):
    """Generate a slug from discussion text."""
    words = re.findall(r'[a-zA-Z]+', text.lower())
    stop = {'the', 'a', 'an', 'is', 'was', 'are', 'were', 'it', 'to', 'of',
            'in', 'for', 'on', 'at', 'and', 'or', 'but', 'not', 'this', 'that',
            'with', 'from', 'by', 'as', 'be', 'has', 'have', 'had', 'do', 'does',
            'did', 'will', 'can', 'could', 'would', 'should', 'may', 'might',
            'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us',
            'them', 'my', 'your', 'his', 'its', 'our', 'their', 'just', 'like',
            'yeah', 'lol', 'ok', 'okay'}
    meaningful = [w for w in words if w not in stop and len(w) > 2][:5]
    if not meaningful:
        meaningful = words[:3]
    return '-'.join(meaningful)[:40] or 'discussion'


def guess_tags(messages, urls):
    """Guess relevant tags from message content."""
    all_text = ' '.join(m.get('content', '') or '' for m in messages).lower()

    tag_patterns = {
        'ai': r'\b(ai|artificial intelligence|llm|gpt|claude|openai|anthropic|gemini|model)\b',
        'coding': r'\b(code|coding|programming|developer|dev|github|repo|api|sdk)\b',
        'crypto': r'\b(crypto|bitcoin|ethereum|blockchain|web3|defi|nft)\b',
        'design': r'\b(design|figma|ui|ux|frontend|css)\b',
        'security': r'\b(security|vulnerability|hack|exploit|privacy|encryption)\b',
        'startup': r'\b(startup|founder|vc|funding|launch|product)\b',
        'open-source': r'\b(open.?source|oss|foss|libre)\b',
        'tools': r'\b(tool|app|software|platform|service)\b',
        'research': r'\b(paper|research|study|academic|arxiv|journal)\b',
        'hardware': r'\b(hardware|chip|gpu|raspberry.?pi|arduino|robot)\b',
    }

    tags = ['whatsapp-intake']
    for tag, pattern in tag_patterns.items():
        if re.search(pattern, all_text):
            tags.append(tag)

    # Domain-based tags from URLs
    for url in urls:
        domain = urlparse(url).netloc.lower()
        if 'github.com' in domain:
            if 'coding' not in tags:
                tags.append('coding')
        elif 'arxiv.org' in domain:
            if 'research' not in tags:
                tags.append('research')
        elif 'youtube.com' in domain or 'youtu.be' in domain:
            if 'video' not in tags:
                tags.append('video')

    # Dedupe preserving order
    seen = set()
    deduped = []
    for t in tags:
        if t not in seen:
            seen.add(t)
            deduped.append(t)
    return deduped


def describe_url_context(url, thread):
    """Extract a description and surrounding context for a shared URL.

    Returns (description, context_markdown).
    """
    url_msg = None
    url_idx = 0
    for i, msg in enumerate(thread):
        if msg.get('content') and url in msg['content']:
            url_msg = msg
            url_idx = i
            break

    if not url_msg:
        return "Shared link", ""

    # Description: the message text minus the URL, or the URL domain
    content = url_msg.get('content', '')
    desc_text = content.replace(url, '').strip()
    if len(desc_text) > 10:
        description = desc_text[:120].replace('"', "'")
    else:
        domain = urlparse(url).netloc.replace('www.', '')
        path = urlparse(url).path.strip('/')
        description = "Link to " + domain + ("/" + path if path else "")
        description = description[:120]

    # Context: surrounding messages (2 before, 2 after)
    start = max(0, url_idx - 2)
    end = min(len(thread), url_idx + 3)
    context_lines = []
    for msg in thread[start:end]:
        sender = msg.get('sender_name', 'Unknown')
        text = msg.get('content', '')
        if text:
            context_lines.append("**{}**: {}".format(sender, text))

    return description, '\n\n'.join(context_lines)


def format_date(ts):
    """Format a timestamp as YYYY-MM-DD."""
    return parse_timestamp(ts).strftime('%Y-%m-%d')


def format_date_display(ts):
    """Format a timestamp for display."""
    return parse_timestamp(ts).strftime('%Y-%m-%d %H:%M UTC')


def generate_url_file(url, thread, group_display):
    """Generate markdown content for a URL extraction file.

    Returns (filename, content).
    """
    url_msg = None
    for msg in thread:
        if msg.get('content') and url in msg['content']:
            url_msg = msg
            break
    if not url_msg:
        url_msg = thread[0]

    date_str = format_date(url_msg['timestamp'])
    sender = url_msg.get('sender_name', 'Unknown')
    slug = slug_from_url(url)
    filename = "{}-wa-{}.md".format(date_str, slug)

    description, context = describe_url_context(url, thread)
    tags = guess_tags(thread, [url])

    # Title from URL
    domain = urlparse(url).netloc.replace('www.', '')
    path_parts = [p for p in urlparse(url).path.strip('/').split('/') if p]
    if path_parts:
        title = "{}: {}".format(domain, '/'.join(path_parts[-2:]))
    else:
        title = domain

    tag_str = ', '.join(tags)

    content = """---
type: reference
description: "{description}"
source: whatsapp-group
source_group: "{group_display}"
source_date: {date_str}
tags: [{tag_str}]
status: draft
agent: jibot
---

# {title}

> Shared by {sender} in {group_display} on {date_display}

## URL
{url}

## Context
{context}
""".format(
        description=description,
        group_display=group_display,
        date_str=date_str,
        tag_str=tag_str,
        title=title,
        sender=sender,
        date_display=format_date_display(url_msg['timestamp']),
        url=url,
        context=context
    )
    return filename, content


def generate_discussion_file(thread, group_display):
    """Generate markdown for a notable discussion thread.

    Returns (filename, content) or None if thread isn't notable.
    """
    # Filter to substantive messages (not just reactions/short)
    substantive = [m for m in thread if m.get('content') and len(m['content']) > 15]
    if len(substantive) < MIN_DISCUSSION_MESSAGES:
        return None

    date_str = format_date(thread[0]['timestamp'])
    first_text = substantive[0].get('content', 'discussion')
    slug = slug_from_text(first_text)
    filename = "{}-wa-discussion-{}.md".format(date_str, slug)

    # Participants
    seen_names = set()
    participants = []
    for m in thread:
        name = m.get('sender_name')
        if name and name not in seen_names:
            seen_names.add(name)
            participants.append(name)

    # All URLs in this thread
    all_urls_set = set()
    all_urls = []
    for msg in thread:
        for u in extract_urls(msg.get('content', '')):
            if u not in all_urls_set:
                all_urls_set.add(u)
                all_urls.append(u)

    tags = guess_tags(thread, all_urls)
    description = "Discussion with {} participants about {}".format(
        len(participants), first_text[:60]
    ).replace('"', "'")

    tag_str = ', '.join(tags)

    # Build conversation
    convo_lines = []
    for msg in thread:
        sender = msg.get('sender_name', 'Unknown')
        text = msg.get('content', '')
        time_str = format_date_display(msg['timestamp'])
        if text:
            convo_lines.append("**{}** ({}):\n{}".format(sender, time_str, text))

    content = """---
type: concept
description: "{description}"
source: whatsapp-group
source_group: "{group_display}"
source_date: {date_str}
tags: [{tag_str}]
status: draft
agent: jibot
---

# Discussion: {title}

> {n_participants} participants in {group_display} on {date_str}
> Participants: {participants}

## Conversation

{conversation}
""".format(
        description=description,
        group_display=group_display,
        date_str=date_str,
        tag_str=tag_str,
        title=first_text[:80],
        n_participants=len(participants),
        participants=', '.join(participants),
        conversation='\n\n'.join(convo_lines)
    )

    if all_urls:
        content += "\n## URLs Referenced\n\n"
        for u in all_urls:
            content += "- {}\n".format(u)

    return filename, content


def load_last_extract(extract_dir):
    """Load last extraction timestamp."""
    marker = extract_dir / ".last-extract"
    if marker.exists():
        ts_str = marker.read_text().strip()
        if ts_str:
            return parse_timestamp(ts_str)
    return None


def save_last_extract(extract_dir, ts):
    """Save extraction timestamp."""
    marker = extract_dir / ".last-extract"
    marker.write_text(ts.strftime('%Y-%m-%dT%H:%M:%SZ') + '\n')


def main():
    parser = argparse.ArgumentParser(
        description="Extract knowledge from WhatsApp group messages"
    )
    parser.add_argument('--group', required=True,
                        help="Group name (from recipients.json) or JID")
    parser.add_argument('--since', required=True,
                        help="Time range: 24h, 7d, or YYYY-MM-DD")
    parser.add_argument('--dry-run', action='store_true',
                        help="Print what would be extracted without writing files")
    parser.add_argument('--db', type=str, default=str(DB_PATH),
                        help="Path to messages.db")
    args = parser.parse_args()

    # Resolve group
    jid, group_folder, group_display = resolve_group(args.group)

    # Parse time
    since = parse_since(args.since)

    # Check DB exists
    db_path = Path(args.db)
    if not db_path.exists():
        print("Error: Database not found at {}".format(db_path), file=sys.stderr)
        sys.exit(1)

    # Fetch messages
    messages = fetch_messages(db_path, jid, since)

    if not messages:
        print("No messages found")
        sys.exit(0)

    # Group into threads
    threads = group_into_threads(messages)

    # Extract knowledge items
    knowledge_items = []  # (filename, content, item_type)
    all_urls = []
    seen_urls = set()

    for thread in threads:
        # Extract URLs from the thread
        thread_urls = []
        for msg in thread:
            urls = extract_urls(msg.get('content', ''))
            for url in urls:
                if url not in seen_urls:
                    seen_urls.add(url)
                    thread_urls.append(url)
                    all_urls.append(url)

        # Generate URL files
        for url in thread_urls:
            filename, content = generate_url_file(url, thread, group_display)
            knowledge_items.append((filename, content, 'url'))

        # Generate discussion file if notable
        result = generate_discussion_file(thread, group_display)
        if result:
            filename, content = result
            knowledge_items.append((filename, content, 'discussion'))

    # Output directory
    extract_dir = EXTRACTIONS_BASE / group_folder

    # Check for duplicates against existing files
    existing_files = set()
    if extract_dir.exists():
        existing_files = {
            f.name for f in extract_dir.iterdir()
            if f.is_file() and f.suffix == '.md'
        }

    new_items = [
        (fn, content, itype)
        for fn, content, itype in knowledge_items
        if fn not in existing_files
    ]

    # Summary
    summary = {
        "group": group_folder,
        "group_display": group_display,
        "jid": jid,
        "since": since.isoformat(),
        "message_count": len(messages),
        "thread_count": len(threads),
        "urls_found": len(all_urls),
        "knowledge_items": len(new_items),
        "skipped_existing": len(knowledge_items) - len(new_items),
        "dry_run": args.dry_run,
    }

    if args.dry_run:
        summary["items"] = []
        for fn, content, itype in new_items:
            summary["items"].append({
                "filename": fn,
                "type": itype,
                "lines": len(content.splitlines()),
            })
        print(json.dumps(summary, indent=2))
        return

    # Write files
    if new_items:
        extract_dir.mkdir(parents=True, exist_ok=True)

        for fn, content, itype in new_items:
            filepath = extract_dir / fn
            filepath.write_text(content)
            print("  wrote: {}".format(filepath), file=sys.stderr)

        # Update last extraction timestamp
        last_ts = parse_timestamp(messages[-1]['timestamp'])
        save_last_extract(extract_dir, last_ts)

    # Print summary to stdout
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
