# autere

Real-time web dashboard for monitoring pi agent sessions via the pi extension API.

![Dashboard](https://img.shields.io/badge/status-stable-green)

## Features

- **Live Stream** — Real-time message history with markdown rendering for assistant responses
- **Session Stats** — Messages, requests, input/output tokens, and cost tracking
- **Context Usage** — Visual progress bar showing context window consumption
- **Model Info** — Current model and thinking level
- **Active Tools** — Tools currently executing with live updates
- **Recent Tools** — Last 5 completed tool calls with expandable arguments
- **WhatsApp Status** — Connection state, registered users and groups
- **Session Reset** — Survives `/new` with automatic state reset and notification

## Installation

### As a pi extension (recommended)

```bash
# Copy to extensions directory
cp -r /path/to/pi-monitor ~/.pi/agent/extensions/

# Or symlink
ln -s /path/to/pi-monitor ~/.pi/agent/extensions/pi-monitor
```

### Via settings.json

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-monitor"]
}
```

### Run with pi directly

```bash
pi --mode rpc -e /path/to/pi-monitor
```

## Usage

Once loaded, the dashboard is available at **http://localhost:3456** (default port).

### Configuration

Set a custom port via pi flag:

```bash
pi --flag pi-monitor:port=8080
```

Or in `settings.json`:

```json
{
  "flags": {
    "pi-monitor:port": "8080"
  }
}
```

## Dashboard

The dashboard shows:

| Section | Description |
|---------|-------------|
| **Header** | pi-monitor title, WhatsApp status indicator |
| **Stats Row** | Messages, Requests, Input Tokens, Output Tokens, Cost |
| **Model** | Current model name and provider |
| **Context Usage** | Token count, context window size, usage percentage bar |
| **Active Tools** | Tools currently executing (with spinner) |
| **WhatsApp** | Connection status, registered users and groups |
| **Recent Tools** | Last 5 completed tool calls (click to expand arguments) |
| **Live Stream** | Real-time message history with role labels |

### Live Stream Roles

| Role | Color | Description |
|------|-------|-------------|
| `user` | Yellow | User messages |
| `assistant` | Blue | Assistant responses (rendered as markdown) |
| `thinking` | Purple italic | Model reasoning/thinking |
| `tool` | Purple | Tool execution requests |
| `toolResult` | Purple | Tool execution results |
| `system` | Gray italic | System messages (e.g., "Session cleared") |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI (HTML) |
| `/events` | GET | SSE stream of real-time events |
| `/api/state` | GET | Current session state |
| `/api/stats` | GET | Token usage statistics |
| `/api/messages` | GET | Recent messages |
| `/api/tools` | GET | Active tool executions |
| `/api/whatsapp` | GET | WhatsApp connection state |

### Response Format

All `/api/*` endpoints return:

```json
{
  "success": true,
  "data": { ... }
}
```

### `GET /api/state`

```json
{
  "model": { "provider": "anthropic", "id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4" },
  "thinkingLevel": "off",
  "isStreaming": false,
  "messageCount": 42,
  "requestCount": 15,
  "connected": true
}
```

### `GET /api/stats`

```json
{
  "tokens": { "input": 125000, "output": 45000, "cacheRead": 10000, "cacheWrite": 2000 },
  "cost": 0.85,
  "contextUsage": { "tokens": 50000, "contextWindow": 200000, "percent": 25 }
}
```

### `GET /api/messages`

Returns array of recent messages:

```json
[
  { "role": "user", "timestamp": 1234567890, "preview": "Hello, how are you?" },
  { "role": "assistant", "timestamp": 1234567891, "preview": "I'm doing well, thanks!" }
]
```

### `GET /api/tools`

Returns currently active tool executions:

```json
[
  { "id": "tool_123", "name": "bash", "cmd": "ls -la", "startedAt": 1234567890 }
]
```

### `GET /api/whatsapp`

```json
{
  "connected": true,
  "users": ["+1234567890"],
  "groups": ["Project Team"]
}
```

## SSE Events

Connect to `/events` for real-time updates:

```javascript
const events = new EventSource('http://localhost:3456/events');

events.onmessage = (e) => {
  const { type, data } = JSON.parse(e.data);
  // Handle event
};
```

### Event Types

| Type | Description | Data |
|------|-------------|------|
| `status` | Session state update | `sessionState` |
| `stats` | Token/cost update | `sessionStats` |
| `message` | New message | `message` object |
| `stream_history` | Live stream update | Array of last 10 messages |
| `tool_start` | Tool started | `{ id, name, cmd }` |
| `tool_end` | Tool completed | `{ id, name, isError, cmd, recentTools }` |
| `whatsapp` | WhatsApp state | `whatsappState` |

### Stream History Format

Each entry in `stream_history`:

```json
{
  "role": "assistant",
  "text": "The response content...",
  "streaming": false
}
```

### Recent Tools (from `tool_end`)

The `recentTools` array in `tool_end` events contains the last 5 completed tool calls:

```json
[
  { "name": "bash", "isError": false, "timestamp": 1234567890, "args": { "command": "ls -la" } },
  { "name": "read", "isError": false, "timestamp": 1234567891, "args": { "path": "/etc/hosts" } }
]
```

This is also available via `GET /api/tools` for the currently active (running) tools.

## Development

```bash
npm install
npm run dev        # Run with tsx
npm run typecheck  # Type check
```

## Architecture

- **Extension** (`src/index.ts`) — Subscribes to pi events, manages state, serves HTTP/SSE
- **Dashboard** (`public/index.html`) — Single-file HTML/CSS/JS, no build step required
- **State** — In-memory, reset on session change (`/new`, `/resume`)

## License

MIT
