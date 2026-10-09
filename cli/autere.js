#!/usr/bin/env node
/**
 * autere CLI — talk to an autere backend's /api/v1 from the shell.
 *
 * Zero dependencies (stdlib only). Token auth only:
 *   login once (`autere login`), the bearer token is stored in
 *   ~/.autere/cli-token.json; pass AUTERE_URL / AUTERE_TOKEN to override.
 *
 * Every endpoint mirrors the backend route table (src/backend/routes.ts;
 * paths come from src/shared/api-paths.ts). `autere` lists commands,
 * `autere <cmd> --help` shows usage.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';

const VERSION = '1.0.0';
const CONFIG_DIR = join(homedir(), '.autere');
const CONFIG_FILE = join(CONFIG_DIR, 'cli-config.json');
const BASE = process.env.AUTERE_URL || 'http://localhost:3456';

// ── Config (token + base url) ──

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}
function saveConfig(patch) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const cfg = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
  return cfg;
}
function token() { return process.env.AUTERE_TOKEN || loadConfig().token; }

// ── HTTP ──

async function request(method, path, { body, raw } = {}) {
  const url = `${BASE.replace(/\/+$/, '')}${path}`;
  const headers = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: payload });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${json?.error ? `: ${json.error}` : text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  if (json && json.success === false) throw new Error(json.error || 'Request failed');
  return json?.data !== undefined ? json.data : json;
}

const get = (p) => request('GET', p);
const post = (p, body) => request('POST', p, { body });
const put = (p, body) => request('PUT', p, body === undefined ? {} : { body });

// ── Output helpers ──

function out(data) { console.log(JSON.stringify(data, null, 2)); }

function printSessions(list) {
  for (const s of list) {
    const active = s.active ? (s.streaming ? '●' : '◦') : ' ';
    const name = s.sessionName || '(unnamed)';
    const when = new Date(s.lastActivity).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`${active} ${s.id.slice(0, 8)}  ${when}  ${name}${s.cwd ? `  [${s.cwd}]` : ''}`);
  }
}

function requireArgs(args, n, usage) {
  const ok = args.filter((a) => a !== undefined && a !== '').length >= n;
  if (!ok) { console.error(`Usage: autere ${usage}\n  (run 'autere help' for all commands)`); process.exit(2); }
}

// Encodes a file into a base64 image attachment body for session messages
function imageArg(file) {
  const data = readFileSync(file);
  const ext = (file.split('.').pop() || 'png').toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
  return { mimeType: mime, data: data.toString('base64') };
}

// ── Commands ──
// Each: { desc, fn(args) } — aligned with the backend route table.

const cmds = {};

// ── Auth ──
cmds.login = {
  desc: 'login <user> <password> — authenticate with username/password, store the bearer token',
  fn: async ([user, password]) => {
    requireArgs([user, password], 2, 'login <user> <password>');
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(`Login failed (HTTP ${res.status})${json?.error ? `: ${json.error}` : ''}`);
    saveConfig({ token: json.token, url: BASE });
    console.log(`Logged in as ${user} — token stored in ${CONFIG_FILE}`);
    if (json.mustChangePassword) console.log('NOTE: a password change is required before other API calls work.');
  },
};
cmds.logout = {
  desc: 'logout — invalidate the token server-side and forget it',
  fn: async () => {
    try { await post('/api/v1/auth/logout'); } catch { /* token already bad — still forget it */ }
    saveConfig({ token: undefined });
    console.log('Logged out.');
  },
};
cmds['auth-status'] = { desc: 'auth-status — who am I / role', fn: async () => out(await get('/api/v1/auth/status')) };
cmds['passwd'] = {
  desc: 'passwd <old> <new> — change own password',
  fn: async ([oldPw, newPw]) => {
    requireArgs([oldPw, newPw].filter(Boolean), 2, 'passwd <old> <new>');
    await post('/api/v1/auth/change-password', { oldPassword: oldPw, newPassword: newPw });
    console.log('Password changed.');
  },
};

