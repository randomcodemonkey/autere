# autere

Real-time web dashboard for monitoring pi agent sessions via per-user RPC processes.

![Dashboard](https://img.shields.io/badge/status-stable-green)

## Features

- **Multi-User Support** — Each user gets their own pi process with isolated state
- **Live Stream** — Real-time message history with markdown rendering and thinking display
- **Session Stats** — Messages, requests, input/output tokens, and cost tracking
- **Context Usage** — Visual progress bar showing context window consumption
- **Model Info** — Current model with real-time switching
- **Active Tools** — Tools currently executing with live updates
- **Recent Tools** — Last 5 completed tool calls with expandable arguments (persisted in memory)
- **Session Management** — Switch sessions, create new ones, delete old ones, rename sessions
- **Extension Discovery** — Automatic detection of installed pi extensions with status
- **User Roles** — Admin role with backend restart privileges
- **Autoscroll** — Smart scrolling with "New messages" button when scrolled up
- **Fullscreen Chat** — Mobile-optimized chat-only view
- **Idle Timeout** — Pi processes automatically terminate after configurable idle period

## Installation

### Standalone (recommended)

```bash
cd /home/slop/code/pi-monitor
npm install
npm start
```

### With custom provider

```bash
npx tsx src/backend/index.ts --provider 9router --model openrouter/mimo-v2.5-all
```

## Usage

Once started, the dashboard is available at **http://localhost:3456** (default port).

### Login

Default user: `admin` with the password set via `--monitor-password` or `PI_MONITOR_PASSWORD`.

### Configuration

```bash
npx tsx src/backend/index.ts \
  --port 3456 \
  --monitor-auth true \
  --monitor-password mypassword \
  --provider 9router \
  --model openrouter/mimo-v2.5-all \
  --idle-timeout 30
```

| Argument | Default | Description |
|----------|---------|-------------|
| `--port` | 3456 | HTTP server port |
| `--monitor-auth` | true | Enable/disable authentication |
| `--monitor-password` | — | Password for login |
| `--provider` | — | Pi provider |
| `--model` | — | Pi model ID |
| `--idle-timeout` | 30 | Minutes before idle pi process is killed |

## Dashboard

The dashboard shows:

| Section | Description |
|---------|-------------|
| **Header** | Autere title, connection status indicator, session selector |
| **Model** | Current model with selector to switch |
| **Stats** | Messages, Requests, Input/Output Tokens, Cost |
| **Context Usage** | Token count, context window size, usage percentage bar |
| **Tools** | Active tools (with spinner) + last 5 completed tools |
| **Extensions** | Installed extensions with connection status |
| **Chat Stream** | Real-time message history with role labels |
| **Chat Input** | Message input with send button |

### Chat Stream Roles

| Role | Description |
|------|-------------|
| `user` | User messages |
| `assistant` | Assistant responses (rendered as markdown) |
| `thinking` | Model reasoning/thinking |
| `toolResult` | Tool execution results |
| `edit` | File edit diffs (colored) |
| `system` | System messages (e.g., "Session cleared") |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI |
| `/events` | GET | SSE stream (user-scoped) |
| `/api/auth/login` | POST | Login (user + password) |
| `/api/auth/logout` | POST | Logout |
| `/api/auth/status` | GET | Auth status + user role |
| `/api/state` | GET | Current session state |
| `/api/stats` | GET | Token usage statistics |
| `/api/messages` | GET | Recent messages |
| `/api/tools` | GET | Active + recent tools |
| `/api/extensions` | GET | Installed extensions |
| `/api/models` | GET | Available models |
| `/api/set-model` | POST | Switch model |
| `/api/sessions` | GET | List sessions |
| `/api/sessions/switch-by-id` | POST | Switch session by ID |
| `/api/sessions/delete` | POST | Delete session |
| `/api/new-session` | POST | Create new session |
| `/api/session-name` | POST | Rename session |
| `/api/send` | POST | Send message |
| `/api/abort` | POST | Abort current operation |
| `/api/compact` | POST | Compact context |
| `/api/restart` | POST | Restart user's pi process |
| `/api/restart-backend` | POST | Restart entire backend (admin only) |

## SSE Events

| Type | Description |
|------|-------------|
| `status` | Session state update |
| `stats` | Token/cost update |
| `stream_history` | Chat messages (last 50) |
| `tool_start` | Tool started |
| `tool_end` | Tool completed (includes recentTools) |
| `models` | Available models list |
| `sessions` | Available sessions list |
| `extensions` | Extension status updates |
| `navigate` | Frontend navigation command |
| `heartbeat` | Keep-alive (every 3s) |
| `new_session_creating` | New session being created |

## Architecture

- **Standalone server** — Node.js HTTP server with per-user pi RPC processes
- **Frontend** — React + Vite SPA served from `dist/`
- **State** — Per-user in-memory state, global extensions/sessions
- **Auth** — Token-based with user roles, atomic file writes

## Data Files

| File | Description |
|------|-------------|
| `~/.pi/agent/monitor-auth-tokens.json` | Auth tokens |
| `~/.pi/agent/monitor-last-session.json` | Last session per user |
| `~/.autere/sessions/` | Session files |
| `~/.autere/deleted-sessions/` | Deleted sessions |

## Development

```bash
npm install
npm run dev        # Run frontend + backend concurrently
npm run typecheck  # Type check
npm run build      # Build frontend to dist/
npm test           # Run component tests
npm run test:e2e   # Run e2e tests
```

## License

MIT
