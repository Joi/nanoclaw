#!/bin/sh
# bookmark - Send a URL to the bookmark-extractor sprite for knowledge extraction
#
# Usage:
#   bookmark <url> [hint]
#   bookmark --health
#   bookmark --recent
#
# Hints: person, concept, organization, reference, event, project
#
# The sprite extracts content, classifies it, and writes vault-compatible
# markdown. Syncthing syncs the files back to all machines automatically.

RELAY="http://host.docker.internal:9999"
CURL="/workspace/.bin/curl"
CACERT="/workspace/.config/ca-certificates.crt"

case "${1:-}" in
  --health)
    $CURL --cacert "$CACERT" -s "$RELAY/health"
    ;;
  --recent)
    $CURL --cacert "$CACERT" -s "$RELAY/recent"
    ;;
  --help|-h|"")
    echo "Usage: bookmark <url> [hint]"
    echo "       bookmark --health"
    echo "       bookmark --recent"
    echo ""
    echo "Hints: person, concept, organization, reference, event, project"
    exit 0
    ;;
  *)
    URL="$1"
    HINT="${2:-}"
    if [ -n "$HINT" ]; then
      PAYLOAD="{\"url\": \"$URL\", \"hint\": \"$HINT\"}"
    else
      PAYLOAD="{\"url\": \"$URL\"}"
    fi
    $CURL --cacert "$CACERT" -s -X POST "$RELAY/intake" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD"
    ;;
esac