// ── Tokens (API tokens) ──
cmds['token-list'] = { desc: 'token-list — list own API tokens', fn: async () => out(await get('/api/v1/tokens')) };
cmds['token-create'] = {
  desc: 'token-create <name> — create an API token (secret printed once)',
  fn: async ([name]) => {
    requireArgs([name], 1, 'token-create <name>');
    out(await request('POST', '/api/v1/tokens', { body: { name } }));
  },
};
cmds['token-revoke'] = {
  desc: 'token-revoke <id> — revoke an API token',
  fn: async ([id]) => { requireArgs([id], 1, 'token-revoke <id>'); await request('DELETE', `/api/v1/tokens/${id}`); console.log('Revoked.'); },
};

// ── Users (admin) ──
cmds['user-list'] = { desc: 'user-list — list registered users (admin)', fn: async () => out(await get('/api/v1/users')) };
cmds['user-create'] = {
  desc: 'user-create <name> <password> [role] — create a user (admin). role: chat|control|admin',
  fn: async ([name, password, role]) => {
    requireArgs([name, password], 2, 'user-create <name> <password> [role]');
    await post('/api/v1/users', { username: name, password, ...(role ? { role } : {}) });
    console.log(`User ${name} created.`);
  },
};
cmds['user-update'] = {
  desc: 'user-update <name> [--role r] [--password p] [--dir /path=rw ...] — update a user (admin)',
  fn: async (args) => {
    const [name, ...rest] = args;
    if (!name) { console.error('Usage: autere user-update <name> [--role r] [--password p] [--dir /path=rw]'); process.exit(2); }
    const patch = {};
    const dirs = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--role') patch.role = rest[++i];
      else if (rest[i] === '--password') patch.password = rest[++i];
      else if (rest[i] === '--dir') dirs.push((() => { const [path, access] = rest[++i].split('='); return { path, access: access || 'read' }; })());
    }
    if (dirs.length) patch.allowedDirs = dirs;
    await request('PUT', `/api/v1/users/${encodeURIComponent(name)}`, { body: patch });
    console.log(`User ${name} updated.`);
  },
};
cmds['user-delete'] = {
  desc: 'user-delete <name> — delete a user (admin)',
  fn: async ([name]) => { requireArgs([name], 1, 'user-delete <name>'); await request('DELETE', `/api/v1/users/${name}`); console.log('Deleted.'); },
};

// ── Sessions ──
cmds.sessions = {
  desc: 'sessions — list sessions',
  fn: async () => printSessions(await get('/api/v1/sessions')),
};
cmds['session-search'] = {
  desc: 'session-search <query> — search sessions by name/id/content',
  fn: async ([q]) => { requireArgs([q], 1, 'session-search <query>'); printSessions(await get(`/api/v1/sessions/search?q=${encodeURIComponent(q)}`)); },
};
cmds['session-create'] = {
  desc: 'session-create [--name NAME] [--persona ID] [--workdir DIR] — start a new session. --workdir scopes the sandboxed pi process to a directory (admin only).',
  fn: async (args) => {
    const body = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--name') body.sessionName = args[++i];
      else if (args[i] === '--persona') body.personaId = args[++i];
      else if (args[i] === '--workdir') body.workdir = resolve(args[++i]);
    }
    const res = await request('POST', '/api/v1/sessions', { body });
    const st = res.sessionState || {};
    console.log(`Created session ${st.sessionId || '?'}${st.sessionName ? ` — ${st.sessionName}` : ''}`);
    if (st.sessionFile) console.log(`  file: ${st.sessionFile}`);
    if (body.workdir) console.log(`  workdir: ${body.workdir}`);
  },
};
cmds['session-activate'] = {
  desc: 'session-activate <id> [--spawn] — bind to a session (CLI calls don\'t keep bindings, but returns the bootstrap payload); --spawn also starts the pi process',
  fn: async ([id, ...rest]) => {
    requireArgs([id], 1, 'session-activate <id> [--spawn]');
    const res = await request('POST', `/api/v1/sessions/${id}/activate`, { body: { spawn: rest.includes('--spawn') } });
    out(res.data?.sessionState ?? res);
  },
};
cmds['session-delete'] = {
  desc: 'session-delete <id> — delete a session (file moves to deleted-sessions, control role)',
  fn: async ([id]) => { requireArgs([id], 1, 'session-delete <id>'); await request('DELETE', `/api/v1/sessions/${id}`); console.log('Deleted.'); },
};
cmds['session-history'] = {
  desc: 'session-history <id> [limit] — stream history of a session',
  fn: async ([id, limit]) => {
    requireArgs([id], 1, 'session-history <id> [limit]');
    out(await get(`/api/v1/sessions/${id}/history${limit ? `?limit=${limit}` : ''}`));
  },
};
cmds['session-filechanges'] = {
  desc: 'session-filechanges <id> — file-change log of a session',
  fn: async ([id]) => { requireArgs([id], 1, 'session-filechanges <id>'); out(await get(`/api/v1/sessions/${id}/file-changes`)); },
};

