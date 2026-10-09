---
name: autere
description: >
  Knowledge base for autere — a real-time web dashboard for
  monitoring pi agent sessions. Use when the user asks about autere, wants
  fixes, features, or modifications to the dashboard, or mentions the monitor.
  Provides architecture overview, file locations, and development guide.
---

# autere

A real-time web dashboard for monitoring pi agent sessions. Runs as a standalone Node.js server that spawns one pi process PER PI AGENT SESSION (RPC mode, JSON lines on stdin/stdout) — sessions run in parallel, and each dashboard client (auth session) views whichever session it navigates to. NOT an extension — a standalone app communicating with pi over the RPC protocol.

**This file is the canonical skill. It lives in the repo and travels with the
code — keep it up to date when architecture or workflows change.**

## Location & Deployment

- Repository location: check your memory for repository location, if not set ASK the user where the autere source code resides and then store that into memory. 
- The running instance is supervisord-managed, serving the built frontend from `dist/`.

**Deploying changes — use `./build-dev.sh` (repo root), which does all of it
correctly: `npm run build`, mirrors `extras/` → `~/pi-ext-extra/` (forwarding
deletions), rsyncs `dist-backend/` → `~/dist-backend/`, and lets Vite write
the frontend straight to `~/dist` (outDir). `--no-ext` skips the extras copy.
Run it from the repo, then tell the user what needs a reload/restart.

**Container recreation reverts `~/dist`, `~/dist-backend` and `~/pi-ext-extra`
(or any non-volume path) to the image state** — only `/home/autere/code` is a
volume. After every container restart, re-run `./build-dev.sh` or the
dashboard runs an old build. `build-dev.sh` also links `~/node_modules` →
repo `node_modules`: the compiled backend resolves bare imports from
`/home/autere/dist-backend` (chain: `dist-backend/node_modules` →
`~/node_modules` → …), which is NOT where the image installs deps
(`~/dist/node_modules`) — without that link any runtime dependency
(e.g. `web-push`) crashes the backend at startup (Dockerfile does the same
link for image builds).

| Change type | How it goes live |
|---|---|
| Frontend only (`src/frontend/`, `styles.scss`) | `./build-dev.sh`, then the user **reloads the UI** (no backend restart; note the PWA service worker — hard reload once if stale) |
| Backend (`src/backend/`) | `./build-dev.sh`, then the **user restarts the backend themselves** — never restart it yourself (see below) |
| pi extensions (`extras/`) | `./build-dev.sh` (mirror sync), live on next pi spawn |

## Non-Negotiable Policies

1. **NEVER restart the backend yourself.** Restarting kills the agent's own
   RPC connection and the task dies. Make changes, tell the user what needs a
   restart, wait for their confirmation.
2. **NEVER commit without the user explicitly asking.** "Commit" in the user's
   message is required. Finishing work ≠ permission to commit. And committing
   permission ≠ pushing permission — always ask before pushing (never push
   automatically when only a commit was requested).
3. **Batch into logical commits** (feat:/fix:/test: headers with a payload
   body). Avoid tiny sequential "fix the fix" commits.
3b. **Lint + typecheck BEFORE every commit** (CI lints itself): `npx eslint .`
   and `npm run typecheck` must pass before you run `git commit` — a lint
   failure in CI is a broken commit shipped to the user.
4. **Never kill supervisord-parented processes.** No `pkill`/`killall` on
   node/tsx; e2e tests manage their own backend lifecycle.
5. **Test runs are slow/expensive.** Pipe output to a temp file and grep from
   it; don't re-run suites without code changes between runs.
6. **Prefer the `edit` and `write` tools over bash for file modifications.**
   The dashboard renders them as diff cards; bash-driven edits only surface
   as generic tool results (best-effort bash detection aside). Use bash for
   file changes only when the tools genuinely can't (multi-file scripted
   transforms, generated content, non-text files) — and share user-facing
   outputs with the `save_file` tool.

## Architecture

