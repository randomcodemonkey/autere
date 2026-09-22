---
name: autere
description: >
  Knowledge base for autere — a real-time web dashboard for
  monitoring pi agent sessions. Use when the user asks about autere, wants
  fixes, features, or modifications to the dashboard, or mentions the monitor.
  Provides architecture overview, file locations, and development guide.
---

# autere

A real-time web dashboard for monitoring pi agent sessions. Runs as a standalone Node.js server that spawns per-user pi processes in RPC mode (JSON lines on stdin/stdout). NOT an extension — a standalone app communicating with pi over the RPC protocol.

**This file is the canonical skill. It lives in the repo and travels with the
code — keep it up to date when architecture or workflows change.**

## Location & Deployment

- Repo: `/home/slop/code/autere/` (git remote: `http://git:3000/xenic/pi-monitor.git`, branch `main`)
- The running instance is supervisord-managed, serving the built frontend from `dist/`.

**Deploying changes — know the difference:**

| Change type | How it goes live |
|---|---|
| Frontend only (`src/frontend/`, `styles.scss`) | `npm run build`, then the user **reloads the UI** (no backend restart) |
| Backend (`src/backend/`) | Code + `npm run build` if assets changed, then the **user restarts the backend themselves** — never restart it yourself (see below) |

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
  routes.ts             # API routes + SSE broadcaster; /api/send image validation
  rpc-client.ts         # pi RPC wrapper (prompt/steer/followUp, image blocks)
  user-session.ts       # Per-user pi process, state, history buffers, SSE fanout
  process-manager.ts    # Spawning/stopping/tracking pi processes, idle timeout
  auth.ts               # Token auth, users, roles, last-session tracking
  state.ts              # Global mutable state (extensions, sessions)
  sessions.ts           # Session file listing
  personas.ts           # Persona library + per-session bindings (JSON files)
  scheduler.ts          # Scheduled tasks (cron-style pi prompts)
  session-peers.ts      # Peer sessions view
  user-settings.ts      # Per-user settings (schema-driven, admin UI; per-model
                        # thinking levels → pi's modelThinkingLevels, per-model
                        # reserve % → pi-token-reserve config)
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
    ChangesPage.tsx, LoginScreen.tsx
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
extras/pi-dedup/       # pi extension: elides exact-duplicate tool results
                       # (tool_result patch → pointer to the in-context first
                       # occurrence; append-time only so prompt caching keeps
                       # working; session_compact resets anchors). Savings
                       # approx 4 chars/token written per session to
                       # dedup-stats.json in the user's OWN pi env; the
                       # dashboard injects the requesting user's stats per
                       # request (withDedupSections) — global state stays
                       # user-agnostic, no cross-user exposure.
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
- **Scroll**: `.stream-box` has a ResizeObserver that re-pins to bottom when
  the box resizes (input expand/collapse) if the user is at bottom;
  `overflow-anchor: auto` + no mid-stream truncation keep reading stable.

## Development

```bash
npm install
npm run dev          # frontend (vite) + backend (tsx watch) concurrently
npm run build        # build frontend to dist/
npm run typecheck    # backend + frontend tsc
npm start            # backend only
```

## Testing

```bash
npm run test:component   # component tests (fast, no server)
npm run test:e2e         # builds frontend, starts isolated backend (slow ~4-5min)
npm run test:all
```

- **Always write tests for new features** (component tests preferred; e2e is
  expensive and flake-prone with slow models — 60s timeouts can flake when
  the model goes on tool-call sprees).
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
- Forced password change: new users (and admin password resets) get
  `mustChangePassword`; the backend 403s every API call except
  change-password/logout until it is cleared, and the frontend shows a
  full-screen ChangePasswordScreen (App.tsx).
- Deleting a user removes their auth tokens (sessions invalidated) and
  terminates their pi processes; their pi env dir stays on disk.

Logs (supervisord instance): `~/log/autere.out.log` / `~/log/autere.err.log`
(err log includes EVENT LOOP LAG warnings — useful for diagnosing load).

Data: per-user pi envs in `~/.autere/pi-envs/<user>/` (sessions/, settings.json,
personas.json, persona-active.json, persona-markers.json, dedup-stats.json),
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