// ── Viewed-session ops (the session the call targets via --session) ──
// These endpoints target "the session the client is viewing"; stateless CLI
// callers pass the session id explicitly with --session <id>.

function takeSessionFlag(args) {
  const i = args.indexOf('--session');
  if (i < 0) return { sessionId: undefined, rest: args };
  const id = args[i + 1];
  const rest = args.filter((_, j) => j !== i && j !== i + 1);
  return { sessionId: id, rest };
}

cmds.state = {
  desc: 'state [--session id] — state of a session',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere state [--session <id>]'); process.exit(2); }
    out(await get(`/api/v1/session/state${sessionId ? `?sessionId=${sessionId}` : ''}`));
  },
};
cmds.stats = {
  desc: 'stats [--session id] — usage stats of a session',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere stats [--session <id>]'); process.exit(2); }
    out(await get(`/api/v1/session/stats${sessionId ? `?sessionId=${sessionId}` : ''}`));
  },
};
cmds.tools = {
  desc: 'tools [--session id] — in-flight tool executions',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere tools [--session <id>]'); process.exit(2); }
    out(await get(`/api/v1/session/tools${sessionId ? `?sessionId=${sessionId}` : ''}`));
  },
};
cmds.models = {
  desc: 'models [--session id] — models available to a session',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere models [--session <id>]'); process.exit(2); }
    out(await get(`/api/v1/session/models${sessionId ? `?sessionId=${sessionId}` : ''}`));
  },
};
cmds['set-model'] = {
  desc: 'set-model <provider> <modelId> [--session id] — change a session model',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    const [provider, modelId] = rest;
    requireArgs([provider, modelId], 2, 'set-model <provider> <modelId> [--session id]');
    await put('/api/v1/session/model', { sessionId, provider, modelId });
    console.log('Model set.');
  },
};
cmds['set-name'] = {
  desc: 'set-name <name> [--session id] — rename a session',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    const [name] = rest;
    requireArgs([name], 1, 'set-name <name> [--session id]');
    await put('/api/v1/session/name', { sessionId, name });
    console.log('Renamed.');
  },
};
cmds['set-persona'] = {
  desc: 'set-persona <personaId|-> [--session id] — bind (or clear with -) a persona',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    const [pid] = rest;
    requireArgs([pid], 1, 'set-persona <personaId|-> [--session id]');
    await put('/api/v1/session/persona', { sessionId, personaId: pid === '-' ? null : pid });
    console.log('Persona set.');
  },
};
cmds.send = {
  desc: 'send <message...> [--session id] [--type prompt|steer|followUp] [--image file] — send a message',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    let type = 'prompt';
    const images = [];
    const text = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--type') type = rest[++i];
      else if (rest[i] === '--image') { images.push(imageArg(rest[++i])); text.push('[image attached]'); }
      else text.push(rest[i]);
    }
    const message = text.join(' ');
    if (!message.trim()) { console.error('Usage: autere send <message...> [--session id] [--type prompt|steer|followUp] [--image file]'); process.exit(2); }
    const body = { sessionId, message, type };
    if (images.length) body.images = images;
    await post('/api/v1/session/messages', body);
    console.log('Sent.');
  },
};
cmds.abort = {
  desc: 'abort [--session id] — abort the active turn',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere abort [--session <id>]'); process.exit(2); }
    await post('/api/v1/session/abort', { sessionId });
    console.log('Abort requested.');
  },
};
cmds.compact = {
  desc: 'compact [--session id] — start compaction (async; progress via events)',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere compact [--session <id>]'); process.exit(2); }
    await post('/api/v1/session/compact', { sessionId });
    console.log('Compaction started.');
  },
};
cmds['compact-abort'] = {
  desc: 'compact-abort [--session id] — abort in-progress compaction',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere compact-abort [--session <id>]'); process.exit(2); }
    await request('DELETE', `/api/v1/session/compact${sessionId ? `?sessionId=${sessionId}` : ''}`);
    console.log('Compaction abort requested.');
  },
};
cmds['session-restart'] = {
  desc: 'session-restart [--session id] — restart the pi process of a session',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere session-restart [--session <id>]'); process.exit(2); }
    await post('/api/v1/session/restart', { sessionId });
    console.log('Restarted.');
  },
};
cmds['session-workdirs'] = {
  desc: 'session-workdirs <dir...> [--session id] — replace the workdirs of a session (admin; idle only — respawns pi)',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    requireArgs(rest, 1, 'session-workdirs <dir...> [--session id]');
    await put('/api/v1/session/workdirs', { sessionId, workdirs: rest });
    console.log('Workdirs set.');
  },
};
cmds['models-refresh'] = {
  desc: 'models-refresh — reload the model catalog from pi (chat)',
  fn: async (args) => {
    if (args.length) { console.error('Usage: autere models-refresh'); process.exit(2); }
    out(await post('/api/v1/models/available'));
  },
};
cmds['pending-cancel'] = {
  desc: 'pending-cancel <text> [--session id] — cancel a queued steer/follow-up message',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    const [text] = rest;
    requireArgs([text], 1, 'pending-cancel <text> [--session id]');
    await request('DELETE', '/api/v1/session/pending', { body: { sessionId, text } });
    console.log('Cancelled.');
  },
};

