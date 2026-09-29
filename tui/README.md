# autere TUI

Terminal client for the autere dashboard — same auth, REST API, and SSE
stream the web UI uses, so it works alongside browsers with zero backend
changes.

## Run

```bash
npm install            # once, from tui/
npx tsx index.tsx [url] [--token <token>]
```

- `url` defaults to `AUTERE_URL` or `http://localhost:3456`.
- **Auth priority**: `--token` flag → `AUTERE_TOKEN` env → saved config
  (`$AUTERE_DIR/tui.json`, default `~/.autere/tui.json`). With a token the
  TUI connects directly; without one it falls back to an interactive
  user/password login (which stores the resulting token in `tui.json`).

Create API tokens in the web dashboard: **Settings → API Tokens**
(full token shown once; TUI authenticates with `Authorization: Bearer`).

## Build a single executable

```bash
npm run build
```

Produces a single `tui/dist/autere-tui` (with ink/react and the whole TUI
embedded). Either run it from there:

```bash
tui/dist/autere-tui --token <token> [url]
```

…or copy it onto your `$PATH`, e.g. `cp tui/dist/autere-tui ~/.local/bin/`.

Requires Node ≥ 20; on Node builds without SEA support (some distro
packages) the build emits the same single file as a `#!/usr/bin/env node`
script instead of a true binary — usable identically, needs `node` on
`$PATH`.

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