```
src/backend/
  index.ts              # Entry point — HTTP server, ProcessManager init
  routes.ts             # Route table (method + path + role + handler), SSE
                        # broadcaster, static files; /session/messages image
                        # validation
  openapi.ts            # OpenAPI 3 spec generated from the route table,
                        # served at GET /api/v1/openapi.json
  rpc-client.ts         # pi RPC wrapper (prompt/steer/followUp, image blocks)
  user-session.ts       # Per-user pi process, state, history buffers, SSE fanout
  process-manager.ts    # Spawning/stopping/tracking pi processes — ONE per
                        # pi agent session (user+sessionFile keyed), idle timeout
  client-hub.ts         # Per-user clientId → viewed-session registry; routes
                        # SSE events and API calls to the right session's process
  auth.ts               # Token auth, users, roles, last-session tracking
  state.ts              # Global mutable state (extensions, sessions)
  sessions.ts           # Session file listing
  personas.ts           # Persona library + per-session bindings (JSON files)
  scheduler.ts          # Scheduled tasks (cron-style pi prompts). Each run gets
                        # its own pi session, deleted for good when the run ends
                        # unless the task has saveSession: true (Settings card
                        # "Save task sessions" toggle). once: true = one-off,
                        # at most one run ever (auto-disabled after it; both a
                        # scheduled tick and a manual trigger are refused
                        # afterwards) — CLI `task-run <id> --wait` blocks on
                        # those and prints the run record
  user-settings.ts      # Per-user settings (schema-driven, admin UI; per-model
                        # thinking levels → pi's modelThinkingLevels, per-model
                        # reserve % → pi-token-reserve config)
  notifications.ts      # Web Push: one-time VAPID keys (~/.autere/vapid-keys.json),
                        # per-user push-subscriptions.json, sendNotification(user,
                        # kind, {title, body, path}) for the three kinds
                        # (explicit / taskStart / turnEnd); 256-char limit lives in
                        # shared/notifications.ts (backend + tests)
  extension-handlers.ts # Named extension handlers (9router status, memory, dedup)
  stream-history.ts     # StreamMessage building, extractImages (shared)
  shared/format.ts      # Formatting shared with frontend
  image-models.ts       # Image-capable model discovery (9router)
src/frontend/
  pages/DashboardPage.tsx  # Main page: SSE event handling, stream history state
  components/
    StreamCard.tsx      # Chat stream: autoscroll, ResizeObserver bottom-pinning, stable keys
    ChatInput.tsx       # Input: expanded state, image attach, optimistic send callback
    ChatMessage.tsx     # Message rendering: markdown, diffs, images, lightbox
    ZoomableImage.tsx   # Pinch-to-zoom/pan lightbox image (pointer events)
    Modal.tsx, Header.tsx, StatusCard.tsx, UsageCard.tsx, ExtensionsCard.tsx,
    SessionModal.tsx, SettingsCard.tsx, ScheduledTasksCard.tsx, SortableList.tsx,
    Personas.tsx        # PersonaSection (Agent card) + PersonasSettingsSection
                        # ExtensionsCard fetches /api/extensions for per-user stats —
                        # the shared state copy carries only zero placeholders
                        # SettingsCard renders schema-driven sections; 'Files' →
                        # folderIgnores (per-folder [edits]/[files] toggles;
                        # filters FileBrowser + Changes server-side, getEditIgnorePaths
                        # derived for the pi env)
    ChangesPage.tsx, LoginScreen.tsx,
    NotificationsSection.tsx # Settings → Notifications: subscribes this browser to
                        # Web Push + renders the three per-kind toggles
    EditsPage.tsx         # Edits view: two-pane — Files/Changes tabbed list card
                          # on the left, detail on the right (Monaco editor /
                          # diffs). FileBrowser: allowedDirs-rooted lazy tree;
                          # save/delete gated to control/admin + rw dirs,
                          # backend-enforced. Mobile: stacked panes.
  hooks/useSSE.ts, useAuth.ts, useCardState.ts
  styles.scss          # Single global stylesheet (~3600 lines)
  types/index.ts       # Shared frontend types incl. SSEEventType
dist/                  # Built frontend, served by backend
cypress/
  component/           # Component tests (~256; no server needed, Vite dev server)
  e2e/                 # Full-app tests (own isolated backend)
extras/pi-images/      # pi extension: generate_image tool via 9router (symlinked
                       # from ~/.pi/agent/extensions/pi-images)
extras/pi-filetools/   # pi extension: file tooling with content cache + edit-ignore
extras/pi-token-reserve/ # pi extension: compaction reserveTokens as % of the model's
                       # context window — per model (perModel map keyed like
                       # enabledModels entries; `percent` fallback), applied live
                       # (symlinked into ~/.pi/agent/extensions/pi-token-reserve;
                       # config written per user env as pi-token-reserve-config.json)
extras/pi-personas/    # pi extension: puts the session's bound persona into the SYSTEM
                       # PROMPT every turn (before_agent_start) — no fake user
                       # messages, immune to process restarts; emits a visible
                       # marker on transitions (new session / changed from X /
                       # re-applied after compaction / removed) (extras/
                       # symlinked into ~/.pi/agent/extensions/pi-personas;
                       # bindings written per user env as persona-active.json,
                       # keyed by session file name; personas.ts stores the
                       # library)
extras/pi-combo-reasoning/ # pi extension: fixes reasoning on 9router COMBO routes.
                       # 9router's combo translator inlines the reasoning stream into
                       # plain `content` when a request carries `reasoning_effort` (which
                       # pi-9router-ext sends for pi thinking levels) — chain-of-thought
                       # then shows up as regular assistant text. Runs on session_start
                       # (after pi-9router-ext registers; npm packages load last, so a
                       # load-time fix would be stomped) and re-registers the "9router"
                       # provider with combo models' thinkingLevelMap fully nulled —
                       # pi-ai drops those levels, pi sends NO reasoning_effort, and
                       # upstream default reasoning streams as reasoning_content. Combo
                       # detection = pi-9router-ext's "🔀" name prefix. Add the same fix
                       # upstream in pi-9router-ext when this is fixed in 9router's
                       # combo translator.
extras/pi-dedup/       # pi extension: elides exact-duplicate tool results
                       # (tool_result patch → pointer to the in-context first
                       # occurrence; append-time only so prompt caching keeps
                       # working; session_compact resets anchors). Savings
                       # approx 4 chars/token written per session to
                       # dedup-stats.json in the user's OWN pi env; the
                       # dashboard injects the requesting user's stats per
                       # request (withDedupSections) — global state stays
                       # user-agnostic, no cross-user exposure. SHIPPED but
                       # NOT auto-installed (entrypoint skips it); opt in
                       # per user via Settings → Extensions.
extras/pi-janitor/     # pi extension: idle-window context cleanup. Observes
                       # cache hits/misses per request (usage from the last
                       # assistant message) to learn the provider's effective
                       # cache retention; when a request goes out after an
                       # idle gap ≥ 2× the longest observed warm gap (floor
                       # 10 min — the cache is cold anyway, so history
                       # rewriting is free), stubs stale tool results, edit
                       # diffs and images older than the last 3 user turns.
                       # Decisions only grow during cold windows; warm calls
                       # replay byte-identical stubs so prompt caching keeps
                       # working. Per-call transform — the session file keeps
                       # full content. Sweep policy is user-configurable via
                       # the Settings card (janitorMinIdleSec floor 600,
                       # janitorWarmGapMultiplier 2, janitorKeepRecentTurns 3):
                       # saving materializes janitor-config.json into the
                       # user's env, which the extension mtime-caches and
                       # applies live — settings save skips the pi restart
                       # when only janitor keys change. Stats per session in
                       # janitor-stats.json (user's OWN env), injected per
                       # request by withJanitorSections().
extras/pi-autere/      # pi extension: agent-facing autere API — schedule/list/
                       # enable scheduled tasks (per-task model = provider/id from
                       # autere_find_models), find sessions with their latest
                       # messages, deliver a message to another session, send an
                       # OS-level notification (send_notification — content ≤ 256
                       # chars, subject = session name/id, opens that session). The tool
                       # descriptions carry the generic "keep checking until X,
                       # then report back" workflow (report + self-disable steps in
                       # a task-prompt footer); no domain wording. HTTP to this
                       # backend with the token ensurePiEnv writes to <pi env>
                       # /autere-agent.json (auth.ensureAgentToken +
                       # writeAgentAccess; baseUrl from AUTERE_BACKEND_URL, set in
                       # createMonitorServer); outside autere every tool fails with
                       # a clear error.
SKILL.md               # This file — canonical, in-repo
```