// ── Settings ──
cmds.settings = { desc: 'settings — read own settings', fn: async () => out(await get('/api/v1/settings')) };
cmds['settings-schema'] = { desc: 'settings-schema — settings schema', fn: async () => out(await get('/api/v1/settings/schema')) };
cmds['settings-put'] = {
  desc: 'settings-put <key=value...> — replace/patch settings (control). Full object is sent (current values + patches).',
  fn: async (args) => {
    if (!args.length) { console.error('Usage: autere settings-put <key=value...>'); process.exit(2); }
    const current = await get('/api/v1/settings');
    const patch = {};
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq < 0) { console.error(`Bad key=value: ${a}`); process.exit(2); }
      let v = a.slice(eq + 1);
      try { v = JSON.parse(v); } catch { /* keep string */ }
      patch[a.slice(0, eq)] = v;
    }
    await request('PUT', '/api/v1/settings', { body: { ...current, ...patch } });
    console.log('Settings saved.');
  },
};

// ── Extensions / Personas / Scheduler / Files / Git ──
cmds['mcp-list'] = { desc: 'mcp-list — own MCP servers (env mcp.json)', fn: async () => out(await get('/api/v1/settings/mcp')) };
cmds['mcp-set'] = {
  desc: 'mcp-set <name> <config-json> — create/replace an MCP server (control). JSON or a file path: {"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."],"exposure":"deferred"}',
  fn: async ([name, spec]) => {
    requireArgs([name, spec], 2, 'mcp-set <name> <config-json|@file.json>');
    const raw = spec.startsWith('@') ? readFileSync(spec.slice(1), 'utf8') : spec;
    let cfg;
    try { cfg = JSON.parse(raw); } catch { console.error('config is not valid JSON'); process.exit(2); }
    // Convenience: a whole mcpServers-style file { "<name>": {...} } works when
    // the single entry's value is the actual config
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && !cfg.command && !cfg.url && Object.keys(cfg).length === 1 && typeof Object.values(cfg)[0] === 'object') {
      const first = Object.entries(cfg)[0];
      cfg = first[1];
    }
    await request('PUT', `/api/v1/settings/mcp/${encodeURIComponent(name)}`, { body: cfg });
    console.log(`MCP server "${name}" saved.`);
  },
};
cmds['mcp-rm'] = {
  desc: 'mcp-rm <name> — remove an MCP server (control)',
  fn: async ([name]) => {
    requireArgs([name], 1, 'mcp-rm <name>');
    await request('DELETE', `/api/v1/settings/mcp/${encodeURIComponent(name)}`);
    console.log('Removed.');
  },
};
cmds.extensions = { desc: 'extensions — installed pi extensions', fn: async () => out(await get('/api/v1/extensions')) };
cmds['extensions-packages'] = { desc: 'extensions-packages — installable extensions + enabled set', fn: async () => out(await get('/api/v1/extensions/packages')) };
cmds['personas-list'] = { desc: 'personas-list — persona library', fn: async () => out(await get('/api/v1/personas')) };
cmds['personas-create'] = {
  desc: 'personas-create <name> <prompt> [description] — create a persona (control)',
  fn: async ([name, prompt, description]) => {
    requireArgs([name, prompt], 2, 'personas-create <name> <prompt> [description]');
    out(await request('POST', '/api/v1/personas', { body: { name, prompt, description } }));
  },
};
cmds['personas-update'] = {
  desc: 'personas-update <id> <name> <prompt> [description] — replace a persona (control)',
  fn: async ([id, name, prompt, description]) => {
    requireArgs([id, name, prompt], 3, 'personas-update <id> <name> <prompt> [description]');
    out(await request('PUT', `/api/v1/personas/${id}`, { body: { name, prompt, description } }));
  },
};
cmds['personas-delete'] = {
  desc: 'personas-delete <id> — delete a persona (control)',
  fn: async ([id]) => { requireArgs([id], 1, 'personas-delete <id>'); await request('DELETE', `/api/v1/personas/${id}`); console.log('Deleted.'); },
};
cmds['personas-global-prompt'] = {
  desc: 'personas-global-prompt [prompt|-] — get the global system prompt, or set it ("-" clears, control)',
  fn: async (args) => {
    if (!args.length) { out(await get('/api/v1/personas/global-prompt')); return; }
    const prompt = args.join(' ');
    await put('/api/v1/personas/global-prompt', { prompt: prompt === '-' ? '' : prompt });
    console.log(prompt === '-' ? 'Global prompt cleared.' : 'Global prompt set.');
  },
};
cmds['personas-generate'] = {
  desc: 'personas-generate <notes...> [--session id] — draft a persona prompt from notes (control)',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    const text = rest.join(' ');
    requireArgs([text], 1, 'personas-generate <notes...> [--session id]');
    const res = await request('POST', '/api/v1/personas/generate', { body: { sessionId, text } });
    console.log(res.prompt);
  },
};
cmds['tasks-list'] = { desc: 'tasks-list — scheduled tasks + recent runs', fn: async () => out(await get('/api/v1/scheduler/tasks')) };
cmds['task-create'] = {
  desc: 'task-create <name> <cron> <prompt> [--model m] [--seed script] [--result script] [--enabled false] [--once] — create a task (control); --once = one-off (runs at most once)',
  fn: async (args) => {
    const [name, schedule, prompt, ...rest] = args;
    requireArgs([name, schedule, prompt], 3, 'task-create <name> <cron> <prompt> [options]');
    const body = { name, schedule, prompt };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--model') body.model = rest[++i];
      else if (rest[i] === '--seed') body.seedScript = rest[++i];
      else if (rest[i] === '--result') body.resultScript = rest[++i];
      else if (rest[i] === '--enabled') body.enabled = rest[++i] !== 'false';
      else if (rest[i] === '--once') body.once = true;
    }
    out(await request('POST', '/api/v1/scheduler/tasks', { body }));
  },
};
cmds['task-update'] = {
  desc: 'task-update <id> <name> <cron> <prompt> — replace a task (control)',
  fn: async (args) => {
    const [id, name, schedule, prompt] = args;
    requireArgs(args, 4, 'task-update <id> <name> <cron> <prompt>');
    await request('PUT', `/api/v1/scheduler/tasks/${id}`, { body: { name, schedule, prompt } });
    console.log('Updated.');
  },
};
cmds['task-delete'] = {
  desc: 'task-delete <id> — delete a task (control)',
  fn: async ([id]) => { requireArgs([id], 1, 'task-delete <id>'); await request('DELETE', `/api/v1/scheduler/tasks/${id}`); console.log('Deleted.'); },
};
// Block on a run by polling its record: one long HTTP request would hit
// undici's 5-minute headers timeout on a slow run, while polling also
// survives backend restarts / keep-alives.
const RUN_POLL_MS = 1000;
const RUN_WAIT_LIMIT_MS = 15 * 60 * 1000; // matches the scheduler's per-run timeout
async function waitForRun(taskId, runId) {
  const deadline = Date.now() + RUN_WAIT_LIMIT_MS;
  for (;;) {
    const rec = await get(`/api/v1/scheduler/runs/${taskId}/${runId}`);
    if (rec && rec.status && rec.status !== 'running') return rec;
    if (Date.now() > deadline) throw new Error('timed out waiting for the run (15m)');
    await new Promise((r) => setTimeout(r, RUN_POLL_MS));
  }
}
cmds['task-run'] = {
  desc: 'task-run <id> [--wait] — trigger a task run now; --wait blocks until it finishes and prints the run record (one-off tasks only) (control)',
  fn: async ([id, flag]) => {
    requireArgs([id], 1, 'task-run <id> [--wait]');
    if (flag === undefined) {
      out(await request('POST', `/api/v1/scheduler/tasks/${id}/run`));
      return;
    }
    if (flag !== '--wait') { console.error('Usage: autere task-run <id> [--wait]'); process.exit(2); }
    // Validate BEFORE triggering: a blocking run only exists for one-offs
    const { tasks } = await get('/api/v1/scheduler/tasks');
    const task = (tasks || []).find((t) => t.id === id);
    if (!task) { console.error(`Task ${id} not found`); process.exit(1); }
    if (!task.once) {
      console.error('--wait applies only to one-off tasks — create one with: autere task-create <name> <cron> <prompt> --once');
      process.exit(2);
    }
    const { runId } = await request('POST', `/api/v1/scheduler/tasks/${id}/run`);
    const rec = await waitForRun(id, runId);
    out(rec);
    if (rec.status !== 'success') process.exitCode = 1;
  },
};
cmds['runs-list'] = {
  desc: 'runs-list [taskId] [limit] — task runs',
  fn: async (args) => {
    const qs = new URLSearchParams();
    if (args[0]) qs.set('taskId', args[0]);
    if (args[1]) qs.set('limit', args[1]);
    const q = qs.toString();
    out(await get(`/api/v1/scheduler/runs${q ? `?${q}` : ''}`));
  },
};
cmds['run-log'] = {
  desc: 'run-log <taskId> <runId> — one run log',
  fn: async ([taskId, runId]) => { requireArgs([taskId, runId], 2, 'run-log <taskId> <runId>'); out(await get(`/api/v1/scheduler/runs/${taskId}/${runId}`)); },
};
cmds['file-roots'] = { desc: 'file-roots — browsable filesystem roots', fn: async () => out(await get('/api/v1/browse/roots')) };
cmds['file-ls'] = {
  desc: 'file-ls <path> — list a directory',
  fn: async ([path]) => { requireArgs([path], 1, 'file-ls <path>'); out(await get(`/api/v1/browse/list?path=${encodeURIComponent(path)}`)); },
};
cmds['file-read'] = {
  desc: 'file-read <path> — read a file',
  fn: async ([path]) => { requireArgs([path], 1, 'file-read <path>'); out(await get(`/api/v1/browse/read?path=${encodeURIComponent(path)}`)); },
};
cmds['file-write'] = {
  desc: 'file-write <path> <content|- stdin> — write a file (control, rw root)',
  fn: async ([path, content]) => {
    requireArgs([path], 1, 'file-write <path> <content|->');
    const data = content === '-' ? readFileSync(0, 'utf-8') : content ?? '';
    await request('PUT', '/api/v1/browse/file', { body: { path, content: data } });
    console.log('Written.');
  },
};
cmds['file-delete'] = {
  desc: 'file-delete <path> — delete a file (control, rw root)',
  fn: async ([path]) => { requireArgs([path], 1, 'file-delete <path>'); await request('DELETE', `/api/v1/browse/file?path=${encodeURIComponent(path)}`); console.log('Deleted.'); },
};
cmds['git-repos'] = { desc: 'git-repos — configured repositories', fn: async () => out(await get('/api/v1/git/repos')) };
cmds['git-status'] = {
  desc: 'git-status <path> [count] — repo detail (status, remotes, commits)',
  fn: async ([path, count]) => { requireArgs([path], 1, 'git-status <path> [count]'); out(await get(`/api/v1/git/repo?path=${encodeURIComponent(path)}${count ? `&count=${count}` : ''}`)); },
};
cmds['git-log'] = {
  desc: 'git-log <file> — commit history of a file',
  fn: async ([path]) => { requireArgs([path], 1, 'git-log <file>'); out(await get(`/api/v1/git/commits?path=${encodeURIComponent(path)}`)); },
};
cmds['git-diff'] = {
  desc: 'git-diff <file> — working-tree diff of a file',
  fn: async ([path]) => { requireArgs([path], 1, 'git-diff <file>'); out(await get(`/api/v1/git/diff?path=${encodeURIComponent(path)}`)); },
};
cmds['git-ls'] = {
  desc: 'git-ls <path> — list inside a configured repo',
  fn: async ([path]) => { requireArgs([path], 1, 'git-ls <path>'); out(await get(`/api/v1/git/list?path=${encodeURIComponent(path)}`)); },
};
cmds['git-clone'] = {
  desc: 'git-clone <path> [remote] — clone into a configured folder (control)',
  fn: async ([path, remote]) => { requireArgs([path], 1, 'git-clone <path> [remote]'); out(await request('POST', '/api/v1/git/repos/clone', { body: { path, remote } })); },
};
cmds['git-init'] = {
  desc: 'git-init <path> — init a repo in a configured folder (control)',
  fn: async ([path]) => { requireArgs([path], 1, 'git-init <path>'); out(await request('POST', '/api/v1/git/repos/init', { body: { path } })); },
};

