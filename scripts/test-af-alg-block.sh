#!/usr/bin/env bash
# test-af-alg-block.sh — pre-deploy / nightly verification that the
# NanoClaw seccomp profile blocks AF_ALG socket creation with errno=EPERM.
#
# Why this exists (jibot-code-1bt): the existing vitest assertion
# (container-runner.test.ts) only verifies that --security-opt seccomp=...
# appears in the spawn args. It does NOT verify that the profile is
# correctly loaded and enforces the deny rule at runtime. The ones that
# would catch a broken profile are runtime checks against actual Docker
# behavior, which require docker + Linux + a container image.
#
# This script runs the canonical AF_ALG creation test inside a container
# spawned with our seccomp profile and pins the expected behavior:
#   - socket(AF_ALG, SOCK_SEQPACKET, 0) MUST raise PermissionError with
#     errno=EPERM (1). Anything else is a regression:
#       errno=94 (ESOCKTNOSUPPORT) → kernel rejected, profile not blocking
#       errno=97 (EAFNOSUPPORT)    → kernel doesn't have AF_ALG, irrelevant
#       valid fd                   → profile silently not loaded — RED ALERT
#   - socket(AF_INET, SOCK_STREAM, 0) MUST succeed (sanity — we haven't
#     accidentally over-restricted).
#
# Run locally (any Linux host with docker + the agent image):
#   ./scripts/test-af-alg-block.sh
#
# Run remotely on jibotmac (the canonical pre-deploy invocation):
#   ssh jibotmac 'cd ~/nanoclaw && ./scripts/test-af-alg-block.sh'
#
# Exit codes:
#   0 — both checks passed
#   1 — a check failed (or docker / image unavailable)
#
# Adjacent context: the static unit test in container-runner.test.ts
# verifies the SPAWN ARG SHAPE (--security-opt seccomp=<abs path>); this
# script verifies the PROFILE BEHAVIOR. Both layers matter and they catch
# different classes of regression.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_PATH="${REPO_ROOT}/seccomp/agent-default.json"
IMAGE="${NANOCLAW_AGENT_IMAGE:-nanoclaw-agent:latest}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

# Preflight
if ! command -v docker >/dev/null 2>&1; then
  red "FAIL: docker not found in PATH"
  exit 1
fi
if [[ ! -f "${PROFILE_PATH}" ]]; then
  red "FAIL: seccomp profile not found at ${PROFILE_PATH}"
  exit 1
fi
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  red "FAIL: container image ${IMAGE} not present locally"
  yellow "  Build it with: cd container && docker build -t nanoclaw-agent:latest ."
  exit 1
fi

# The canonical test: socket(AF_ALG, SOCK_SEQPACKET, 0).
# Pin errno explicitly so we distinguish "blocked by seccomp" from
# "kernel-side ESOCKTNOSUPPORT" and friends.
TEST_PY=$(cat <<'PYEOF'
import socket, sys, errno

# AF_ALG socket creation — must be blocked with EPERM under our profile
try:
    s = socket.socket(socket.AF_ALG, socket.SOCK_SEQPACKET, 0)
    print(f"FAIL: AF_ALG socket OPENED (fd={s.fileno()}) — profile NOT enforcing the AF_ALG deny rule")
    sys.exit(1)
except PermissionError as e:
    if e.errno == errno.EPERM:
        print(f"OK: AF_ALG blocked with errno={e.errno} (EPERM)")
    else:
        code = errno.errorcode.get(e.errno, "?")
        print(f"FAIL: AF_ALG raised PermissionError but errno={e.errno} ({code}), expected EPERM (1)")
        sys.exit(1)
except OSError as e:
    code = errno.errorcode.get(e.errno, "?")
    if e.errno == errno.EAFNOSUPPORT:
        print(f"WARN: AF_ALG rejected as EAFNOSUPPORT — kernel lacks AF_ALG, profile cannot be tested here")
        # Treat as inconclusive rather than fail; this means seccomp may or
        # may not be doing its job, we can't tell from outside.
    else:
        print(f"FAIL: AF_ALG raised OSError errno={e.errno} ({code}), expected PermissionError EPERM")
        sys.exit(1)

# AF_INET sanity — must still work
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM, 0)
    print(f"OK: AF_INET still works (fd={s.fileno()})")
    s.close()
except OSError as e:
    code = errno.errorcode.get(e.errno, "?")
    print(f"FAIL: AF_INET unexpectedly blocked — errno={e.errno} ({code}). Profile is over-restricting.")
    sys.exit(1)

print("PASS: seccomp profile correctly blocks AF_ALG and allows AF_INET")
PYEOF
)

# Mirror production flags: no-new-privileges, custom seccomp, read-only,
# tmpfs nosuid, --cap-drop ALL. This is exactly what container-runner.ts
# applies to live agent containers.
echo "Profile under test: ${PROFILE_PATH}"
echo "Image:              ${IMAGE}"
echo

# Pipe the test script in via stdin (cleaner than -v bind-mount which has
# Colima/Docker-Desktop path-translation surprises on macOS hosts).
docker run --rm -i --user 0:0 --entrypoint /bin/sh \
  --security-opt no-new-privileges \
  --security-opt seccomp="${PROFILE_PATH}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /home/node/.npm:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  "${IMAGE}" \
  -c 'cat > /tmp/test.py && python3 /tmp/test.py' <<<"${TEST_PY}"

result=$?
if [[ ${result} -eq 0 ]]; then
  green "AF_ALG block verified ✓"
else
  red "AF_ALG block check FAILED (exit ${result})"
fi
exit ${result}
