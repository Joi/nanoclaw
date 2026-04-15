#!/bin/bash
# fetch-tweet.sh - Fetch tweet/X post content via FxTwitter API (no auth needed)
# Usage: fetch-tweet.sh <url_or_status_id>
# Examples:
#   fetch-tweet.sh https://x.com/user/status/123456789
#   fetch-tweet.sh https://twitter.com/user/status/123456789
#   fetch-tweet.sh 123456789

set -euo pipefail

url="$1"

# Extract status ID from URL or use as-is
status_id=$(echo "$url" | grep -oE '[0-9]{15,}' | tail -1)

if [ -z "$status_id" ]; then
    echo "Error: Could not extract tweet/status ID from: $url" >&2
    exit 1
fi

# Fetch via FxTwitter API (public, no auth needed)
response=$(curl -sf "https://api.fxtwitter.com/status/$status_id" 2>/dev/null)

if [ -z "$response" ]; then
    echo "Error: Failed to fetch tweet $status_id" >&2
    exit 1
fi

# Format the output
python3 -c "
import json, sys, textwrap

data = json.loads('''$response''')
tweet = data.get('tweet', {})
author = tweet.get('author', {})

print(f\"\"\"## Tweet by @{author.get('screen_name', '?')} ({author.get('name', '?')})
**Date:** {tweet.get('created_at', '?')}
**Likes:** {tweet.get('likes', 0):,} | **Retweets:** {tweet.get('retweets', 0):,} | **Replies:** {tweet.get('replies', 0):,}

{tweet.get('text', 'No text')}
\"\"\")

# Show media if present
media = tweet.get('media', {})
photos = media.get('photos', [])
videos = media.get('videos', [])
if photos:
    print('**Media:**')
    for p in photos:
        print(f\"  - Image: {p.get('url', '?')}\")
if videos:
    print('**Media:**')
    for v in videos:
        print(f\"  - Video: {v.get('url', '?')}\")

# Show quote tweet if present
qt = tweet.get('quote', {})
if qt:
    qa = qt.get('author', {})
    print(f\"\n**Quote tweet from @{qa.get('screen_name', '?')}:**\")
    print(qt.get('text', ''))

# Show reply context
if tweet.get('replying_to'):
    print(f\"\n*Replying to @{tweet.get('replying_to')}*\")

print(f\"\n**Source:** https://x.com/{author.get('screen_name', '_')}/status/{tweet.get('id', status_id)}\")
" 2>/dev/null || echo "$response"