## Streaming & Image Pipeline (important invariants)

- **Per-token updates**: `text_delta`/`thinking_delta` broadcast a tiny
  `stream_delta` payload (role + entry text only) — NEVER the full history
  buffer. Re-broadcasting history with multi-MB base64 images on every token
  caused multi-GB memory spikes, event-loop lag, OOM, and client freezes.
- **Full snapshots** (`stream_history`) carry images; sent on load, entry
  creation, message_end, tool events, session switch.
- **History entries** carry stable server-assigned `id`s (monotonic) —
  frontend React keys prefer them so expansion state and scroll anchoring
  survive broadcasts. toolCall→toolResult replacement inherits the id.
- **Images**: max 4 attachments × 8MB, `image/*` mime, base64 without data:
  prefix over the wire (`MAX_ATTACHED_IMAGES`, `MAX_IMAGE_BYTES` in routes.ts).
- **Optimistic UI**: DashboardPage injects pending user messages (⏳) on
  successful send; retired when a broadcast contains the same text.
- **Scroll**: `.stream-box` anchors in JS (StreamCard `scrollAnchorRef`):
  scrolled-up users get the reading message pinned at its offset after every
  update (`overflow-anchor: none` — CSS anchoring fought React remounts);
  at bottom, autoscroll + a ResizeObserver re-pin on box resize.

