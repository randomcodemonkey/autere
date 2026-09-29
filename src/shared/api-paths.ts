/**
 * Single source of truth for every autere HTTP API path.
 *
 * Imported by the backend (route matching + OpenAPI), the web UI, and the
 * TUI. All paths are versioned (API_VERSION); the /events SSE stream is
 * part of the API surface and versioned with it.
 */

export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

const P = API_PREFIX;

export const API = {
  openapi: `${P}/openapi.json`,
  events: `${P}/events`,

  auth: {
    login: `${P}/auth/login`,
    logout: `${P}/auth/logout`,
    status: `${P}/auth/status`,
    changePassword: `${P}/auth/change-password`,
  },

  tokens: {
    list: `${P}/tokens`,
    item: (id: string) => `${P}/tokens/${encodeURIComponent(id)}`,
  },

  users: {
    list: `${P}/users`,
    item: (name: string) => `${P}/users/${encodeURIComponent(name)}`,
  },

  browse: {
    roots: `${P}/browse/roots`,
    list: (path: string) => `${P}/browse/list?path=${encodeURIComponent(path)}`,
    read: (path: string) => `${P}/browse/read?path=${encodeURIComponent(path)}`,
    write: `${P}/browse/file`,
    remove: (path: string) => `${P}/browse/file?path=${encodeURIComponent(path)}`,
  },

  git: {
    repos: `${P}/git/repos`,
    detail: (path: string) => `${P}/git/repo?path=${encodeURIComponent(path)}`,
    commits: (path: string) => `${P}/git/commits?path=${encodeURIComponent(path)}`,
    diff: (path: string) => `${P}/git/diff?path=${encodeURIComponent(path)}`,
    list: (path: string) => `${P}/git/list?path=${encodeURIComponent(path)}`,
  },

  bootstrap: `${P}/bootstrap`,
  status: `${P}/status`,

  sessions: {
    list: `${P}/sessions`,
    search: (q: string) => `${P}/sessions/search?q=${encodeURIComponent(q)}`,
    history: (id: string) => `${P}/sessions/${encodeURIComponent(id)}/history`,
    fileChanges: (id: string) => `${P}/sessions/${encodeURIComponent(id)}/file-changes`,
    activate: (id: string) => `${P}/sessions/${encodeURIComponent(id)}/activate`,
    item: (id: string) => `${P}/sessions/${encodeURIComponent(id)}`,
  },

  // The session the client is VIEWING — target selected by sessionId body
  // field / query parameter, bound by bootstrap / session activation.
  session: {
    state: `${P}/session/state`,
    stats: `${P}/session/stats`,
    tools: `${P}/session/tools`,
    models: `${P}/session/models`,
    messages: `${P}/session/messages`,
    model: `${P}/session/model`,
    name: `${P}/session/name`,
    persona: `${P}/session/persona`,
    abort: `${P}/session/abort`,
    restart: `${P}/session/restart`,
    compact: `${P}/session/compact`,
    pending: `${P}/session/pending`,
    fileChangesQuery: (id: string) => `sessionId=${encodeURIComponent(id)}`,
  },

  settings: {
    root: `${P}/settings`,
    schema: `${P}/settings/schema`,
  },

  extensions: {
    root: `${P}/extensions`,
    packages: `${P}/extensions/packages`,
  },

  personas: {
    root: `${P}/personas`,
    generate: `${P}/personas/generate`,
    globalPrompt: `${P}/personas/global-prompt`,
    item: (id: string) => `${P}/personas/${encodeURIComponent(id)}`,
  },

  scheduler: {
    tasks: `${P}/scheduler/tasks`,
    task: (id: string) => `${P}/scheduler/tasks/${encodeURIComponent(id)}`,
    taskRun: (id: string) => `${P}/scheduler/tasks/${encodeURIComponent(id)}/run`,
    runs: `${P}/scheduler/runs`,
    runLog: (taskId: string, runId: string) => `${P}/scheduler/runs/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}`,
  },

  backend: {
    restart: `${P}/backend/restart`,
  },

  images: (name: string) => (name.startsWith('gen-') || name.startsWith('edit-')) ? `${P}/images/generated/${name}` : `${P}/images/${name}`,
  files: (name: string) => `${P}/files/${encodeURIComponent(name)}`,
} as const;