// ── Misc ──
cmds.bootstrap = {
  desc: 'bootstrap [sessionId] — full dashboard bootstrap payload',
  fn: async ([id]) => {
    if (id) return out(await get(`/api/v1/bootstrap?sessionId=${id}`));
    out(await get('/api/v1/bootstrap'));
  },
};
cmds.status = { desc: 'status — backend/uptime info', fn: async () => out(await get('/api/v1/status')) };
cmds['backend-restart'] = {
  desc: 'backend-restart — restart the autere backend (admin)',
  fn: async () => { await post('/api/v1/backend/restart'); console.log('Restart requested.'); },
};
cmds.openapi = {
  desc: 'openapi [out] — dump GET /api/v1/openapi.json',
  fn: async ([file]) => {
    const data = await get('/api/v1/openapi.json');
    if (file) { writeFileSync(file, JSON.stringify(data, null, 2)); console.log(`Wrote ${file}`); }
    else out(data);
  },
};
cmds['file-get'] = {
  desc: 'file-get <name> [out] — download a shared file or generated image (name: file-… or gen-/edit-…)',
  fn: async ([name, outPath]) => {
    requireArgs([name], 1, 'file-get <name> [out]');
    const base = name.startsWith('gen-') || name.startsWith('edit-') ? '/api/v1/images/generated/' : '/api/v1/files/';
    const res = await request('GET', base + encodeURIComponent(name), { raw: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const target = outPath || name;
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    console.log(`Wrote ${target} (${res.headers.get('content-type') || 'octet-stream'}).`);
  },
};
cmds['raw'] = {
  desc: 'raw <METHOD> <path> [jsonBody] — call any API endpoint directly',
  fn: async (args) => {
    const [method, path, body] = args;
    if (!method || !path) { console.error('Usage: autere raw <METHOD> <path> [jsonBody]'); process.exit(2); }
    const opts = body !== undefined ? { body: body === '-' ? readFileSync(0, 'utf-8') : body } : {};
    out(await request(method.toUpperCase(), path, opts));
  },
};
cmds['stream'] = {
  desc: 'stream [--session id] — live SSE event stream (clientId generated per run)',
  fn: async (args) => {
    const { sessionId, rest } = takeSessionFlag(args);
    if (rest.length) { console.error('Usage: autere stream [--session <id>]'); process.exit(2); }
    const clientId = `cli-${process.pid}-${Date.now().toString(36)}`;
    // POST /bootstrap binds this client id to the session first, so events land.
    if (sessionId) {
      await request('POST', `/api/v1/sessions/${sessionId}/activate`, { body: { spawn: true } }).catch(() => {});
    }
    const url = `${BASE}/api/v1/events?clientId=${encodeURIComponent(clientId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.error(`Streaming ${url} — Ctrl+C to stop.`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (data) {
          try { console.log(JSON.stringify(JSON.parse(data))); } catch { console.log(data); }
        }
      }
    }
  },
};

// ── Dispatch ──

function usage() {
  console.log(`autere ${VERSION} — autere backend CLI

Auth: token only. 'autere login <user> <password>' stores a bearer token in
${CONFIG_FILE}; alternatively export AUTERE_TOKEN=<token>. Backend via AUTERE_URL or 'autere set-url <url>' (default ${BASE}).

Commands:`);
  for (const [name, cmd] of Object.entries(cmds).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${name.padEnd(20)} ${cmd.desc.split('—')[1]}`);
  }
}

cmds.help = { desc: 'help — this help', fn: () => usage() };
cmds['set-url'] = {
  desc: 'set-url <url> — set the backend URL in the CLI config',
  fn: ([url]) => { if (!url) { console.error('Usage: autere set-url <url>'); process.exit(2); } saveConfig({ url }); console.log(`Backend URL set to ${url}`); },
};

const [cmd, ...args] = process.argv.slice(2);
const entry = cmd && cmds[cmd];
if (!cmd) { usage(); process.exit(0); }
if (!entry) { console.error(`Unknown command: ${cmd}\n`); usage(); process.exit(2); }
Promise.resolve(entry.fn(args)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
