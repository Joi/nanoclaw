#!/bin/bash
export GOG_KEYRING_PASSWORD=gogjibot

# Strip --from flag from "gmail send" commands to avoid send-as verification
# errors. The agent sometimes adds --from jibot@ito.com but Gmail requires
# send-as alias verification even for the primary address. Without --from,
# gog uses the account default which works without verification.

# Check if this is a "gmail send" (or "mail send" / "email send") command
is_gmail_send=false
prev=""
for arg in "$@"; do
    if [[ "$arg" == "send" && ("$prev" == "gmail" || "$prev" == "mail" || "$prev" == "email") ]]; then
        is_gmail_send=true
        break
    fi
    prev="$arg"
done

# Build filtered args, stripping --from <value> for gmail send
args=()
skip_next=false
for arg in "$@"; do
    if [[ "$skip_next" == true ]]; then
        skip_next=false
        continue
    fi
    if [[ "$is_gmail_send" == true && "$arg" == "--from" ]]; then
        skip_next=true
        continue
    fi
    args+=("$arg")
done

if [ -f /.dockerenv ]; then
    export XDG_CONFIG_HOME=/workspace/.config
    export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
    exec /usr/local/bin/gog-linux "${args[@]}"
else
    exec /opt/homebrew/bin/gog "${args[@]}"
fi
