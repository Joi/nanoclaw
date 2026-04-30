# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    poppler-utils \
    tesseract-ocr \
    socat \
    && rm -rf /var/lib/apt/lists/*

# Defense-in-depth for CVE-2026-31431 (Linux kernel AF_ALG LPE, disclosed 2026-04-29).
# The exploit chain is socket(AF_ALG) -> write payload -> exec `su` to root. The
# seccomp profile (seccomp/agent-default.json, wired in via container-runner.ts)
# breaks step 1; this layer breaks step 3 by removing the `su` primitive entirely.
# Independently effective: even if a future kernel LPE bypasses seccomp, an agent
# in this image has no `su` to escalate with.
#
# Other setuid binaries shipped in node:22-slim that this layer also strips:
# `passwd`, `chfn`, `chsh`, `gpasswd`, `newgrp` (no legitimate use in agent
# containers; removing them shrinks the privilege-escalation surface). `mount`
# and `umount` are deliberately retained — chromium's renderer sandbox sometimes
# inspects them and removing them surfaces noisy errors without gaining defense
# (the syscalls are already blocked by seccomp + no-new-privileges + USER node).
#
# See ~/switchboard/jibrain/atlas/concepts/2026-04-30-CVE-2026-31431-AF-ALG-LPE.md
# and beads jibot-code-ilg.
RUN rm -f /bin/su /usr/bin/su \
          /usr/bin/passwd /usr/bin/chfn /usr/bin/chsh \
          /usr/bin/gpasswd /usr/bin/newgrp \
    && ! command -v su

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @tobilu/qmd

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
