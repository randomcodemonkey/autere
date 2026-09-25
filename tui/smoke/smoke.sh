#!/usr/bin/env bash
# TUI smoke test: isolated backend + seeded session + pty-driven TUI + PNG screenshots.
# Usage: bash smoke/smoke.sh   (from tui/)
set -e
cd "$(dirname "$0")/.."
TD=$(mktemp -d /tmp/autere-tui-smoke.XXXX)
PORT=3947

cleanup() {
  # kill by command-line marker — the smoke backend is the only process
  # matching this (stale test instances from earlier runs included)
  pkill -f "monitor-password testpw" 2>/dev/null || true
  [ -n "$SMOKE_DEBUG" ] && [ -f "$TD/backend.log" ] && cp "$TD/backend.log" /tmp/smoke-backend.log
  rm -rf "$TD"
}
trap cleanup EXIT

# ── isolated backend (AUTERE_DIR keeps auth/users/settings out of ~/.autere) ──
export AUTERE_DIR=$TD/autere AUTERE_PI_ENVS_DIR=$TD/pi-envs AUTERE_USERS_FILE=$TD/autere/users.json \
  AUTERE_ADMIN_USER=admin AUTERE_ADMIN_PASSWORD=testpw PI_SANDBOX_IMAGE=off
npx tsx ../src/backend/index.ts --port $PORT --monitor-auth true --monitor-password testpw \
  > "$TD/backend.log" 2>&1 &
for i in $(seq 1 30); do
  curl -s -o /dev/null http://127.0.0.1:$PORT/api/v1/auth/status && break
  sleep 0.5
done
curl -s -o /dev/null http://127.0.0.1:$PORT/api/v1/auth/status || { echo 'ERROR: backend did not come up'; cat "$TD/backend.log"; exit 1; }

# ── seed one session (pi session-file format: header + messages) ──
mkdir -p "$TD/pi-envs/admin/sessions" "$TD/autere"
python3 - "$TD" <<'EOF'
import json, sys, time
td = sys.argv[1]
lines = [
  {"type": "session", "id": "smoke-seeded-0001", "timestamp": "2026-09-25T15:00:00.000Z", "cwd": "/tmp", "parentSession": None},
  {"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "Hello from the seeded session"}]}, "timestamp": time.time() * 1000},
  {"type": "message", "message": {"role": "assistant", "provider": "9router", "model": "test/model", "content": [{"type": "text", "text": "Hi! TUI smoke test reply."}]}, "timestamp": time.time() * 1000},
]
with open(f"{td}/pi-envs/admin/sessions/smoke-seeded.jsonl", "w") as f:
    for l in lines:
        f.write(json.dumps(l) + "\n")

# color override: user messages in pure green — driver asserts the TUI emits it
json.dump({"user": "#00ff00"}, open(f"{td}/autere/tui-colors.json", "w"))
EOF

# ── drive the TUI in a pty ──
python3 smoke/driver.py http://127.0.0.1:$PORT admin testpw

# ── render screenshots ──
node smoke/render.mjs
echo "Screenshots in tui/smoke/out/*.png"
