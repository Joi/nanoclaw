#!/usr/bin/env python3
"""
Telegram Bot-to-Bot Relay for NanoClaw

Bridges the Telegram Bot API limitation where bots cannot see messages
from other bots. Uses Telethon (MTProto user API) to monitor a group
chat and injects bot messages directly into NanoClaw's SQLite store.

NanoClaw's 2-second polling loop picks them up automatically.
"""

import asyncio
import logging
import os
import re
import signal
import sqlite3
import sys
from datetime import timezone
from pathlib import Path

from telethon import TelegramClient, events

# ---------------------------------------------------------------------------
# Configuration (env vars with sensible defaults)
# ---------------------------------------------------------------------------
API_ID = int(os.environ.get("TELEGRAM_API_ID", "0"))
API_HASH = os.environ.get("TELEGRAM_API_HASH", "")
SESSION_PATH = os.environ.get(
    "RELAY_SESSION_PATH",
    str(Path.home() / "nanoclaw" / "scripts" / "telegram-relay" / "relay.session"),
)
NANOCLAW_DB = os.environ.get(
    "NANOCLAW_DB",
    str(Path.home() / "nanoclaw" / "store" / "messages.db"),
)

# Group chat to monitor (numeric Telegram chat ID, negative for groups)
WATCH_CHAT_ID = int(os.environ.get("RELAY_WATCH_CHAT", "-5212847014"))

# JID format NanoClaw expects
CHAT_JID = f"tg:{WATCH_CHAT_ID}"

# Bot usernames to relay (lowercase, without @)
RELAY_BOTS = set(
    os.environ.get("RELAY_BOTS", "fredforever_bot").lower().split(",")
)

# Our own bot username to skip (don't relay our own messages back)
OWN_BOT_USERNAME = os.environ.get("OWN_BOT_USERNAME", "joiitobot").lower()

# NanoClaw's internal trigger name (what the agent responds to)
ASSISTANT_NAME = os.environ.get("ASSISTANT_NAME", "jibot")

# Telegram @username -> NanoClaw trigger name rewrite map
# When Fred says @joiitobot, we rewrite to @jibot so the trigger fires
MENTION_REWRITES = {
    r"@joiitobot": f"@{ASSISTANT_NAME}",
}

# Display name mapping for relayed bots
BOT_DISPLAY_NAMES = {
    "fredforever_bot": "Fred",
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_PATH = os.environ.get(
    "RELAY_LOG",
    str(Path.home() / "nanoclaw" / "scripts" / "telegram-relay" / "relay.log"),
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("telegram-relay")

# ---------------------------------------------------------------------------
# Mention rewriting
# ---------------------------------------------------------------------------

def rewrite_mentions(text: str) -> str:
    """Rewrite Telegram @bot_username mentions to NanoClaw trigger names."""
    for pattern, replacement in MENTION_REWRITES.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text

# ---------------------------------------------------------------------------
# SQLite injection
# ---------------------------------------------------------------------------

def inject_message(
    msg_id: str,
    sender_id: str,
    sender_name: str,
    content: str,
    timestamp: str,
) -> bool:
    """Insert a message into NanoClaw's messages table.

    Returns True on success, False if duplicate or error.
    """
    try:
        db = sqlite3.connect(NANOCLAW_DB)
        db.execute("PRAGMA journal_mode=WAL")  # safe for concurrent reads

        # Insert message -- is_bot_message=0 so NanoClaw's polling picks it up
        db.execute(
            """
            INSERT OR IGNORE INTO messages
            (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
            VALUES (?, ?, ?, ?, ?, ?, 0, 0)
            """,
            (msg_id, CHAT_JID, sender_id, sender_name, content, timestamp),
        )

        # Update chat's last_message_time so NanoClaw knows there's activity
        db.execute(
            """
            UPDATE chats SET last_message_time = ?
            WHERE jid = ? AND (last_message_time IS NULL OR last_message_time < ?)
            """,
            (timestamp, CHAT_JID, timestamp),
        )

        db.commit()
        db.close()
        return True
    except Exception:
        log.exception("Failed to inject message into NanoClaw DB")
        return False


# ---------------------------------------------------------------------------
# Telethon client
# ---------------------------------------------------------------------------

async def main():
    if not API_ID or not API_HASH:
        log.error(
            "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set. "
            "Get them from https://my.telegram.org"
        )
        sys.exit(1)

    # Ensure session directory exists
    Path(SESSION_PATH).parent.mkdir(parents=True, exist_ok=True)

    client = TelegramClient(SESSION_PATH, API_ID, API_HASH)

    # Graceful shutdown
    stop_event = asyncio.Event()

    def _shutdown(sig, frame):
        log.info(f"Received {signal.Signals(sig).name}, shutting down...")
        stop_event.set()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    await client.start()
    me = await client.get_me()
    log.info(f"Connected as {me.first_name} (@{me.username}, id={me.id})")
    log.info(f"Monitoring chat {WATCH_CHAT_ID} for bots: {RELAY_BOTS}")
    log.info(f"Mention rewrites: {MENTION_REWRITES}")

    @client.on(events.NewMessage(chats=WATCH_CHAT_ID))
    async def on_message(event):
        msg = event.message
        sender = await event.get_sender()

        if sender is None:
            return

        # Only relay messages from bots
        if not getattr(sender, "bot", False):
            return

        # Don't relay our own bot's messages
        username = getattr(sender, "username", "") or ""
        if username.lower() == OWN_BOT_USERNAME:
            return

        # Only relay from configured bots (or all bots if RELAY_BOTS is empty)
        if RELAY_BOTS and username.lower() not in RELAY_BOTS:
            log.debug(f"Skipping bot @{username} (not in relay list)")
            return

        # Get message text
        text = msg.text or msg.message or ""
        if not text.strip():
            return

        # Rewrite @joiitobot -> @jibot so NanoClaw's trigger pattern fires
        text = rewrite_mentions(text)

        # Build display name
        display_name = BOT_DISPLAY_NAMES.get(
            username.lower(),
            sender.first_name or username or str(sender.id),
        )

        # Build unique message ID with relay prefix to avoid collisions
        relay_msg_id = f"relay-{msg.id}"
        timestamp = msg.date.astimezone(timezone.utc).isoformat()

        log.info(
            f"Relaying: @{username} ({display_name}) -> {relay_msg_id}: "
            f"{text[:80]}{'...' if len(text) > 80 else ''}"
        )

        ok = inject_message(
            msg_id=relay_msg_id,
            sender_id=str(sender.id),
            sender_name=display_name,
            content=text,
            timestamp=timestamp,
        )

        if ok:
            log.info(f"Injected {relay_msg_id} into NanoClaw")
        else:
            log.warning(f"Failed to inject {relay_msg_id}")

    log.info("Relay running. Waiting for messages...")

    # Keep running until stop signal
    await stop_event.wait()

    log.info("Disconnecting...")
    await client.disconnect()
    log.info("Relay stopped.")


if __name__ == "__main__":
    asyncio.run(main())