## Mobile/PWA notes

- **OS-level notifications (Web Push)**: Settings → Notifications (`NotificationsSection.tsx`)
  subscribes the browser (`GET /notifications/vapid-public-key` → `POST
  /notifications/subscribe`); subscriptions are stored per user. The backend
  pushes `{ title, body, path, tag }` (`src/backend/notifications.ts`) for
  four kinds — `explicit` (agent tool `send_notification`, content ≤ 256
  chars, enforced by tool AND route), `taskStart` (scheduler, after the run's
  pi session exists), `turnEnd` (UserSession, first 256 chars of the last
  assistant message) and `allDone` (idle with nothing queued, checked 3 s
  after a turn ends). Title = session name, id when unnamed; `path` is
  scope-relative (`session/<id>`) and resolved inside `public/sw.js`
  (`push` renders, `notificationclick` focuses/opens the app there), so no
  reverse-proxy base path travels with the notification. Toggles are normal
  settings keys (`notifyExplicit/TaskStart/TurnEnd/AllDone`, default on
  except all-done, live-read → they are in the settings-save live-apply list,
  no pi restart). Two policies (pure, in `shared/notifications.ts`):
  `notifyTurnEndAfterMinutes` (0 = every time) gates BOTH turn-end (per
  turn) and `allDone` (measured over the whole quiet-to-quiet work block —
  queued turns count as one run); a turn-end notification sent moments ago
  suppresses `allDone`, so enabling both never double-notifies one moment.

## Development

```bash
npm install
npm run dev          # frontend (vite) + backend (tsx watch) concurrently
npm run build        # build frontend to dist/
npm run typecheck    # backend + frontend tsc
npm start            # backend only
```

## Docker sandbox

