#!/usr/bin/env bash
# CLI integration tests — isolated backend + isolated HOME so nothing ever
# touches real ~/.autere state or the master backend.
#
# Starts ONE isolated autere backend (tmp AUTERE_DIR/PI_ENVS_DIR/users file,
# auth enabled with a known admin password, sandbox off), seeds a session
# file, then drives ../autere.js through its command groups asserting on
# output/exit codes.
#
# Usage: bash cli/test/run.sh          (or: npm run test:cli)
#
# Prerequisite (same as e2e): a master pi install with pi-9router-ext and
# the 9router provider in $HOME/.pi/agent/settings.json — pi turns are real
# assertions here, not mocked at the pi layer.
set -u
cd "$(dirname "$0")/../.."

PASS=0; FAIL=0
TD=$(mktemp -d /tmp/autere-cli-test.XXXX)
PORT=$(( 31000 + RANDOM % 20000 ))
CLI="$PWD/cli/autere.js"
WORK="$TD/work"
# JUnit report (what jest-junit / cypress junit reporter emit) — standard
# input for any CI test-summary UI or reporter action.
JUNIT="$PWD/cli/test/results/junit.xml"
rm -f "$JUNIT"; mkdir -p "$(dirname "$JUNIT")"
SUITE="setup"; CASES=""
mkdir -p "$WORK"

# XML attribute/text escaping (+ drop control chars a truncated OUT may carry)
xesc() { printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

fail() {
  echo "  ✗ $1"; FAIL=$((FAIL+1))
  CASES="$CASES    <testcase classname=\"cli.$(xesc "$SUITE")\" name=\"$(xesc "$1")\"><failure message=\"$(xesc "$1")\"/></testcase>\n"
}
ok() {
  echo "  ✓ $1"; PASS=$((PASS+1))
  CASES="$CASES    <testcase classname=\"cli.$(xesc "$SUITE")\" name=\"$(xesc "$1")\"/>\n"
}
section() { echo; echo "== $1 =="; SUITE="$1"; }

# assert_in <needle> <desc> — needle must appear in $OUT (set by cli())
assert_in() {
  case "$OUT" in *"$1"*) ok "$2";; *) fail "$2 — expected '$1' in: $(printf '%s' "$OUT" | head -c 200)";; esac
}
assert_exit() { [ "${RC:-}" = "$1" ] && ok "$2" || fail "$2 — exit ${RC:-unset} (want $1)"; }

# cli <args...> — run the CLI against the test backend & isolated HOME.
# Captures combined output in $OUT and the exit code in $RC (nothing is
# printed, so tests assert on $OUT — never pipe the function call).
cli() {
  OUT=$(HOME="$TD/home" AUTERE_URL="http://127.0.0.1:$PORT" timeout 60 node "$CLI" "$@" 2>&1)
  RC=$?
}

