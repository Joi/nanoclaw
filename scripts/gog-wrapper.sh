#!/bin/bash
export GOG_KEYRING_PASSWORD=gogjibot

if [ -f /.dockerenv ]; then
    export XDG_CONFIG_HOME=/workspace/.config
    export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
    exec /usr/local/bin/gog-linux "$@"
else
    exec /opt/homebrew/bin/gog "$@"
fi