`piSandboxImage` user setting (Settings → Sandbox) runs every pi agent
session inside a docker container (default suggestion: the project's own
slopbox image). Only the needed volume subpaths are mounted
(current user's pi-env dir + session cwd, via --mount volume-subpath at
their original paths — never the whole home volume, which would expose
other users' pi-envs); /tmp is tmpfs; never mounted: docker.sock.
The container is forced --user <backend uid>:<gid> with
no-new-privileges (no root, no sudo/setuid escalation); sandbox image
defaults to randomcodemonkey.org/slopbox:latest (off via
PI_SANDBOX_IMAGE=off — set in the e2e backend). \$HOME is a persistent
per-user volume (autere-home-<user>, created lazily, empty and
chowned to the sandbox uid) so ~/.cache etc. survive spawns., host network keeps the
model router on localhost, docker.sock is forwarded when present. Backend
wiring: rpc-client.buildSandboxCommand + user-session spawn options.

## Testing

```bash
npm run test:component   # component tests (fast, no server)
npm run test:e2e         # builds frontend, starts isolated backend (slow ~4-5min)
npm run test:all
# Run ONE e2e group instead of the whole suite (isolated backend, faster):
npx tsx cypress/e2e/support/run-one.ts cypress/e2e/dashboard.cy.ts
```

- **Always write tests for new features** (component tests preferred; e2e is
  expensive and flake-prone with slow models — 60s timeouts can flake when
  the model goes on tool-call sprees).
- **e2e is split into logical specs** (cypress/e2e/*.cy.ts): chat,
  dashboard (UI smoke), model-selection, realtime, sessions-flow (create/
  switch), sessions-modal (incl. lazy-spawn), settings, stream-reload,
  edits-feature, tasks, tools. **Each spec is self-sufficient and
  order-independent**: it seeds its own state (cy.task('seedSession')), must
  pass in isolation (run-one.ts), and must leave shared env state intact
  (net-zero mutations). No spec may rely on other specs having run first.
- Component tests run on the Vite dev server: `cy.intercept` does NOT work for
  network requests — intercept HTTP from the app only where it uses
  `fetch`/XHR normally, stub `window.fetch` otherwise.
- `selectFile` contents must use `Cypress.Buffer.from(b64, 'base64')` —
  Blobs/ArrayBuffers serialize to `{}` across the bridge.
- Real multi-touch pinch can't be simulated in component tests — test gesture
  logic via double-click/wheel/click paths.
- Failure screenshots land in `cypress/screenshots/` — READ them (the read
  tool renders images); they usually reveal the root cause instantly.
  Cypress wipes the folder each run.
- E2E runs in an isolated temp env (`AUTERE_PI_ENVS_DIR`); deleted sessions
  are MOVED to `~/.autere/deleted-sessions/`.

## CLI & Config

```bash
npx tsx src/backend/index.ts \
  --port 3456 --monitor-auth true --monitor-password pw \
  --provider 9router --model <model-id> --idle-timeout 30 -- [pi args]
```

Env: `PI_MONITOR_PASSWORD`, `PI_MONITOR_AUTH`, `PI_IMAGES_MODEL`,
`AUTERE_ADMIN_USER` (default `admin`), `AUTERE_ADMIN_PASSWORD` (default
`admin`).

**Roles** (hierarchy: chat < control < admin, enforced per API call in
`requiredRole()` / `hasRole()` in auth.ts):

- **chat** — converse and view: send/abort/compact, sessions, models, state
- **control** — everything except restarting autere itself: settings save,
  personas library, scheduled tasks, session deletion
- **admin** — everything, including `/api/restart-backend` and user
  management (Users view + `/api/users*` endpoints)

The admin account comes from `AUTERE_ADMIN_USER`/`AUTERE_ADMIN_PASSWORD`
(falling back to the monitor password, then `admin`/`admin`). The legacy
shared `user` account (monitor password) has the `control` role and only
exists when a monitor password is configured.

## User management

Admin-managed account registry in `~/.autere/monitor-users.json`
(`AUTERE_USERS_FILE` overrides — e2e sets it; a future sqlite table would
replace `src/backend/users.ts`'s JSON load/save only). Seeded ONCE from
`AUTERE_ADMIN_*` / monitor password when the file doesn't exist; afterwards
the file is authoritative (env password changes no longer reset accounts —
delete the file to re-seed). Passwords are scrypt hashes (`s2:salt:hash`).

- Admin UI: Users view (`/session/:id/users`, Header button for admin role
  only) — `UsersCard.tsx`: create/edit/delete users, per-user
  `allowedDirs: [{path, access: 'read'|'rw'}]` (the future per-user container
  mounts), role, optional password reset. Guards: no self-delete, no
  deleting/demoting the last admin.
- Endpoints: `GET/POST /api/users`, `POST/DELETE /api/users/<name>` (admin),
  `POST /api/auth/change-password` (self, any role).
- File browser: `GET /api/browse/roots|list|read`, `POST /api/browse/write|delete`
  (src/backend/files.ts). Roots = the user's `allowedDirs`, fallback `$HOME`;
  list/read are chat-level, write/delete need `control` AND an `rw` root,
  enforced server-side per request.
- Forced password change: new users (and admin password resets) get
  `mustChangePassword`; the backend 403s every API call except
  change-password/logout until it is cleared, and the frontend shows a
  full-screen ChangePasswordScreen (App.tsx).
- Deleting a user removes their auth tokens (sessions invalidated) and
  terminates their pi processes; their pi env dir stays on disk.

Logs (supervisord instance): `~/log/autere.out.log` / `~/log/autere.err.log`
(err log includes EVENT LOOP LAG warnings — useful for diagnosing load).

Data: per-user pi envs in `~/.autere/pi-envs/<user>/` (sessions/, settings.json,
personas.json, persona-active.json, persona-markers.json, dedup-stats.json,
autere-agent.json — pi-autere's backend baseUrl+token),
`~/.autere/users/<user>/` (settings.json, scheduled-tasks/,
push-subscriptions.json — Web Push), `~/.autere/vapid-keys.json`,
`~/.autere/deleted-sessions/`, `~/.autere/monitor-auth-tokens.json`,
`~/.autere/monitor-last-session.json`.

## Conventions

- **Errors are never silently swallowed.** Backend: always log, and broadcast
  to the frontend where possible. Frontend: always surface to the user.
- **Routing** via react-router with real routes; the wildcard route is only
  for 404.
- **Mobile/PWA matters**: the dashboard is used from an iPhone home-screen
  pin. Keep tap targets stable across layout changes, avoid disable-induced
  focus loss mid-tap, and set `-webkit-text-size-adjust: 100%` is already in
  place (don't reintroduce landscape font inflation).

### HTTP API conventions (mandatory, every change)

The API is versioned under **`/api/v1`** and documented with OpenAPI 3.
These rules apply to EVERY new endpoint, rename, or behavior change:

1. **Paths live in exactly one file: `src/shared/api-paths.ts`.** It is the
   single source of truth shared by the backend, the web UI and the TUI.
   - Never hardcode an API path string anywhere else — not in components,
     hooks, the TUI, or tests that can import it.
   - Web UI: import `{ API } from '../api-paths'` (re-export) and wrap with
     `url(...)` for the reverse-proxy base path.
   - TUI: import `{ API } from './api.js'` (re-export of the shared module).
   - Backend regex matchers are built from `API_PREFIX` in routes.ts.
   - Backend-emitted URLs that reach the frontend (stream-history image/file
     URLs) must also come from `API.images(...)` / `API.files(...)`.
2. **REST verbs and resources**
   - `GET` read, `POST` create or execute an action, `PUT` replace a
     subresource, `DELETE` remove. No verb-in-path endpoints (`/x/delete`,
     `/set-y`) — use `DELETE /x/{id}`, `PUT /y`.
   - Plural collections (`/api/v1/sessions`), singular for the VIEWED
     session's operations (`/api/v1/session/...`, target selected by a
     `sessionId` body field or query param).
   - Path params in the table as regex groups; OpenAPI templates use
     `{param}` placeholders.
3. **Status codes**
   - 200 default; 201 for creates (POST .../tokens, .../personas,
     .../users, POST /sessions); 202 for accepted async work.
   - 400 invalid input (incl. malformed JSON — `readBody` rejects with
     `statusCode`), 401 unauthenticated, 403 insufficient role, 404 missing,
     405 wrong method (the dispatcher adds an `Allow` header), 409 state
     conflict (e.g. no viewed session, compaction already running),
     413 oversized body, 500 failure, 503 dependency unavailable.
   - Unauthenticated callers get 401 before 404/405 — paths are not
     enumerable without a session.
4. **Response envelope**: every JSON response is `application/json` and
   either `{ success: true, data?..., ... }` or
   `{ success: false, error }`. No HTML error bodies on API routes.
5. **Route registration**: add to the route table in `routes.ts` via
   `route({ method, path, template, role, tag, summary, status?, handler })`.
   `role` is one of `chat < control < admin` (declared per route; auth.ts
   owns only the hierarchy). `tag` + `summary` feed the OpenAPI document —
   write them for an external API consumer. Public (no-auth) routes set
   `isPublic: true` and must be limited to auth + docs endpoints.
6. **OpenAPI**: served automatically at `GET /api/v1/openapi.json` from the
   route table — registering a route with a good `template`/`summary` is
   what documents it. Keep them accurate when changing behavior.
7. **Auth model**: `POST /api/v1/auth/login` sets an HttpOnly cookie AND
   returns a bearer token (non-browser clients); API requests authenticate
   with cookie or `Authorization: Bearer`. CORS allows the
   `Authorization` + `X-Autere-Client-Id` headers.
8. **Tests**: update cypress specs through the same constants (import from
   `src/shared/api-paths` where possible) and adjust methods
   (`PUT`/`DELETE`) alongside the frontend.

Checklist for a new endpoint:
- [ ] constant in `src/shared/api-paths.ts`
- [ ] `route({...})` entry in `routes.ts` (verb, role, tag, summary)
- [ ] frontend/TUI callers use the constant + correct verb
- [ ] cypress stubs/intercepts updated
- [ ] `npm run typecheck` + targeted cypress run
