#!/usr/bin/env bash
# Smoke test: runs one built autere image in a container and verifies the
# container boots, the backend starts, 9router is running, pi can be spawned
# (via a fresh session + a prompt) and the LLM turn fails because 9router has
# no valid upstream credentials. Zero external setup expected from the image.
#
# Usage: docker/smoke-test.sh <image:tag> <platform>   (platform: linux/amd64|linux/arm64)
# Override host-network ports with AUTERE_SMOKE_BACKEND_PORT / AUTERE_SMOKE_ROUTER_PORT.
set -euo pipefail

IMAGE="$1"
PLATFORM="$2"
BACKEND_PORT="${AUTERE_SMOKE_BACKEND_PORT:-3456}"
ROUTER_PORT="${AUTERE_SMOKE_ROUTER_PORT:-20128}"
BACKEND_URL="http://localhost:$BACKEND_PORT"
ROUTER_URL="http://localhost:$ROUTER_PORT"
PI_MONITOR_PASSWORD="smoke-$RANDOM$RANDOM"

CONTAINER="autere-smoke-$(echo "$PLATFORM" | tr / -)"
container() { docker exec "$CONTAINER" "$@"; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$CONTAINER-data" "$CONTAINER-pi" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log() { echo "[smoke] [$PLATFORM] $*"; }
die() { log "FAIL: $*"; exit 1; }

# poll <desc> <timeout-sec> <cmd...> — waits until cmd succeeds
poll() {
  local desc="$1" timeout="$2"; shift 2
  local deadline=$((SECONDS + timeout))
  until "$@"; do
    [ $SECONDS -lt $deadline ] || die "$desc: timed out after ${timeout}s"
    sleep 5
  done
}

log "starting container from $IMAGE ($PLATFORM)"
# group_add: the host docker.sock gid, so the backend can talk to the daemon
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
# The CI runner is amd64 even for the arm64 matrix leg. Keep the nested
# sandbox native to the host, and share the host network so its localhost
# router address resolves to the backend's 9router process.
docker run -d --name "$CONTAINER" --platform "$PLATFORM" --network host \
  --group-add "$DOCKER_GID" \
  -e INITIAL_PASSWORD="$PI_MONITOR_PASSWORD" \
  -e NINE_ROUTER_API_KEY=configure-9router-first \
  -e AUTERE_PORT="$BACKEND_PORT" \
  -e AUTERE_NINE_ROUTER_URL="$ROUTER_URL" \
  -e AUTERE_SANDBOX_IMAGE="$IMAGE" \
  -e DOCKER_DEFAULT_PLATFORM=linux/amd64 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$CONTAINER-data":/home/autere/.autere \
  -v "$CONTAINER-pi":/home/autere/.pi \
  "$IMAGE" >/dev/null || die "container did not start"

# 1. backend starts and accepts login (arm64 + QEMU emulation boots slowly)
login() {
  container curl -sf -X POST "$BACKEND_URL/api/v1/auth/login" -H 'content-type: application/json' \
    -d "{\"user\":\"admin\",\"password\":\"$PI_MONITOR_PASSWORD\"}"
}
poll "backend up + admin login" 600 login >/dev/null

TOKEN=$(login | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || die "no auth token from login"
auth=(-H "Authorization: Bearer $TOKEN")

# 2. 9router must be running inside the container (spawned by the backend)
#    without any upstream/model configuration — any HTTP answer other than a
#    connection failure proves it listens on the router port.
poll "9router listening on $ROUTER_URL" 120 \
  docker exec "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' "$ROUTER_URL/" >/dev/null

# 3. Point the per-user 9router extension at this isolated router instance.
#    Otherwise host networking could silently use a developer's existing router.
docker exec "$CONTAINER" sh -c \
  'printf "{\"baseUrl\":\"%s\",\"apiKey\":\"\"}\\n" "$1" > /home/autere/.pi/agent/9router-config.json' \
  sh "$ROUTER_URL"

# 4. create a session (verifies auth/session machinery)
if ! NEW=$(docker exec "$CONTAINER" curl -sS -w '\n%{http_code}' -X POST "$BACKEND_URL/api/v1/sessions" "${auth[@]}" \
  -H 'content-type: application/json' -d '{"sessionName":"smoke-test"}'); then
  die "POST /sessions could not reach the backend"
fi
NEW_STATUS=${NEW##*$'\n'}
NEW_BODY=${NEW%$'\n'*}
if [ "$NEW_STATUS" != 201 ]; then
  log "POST /sessions returned HTTP $NEW_STATUS: $NEW_BODY"
  log "backend error log:"
  docker exec "$CONTAINER" tail -n 80 /home/autere/log/autere.err.log || true
  die "POST /sessions failed"
fi
SESSION_ID=$(echo "$NEW_BODY" | jq -r '.sessionState.sessionId // empty')
[ -n "$SESSION_ID" ] || { log "$NEW_BODY"; die "no sessionId in POST /sessions response"; }
log "created session $SESSION_ID"

# 5. pi must be installed and runnable in the image
docker exec "$CONTAINER" pi --version >/dev/null || die "pi binary not runnable in image"

# 6. Send a prompt. Pi may reject it synchronously or accept it and report
#    the LLM error asynchronously; both paths prove pi ran without credentials.
SEND=$(docker exec "$CONTAINER" curl -sS -X POST "$BACKEND_URL/api/v1/session/messages" "${auth[@]}" \
  -H 'content-type: application/json' -d "{\"sessionId\":\"$SESSION_ID\",\"message\":\"smoke test prompt\"}")
if echo "$SEND" | jq -e '.success == false and (.error | test("No API key found for the selected model|Invalid API key"))' >/dev/null; then
  log "prompt rejected as expected: $(echo "$SEND" | jq -r '.error' | head -n 1)"
elif echo "$SEND" | jq -e '.success == true' >/dev/null; then
  turn_failed() {
    docker exec "$CONTAINER" grep -Eq 'assistant stream ended with stop=error: (No API key found for the selected model|.*Invalid API key)' \
      /home/autere/log/autere.err.log
  }
  TURN_DEADLINE=$((SECONDS + 120))
  until turn_failed; do
    if [ "$SECONDS" -ge "$TURN_DEADLINE" ]; then
      docker exec "$CONTAINER" tail -n 80 /home/autere/log/autere.err.log || true
      die "expected turn failure due to unconfigured 9router credentials"
    fi
    sleep 5
  done
  log "turn failed asynchronously as expected (9router has no valid upstream credentials)"
else
  log "$SEND"
  die "expected missing/invalid 9router credential error"
fi

log "OK: container boots, backend + 9router + pi all start, turn fails with unconfigured credentials as expected"
