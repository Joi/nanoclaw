---
name: fetch-tweet
description: Read X/Twitter posts without authentication. Use when someone shares a twitter.com or x.com link and you need to see the tweet content. Replaces failed WebFetch attempts on Twitter URLs.
---

# Reading X/Twitter Posts

Twitter/X blocks unauthenticated WebFetch. Use the FxTwitter API instead.

## When to Use

When you see a URL matching `x.com/*/status/*` or `twitter.com/*/status/*` and need to read the tweet.

**DO NOT use WebFetch on Twitter/X URLs.** It will return a login page, not the tweet.

## How to Read a Tweet

Extract the numeric status ID from the URL, then fetch via FxTwitter API:

```bash
# Extract status ID and fetch tweet content
STATUS_ID=$(echo "THE_URL_HERE" | grep -oE '[0-9]{15,}' | tail -1)
curl -sf "https://api.fxtwitter.com/status/$STATUS_ID" | python3 -c "
import json, sys
data = json.load(sys.stdin)
t = data.get('tweet', {})
a = t.get('author', {})
print(f'@{a.get(\"screen_name\", \"?\")} ({a.get(\"name\", \"?\")})  —  {t.get(\"created_at\", \"?\")}')
print(f'Likes: {t.get(\"likes\", 0):,} | RTs: {t.get(\"retweets\", 0):,} | Replies: {t.get(\"replies\", 0):,}')
print()
print(t.get('text', 'No text'))
media = t.get('media', {})
for p in media.get('photos', []):
    print(f'[Image: {p.get(\"url\", \"?\")}]')
for v in media.get('videos', []):
    print(f'[Video: {v.get(\"url\", \"?\")}]')
qt = t.get('quote', {})
if qt:
    print(f'> Quote from @{qt.get(\"author\",{}).get(\"screen_name\",\"?\")}: {qt.get(\"text\",\"\")}')
"
```

## Example

User asks: "is this real? https://x.com/someuser/status/123456789"

```bash
curl -sf "https://api.fxtwitter.com/status/123456789" | python3 -c "
import json, sys
data = json.load(sys.stdin)
t = data.get('tweet', {})
a = t.get('author', {})
print(f'@{a.get(\"screen_name\",\"?\")} ({a.get(\"name\",\"?\")})')
print(t.get('text', ''))
print(f'Likes: {t.get(\"likes\",0):,}')
"
```

Then analyze the content and respond to the user's question.

## Also Works For

- **User profiles**: `curl -sf "https://api.fxtwitter.com/USER_HANDLE"` (without /status/)
- **Quote tweets**: Included in the tweet JSON under `.tweet.quote`
- **Media**: Photos and videos included in `.tweet.media`
- **Reply context**: `.tweet.replying_to` shows who the tweet replies to