cleanup() {
  # An early abort (setup/prerequisite failure) never reaches the summary —
  # still emit a report so CI always has one to ingest.
  if [ -z "${JUNIT_DONE:-}" ]; then
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
      '<testsuites><testsuite name="cli" tests="1" failures="1">' \
      '  <testcase classname="cli" name="harness aborted before summary (see job log)"><failure message="harness aborted before summary (see job log)"/></testcase>' \
      '</testsuite></testsuites>' > "$JUNIT"
  fi
  [ -n "${ROUTER_PID:-}" ] && kill "$ROUTER_PID" 2>/dev/null
  # Kill the backend and its children (pi processes are direct children)
  [ -n "${BACKEND_PID:-}" ] || return
  for p in $(ps -o pid= --ppid "$BACKEND_PID" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  kill "$BACKEND_PID" 2>/dev/null
  wait "$BACKEND_PID" 2>/dev/null
  rm -rf "$TD"
}
trap cleanup EXIT

section "start isolated backend"
# Mock router first: the backend's 9router preflight and pi's model calls
# target it (no live router on a CI runner). Its isolated cache keeps the
# discovery cache out of the dev box's real ~/.cache/pi.
grep -q '9router' "$HOME/.pi/agent/settings.json" 2>/dev/null || {
  echo "prerequisite missing: $HOME/.pi/agent/settings.json must enable the 9router provider (pi + pi-9router-ext — see the 'Install pi' step in .github/workflows/tests.yml)"
  exit 1
}
# Tests must spawn the SAME pi the release image ships (docker/Dockerfile).
SPAWNED_PI=$(node -p "JSON.parse(require('fs').readFileSync('node_modules/@earendil-works/pi-coding-agent/package.json','utf8')).version")
RELEASE_PI=$(grep -oE 'pi-coding-agent@[0-9][0-9.]*' docker/Dockerfile | head -1 | cut -d@ -f2)
[ -n "$RELEASE_PI" ] && [ "$SPAWNED_PI" = "$RELEASE_PI" ] || {
  echo "pi version mismatch: tests spawn $SPAWNED_PI, release ships $RELEASE_PI (docker/Dockerfile)"
  exit 1
}
# pi resolves an extension's npm deps by walking up from the symlinked env
# path (/tmp/…/pi-envs/admin/extensions/…) — that chain has no node_modules
# on CI (upstream node lacks Debian's /usr/share/nodejs fallback, which is
# why dev/prod passed while CI's pi exited on 'Cannot find module diff').
ln -s "$PWD/node_modules" "$TD/node_modules"
export XDG_CACHE_HOME="$TD/cache"
node node_modules/tsx/dist/cli.mjs cli/test/router.ts > "$TD/router.log" 2>&1 &
ROUTER_PID=$!
ROUTER_URL=""
for i in $(seq 1 40); do
  ROUTER_URL=$(sed -n 's/^ROUTER_URL=//p' "$TD/router.log")
  [ -n "$ROUTER_URL" ] && break
  sleep 0.5
done
[ -n "$ROUTER_URL" ] || { echo "mock router did not start"; cat "$TD/router.log"; exit 1; }
export AUTERE_NINE_ROUTER_URL="$ROUTER_URL" NINE_ROUTER_BASE_URL="$ROUTER_URL" \
  NINE_ROUTER_API_KEY=9router-no-api-key AUTERE_TEST_MODELS=mock-chat
export AUTERE_DIR=$TD/state AUTERE_PI_ENVS_DIR=$TD/pi-envs AUTERE_USERS_FILE=$TD/state/users.json \
  AUTERE_ADMIN_USER=admin INITIAL_PASSWORD=clitest AUTERE_SANDBOX_IMAGE=off AUTERE_LOG_LEVEL=warn
node node_modules/tsx/dist/cli.mjs src/backend/index.ts --port $PORT --autere-auth true \
  > "$TD/backend.log" 2>&1 &
BACKEND_PID=$!
UP=0
for i in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/auth/status" && UP=1 && break
  sleep 0.5
done
[ "$UP" = 1 ] || { echo "backend did not start"; cat "$TD/backend.log"; exit 1; }
echo "backend up on $PORT (pid $BACKEND_PID)"

section "seed a session file"
SEED="$TD/pi-envs/admin/sessions/e8d236ab-568d-434e-a0ef-95ae5a613a8f.jsonl"
mkdir -p "$TD/pi-envs/admin/sessions"
node -e '
const fs = require("fs");
const [f] = process.argv.slice(1);
const now = Date.now();
const lines = [
  { type: "session", id: "e8d236ab-568d-434e-a0ef-95ae5a613a8f", timestamp: new Date(now).toISOString(), cwd: process.env.HOME, parentSession: null },
  { type: "session_info", name: "seeded session" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "hello from the seeded session needle-xyz" }] }, timestamp: now },
];
fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
' "$SEED"

section "auth (token only)"
cli auth-status
assert_exit 0 "auth-status is public (200 even unauthenticated)"
cli sessions
assert_exit 1 "protected endpoints reject calls without a token"
assert_in "401" "error carries the HTTP status"
cli login admin WRONGPW
assert_exit 1 "login rejects a bad password"
cli login admin clitest > /dev/null
[ -f "$TD/home/.autere/cli-config.json" ] && ok "login stores the token in isolated HOME" || fail "token file missing"
[ "$(stat -c %a "$TD/home/.autere/cli-config.json")" = "600" ] && ok "token file is 0600" || fail "token file perms"
cli auth-status
assert_in '"role": "admin"' "auth-status reports admin"
assert_in '"user": "admin"' "auth-status reports user"

