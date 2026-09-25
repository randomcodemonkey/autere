# autere TUI

Terminal client for the autere dashboard — same auth, REST API, and SSE
stream the web UI uses, so it works alongside browsers with zero backend
changes.

## Run

```bash
npx tsx index.tsx [url] [--token <token>]
```

- `url` defaults to `AUTERE_URL` or `http://localhost:3456`.
- **Auth priority**: `--token` flag → `AUTERE_TOKEN` env → saved config
  (`$AUTERE_DIR/tui.json`, default `~/.autere/tui.json`). With a token the
  TUI connects directly; without one it falls back to an interactive
  user/password login (which stores the resulting token in `tui.json`).

Create API tokens in the web dashboard: **Settings → API Tokens**
(full token shown once; TUI authenticates with `Authorization: Bearer`).

## Keys

| Key | Action |
|---|---|
| `↑`/`↓` | select session (sessions pane) |
| `Enter` | switch to selected session |
| `Tab` | focus chat input |
| `Enter` (input) | send |
| `Esc` (input, streaming) | abort |
| `h` | toggle help overlay |
| `⌘/Ctrl+C` | quit |

## Smoke test

```bash
bash smoke/smoke.sh
```

Starts an isolated backend (fully under `AUTERE_DIR`/`AUTERE_PI_ENVS_DIR` —
never touches the shared `~/.autere`), seeds a session, drives the TUI in a
pty through login → switch → send, asserts each step, and renders PNG
screenshots of the captured terminal output to `smoke/out/*.png`.
