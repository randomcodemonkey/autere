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
  extension-handlers.ts # Named extension handlers (9router status etc.)
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
    SessionModal.tsx, SettingsCard.tsx, ScheduledTasksCard.tsx, SortableList.tsx
  hooks/useSSE.ts, useAuth.ts, useCardState.ts
  styles.scss          # Single global stylesheet (~3100 lines)
  types/index.ts       # Shared frontend types incl. SSEEventType
dist/                  # Built frontend, served by backend
cypress/
  component/           # Component tests (~230; no server needed, Vite dev server)
  e2e/                 # Full-app tests (own isolated backend)
extras/pi-images/      # pi extension: generate_image tool via 9router (symlinked
                       # from ~/.pi/agent/extensions/pi-images)
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

Env: `PI_MONITOR_PASSWORD`, `PI_MONITOR_AUTH`, `PI_IMAGES_MODEL`.

Logs (supervisord instance): `~/log/autere.out.log` / `~/log/autere.err.log`
(err log includes EVENT LOOP LAG warnings — useful for diagnosing load).

Data: `~/.autere/sessions/` (JSONL sessions), `~/.autere/deleted-sessions/`,
`~/.pi/agent/monitor-auth-tokens.json`, `~/.pi/agent/monitor-last-session.json`.

## Conventions

- **Errors are never silently swallowed.** Backend: always log, and broadcast
  to the frontend where possible. Frontend: always surface to the user.
- **Routing** via react-router with real routes; the wildcard route is only
  for 404.
- **Mobile/PWA matters**: the dashboard is used from an iPhone home-screen
  pin. Keep tap targets stable across layout changes, avoid disable-induced
  focus loss mid-tap, and set `-webkit-text-size-adjust: 100%` is already in
  place (don't reintroduce landscape font inflation).