section "AUTERE_TOKEN env override (no stored config)"
T=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).token)' "$TD/home/.autere/cli-config.json")
OUT=$(HOME="$TD/home2" AUTERE_URL="http://127.0.0.1:$PORT" AUTERE_TOKEN=$T timeout 60 node "$CLI" sessions 2>&1)
RC=$?
assert_exit 0 "AUTERE_TOKEN works without a stored token"
assert_in "seeded session" "override lists sessions"

# Give the admin user a work root inside the temp dir — backend file roots
# fall back to the BACKEND's homedir when no allowedDirs are configured.
cli user-update admin --dir "$WORK=rw"
assert_exit 0 "seed admin allowedDirs"

section "sessions"
cli sessions
assert_in "seeded session" "sessions lists the seeded session"
# printSessions shortens ids to 8 chars — grab that prefix
SEED_ID=$(printf '%s' "$OUT" | grep -oE '^.?.?  [0-9a-f]{8}' | head -1 | grep -oE '[0-9a-f]{8}$')
[ -n "$SEED_ID" ] && ok "session id captured" || fail "session id"
cli session-search needle-xyz
assert_in "seeded session" "session-search finds by content"
cli session-search "$SEED_ID"
assert_in "seeded session" "search by id"

section "session ops"
cli state --session "$SEED_ID" > /dev/null
assert_exit 0 "state --session"
cli session-history "$SEED_ID"
assert_in "needle-xyz" "session-history"
cli session-filechanges "$SEED_ID" > /dev/null
assert_exit 0 "session-filechanges"
cli bootstrap "$SEED_ID" > /dev/null
assert_exit 0 "bootstrap"
cli status > /dev/null
assert_exit 0 "status"
cli models > /dev/null
assert_exit 0 "models"
cli models --session "$SEED_ID" > /dev/null
assert_exit 0 "models --session"
cli stats --session "$SEED_ID" > /dev/null
assert_exit 0 "stats"

section "session-create (+workdir admin gating)"
cli session-create --name "cli test session"
assert_exit 0 "session-create"
assert_in "Created session" "create output"
cli session-create --workdir "$WORK"
assert_exit 0 "session-create with in-root workdir"
cli session-create --workdir /definitely-not-a-dir-xyz
assert_exit 1 "session-create rejects a nonexistent workdir (400 from backend)"
assert_in "workdir" "error mentions workdir"
cli session-create --workdir /etc
assert_exit 1 "outside-root workdir rejected"

section "followUp on idle session → runs as prompt"
cli session-create --name "fu down"
assert_exit 0 "created fu session"
FU_ID=$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
cli session-activate "$FU_ID" >/dev/null
assert_exit 0 "spawned fu session"
cli send "Reply with exactly: pong" --session "$FU_ID" --type followUp
assert_exit 0 "idle followUp accepted (downgraded)"
FU_REPLY=""
for i in 1 2 3 4 5 6 7 8; do
  sleep 4
  cli session-history "$FU_ID"
  if printf '%s' "$OUT" | grep -q '"role": "assistant"'; then FU_REPLY=1; break; fi
done
[ -n "$FU_REPLY" ] && ok "idle followUp produced an assistant turn" || fail "followUp never ran (pending forever?)"
cli session-history "$FU_ID"
printf '%s' "$OUT" | grep -q 'pong' && ok "assistant replied" || fail "assistant reply missing"
cli session-delete "$FU_ID" > /dev/null 2>&1

