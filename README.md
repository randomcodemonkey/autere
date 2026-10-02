# autere

Autere is a web frontend and orchestrator for the [Pi Coding Agent](https://pi.dev/) with multi-user and multi-session support.

Designed to communicate to a locally running 9router instance, but the underlying pi agents can be configured to use
some other supported AI provider directly.

The backend multiplexes pi sessions per user, allowing the same user to interact with any pi session from any
number of devices. The pi sessions are optionally isolated into their own docker containers, providing each
user their own (configurable) workdirs inside the container.

The web frontend shows a users pi sessions, allows interacting with them ('chat'), has a file browser with git repository
support and provides access to per-user settings.

## Installation and Running

Build a docker image with the autere frontend + backend (9router started/managed by the backend when the provider is 9router) under supervisord:

```bash
docker buildx build --platform linux/arm64 -t autere -f docker/Dockerfile .
```

Local buildx builds only target a single architecture; use `--platform linux/amd64,linux/arm64 --push` for a multi-arch push.

All configuration is via env variables (docker run / compose):

```bash
docker run -d --name autere \
  -p 127.0.0.1:3456:3456 -p 127.0.0.1:20128:20128 \
  -e INITIAL_PASSWORD=secret \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v autere-data:/home/autere/.autere \
  -v autere-master-pi-data:/home/autere/.pi \
  -v autere-master-9router-data:/home/autere/.9router \
  autere
```

`/var/run/docker.sock` is required for sandboxed pi sessions - without it the backend cannot start session containers. Admin user may set 'sandbox' image to 'off' in their per-user settings, or disable sandboxing globally by setting env `AUTERE_SANDBOX_IMAGE=off`. When mounting docker.sock inside the autere container, you **must** use `--group-add <gid>` in the docker run command, where gid matches the group of the socket inside the autere container.

The `/home/autere/.autere` and `/home/autere/.pi` must be mounted as named docker volumes if using sandboxed pi containers. It is strongly suggested to always mount them as named volumes (not bind mounts) so it is possible to switch to sandboxed mode later.

Once started, the web app is available at **http://localhost:3456**; 9router, if enabled, at **http://localhost:20128**.

### Authentication

Auth is on by default (`AUTERE_AUTH=false` disables it — only for private/dev instances). The fixed `admin` account is seeded on first start from `--autere-password` (config file) or `INITIAL_PASSWORD` (defaults to `admin`) and is not forced to rotate it — **set a real `INITIAL_PASSWORD` with `-e INITIAL_PASSWORD=<secret>`** before first start. Users created later (via the admin Users page, or `autere user-create`) must change their generated/seed password at first login before the API accepts anything else.

The CLI authenticates with the same accounts (`autere login admin <password>`), storing its token in `~/.autere/cli-config.json`.

Autere can also be ran without 9router, by defining the `AUTERE_PROVIDER` env value to a valid `pi` provider. With this mode, you must manually configure the provider with `pi` through the running autere docker container

```bash
docker exec -it autere pi
```

Enter `/login` to pi and follow the instructions for configuring your selected profile.


### Configuration (system env)

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTERE_PORT` | 3456 | HTTP server port |
| `AUTERE_AUTH` | true | Enable/disable authentication |
| `INITIAL_PASSWORD` | `admin` | First-boot password for the `admin` user and 9router — should always be set in docker deployments |
| `AUTERE_PROVIDER` | - | Pi provider |
| `AUTERE_MODEL` | - | Pi model ID |
| `AUTERE_IDLE_TIMEOUT` | 30 | Minutes before idle pi process is killed |
| `AUTERE_NINE_ROUTER_URL` | `http://localhost:20128` | Backend-managed 9router |
| `AUTERE_SANDBOX_IMAGE` | randomcodemonkey.org/autere:latest | Docker image for sandboxed pi sessions (`off` to run pi on the host) |

## Architecture

### Data files

Global (under `~/.autere/`):

| File | Contents |
|------|----------|
| `autere-users.json` | User registry (roles, password hashes, allowed dirs) - seeded on first start, authoritative afterwards |
| `autere-auth-tokens.json` | Active login tokens (30-day expiry) |
| `users/<user>/settings.json` | Per-user (persisted) settings values |
| `users/<user>/scheduled-tasks.json` (+ `scheduled-task-logs/`) | Scheduled tasks and run logs |

Per-user pi env (under `~/.autere/pi-envs/<user>/`):

| File | Contents |
|------|----------|
| `sessions/*.jsonl` | Pi session transcripts (current last id in `last-session.json`) |
| `file-changes/*.jsonl` | Per-session file change log (Files -> Session Edits) |
| `images/`, `uploads/` | Generated images / session attachments |
| `9router-config.json` | 9router endpoint + per-user settings overrides |
| `models.json` | pi model overrides (per-input-type forcing) |
| `settings.json` | pi settings for the session environment |
| `janitor-config.json`, `dedup-stats.json` | Extension state (live-read) |

### REST API

All endpoints are versioned under `/api/v1`. The full machine-generated spec is served at
`/api/v1/openapi.json` - no endpoint list is kept in this document.

Run Swagger UI against a local backend:

```bash
docker run --rm -p 8081:8080 -e SWAGGER_JSON_URL=http://localhost:3456/api/v1/openapi.json swaggerapi/swagger-ui
# open http://localhost:8081 - for auth'd calls, first POST /api/v1/auth/login and set the returned bearer token via the Authorize button
```

### SSE

Stream: `GET /api/v1/events` (per-user, scoped to the viewed session where applicable). Heartbeats every 3s.

| Event | Data |
|-------|------|
| `status` | session state (model, isStreaming, compacting, sessionId, ...) |
| `stats` | token usage/cost |
| `stream_history` | full history snapshot (connect/reload) |
| `history_upsert` | entries appended or replaced by stable id |
| `history_remove` | entry ids removed |
| `stream_delta` | `{role, text}` of the streaming entry (throttled client-side) |
| `tool_start` / `tool_end` | tool lifecycle |
| `models` / `sessions` / `extensions` | resource lists |
| `navigate` | server-commanded frontend navigation |
| `new_session_creating` | new session creation in flight |
| `error` | error message |
| `heartbeat` | keep-alive |

History entry `role` values: `user`, `assistant`, `thinking`, `toolCall`, `toolResult`, `edit`, `file`, `image`. Non-renderable pi roles (e.g. `model_change`) are dropped.

## License

MIT