section "tokens"
cli token-list > /dev/null
assert_exit 0 "token-list"
TOKEN_NAME="cli-test-$$"
cli token-create "$TOKEN_NAME"
assert_exit 0 "token-create returns the secret"
TOK_ID=$(printf '%s' "$OUT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
[ -n "$TOK_ID" ] && ok "created token id captured" || fail "token id"
cli token-revoke "$TOK_ID" > /dev/null
assert_exit 0 "token-revoke"
cli token-list
printf '%s' "$OUT" | grep -q "$TOKEN_NAME" && fail "revoked token still listed" || ok "revoked token gone"

section "settings"
cli settings
assert_exit 0 "settings read"
cli settings-schema
assert_in '"fields"' "settings-schema"

section "personas"
cli personas-create "cli persona $$" "Always answer tersely." "test persona"
assert_exit 0 "personas-create"
PID=$(printf '%s' "$OUT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
[ -n "$PID" ] && ok "persona id captured" || fail "persona id"
cli personas-list
assert_in "cli persona $$" "personas-list shows it"
cli personas-update "$PID" "renamed $$" "still terse" > /dev/null
assert_exit 0 "personas-update"
cli personas-delete "$PID" > /dev/null
assert_exit 0 "personas-delete"
cli personas-list
printf '%s' "$OUT" | grep -q "renamed $$" && fail "deleted persona still present" || ok "persona deleted"

section "scheduler"
cli task-create "cli task $$" "* * * * *" "say hi" --enabled false
assert_exit 0 "task-create"
TASK_ID=$(printf '%s' "$OUT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
[ -n "$TASK_ID" ] && ok "task id captured" || fail "task id"
cli tasks-list
assert_in "cli task $$" "tasks-list shows it"
cli task-update "$TASK_ID" "renamed task $$" "0 0 1 1 *" "hi" > /dev/null
assert_exit 0 "task-update"
cli runs-list > /dev/null
assert_exit 0 "runs-list"
cli task-delete "$TASK_ID" > /dev/null
assert_exit 0 "task-delete"

section "files"
cli file-roots
assert_in "$WORK" "file-roots reflect the seeded allowedDirs"
cli file-ls "$WORK"
assert_exit 0 "file-ls"
echo "hello cli test" > "$WORK/f.txt"
cli file-read "$WORK/f.txt"
assert_exit 0 "file-read"
assert_in "hello cli test" "file-read content"
echo "written by cli test" | cli file-write "$WORK/w.txt" -
assert_exit 0 "file-write (stdin)"
cli file-read "$WORK/w.txt"
assert_in "written by cli test" "file-read back the written file"
cli file-delete "$WORK/w.txt" > /dev/null
assert_exit 0 "file-delete"

section "users (admin)"
cli user-list
assert_in '"admin"' "user-list"
cli user-create "uitest$$" "pw-12345678" chat > /dev/null
assert_exit 0 "user-create"
cli user-update "uitest$$" --role control > /dev/null
assert_exit 0 "user-update"
cli user-delete "uitest$$" > /dev/null
assert_exit 0 "user-delete"

section "raw + openapi"
cli openapi
assert_in '"/api/v1/sessions"' "openapi"
cli raw GET /api/v1/config
assert_exit 1 "raw surfaces 404"
node "$CLI" no-such-cmd > /dev/null 2>&1
RC=$?
assert_exit 2 "unknown command exits 2"

section "argument validation"
cli session-history
assert_exit 2 "missing arg → usage error, not a 404"
assert_in "Usage: autere session-history <id> [limit]" "usage line shows the command signature"
assert_in "run 'autere help'" "usage hint points to help"
cli file-ls
assert_exit 2 "file-ls validates too"
cli set-model
assert_exit 2 "set-model validates"

section "summary"
echo "PASS=$PASS FAIL=$FAIL"
{
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n'
  printf '  <testsuite name="cli" tests="%d" failures="%d">\n' "$((PASS+FAIL))" "$FAIL"
  printf '%s' "$CASES"
  printf '  </testsuite>\n</testsuites>\n'
} > "$JUNIT"
JUNIT_DONE=1
echo "junit report: $JUNIT"
# CI: surface the backend/pi log on failure — a bare ✗ count hides the
# actual spawn/RPC error (that's how 'pi did not report a sessionId' went
# unexplained).
if [ "$FAIL" != 0 ]; then
  echo ""
  echo "== backend.log tail =="
  tail -n 80 "$TD/backend.log" 2>/dev/null
fi
[ "$FAIL" = 0 ]
