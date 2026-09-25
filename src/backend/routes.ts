/**
 * HTTP server and API routes for the autere dashboard.
 *
 * The API is versioned (src/shared/api-paths.ts is the single source of
 * truth for every path, shared with the web UI and the TUI). Routes are
 * declared in one table: method + path pattern + minimum role + handler.
 * Standard HTTP semantics apply:
 * - verbs: GET read, POST create/execute, PUT replace, DELETE remove
 * - success: 200, 201 for creates
 * - errors: 400 invalid input, 401 unauthenticated, 403 forbidden,
 *   404 missing, 405 wrong method (with Allow), 409 state conflict,
 *   413 body too large, 500 failed, 503 unavailable
 * - every JSON response carries Content-Type: application/json and the
 *   envelope { success: true, ...data } or { success: false, error }
 *
 * All pi operations are performed via RPC to per-user pi processes.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { ProcessManager } from './process-manager.js';
import { getUser, getUserRole, hasRole, verifyCredentials, checkAuth, requireAuth, parseCookies, generateToken, addAuthToken, removeAuthToken, removeUserTokens, saveAuthTokens, getAuthEnabled, getAuthTokenExpiry, getTokenFromRequest, setLastSession, getLastSession, isRegisteredUser, userMustChangePassword, listApiTokens, createApiToken, deleteApiToken } from './auth.js';
import { getClientSession, setClientSession, registerClient, broadcastToUser, viewedSessions, hubUsers } from './client-hub.js';
import { listUsers, createUser, updateUser, deleteUser, changeOwnPassword, getUserAllowedDirs } from './users.js';
import { withDedupSections, withJanitorSections } from './extension-handlers.js';
import { readExtensions } from './extensions.js';
import { sendJSON, getDashboardHTML, readSessionHistory } from './utils.js';
import { getEnabledModelEntries, scopeModelsForSession } from './utils.js';
import { getPiEnvDir, validateSandboxImage } from './pi-env.js';
import { listPersonas, savePersonas, validatePersona, setActivePersona, getActivePersona, type Persona } from './personas.js';
import { readMessageEntries } from './stream-history.js';
import { getHistoryLimit } from './user-settings.js';
import { getRouterConfig } from './image-models.js';
import { extensionsState } from './state.js';
import { pathIsIgnored } from '../shared/edit-ignore.js';
import { userFileRoots, browseList, browseRead, browseWrite, browseDelete, type BrowseResult } from './files.js';
import { listRepos, repoDetail, fileLog, initRepo, cloneRepo, fileDiff, gitList } from './git.js';
import { log } from './logger.js';
import type { UserSession } from './user-session.js';
import {
  Scheduler,
  listTasks, getTask, saveTask, deleteTask, validateTaskInput,
  listRuns, readRunLog,
  type ScheduledTask,
} from './scheduler.js';
import { randomUUID, createHash } from 'crypto';
import { API, API_PREFIX } from '../shared/api-paths.js';
import { buildOpenApiSpec, type RouteDoc } from './openapi.js';
import type { SessionInfo } from './types.js';

import { getAllUserSettings, saveUserSettings, setUserSetting, getUserSettingsSchema, getAvailablePackages, getEnabledPackages, getSendImagesToChatModel, getImagePreviewQuality, getEditIgnorePaths, getFolderIgnores } from './user-settings.js';

// ── Image attachment limits (session messages) ──
const MAX_ATTACHED_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per image (decoded)

// Maximum accepted request body size (covers 4 base64 images + text)
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read and parse a JSON request body; rejects with statusCode-mapped errors */
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) {
        reject(Object.assign(new Error('Request body is not valid JSON'), { statusCode: 400, cause: err }));
      }
    });
    req.on('error', reject);
  });
}

// ── Client identity: each browser tab sends a stable id (header on API
// calls, query param on the event stream) — events and session calls route
// to that tab's viewed session. ──
function getClientId(req: IncomingMessage): string | null {
  return (req.headers['x-autere-client-id'] as string | undefined)
    || parseCookies(req.headers.cookie || '')['autere-client-id']
    || null;
}

function detectBasePath(req: IncomingMessage): string {
  const prefix = (req.headers['x-forwarded-path'] || req.headers['x-forwarded-prefix'] || req.headers['x-forwarded-base'] || '') as string;
  if (prefix) return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return '';
}

function detectBasePathFromURL(requestPath: string): string {
  // Reverse-proxy base: /<base>/api/... — the API version segment is not
  // part of the base.
  const match = requestPath.match(/^(.+)\/api(?:\/v\d+)?\//);
  if (match && match[1]) return match[1];
  return '';
}

// Serialize the in-flight tool executions pi is currently running. Sent
// with history responses so a client joining mid-turn sees the active
// tools immediately instead of waiting for the next tool_start event.
function activeToolsSnapshot(session: UserSession): Array<{ id: string; name: string; cmd: string; args: any; startTime: number }> {
  const out: Array<{ id: string; name: string; cmd: string; args: any; startTime: number }> = [];
  for (const [id, t] of session.state.activeTools) {
    out.push({ id, name: t.name, cmd: t.cmd, args: t.args || {}, startTime: t.startTime });
  }
  return out;
}

// ── Route table ──

/** Minimum role a user needs for a route (chat < control < admin) */
type Role = 'chat' | 'control' | 'admin';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Authenticated autere user */
  user: string;
  /** Auth token (cookie value or bearer) */
  token: string;
  /** Per-tab client id — routes SSE + API calls to the viewed session */
  clientId: string | null;
  /** The pi session process this client currently views (may be undefined) */
  session: UserSession | undefined;
  /** Session files viewed by any of the user's clients */
  viewed: Set<string | null>;
}

type Handler = (c: Ctx, m: RegExpMatchArray | null) => Promise<void> | void;

interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Literal path or regex; regex capture groups reach the handler */
  path: string | RegExp;
  /** OpenAPI path template ({param} placeholders) */
  template: string;
  role: Role;
  tag: string;
  summary: string;
  /** Success status code (default 200) */
  status?: number;
  handler: Handler;
}

// Dynamic path matchers — built from API_PREFIX so path segments are
// defined once, in src/shared/api-paths.ts.
const RE = {
  tokensItem: new RegExp(`^${API_PREFIX}/tokens/([\\w-]+)$`),
  usersItem: new RegExp(`^${API_PREFIX}/users/([\\w.-]+)$`),
  browseFile: new RegExp(`^${API_PREFIX}/browse/file$`),
  gitRepo: new RegExp(`^${API_PREFIX}/git/repo$`),
  gitCommits: new RegExp(`^${API_PREFIX}/git/commits$`),
  gitDiff: new RegExp(`^${API_PREFIX}/git/diff$`),
  gitList: new RegExp(`^${API_PREFIX}/git/list$`),
  gitReposAction: new RegExp(`^${API_PREFIX}/git/repos/(clone|init)$`),
  sessionsItem: new RegExp(`^${API_PREFIX}/sessions/([\\w-]+)$`),
  sessionsActivate: new RegExp(`^${API_PREFIX}/sessions/([\\w-]+)/activate$`),
  sessionsHistory: new RegExp(`^${API_PREFIX}/sessions/([\\w-]+)/history$`),
  sessionsFileChanges: new RegExp(`^${API_PREFIX}/sessions/([\\w-]+)/file-changes$`),
  personasItem: new RegExp(`^${API_PREFIX}/personas/([\\w-]+)$`),
  schedulerTask: new RegExp(`^${API_PREFIX}/scheduler/tasks/([\\w-]+)$`),
  schedulerTaskRun: new RegExp(`^${API_PREFIX}/scheduler/tasks/([\\w-]+)/run$`),
  schedulerRunLog: new RegExp(`^${API_PREFIX}/scheduler/runs/([\\w-]+)/([\\w-]+)$`),
  image: new RegExp(`^${API_PREFIX}/images/([a-zA-Z0-9._-]+)$`),
  file: new RegExp(`^${API_PREFIX}/files/([a-zA-Z0-9._%~-]+)$`),
};

const STATIC_MIME: Record<string, string> = {
  js: 'application/javascript', css: 'text/css', json: 'application/json',
  png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon',
  txt: 'text/plain', map: 'application/json', woff2: 'font/woff2',
};

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

/** Read the session target selector from body or query string */
function targetParam(c: Ctx, body?: any): string | undefined {
  return body?.sessionId ?? c.url.searchParams.get('sessionId') ?? undefined;
}

interface RouteMatch {
  route: RouteDef;
  match: RegExpMatchArray | null;
}

function matchRoute(list: RouteDef[], method: string, pathname: string): RouteMatch | null {
  for (const route of list) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, match: null };
    } else {
      const m = pathname.match(route.path);
      if (m) return { route, match: m };
    }
  }
  return null;
}

/** Methods defined for a path (for the 405 Allow header) */
function allowedMethods(list: RouteDef[], pathname: string): string[] {
  const out = new Set<string>();
  for (const route of list) {
    if (typeof route.path === 'string' ? route.path === pathname : route.path.test(pathname)) {
      out.add(route.method);
    }
  }
  return ['OPTIONS', ...out];
}

/** Run one route handler; body-parse/reject errors map to their status */
async function runHandler(route: RouteDef, match: RegExpMatchArray | null, c: Ctx) {
  try {
    await route.handler(c, match);
  } catch (err: any) {
    if (err?.statusCode) {
      sendJSON(c.res, { success: false, error: err.message }, err.statusCode);
      return;
    }
    throw err;
  }
}

export function createMonitorServer(PORT: number, pm: ProcessManager, scheduler?: Scheduler): ReturnType<typeof createServer> {
  let sessionRefreshInterval: ReturnType<typeof setInterval> | null = null;

  // ── Session-process resolution ──

  // Resolve the session process a request targets. An explicit sessionId
  // (the session the client is VIEWING, sent per call) wins — the hub
  // binding is established by bootstrap/activate and the first calls after
  // a (re)load can race it, so every session-scoped call carries its
  // target. spawn=true only for calls that NEED a live process (messages/
  // compact/restart/model-change and the explicit load click). Everything
  // else resolves to the running process or undefined — viewing a session
  // must not spawn pi.
  const resolveTarget = async (c: Ctx, explicitId?: unknown, spawn = false): Promise<UserSession | undefined> => {
    if (typeof explicitId === 'string' && explicitId) {
      const sess = pm.findSession(c.user, explicitId, c.viewed);
      if (sess) {
        const running = pm.get(c.user, sess.sessionFile);
        if (running) return running;
        if (!spawn) return undefined;
        const t = await pm.getOrCreate(c.user, sess.sessionFile);
        setClientSession(c.user, c.clientId, t.routedSessionFile());
        return t;
      }
    }
    return c.session;
  };

  let diskEntrySeq = 0;

  // Bootstrap payload builder — shared by GET /bootstrap and the session
  // activation response: everything the UI needs to (re)render for ONE
  // session's process in one shape. sess may be undefined when no session
  // is bound/resolvable — a degenerate payload is returned (the UI treats
  // it as invalid snapshot).
  const buildBootstrapData = (c: Ctx, sess?: UserSession, disk?: SessionInfo) => {
    const user = c.user;
    const st = sess?.state.sessionState ?? null;
    let streamHistory: ReturnType<typeof readSessionHistory> = [];
    // No live process: build the payload from the session file on disk —
    // viewing an idle session must not spawn pi.
    if (!sess && disk) {
      let model: { provider: string; id: string; name: string } | null = null;
      try {
        if (existsSync(disk.sessionFile)) {
          // Disk entries need ids too so live history_upserts after the
          // spawn can match them client-side (module-level counter — the
          // UserSession's own seq keeps its buffer ids unique per process).
          streamHistory = readSessionHistory(disk.sessionFile, getHistoryLimit(user)).map((e: any) => ({ ...e, id: `d${++diskEntrySeq}` }));
          // The model the session actually used (pi reports its CLI default
          // on resume — same source of truth as handleSessionStart).
          const raw = readMessageEntries(disk.sessionFile, 40);
          for (let i = raw.length - 1; i >= 0; i--) {
            const m: any = (raw[i] as any).message;
            if (m?.role === 'assistant' && m.model) {
              model = { provider: String(m.model).split('/')[0] || '', id: m.model, name: String(m.model).replace(/^[a-z0-9-]+\//i, '') };
              break;
            }
          }
        }
      } catch (err) {
        log.http.error('bootstrap: failed to read idle session from disk:', err);
      }
      const persona = getActivePersona(user, disk.sessionFile);
      return {
        sessionState: {
          sessionId: disk.id, sessionFile: disk.sessionFile, sessionName: disk.sessionName ?? null,
          model, thinkingLevel: 'off', isStreaming: false, compacting: false,
          messageCount: 0, requestCount: 0, pendingMessageCount: 0,
          connected: false, startTime: disk.createdAt,
          steerPending: 0, followUpPending: 0,
          persona: persona ? { id: persona.id, name: persona.name } : null,
        },
        sessionStats: null,
        activeTools: [],
        recentTools: [],
        streamHistory,
        historySessionId: disk.id,
        availableSessions: pm.listSessions(user, c.viewed),
        availableModels: getEnabledModelEntries(),
        extensions: extensionsState,
      };
    }
    // Prefer the LIVE in-memory history buffer: mid-turn it holds the
    // streaming entry (streaming:true, current text, live id) that the
    // session file lacks. File read stays the fallback for a not-yet-loaded
    // buffer (e.g. spawn race before pi's getMessages resolves).
    if (sess) {
      const liveBuf = sess.history();
      if (liveBuf.length > 0) streamHistory = liveBuf.slice(-sess.historyLimit);
      if (streamHistory.length === 0 && sess.state.sessionState?.sessionFile && existsSync(sess.state.sessionState.sessionFile)) {
        try { streamHistory = sess.withStableIds(readSessionHistory(sess.state.sessionState.sessionFile, sess.historyLimit)); } catch (err) {
          log.http.error('bootstrap: failed to read session history:', err);
        }
      }
    }
    return {
      sessionState: st ? { ...st } : null,
      sessionStats: sess ? { ...sess.state.sessionStats } : null,
      activeTools: sess ? activeToolsSnapshot(sess) : [],
      recentTools: sess ? [...sess.state.recentTools] : [],
      streamHistory,
      historySessionId: st?.sessionId ?? null,
      availableSessions: pm.listSessions(user, c.viewed),
      availableModels: sess
        ? scopeModelsForSession(sess.state.availableModels, sess.state.sessionState?.model)
        : getEnabledModelEntries(),
      extensions: extensionsState,
    };
  };

  // ── Route table ──
  // docRoutes mirrors the table for the OpenAPI generator (see openapi.ts).

  const docRoutes: RouteDoc[] = [];
  const routes: RouteDef[] = [];
  // Unauthenticated subset (login/logout/status/openapi)
  const publicRoutes: RouteDef[] = [];

  const route = (r: RouteDef & { isPublic?: boolean }) => {
    routes.push(r);
    if (r.isPublic) publicRoutes.push(r);
    docRoutes.push({ method: r.method, template: r.template, role: r.role, tag: r.tag, summary: r.summary, status: r.status });
  };

  // ── Public routes (no auth) ──

  route({
    isPublic: true, method: 'POST', path: API.auth.login, template: `${API_PREFIX}/auth/login`,
    role: 'chat', tag: 'Auth', summary: 'Log in; sets the session cookie and returns a bearer token',
    handler: async (c) => {
      const { user, password } = await readBody(c.req);
      if (!getAuthEnabled()) { sendJSON(c.res, { success: true, message: 'Authentication disabled' }); return; }
      if (!user || typeof user !== 'string') { sendJSON(c.res, { success: false, error: 'User is required' }, 400); return; }
      if (!isRegisteredUser(user)) { sendJSON(c.res, { success: false, error: 'Invalid user' }, 401); return; }
      if (!verifyCredentials(user, password)) { sendJSON(c.res, { success: false, error: 'Invalid password' }, 401); return; }
      const token = generateToken();
      addAuthToken(token, user);
      saveAuthTokens();
      const basePath = detectBasePath(c.req) || detectBasePathFromURL(c.req.url || '/');
      c.res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `autere-token=${token}; Path=${basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(getAuthTokenExpiry() / 1000)}`,
      });
      // `token` in the body: non-browser clients (TUI) authenticate with
      // Authorization: Bearer — they can't read the HttpOnly cookie.
      c.res.end(JSON.stringify({ success: true, token, mustChangePassword: userMustChangePassword(user) }));
    },
  });

  route({
    isPublic: true, method: 'POST', path: API.auth.logout, template: `${API_PREFIX}/auth/logout`,
    role: 'chat', tag: 'Auth', summary: 'Log out; invalidates the session cookie',
    handler: async (c) => {
      const cookies = parseCookies(c.req.headers.cookie || '');
      if (cookies['autere-token']) {
        removeAuthToken(cookies['autere-token']);
        saveAuthTokens();
      }
      const basePath = detectBasePath(c.req) || detectBasePathFromURL(c.req.url || '/');
      c.res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `autere-token=; Path=${basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
      c.res.end(JSON.stringify({ success: true }));
    },
  });

  route({
    isPublic: true, method: 'GET', path: API.auth.status, template: `${API_PREFIX}/auth/status`,
    role: 'chat', tag: 'Auth', summary: 'Auth state for the caller',
    handler: async (c) => {
      const user = getUser(c.req);
      sendJSON(c.res, {
        success: true,
        data: {
          authEnabled: getAuthEnabled(),
          authenticated: checkAuth(c.req),
          user,
          role: user ? getUserRole(user) : null,
          mustChangePassword: user && getAuthEnabled() ? userMustChangePassword(user) : false,
        },
      });
    },
  });

  route({
    isPublic: true, method: 'GET', path: API.openapi, template: `${API_PREFIX}/openapi.json`,
    role: 'chat', tag: 'Docs', summary: 'OpenAPI 3 description of this API',
    handler: async (c) => {
      sendJSON(c.res, buildOpenApiSpec(docRoutes));
    },
  });

  // ── Protected routes ──

  // ── Auth: change own password (any authenticated user) ──
  route({
    method: 'POST', path: API.auth.changePassword, template: `${API_PREFIX}/auth/change-password`,
    role: 'chat', tag: 'Auth', summary: 'Change the caller password',
    handler: async (c) => {
      const { oldPassword, newPassword } = await readBody(c.req);
      const err = changeOwnPassword(c.user, String(oldPassword ?? ''), String(newPassword ?? ''));
      if (err) { sendJSON(c.res, { success: false, error: err }, 400); return; }
      sendJSON(c.res, { success: true });
    },
  });

  // ── API tokens (personal credentials, any role) ──
  route({
    method: 'GET', path: API.tokens.list, template: `${API_PREFIX}/tokens`,
    role: 'chat', tag: 'Tokens', summary: 'List the caller API tokens',
    handler: async (c) => sendJSON(c.res, { success: true, data: listApiTokens(c.user) }),
  });

  route({
    method: 'POST', path: API.tokens.list, template: `${API_PREFIX}/tokens`,
    role: 'chat', tag: 'Tokens', summary: 'Create an API token (the secret appears only in this response)', status: 201,
    handler: async (c) => {
      const body = await readBody(c.req);
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) { sendJSON(c.res, { success: false, error: 'Name is required' }, 400); return; }
      const created = createApiToken(c.user, name);
      sendJSON(c.res, { success: true, data: { id: created.id, name, token: created.token } }, 201);
    },
  });

  route({
    method: 'DELETE', path: RE.tokensItem, template: `${API_PREFIX}/tokens/{id}`,
    role: 'chat', tag: 'Tokens', summary: 'Revoke an API token',
    handler: async (c, m) => {
      const ok = deleteApiToken(c.user, m![1]);
      if (!ok) { sendJSON(c.res, { success: false, error: 'Token not found' }, 404); return; }
      sendJSON(c.res, { success: true });
    },
  });

  // ── User management (admin only; needs no pi session) ──
  route({
    method: 'GET', path: API.users.list, template: `${API_PREFIX}/users`,
    role: 'admin', tag: 'Users', summary: 'List registered users',
    handler: async (c) => sendJSON(c.res, { success: true, data: listUsers() }),
  });

  route({
    method: 'POST', path: API.users.list, template: `${API_PREFIX}/users`,
    role: 'admin', tag: 'Users', summary: 'Create a user', status: 201,
    handler: async (c) => {
      const input = await readBody(c.req);
      const err = createUser(input);
      if (err) { sendJSON(c.res, { success: false, error: err }, 400); return; }
      sendJSON(c.res, { success: true, data: listUsers().find((u) => u.username === input.username) }, 201);
    },
  });

  route({
    method: 'PUT', path: RE.usersItem, template: `${API_PREFIX}/users/{name}`,
    role: 'admin', tag: 'Users', summary: 'Update a user (role, password reset, allowed directories)',
    handler: async (c, m) => {
      const patch = await readBody(c.req);
      const err = updateUser(c.user, decodeURIComponent(m![1]), patch);
      if (err) { sendJSON(c.res, { success: false, error: err }, 400); return; }
      sendJSON(c.res, { success: true });
    },
  });

  route({
    method: 'DELETE', path: RE.usersItem, template: `${API_PREFIX}/users/{name}`,
    role: 'admin', tag: 'Users', summary: 'Delete a user',
    handler: async (c, m) => {
      const name = decodeURIComponent(m![1]);
      const err = deleteUser(c.user, name);
      if (err) { sendJSON(c.res, { success: false, error: err }, 400); return; }
      // Invalidate the deleted user's login tokens and stop their pi processes
      removeUserTokens(name);
      await pm.terminateByUser(name);
      sendJSON(c.res, { success: true });
    },
  });

  // ── File browser (Edits/Files view). list/read are chat-level;
  // write/delete need control — plus path/allowedDirs checks inside the
  // file handlers themselves. ──
  const sendBrowse = (c: Ctx, r: BrowseResult<any>) => {
    if ('error' in r) sendJSON(c.res, { success: false, error: r.error }, r.status);
    else sendJSON(c.res, { success: true, data: r.data });
  };

  route({
    method: 'GET', path: API.browse.roots, template: `${API_PREFIX}/browse/roots`,
    role: 'chat', tag: 'Files', summary: 'Filesystem roots browsable by the caller',
    handler: async (c) => {
      // Files-view ignores: drop roots and entries matching [files] entries
      // so the tree (and the Files search walk) never sees them. Read and
      // delete stay unfiltered — hidden files remain reachable by path.
      const filesIgnore = getFolderIgnores(c.user).filter((e) => e.files).map((e) => e.path);
      sendBrowse(c, { data: userFileRoots(c.user).filter((r) => !pathIsIgnored(r.path, filesIgnore)) });
    },
  });

  route({
    method: 'GET', path: `${API_PREFIX}/browse/list`, template: `${API_PREFIX}/browse/list`,
    role: 'chat', tag: 'Files', summary: 'List a directory (query: path)',
    handler: async (c) => {
      const dir = c.url.searchParams.get('path') || '';
      const filesIgnore = getFolderIgnores(c.user).filter((e) => e.files).map((e) => e.path);
      const r = browseList(c.user, dir);
      if ('data' in r) r.data = r.data.filter((e) => !pathIsIgnored(`${dir}/${e.name}`, filesIgnore));
      sendBrowse(c, r);
    },
  });

  route({
    method: 'GET', path: `${API_PREFIX}/browse/read`, template: `${API_PREFIX}/browse/read`,
    role: 'chat', tag: 'Files', summary: 'Read a file (query: path)',
    handler: async (c) => {
      sendBrowse(c, browseRead(c.user, c.url.searchParams.get('path') || ''));
    },
  });

  route({
    method: 'PUT', path: RE.browseFile, template: `${API_PREFIX}/browse/file`,
    role: 'control', tag: 'Files', summary: 'Write a file (body: path, content)',
    handler: async (c) => {
      try {
        const { path, content } = await readBody(c.req);
        sendBrowse(c, browseWrite(c.user, path, content));
      } catch (err: any) {
        sendBrowse(c, { error: err.message, status: err.statusCode || 400 });
      }
    },
  });

  route({
    method: 'DELETE', path: RE.browseFile, template: `${API_PREFIX}/browse/file`,
    role: 'control', tag: 'Files', summary: 'Delete a file (query: path)',
    handler: async (c) => {
      sendBrowse(c, browseDelete(c.user, c.url.searchParams.get('path') || ''));
    },
  });

  // ── Git (Repositories view). All path checks inside git.ts are rooted in
  // resolveInRoots (allowedDirs); mutations additionally need rw + control. ──
  route({
    method: 'GET', path: API.git.repos, template: `${API_PREFIX}/git/repos`,
    role: 'chat', tag: 'Git', summary: 'Configured repository folders with git-repo detection',
    handler: async (c) => sendBrowse(c, listRepos(c.user)),
  });

  route({
    method: 'GET', path: RE.gitRepo, template: `${API_PREFIX}/git/repo`,
    role: 'chat', tag: 'Git', summary: 'Repository detail: status, remotes, commits (query: path, count=10)',
    handler: async (c) => {
      const count = Math.min(100, Math.max(1, parseInt(c.url.searchParams.get('count') || '10', 10) || 10));
      const offset = Math.max(0, parseInt(c.url.searchParams.get('offset') || '0', 10) || 0);
      const r = repoDetail(c.user, c.url.searchParams.get('path') || '', count + offset);
      if ('data' in r) r.data.commits = r.data.commits.slice(offset);
      sendBrowse(c, r);
    },
  });

  route({
    method: 'GET', path: RE.gitCommits, template: `${API_PREFIX}/git/commits`,
    role: 'chat', tag: 'Git', summary: 'Commit history for one file, max 100 (query: path)',
    handler: async (c) => sendBrowse(c, fileLog(c.user, c.url.searchParams.get('path') || '')),
  });

  route({
    method: 'GET', path: RE.gitDiff, template: `${API_PREFIX}/git/diff`,
    role: 'chat', tag: 'Git', summary: 'Unified diff for one working-tree file (query: path)',
    handler: async (c) => sendBrowse(c, fileDiff(c.user, c.url.searchParams.get('path') || '')),
  });

  route({
    method: 'GET', path: RE.gitList, template: `${API_PREFIX}/git/list`,
    role: 'chat', tag: 'Git', summary: 'List a directory inside a configured repository (query: path)',
    handler: async (c) => {
      // Same files-view ignores as the Files browser — repositories use
      // their own list endpoint, so node_modules etc. must be filtered here.
      const dir = c.url.searchParams.get('path') || '';
      const filesIgnore = getFolderIgnores(c.user).filter((e) => e.files).map((e) => e.path);
      const r = gitList(c.user, dir);
      if ('data' in r) r.data = r.data.filter((e) => !pathIsIgnored(`${dir}/${e.name}`, filesIgnore));
      sendBrowse(c, r);
    },
  });

  route({
    method: 'POST', path: RE.gitReposAction, template: `${API_PREFIX}/git/repos/{action}`,
    role: 'control', tag: 'Git', summary: 'Initialize ({action}=init) or clone ({action}=clone) into a configured folder (body: path, remote?)',
    status: 201,
    handler: async (c, m) => {
      try {
        const body = await readBody(c.req);
        const action = m![1];
        const r = action === 'init'
          ? initRepo(c.user, body.path, body.remote)
          : cloneRepo(c.user, body.path, body.remote);
        sendBrowse(c, r);
      } catch (err: any) {
        sendBrowse(c, { error: err.message, status: err.statusCode || 400 });
      }
    },
  });

  // ── Sessions ──
  route({
    method: 'GET', path: API.sessions.list, template: `${API_PREFIX}/sessions`,
    role: 'chat', tag: 'Sessions', summary: 'List the caller sessions',
    handler: async (c) => sendJSON(c.res, { success: true, data: pm.listSessions(c.user, c.viewed) }),
  });

  route({
    method: 'POST', path: API.sessions.list, template: `${API_PREFIX}/sessions`,
    role: 'chat', tag: 'Sessions', summary: 'Start a new session (optional body: personaId, sessionName, locale, timeZone; admin-only workdir — scopes the sandboxed pi process to that directory)', status: 201,
    handler: async (c) => {
      // Body is optional (tests may post without JSON). Read ONCE — a
      // second read on a consumed stream would hang forever.
      const body = await readBody(c.req).catch(() => ({}) as any);

      // Admin-only: scope the new pi session to a working directory (the
      // sandbox work area — the cwd the docker-wrapped pi process runs in,
      // translated by planSandboxMounts into the container's $HOME/work/…
      // layout). Validated BEFORE anything is spawned.
      let workdir: string | undefined;
      if (body?.workdir !== undefined) {
        const wd = typeof body.workdir === 'string' ? body.workdir.trim() : '';
        if (getUserRole(c.user) !== 'admin') {
          sendJSON(c.res, { success: false, error: 'workdir requires admin role' }, 403);
          return;
        }
        if (!/^\//.test(wd) || wd.includes('\0')) {
          sendJSON(c.res, { success: false, error: 'workdir must be an absolute path' }, 400);
          return;
        }
        // Must sit inside the caller's allowed dirs — those are the work
        // roots the sandbox mounts. Admins without configured dirs get $HOME.
        const dirs = isRegisteredUser(c.user) ? getUserAllowedDirs(c.user) : [];
        const roots = dirs.length ? dirs.map((d) => d.path) : [homedir()];
        const inside = roots.some((r) => {
          const root = r.replace(/\/+$/, '');
          return wd === root || wd.startsWith(root + '/');
        });
        if (!inside) {
          sendJSON(c.res, { success: false, error: `workdir is outside your allowed directories (${roots.join(', ')})` }, 403);
          return;
        }
        try {
          if (!statSync(wd).isDirectory()) {
            sendJSON(c.res, { success: false, error: 'workdir is not a directory' }, 400);
            return;
          }
        } catch {
          sendJSON(c.res, { success: false, error: 'workdir does not exist' }, 400);
          return;
        }
        workdir = wd;
      }

      // Persona for the new session — validated BEFORE creating anything,
      // so an invalid id fails cleanly without leaving a stray session.
      const personaId = typeof body?.personaId === 'string' && body.personaId ? body.personaId : '';
      let persona: Persona | null = null;
      if (personaId) {
        persona = listPersonas(c.user).find((p) => p.id === personaId) || null;
        if (!persona) { sendJSON(c.res, { success: false, error: `Unknown persona: ${personaId}` }, 400); return; }
      }

      // Spawn a DEDICATED process for the fresh session — the previous
      // session's process (if any, even mid-turn) keeps running untouched.
      // workdir scopes pi's cwd (docker sandbox work area) — admin only.
      const fresh = await pm.getOrCreate(c.user, null, workdir ? { cwd: workdir } : {});
      const state = fresh.state.sessionState;
      if (!state.sessionId || !state.sessionFile) {
        throw new Error('pi started a new session but did not report a sessionId or sessionFile');
      }

      // The fresh process auto-names itself at spawn ("[ui] - …"). An
      // explicit name from the request body (frontend-generated with the
      // browser locale/timezone) overrides it; locale/timeZone are
      // persisted per user for spawn-time and task-run auto-naming.
      try {
        const locale = typeof body?.locale === 'string' ? body.locale.trim() : '';
        const timeZone = typeof body?.timeZone === 'string' ? body.timeZone.trim() : '';
        if (locale) setUserSetting(c.user, 'locale', locale);
        if (timeZone) setUserSetting(c.user, 'timeZone', timeZone);
      } catch {}
      if (typeof body?.sessionName === 'string' && body.sessionName.trim()) {
        try {
          await fresh.rpc.setSessionName(body.sessionName.trim());
          state.sessionName = body.sessionName.trim();
        } catch (err) {
          log.http.error('Failed to name new session:', err);
        }
      }

      // Only the REQUESTING client follows the new session — every other
      // client keeps viewing its own session (parallel processes now).
      setClientSession(c.user, c.clientId, state.sessionFile);
      setLastSession(c.user, c.token, state.sessionFile);
      const viewedNow = viewedSessions(c.user);

      // Bind the chosen persona (if any) to the new session — the
      // pi-personas extension puts it into the system prompt every turn.
      setActivePersona(c.user, state.sessionFile, persona);
      state.persona = persona ? { id: persona.id, name: persona.name } : null;

      // Broadcast the updated sessions list (the new entry is file-less
      // until the first message) to all of the user's clients.
      broadcastToUser(c.user, { type: 'sessions', data: pm.listSessions(c.user, viewedNow) });

      log.http.info(`New session created -> /session/${state.sessionId}`);
      // Include the fresh session state so the requesting client can update
      // its badge immediately; the subsequent activation returns the full
      // bootstrap payload from the new process.
      sendJSON(c.res, { success: true, navigateUrl: `/session/${state.sessionId}`, sessionState: { ...state } }, 201);
    },
  });

  route({
    method: 'GET', path: `${API_PREFIX}/sessions/search`, template: `${API_PREFIX}/sessions/search`,
    role: 'chat', tag: 'Sessions', summary: 'Search sessions by name, id and file content (query: q)',
    handler: async (c) => {
      const q = (c.url.searchParams.get('q') || '').trim().toLowerCase();
      const sessions = pm.listSessions(c.user, c.viewed);
      if (q.length < 2) { sendJSON(c.res, { success: true, data: sessions }); return; }
      const scored: { s: SessionInfo; score: number; match: string }[] = [];
      for (const sess of sessions) {
        let score = 0;
        let match = '';
        if (sess.sessionName && sess.sessionName.toLowerCase().includes(q)) {
          score = 30; match = 'name';
        } else if (sess.id.toLowerCase().includes(q)) {
          score = 20; match = 'id';
        }
        if (score < 30 && existsSync(sess.sessionFile)) {
          try {
            // Cap the read — huge session files shouldn't make typing laggy
            const fd = openSync(sess.sessionFile, 'r');
            const buf = Buffer.alloc(Math.min(1024 * 1024, statSync(sess.sessionFile).size));
            readSync(fd, buf, 0, buf.length, 0);
            closeSync(fd);
            if (buf.toString('utf-8').toLowerCase().includes(q)) {
              score = Math.max(score, 10); match = 'content';
            }
          } catch { /* unreadable file — skip content search */ }
        }
        if (score > 0) scored.push({ s: sess, score, match });
      }
      scored.sort((a, b) => b.score - a.score || b.s.lastActivity - a.s.lastActivity);
      sendJSON(c.res, { success: true, data: scored.map(({ s, match }) => ({ ...s, match })) });
    },
  });

  route({
    method: 'GET', path: RE.sessionsHistory, template: `${API_PREFIX}/sessions/{id}/history`,
    role: 'chat', tag: 'Sessions', summary: 'Stream history for one session (query: limit ≤ 100, default 30)',
    handler: async (c, m) => {
      const sess = pm.findSession(c.user, m![1], c.viewed);
      if (!sess) { sendJSON(c.res, { success: false, error: 'Session not found' }, 404); return; }
      const limit = parseInt(c.url.searchParams.get('limit') || '30');
      const bound = await resolveTarget(c, c.url.searchParams.get('sessionId'));
      const isActive = sess.id === bound?.state.sessionState.sessionId;
      sendJSON(c.res, {
        success: true,
        data: readSessionHistory(sess.sessionFile, Math.min(limit, 100)),
        activeTools: isActive && bound ? activeToolsSnapshot(bound) : [],
      });
    },
  });

  route({
    method: 'GET', path: RE.sessionsFileChanges, template: `${API_PREFIX}/sessions/{id}/file-changes`,
    role: 'chat', tag: 'Sessions', summary: 'File-change log for one session',
    handler: async (c, m) => {
      const sess = pm.findSession(c.user, m![1], c.viewed);
      if (!sess) { sendJSON(c.res, { success: true, data: [] }); return; }
      // file-changes JSONL is named after the session filename
      const baseName = basename(sess.sessionFile, '.jsonl');
      const filePath = join(getPiEnvDir(c.user), 'file-changes', `${baseName}.jsonl`);
      if (!existsSync(filePath)) { sendJSON(c.res, { success: true, data: [] }); return; }
      try {
        const content = readFileSync(filePath, 'utf-8');
        const entries = content.split('\n').filter(Boolean).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        // Retroactive ignore filtering: rows written before an entry was
        // added must not resurface.
        const ignores = getEditIgnorePaths(c.user);
        sendJSON(c.res, { success: true, data: entries.filter((e: any) => !e?.path || !pathIsIgnored(e.path, ignores)) });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: err.message }, 500);
      }
    },
  });

  route({
    method: 'POST', path: RE.sessionsActivate, template: `${API_PREFIX}/sessions/{id}/activate`,
    role: 'chat', tag: 'Sessions', summary: 'Bind the calling client to a session (optional body: spawn — also starts the pi process); responds with the bootstrap payload',
    handler: async (c, m) => {
      const sessionId = m![1];
      const body = await readBody(c.req).catch(() => ({}) as any);
      log.http.forSession(c.session?.state.sessionState.sessionId ?? null).info(`activate request: ${sessionId}`);
      const curState = c.session?.state.sessionState;
      let sess = pm.findSession(c.user, sessionId, c.viewed);
      if (!sess && sessionId === curState?.sessionId && curState?.sessionFile) {
        // The client's current session may not be listable yet (its file
        // hasn't been written to disk). Allow switching to it anyway.
        sess = {
          id: sessionId,
          sessionFile: curState.sessionFile,
          sessionName: curState.sessionName || null,
          parentSession: null,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          cwd: null,
        };
      }
      if (!sess) { sendJSON(c.res, { success: false, error: 'Session not found' }, 404); return; }

      // pi refuses to load a session whose stored working directory no
      // longer exists (MissingSessionCwdError). Reject BEFORE spawning —
      // otherwise the response reports the new session while pi never
      // started, leaving the UI stuck until a resync.
      if (sess.cwd && !existsSync(sess.cwd)) {
        sendJSON(c.res, {
          success: false,
          error: `Cannot switch: session's working directory no longer exists (${sess.cwd})`,
        }, 400);
        return;
      }

      // Bind this client to the target session. Lazy: only spawn when the
      // caller asked (the status card's "load" click) — plain switching
      // gets a disk-built payload. Switching never touches the PREVIOUS
      // session's process — a session that was streaming keeps streaming
      // in its own process, viewable by any client at any time.
      let target = pm.get(c.user, sess.sessionFile);
      if (!target && body.spawn === true) target = await pm.getOrCreate(c.user, sess.sessionFile);
      setClientSession(c.user, c.clientId, target?.routedSessionFile() ?? sess.sessionFile);
      if (target) {
        const boundFile = target.routedSessionFile();
        if (boundFile) setLastSession(c.user, c.token, boundFile);
      } else {
        setLastSession(c.user, c.token, sess.sessionFile);
      }

      log.http.info(`activate done: ${sessionId}${target ? ' (live)' : ' (idle)'}`);
      // Same payload shape as GET /bootstrap — the requesting client
      // applies it with the exact same code path.
      sendJSON(c.res, { success: true, data: buildBootstrapData(c, target, sess) });
    },
  });

  route({
    method: 'DELETE', path: RE.sessionsItem, template: `${API_PREFIX}/sessions/{id}`,
    role: 'control', tag: 'Sessions', summary: 'Delete a session (the file moves to the deleted-sessions dir)',
    handler: async (c, m) => {
      const sess = pm.findSession(c.user, m![1], c.viewed);
      if (!sess) { sendJSON(c.res, { success: false, error: 'Session not found' }, 404); return; }
      if (sess.sessionFile === (c.session?.routedSessionFile() ?? getClientSession(c.user, c.clientId))) {
        sendJSON(c.res, { success: false, error: 'Cannot delete the session you are viewing' }, 400);
        return;
      }
      // Stop a running process for the session before removing its file
      await pm.terminate(c.user, sess.sessionFile);
      const deletedDir = join(homedir(), '.autere', 'deleted-sessions');
      mkdirSync(deletedDir, { recursive: true });
      renameSync(sess.sessionFile, join(deletedDir, basename(sess.sessionFile)));
      broadcastToUser(c.user, { type: 'sessions', data: pm.listSessions(c.user, c.viewed) });
      sendJSON(c.res, { success: true });
    },
  });

  // ── Bootstrap + backend status ──
  route({
    method: 'GET', path: API.bootstrap, template: `${API_PREFIX}/bootstrap`,
    role: 'chat', tag: 'Session', summary: 'Everything the UI needs at (re)load: session state, stats, tools, chat history, sessions, models, extensions (query: sessionId?)',
    handler: async (c) => {
      const requested = c.url.searchParams.get('sessionId');
      // Direct URL entry / reload: attach this client to the requested
      // session and return ITS payload — from the live process when one is
      // running, otherwise from the session file on disk. Viewing never
      // spawns pi (lazy: spawn happens on messages/compact/restart/load
      // click). With no sessionId (landing on /): the auth session's last
      // pi session is the login-time default view — also without spawning.
      let diskInfo: SessionInfo | undefined;
      const requestedInfo = requested ? pm.findSession(c.user, requested, c.viewed) : undefined;
      if (requestedInfo) diskInfo = requestedInfo;
      const fallbackFile = !requested && !c.session && pm.resumeLastSession && getAuthEnabled()
        ? getLastSession(c.user, c.token) : null;
      if (requestedInfo || fallbackFile) {
        const file = requestedInfo?.sessionFile ?? fallbackFile!;
        c.session = pm.get(c.user, file);
        setClientSession(c.user, c.clientId, c.session?.routedSessionFile() ?? file);
        if (!c.session && !requestedInfo) {
          diskInfo = pm.listSessions(c.user, viewedSessions(c.user)).find(i => i.sessionFile === file);
        }
      }
      sendJSON(c.res, { success: true, data: buildBootstrapData(c, c.session, !c.session ? diskInfo : undefined) });
    },
  });

  route({
    method: 'GET', path: API.status, template: `${API_PREFIX}/status`,
    role: 'chat', tag: 'Backend', summary: 'Uptime info: autere process start and the viewed session pi process start (null when idle)',
    handler: async (c) => {
      const t = await resolveTarget(c, c.url.searchParams.get('sessionId'));
      sendJSON(c.res, {
        success: true,
        data: {
          autereStartedAt: Date.now() - Math.round(process.uptime() * 1000),
          piStartedAt: t?.state.sessionState.connected ? t.state.sessionState.startTime : null,
        },
      });
    },
  });

  route({
    method: 'POST', path: API.backend.restart, template: `${API_PREFIX}/backend/restart`,
    role: 'admin', tag: 'Backend', summary: 'Restart the autere backend process',
    handler: async (c) => {
      sendJSON(c.res, { success: true });
      setTimeout(() => { try { if (typeof process.exit === 'function') process.exit(0); } catch {} }, 200);
    },
  });

  // ── Viewed-session operations (singular /session) ──
  // Target selected by sessionId (body field or query parameter); bound by
  // GET /bootstrap or session activation.

  const sendTargetMissing = (c: Ctx) =>
    sendJSON(c.res, { success: false, error: 'No active session — reload the page' }, 409);

  route({
    method: 'GET', path: API.session.state, template: `${API_PREFIX}/session/state`,
    role: 'chat', tag: 'Session', summary: 'State of the viewed session (query: sessionId?)',
    handler: async (c) => {
      const t = await resolveTarget(c, targetParam(c));
      sendJSON(c.res, { success: true, data: t?.state.sessionState ?? null });
    },
  });

  route({
    method: 'GET', path: API.session.stats, template: `${API_PREFIX}/session/stats`,
    role: 'chat', tag: 'Session', summary: 'Usage stats of the viewed session (query: sessionId?)',
    handler: async (c) => {
      const t = await resolveTarget(c, targetParam(c));
      sendJSON(c.res, { success: true, data: t?.state.sessionStats ?? null });
    },
  });

  route({
    method: 'GET', path: API.session.tools, template: `${API_PREFIX}/session/tools`,
    role: 'chat', tag: 'Session', summary: 'Tool executions currently in flight in the viewed session (query: sessionId?)',
    handler: async (c) => {
      const t = await resolveTarget(c, targetParam(c));
      const tools = t ? Array.from(t.state.activeTools.entries()).map(([id, tool]) => ({ id, ...tool })) : [];
      sendJSON(c.res, { success: true, data: tools });
    },
  });

  route({
    method: 'GET', path: API.session.models, template: `${API_PREFIX}/session/models`,
    role: 'chat', tag: 'Session', summary: 'Models available to the viewed session, scoped by settings; enabled models when no live process (query: sessionId?)',
    handler: async (c) => {
      const t = await resolveTarget(c, targetParam(c));
      let data: any[];
      if (t) {
        if (t.state.availableModels.length === 0) {
          try {
            const models = await t.rpc.getAvailableModels();
            t.state.availableModels = models.map((m: any) => ({
              provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined,
            }));
          } catch (err) {
            log.http.error('Failed to fetch models on demand:', err);
          }
        }
        // Active session: pi's models, scoped — current session model always shown.
        data = scopeModelsForSession(t.state.availableModels, t.state.sessionState.model);
      } else {
        // Idle session (lazy spawn): no pi process to ask — enabled models only.
        data = getEnabledModelEntries();
      }
      sendJSON(c.res, { success: true, data });
    },
  });

  route({
    method: 'PUT', path: API.session.model, template: `${API_PREFIX}/session/model`,
    role: 'chat', tag: 'Session', summary: 'Set the model of the viewed session (body: sessionId?, provider, modelId)',
    handler: async (c) => {
      try {
        const body = await readBody(c.req);
        const t = await resolveTarget(c, body.sessionId, true);
        if (!t) { sendTargetMissing(c); return; }
        const { provider, modelId } = body;
        if (!provider || !modelId) { sendJSON(c.res, { success: false, error: 'provider and modelId are required' }, 400); return; }
        const model = await t.rpc.setModel(provider, modelId);
        if (model) {
          t.state.sessionState.model = { provider: model.provider, id: model.id, name: model.name || model.id };
          t.broadcast({ type: 'status', data: { ...t.state.sessionState } });
        }
        sendJSON(c.res, { success: true });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to set model: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'PUT', path: API.session.name, template: `${API_PREFIX}/session/name`,
    role: 'chat', tag: 'Session', summary: 'Rename the viewed session (body: sessionId?, name)',
    handler: async (c) => {
      try {
        const body = await readBody(c.req);
        const t = await resolveTarget(c, body.sessionId);
        if (!t) { sendTargetMissing(c); return; }
        const { name } = body;
        if (typeof name !== 'string') { sendJSON(c.res, { success: false, error: 'name must be a string' }, 400); return; }
        const trimmed = name.trim();
        t.state.sessionState.sessionName = trimmed || null;
        t.broadcast({ type: 'status', data: { ...t.state.sessionState } });
        broadcastToUser(c.user, { type: 'sessions', data: pm.listSessions(c.user, c.viewed) });
        await t.rpc.setSessionName(trimmed);
        sendJSON(c.res, { success: true });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to set session name: ${err.statusCode ? err.message : err}` }, err.statusCode || 400);
      }
    },
  });

  route({
    method: 'PUT', path: API.session.persona, template: `${API_PREFIX}/session/persona`,
    role: 'chat', tag: 'Session', summary: 'Bind a persona to the viewed session (body: sessionId?, personaId — null clears)',
    handler: async (c) => {
      try {
        const body = await readBody(c.req);
        const t = await resolveTarget(c, body.sessionId);
        if (!t) { sendTargetMissing(c); return; }
        const { personaId } = body;
        let persona: Persona | null = null;
        if (personaId) {
          persona = listPersonas(c.user).find((p) => p.id === personaId) || null;
          if (!persona) { sendJSON(c.res, { success: false, error: 'Unknown persona' }, 400); return; }
        }
        if (!t.state.sessionState.sessionFile) {
          sendJSON(c.res, { success: false, error: 'No active session' }, 400);
          return;
        }
        setActivePersona(c.user, t.state.sessionState.sessionFile, persona);
        t.state.sessionState.persona = persona ? { id: persona.id, name: persona.name } : null;
        t.broadcast({ type: 'status', data: { ...t.state.sessionState } });
        sendJSON(c.res, { success: true, data: { persona: t.state.sessionState.persona } });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to set persona: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'POST', path: API.session.abort, template: `${API_PREFIX}/session/abort`,
    role: 'chat', tag: 'Session', summary: 'Abort the active turn in the viewed session (body/query: sessionId?)',
    handler: async (c) => {
      try {
        const body = await readBody(c.req);
        const t = await resolveTarget(c, targetParam(c, body));
        if (!t) { sendTargetMissing(c); return; }
        log.http.forSession(t.state.sessionState.sessionId).info('Abort requested');
        await t.rpc.abort();
        sendJSON(c.res, { success: true });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to abort: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'POST', path: API.session.restart, template: `${API_PREFIX}/session/restart`,
    role: 'chat', tag: 'Session', summary: 'Restart the viewed session pi process (body/query: sessionId?)',
    handler: async (c) => {
      try {
        const t = await resolveTarget(c, targetParam(c), true);
        if (!t) { sendTargetMissing(c); return; }
        const file = t.routedSessionFile();
        await pm.terminate(c.user, file);
        const fresh = await pm.getOrCreate(c.user, file);
        setClientSession(c.user, c.clientId, fresh.routedSessionFile());
        sendJSON(c.res, { success: true });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to restart pi process: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'POST', path: API.session.compact, template: `${API_PREFIX}/session/compact`,
    role: 'chat', tag: 'Session', summary: 'Start compaction of the viewed session; responds immediately — progress arrives via the event stream (body/query: sessionId?)',
    handler: async (c) => {
      const t = await resolveTarget(c, targetParam(c), true);
      if (!t) { sendTargetMissing(c); return; }
      const sessionState = t.state.sessionState;
      log.http.forSession(sessionState.sessionId).info('Compaction requested');
      if (sessionState.compacting) {
        sendJSON(c.res, { success: false, error: 'Compaction already in progress' }, 409);
        return;
      }
      // Respond immediately — compaction can take minutes and holding the
      // request open gets it killed by proxy timeouts (Apache etc.), making
      // the UI report "failed to compact" while compaction is merely slow.
      // pi's compaction_start/compaction_end events drive the UI state; a
      // genuine failure is surfaced via the SSE error event below.
      sendJSON(c.res, { success: true });
      sessionState.compactionAborted = false; // clear stale flag from any previous abort
      t.rpc.compact().catch((err) => {
        log.http.forSession(sessionState.sessionId).error('Compaction failed:', err);
        if (sessionState.compacting) {
          sessionState.compacting = false;
          sessionState.isStreaming = false;
          t.broadcast({ type: 'status', data: { ...sessionState } });
        }
        if (sessionState.compactionAborted) {
          // User-initiated abort — not an error. Shared per-session flag, so
          // no client on this session gets the error popup. Transient notice:
          // not persisted to pi's session file, gone after reload.
          sessionState.compactionAborted = false;
          t.broadcast({
            type: 'history_upsert',
            sessionId: sessionState.sessionId,
            data: [{ id: `sys-${Date.now()}`, role: 'system', text: 'Compaction aborted', streaming: false, timestamp: Date.now() }],
          });
        } else {
          t.broadcast({ type: 'error', data: { message: `Compaction failed: ${err}` } });
        }
      });
    },
  });

  route({
    method: 'DELETE', path: API.session.compact, template: `${API_PREFIX}/session/compact`,
    role: 'chat', tag: 'Session', summary: 'Abort an in-progress compaction (body/query: sessionId?)',
    handler: async (c) => {
      try {
        const body = await readBody(c.req);
        const t = await resolveTarget(c, targetParam(c, body));
        if (!t) { sendTargetMissing(c); return; }
        const sessionState = t.state.sessionState;
        log.http.forSession(sessionState.sessionId).info('Compaction abort requested');
        if (!sessionState.compacting || !sessionState.sessionFile) {
          sendJSON(c.res, { success: false, error: 'No compaction in progress' }, 409);
          return;
        }
        // pi exposes no RPC abort for compaction. switchSession to the SAME
        // file tears the session down (dispose() -> abortCompaction()) and
        // reloads it from disk — lossless, since no CompactionEntry is
        // written until compaction succeeds. Teardown discards queued
        // messages, so capture and re-queue them.
        // Flag BEFORE the switch: the in-flight compact() promise rejects
        // the moment teardown fires, racing this handler's remaining awaits.
        sessionState.compactionAborted = true;
        const cleared = await t.rpc.clearQueue();
        await t.rpc.switchSession(sessionState.sessionFile);
        for (const text of cleared.steering) await t.rpc.steer(text);
        for (const text of cleared.followUp) await t.rpc.followUp(text);
        sessionState.compacting = false;
        t.broadcast({ type: 'status', data: { ...sessionState } });
        sendJSON(c.res, { success: true });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to abort compaction: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'DELETE', path: API.session.pending, template: `${API_PREFIX}/session/pending`,
    role: 'chat', tag: 'Session', summary: 'Cancel a queued (steer/follow-up) message (body: sessionId?, text)',
    handler: async (c) => {
      try {
        const body = await readBody(c.req);
        const t = await resolveTarget(c, body.sessionId);
        if (!t) { sendTargetMissing(c); return; }
        const { text } = body;
        if (!text || typeof text !== 'string') {
          sendJSON(c.res, { success: false, error: 'text is required' }, 400);
          return;
        }
        const cancelled = await t.cancelPending(text.trim());
        if (!cancelled) { sendJSON(c.res, { success: false, error: 'No matching queued message' }, 404); return; }
        sendJSON(c.res, { success: true });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to cancel pending message: ${err.statusCode ? err.message : err}` }, err.statusCode || 400);
      }
    },
  });

  // ── Send a message to the viewed session ──
  route({
    method: 'POST', path: API.session.messages, template: `${API_PREFIX}/session/messages`,
    role: 'chat', tag: 'Session', summary: 'Send a message (prompt, steer or follow-up) to the viewed session; optionally with base64 image attachments (body: sessionId?, message?, type? prompt|steer|followUp, images?[{mimeType,data}])',
    handler: async (c) => {
      const body = await readBody(c.req);
      const t = await resolveTarget(c, body.sessionId, true);
      if (!t) { sendTargetMissing(c); return; }
      const sessionState = t.state.sessionState;
      const { message, type, images } = body;
      if ((!message || typeof message !== 'string' || !message.trim()) && !(Array.isArray(images) && images.length > 0)) {
        sendJSON(c.res, { success: false, error: 'Message is required' }, 400);
        return;
      }
      // Image attachments (base64, pi ImageContent format)
      let rpcImages: import('./rpc-client.js').RpcImage[] | undefined;
      if (images !== undefined) {
        if (!Array.isArray(images) || images.length > MAX_ATTACHED_IMAGES) {
          sendJSON(c.res, { success: false, error: `images must be an array of at most ${MAX_ATTACHED_IMAGES} items` }, 400);
          return;
        }
        rpcImages = [];
        for (const img of images) {
          const mime = typeof img?.mimeType === 'string' ? img.mimeType : '';
          const data = typeof img?.data === 'string' ? img.data : '';
          // Accept data: URLs too — strip the prefix
          const raw = data.startsWith('data:') ? data.replace(/^data:[^;]+;base64,/, '') : data;
          if (!mime.startsWith('image/')) {
            sendJSON(c.res, { success: false, error: 'Only image attachments are supported' }, 400);
            return;
          }
          if (!raw || Buffer.from(raw, 'base64').length === 0) {
            sendJSON(c.res, { success: false, error: 'Invalid image data' }, 400);
            return;
          }
          if (Buffer.from(raw, 'base64').length > MAX_IMAGE_BYTES) {
            sendJSON(c.res, { success: false, error: 'Image too large (max 8 MB)' }, 400);
            return;
          }
          rpcImages.push({ type: 'image', data: raw, mimeType: mime });
        }
        if (rpcImages.length === 0) rpcImages = undefined;
      }
      let text = (message || '').trim();
      log.http.forSession(sessionState.sessionId).info(
        `${type || 'prompt'}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"${rpcImages?.length ? ` [${rpcImages.length} image(s)]` : ''}`);
      const queued = type === 'steer' || type === 'followUp' || t.rpc.isStreaming;
      // pi only runs extension input hooks on the prompt() path — steer/
      // followUp bypass them, so queued messages with images must get the
      // same attachment intake here (save to uploads + path note) that
      // pi-filetools provides for prompts.
      if (queued && rpcImages && rpcImages.length > 0) {
        const sendPreviews = getSendImagesToChatModel(c.user);
        const preset = getImagePreviewQuality(c.user);
        try {
          const uploadsDir = join(t.getEnvDir(), 'uploads');
          mkdirSync(uploadsDir, { recursive: true });
          const stamp = Date.now();
          const paths: string[] = [];
          const previews: import('./rpc-client.js').RpcImage[] = [];
          for (const [i, img] of rpcImages.entries()) {
            const ext = (img.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
            const file = join(uploadsDir, `upload-${stamp}-${i + 1}.${ext}`);
            writeFileSync(file, Buffer.from(img.data, 'base64'));
            paths.push(file);
            // Publish under the hist-* name the images route serves, and push
            // an image entry so the attachment still renders in chat.
            const name = `hist-${createHash('sha1').update(img.data).digest('hex').slice(0, 16)}.${ext}`;
            const histFile = join(uploadsDir, name);
            if (!existsSync(histFile)) writeFileSync(histFile, Buffer.from(img.data, 'base64'));
            t.pushImageEntry(name, img.mimeType);
            // Downscaled preview for the LLM (full res stays on disk)
            if (sendPreviews) {
              try {
                if (preset === 'full') previews.push(img);
                else {
                  const { resizeImage } = await import('@earendil-works/pi-coding-agent');
                  const r = await resizeImage(Buffer.from(img.data, 'base64'), img.mimeType, preset);
                  previews.push(r ? { type: 'image', mimeType: r.mimeType, data: r.data } : img);
                }
              } catch (e: any) {
                log.http.error('preview resize failed:', e?.message || e);
                previews.push(img);
              }
            }
          }
          text += `\n\n[Attached file${paths.length > 1 ? 's' : ''} saved to:\n${paths.join('\n')}\n${sendPreviews ? 'Full-resolution originals are at these paths — use them with tools (read, bash, edit_image, …). The image(s) shown to you here are downscaled previews.' : 'Use these paths directly with tools (read, bash, edit_image, …) instead of searching for the attachment. Images are not shown inline.'}]`;
          rpcImages = sendPreviews ? previews : undefined;
        } catch (err: any) {
          log.http.error('Failed to save queued image attachments:', err?.message || err);
        }
      }
      if (type === 'steer') {
        await t.rpc.steer(text);
      } else if (type === 'followUp') {
        await t.rpc.followUp(text);
      } else if (t.rpc.isStreaming) {
        await t.rpc.steer(text);
      } else {
        await t.rpc.prompt(text);
      }
      // Commit the user message into the stream history immediately —
      // retires the client's optimistic pending copy (pi never emits
      // message_end for user messages).
      t.addUserEntry(text, queued);
      sendJSON(c.res, { success: true });
    },
  });

  // ── Extensions ──
  route({
    method: 'GET', path: API.extensions.root, template: `${API_PREFIX}/extensions`,
    role: 'chat', tag: 'Extensions', summary: 'Discovered pi extensions with per-user sections/status',
    handler: async (c) => {
      // Dedup/janitor stats are per-user (each pi env has its own counters)
      // and are injected per request — global state must never carry them, or
      // any logged-in user could read other users' (user)names and counts.
      const data = extensionsState.map((e) => {
        if (e.name === 'pi-dedup') {
          const patched = withDedupSections(e, c.user);
          return { ...e, sections: patched.sections, status: patched.status, statusText: patched.statusText };
        }
        if (e.name === 'pi-janitor') {
          const patched = withJanitorSections(e, c.user);
          return { ...e, sections: patched.sections, status: patched.status, statusText: patched.statusText };
        }
        return e;
      });
      sendJSON(c.res, { success: true, data });
    },
  });

  route({
    method: 'GET', path: API.extensions.packages, template: `${API_PREFIX}/extensions/packages`,
    role: 'chat', tag: 'Extensions', summary: 'Installable extension packages and the caller enabled set',
    handler: async (c) => {
      sendJSON(c.res, {
        success: true,
        data: {
          available: getAvailablePackages(),
          enabled: getEnabledPackages(c.user),
        },
      });
    },
  });

  // ── Personas (library CRUD + LLM-assisted prompt generation) ──
  route({
    method: 'GET', path: API.personas.root, template: `${API_PREFIX}/personas`,
    role: 'chat', tag: 'Personas', summary: 'List the caller persona library',
    handler: async (c) => sendJSON(c.res, { success: true, data: listPersonas(c.user) }),
  });

  route({
    method: 'POST', path: API.personas.root, template: `${API_PREFIX}/personas`,
    role: 'control', tag: 'Personas', summary: 'Create a persona (body: name, prompt, description?)', status: 201,
    handler: async (c) => {
      try {
        const input = await readBody(c.req);
        const validationError = validatePersona(input);
        if (validationError) { sendJSON(c.res, { success: false, error: validationError }, 400); return; }
        const saved: Persona = {
          id: randomUUID(),
          name: input.name.trim(),
          description: typeof input.description === 'string' ? input.description.trim() : '',
          prompt: input.prompt.trim(),
        };
        const personas = listPersonas(c.user);
        personas.push(saved);
        savePersonas(c.user, personas);
        sendJSON(c.res, { success: true, data: saved }, 201);
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to save persona: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'PUT', path: RE.personasItem, template: `${API_PREFIX}/personas/{id}`,
    role: 'control', tag: 'Personas', summary: 'Replace a persona (body: name, prompt, description?)',
    handler: async (c, m) => {
      try {
        const id = m![1];
        const input = await readBody(c.req);
        const validationError = validatePersona(input);
        if (validationError) { sendJSON(c.res, { success: false, error: validationError }, 400); return; }
        const personas = listPersonas(c.user);
        const idx = personas.findIndex((p) => p.id === id);
        if (idx < 0) { sendJSON(c.res, { success: false, error: 'Persona not found' }, 404); return; }
        const saved: Persona = {
          id,
          name: input.name.trim(),
          description: typeof input.description === 'string' ? input.description.trim() : '',
          prompt: input.prompt.trim(),
        };
        personas[idx] = saved;
        savePersonas(c.user, personas);
        sendJSON(c.res, { success: true, data: saved });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to save persona: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'DELETE', path: RE.personasItem, template: `${API_PREFIX}/personas/{id}`,
    role: 'control', tag: 'Personas', summary: 'Delete a persona',
    handler: async (c, m) => {
      try {
        const personas = listPersonas(c.user);
        const next = personas.filter((p) => p.id !== m![1]);
        if (next.length === personas.length) { sendJSON(c.res, { success: false, error: 'Persona not found' }, 404); return; }
        savePersonas(c.user, next);
        sendJSON(c.res, { success: true });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to delete persona: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  // Generate a persona prompt from the user's notes using the CURRENT
  // session's model via 9router (OpenAI-compatible chat completions).
  route({
    method: 'POST', path: API.personas.generate, template: `${API_PREFIX}/personas/generate`,
    role: 'control', tag: 'Personas', summary: 'Generate a persona prompt from notes with the viewed session model (body: text, sessionId?)',
    handler: async (c) => {
      try {
        const body = await readBody(c.req);
        const { text } = body;
        if (!text || typeof text !== 'string' || !text.trim()) {
          sendJSON(c.res, { success: false, error: 'text is required' }, 400);
          return;
        }
        const model = (await resolveTarget(c, body.sessionId))?.state.sessionState.model?.id;
        if (!model) {
          sendJSON(c.res, { success: false, error: 'No model selected' }, 400);
          return;
        }
        // Per-user env config first (the settings UI writes there), master as fallback
        let routerConfig = getRouterConfig();
        try {
          const envConfig = JSON.parse(readFileSync(join(getPiEnvDir(c.user), '9router-config.json'), 'utf-8'));
          if (envConfig?.baseUrl) {
            routerConfig = { baseUrl: String(envConfig.baseUrl).replace(/\/+$/, ''), apiKey: String(envConfig.apiKey || '') };
          }
        } catch {}
        if (!routerConfig.baseUrl) {
          sendJSON(c.res, { success: false, error: 'No model router configured' }, 400);
          return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        try {
          const llmRes = await fetch(`${routerConfig.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(routerConfig.apiKey ? { Authorization: `Bearer ${routerConfig.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              messages: [{
                role: 'user',
                content: `Turn the notes below into a persona system prompt for an AI coding agent: a clear, self-contained, imperative description of the agent's role, tone and behavior. Output ONLY the persona prompt text — no commentary, no markdown fences.\n\nNotes:\n${text.trim()}`,
              }],
            }),
            signal: controller.signal,
          });
          if (!llmRes.ok) throw new Error(`HTTP ${llmRes.status}`);
          // 9router may return SSE-flavored bodies even without stream:true —
          // a plain JSON object followed by "data: [DONE]", padding whitespace,
          // or real SSE data chunks. Parse leniently: exact JSON, then SSE
          // chunks, then the largest {...} region.
          const raw = await llmRes.text();
          const contentFrom = (obj: any) => obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.message?.content;
          let content: any = null;
          try {
            content = contentFrom(JSON.parse(raw.trim()));
          } catch {
            for (const line of raw.split('\n')) {
              const t = line.trim();
              if (!t.startsWith('data:') || t === 'data: [DONE]') continue;
              try {
                const piece = contentFrom(JSON.parse(t.slice(5).trim()));
                if (typeof piece === 'string') content = (content || '') + piece;
              } catch { /* skip unparseable chunk */ }
            }
            if (!content) {
              const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
              if (s >= 0 && e > s) content = contentFrom(JSON.parse(raw.slice(s, e + 1)));
            }
          }
          const prompt = typeof content === 'string' ? content.trim() : '';
          if (!prompt) throw new Error('Empty response from model');
          sendJSON(c.res, { success: true, data: { prompt } });
        } finally {
          clearTimeout(timeout);
        }
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to generate persona prompt: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  // ── User settings ──
  route({
    method: 'GET', path: API.settings.schema, template: `${API_PREFIX}/settings/schema`,
    role: 'chat', tag: 'Settings', summary: 'Settings schema (sections, fields, option values)',
    handler: async (c) => {
      const schema = await getUserSettingsSchema(c.user);
      sendJSON(c.res, { success: true, data: schema });
    },
  });

  route({
    method: 'GET', path: API.settings.root, template: `${API_PREFIX}/settings`,
    role: 'chat', tag: 'Settings', summary: 'Read the caller settings',
    handler: async (c) => {
      sendJSON(c.res, { success: true, data: getAllUserSettings(c.user) });
    },
  });

  route({
    method: 'PUT', path: API.settings.root, template: `${API_PREFIX}/settings`,
    role: 'control', tag: 'Settings', summary: 'Replace the caller settings (body: settings object); responds { deferred } when a session restart is queued behind an active turn',
    handler: async (c) => {
      try {
        const settings = await readBody(c.req);
        if (!settings || typeof settings !== 'object') {
          sendJSON(c.res, { success: false, error: 'Settings must be an object' }, 400);
          return;
        }
        const prev = getAllUserSettings(c.user);
        // Changing the sandbox image is only useful if it can actually
        // run pi — validate before saving (docker may pull, so this can
        // take a while the first time).
        if (settings.piSandboxImage !== undefined && String(settings.piSandboxImage).trim() !== prev.piSandboxImage) {
          const image = String(settings.piSandboxImage).trim();
          if (/^(off|none|disabled)$/i.test(image) && !isRegisteredUser(c.user) && getUserRole(c.user) !== 'admin') {
            sendJSON(c.res, { success: false, error: 'Disabling the sandbox is admin-only' }, 400);
            return;
          }
          if (image && !/^(off|none|disabled)$/i.test(image)) {
            const err = await validateSandboxImage(image);
            if (err) { sendJSON(c.res, { success: false, error: err }, 400); return; }
          }
        }
        saveUserSettings(c.user, settings);
        // Reserve-% and janitor sweep policy are applied live by their pi
        // extensions (mtime-cached config reads, per model/call — no
        // restart needed) — skip the restart when only those change, so
        // the running session is not interrupted.
        const onlyLiveApplyKeys = Object.keys(settings).every(
          (k) => k === 'reserveTokensPercent' || k === 'reserveTokensPercentByModel' || k.startsWith('janitor') || prev[k] === (settings as any)[k]
        );
        if (onlyLiveApplyKeys) {
          sendJSON(c.res, { success: true });
          return;
        }
        // Other settings need a pi process restart to take effect — never
        // kill an active turn: streaming processes get a deferred restart
        // applied at their own turn end, idle ones restart immediately.
        let deferred = false;
        for (const s of pm.allSessions()) {
          if (s.user !== c.user) continue;
          if (s.state.sessionState.isStreaming || s.state.sessionState.compacting) { deferred = true; continue; }
          const f = s.routedSessionFile();
          try { await pm.terminate(c.user, f); await pm.getOrCreate(c.user, f); } catch (err) {
            log.http.error(`Settings restart failed for a session process: ${err}`);
          }
        }
        if (deferred) pm.queueRestart(c.user);
        sendJSON(c.res, { success: true, deferred });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to save settings: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  // ── Scheduled tasks ──
  route({
    method: 'GET', path: API.scheduler.tasks, template: `${API_PREFIX}/scheduler/tasks`,
    role: 'chat', tag: 'Scheduler', summary: 'List tasks and the 50 most recent runs',
    handler: async (c) => {
      sendJSON(c.res, { success: true, data: { tasks: listTasks(c.user), runs: listRuns(c.user, undefined, 50) } });
    },
  });

  route({
    method: 'POST', path: API.scheduler.tasks, template: `${API_PREFIX}/scheduler/tasks`,
    role: 'control', tag: 'Scheduler', summary: 'Create a scheduled task', status: 201,
    handler: async (c) => {
      try {
        const input = await readBody(c.req);
        const err = validateTaskInput(input);
        if (err) { sendJSON(c.res, { success: false, error: err }, 400); return; }
        const now = Date.now();
        const task: ScheduledTask = {
          id: randomUUID(),
          name: input.name.trim(),
          schedule: input.schedule.trim(),
          prompt: input.prompt,
          model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined,
          seedScript: typeof input.seedScript === 'string' && input.seedScript.trim() ? input.seedScript : undefined,
          resultScript: typeof input.resultScript === 'string' && input.resultScript.trim() ? input.resultScript : undefined,
          enabled: input.enabled !== false,
          createdAt: now,
          updatedAt: now,
        };
        saveTask(c.user, task);
        sendJSON(c.res, { success: true, data: task }, 201);
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to create task: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'PUT', path: RE.schedulerTask, template: `${API_PREFIX}/scheduler/tasks/{id}`,
    role: 'control', tag: 'Scheduler', summary: 'Replace a scheduled task',
    handler: async (c, m) => {
      try {
        const existing = getTask(c.user, m![1]);
        if (!existing) { sendJSON(c.res, { success: false, error: 'Task not found' }, 404); return; }
        const input = await readBody(c.req);
        const err = validateTaskInput(input);
        if (err) { sendJSON(c.res, { success: false, error: err }, 400); return; }
        const updated: ScheduledTask = {
          ...existing,
          name: input.name.trim(),
          schedule: input.schedule.trim(),
          prompt: input.prompt,
          model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined,
          seedScript: typeof input.seedScript === 'string' && input.seedScript.trim() ? input.seedScript : undefined,
          resultScript: typeof input.resultScript === 'string' && input.resultScript.trim() ? input.resultScript : undefined,
          enabled: input.enabled !== false,
          updatedAt: Date.now(),
        };
        saveTask(c.user, updated);
        sendJSON(c.res, { success: true, data: updated });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to update task: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'DELETE', path: RE.schedulerTask, template: `${API_PREFIX}/scheduler/tasks/{id}`,
    role: 'control', tag: 'Scheduler', summary: 'Delete a scheduled task',
    handler: async (c, m) => {
      try {
        const deleted = deleteTask(c.user, m![1]);
        if (!deleted) { sendJSON(c.res, { success: false, error: 'Task not found' }, 404); return; }
        sendJSON(c.res, { success: true });
      } catch (err: any) {
        sendJSON(c.res, { success: false, error: `Failed to delete task: ${err.statusCode ? err.message : err}` }, err.statusCode || 500);
      }
    },
  });

  route({
    method: 'POST', path: RE.schedulerTaskRun, template: `${API_PREFIX}/scheduler/tasks/{id}/run`,
    role: 'control', tag: 'Scheduler', summary: 'Trigger a task run now (202; 409 when already running)',
    handler: async (c, m) => {
      if (!scheduler) { sendJSON(c.res, { success: false, error: 'Scheduler not available' }, 503); return; }
      try {
        const runId = await scheduler.runNow(c.user, m![1]);
        sendJSON(c.res, { success: true, data: { runId } }, 202);
      } catch (err: any) {
        const alreadyRunning = /already running/.test(err?.message || '');
        sendJSON(c.res, { success: false, error: `Failed to run task: ${err}` }, alreadyRunning ? 409 : 404);
      }
    },
  });

  route({
    method: 'GET', path: API.scheduler.runs, template: `${API_PREFIX}/scheduler/runs`,
    role: 'chat', tag: 'Scheduler', summary: 'List task runs (query: taskId?, limit? ≤ 200 default 50)',
    handler: async (c) => {
      const taskId = c.url.searchParams.get('taskId') || undefined;
      const limit = Math.min(parseInt(c.url.searchParams.get('limit') || '50', 10) || 50, 200);
      sendJSON(c.res, { success: true, data: listRuns(c.user, taskId, limit) });
    },
  });

  route({
    method: 'GET', path: RE.schedulerRunLog, template: `${API_PREFIX}/scheduler/runs/{taskId}/{runId}`,
    role: 'chat', tag: 'Scheduler', summary: 'Log of one task run',
    handler: async (c, m) => {
      const entry = readRunLog(c.user, m![1], m![2]);
      if (!entry) { sendJSON(c.res, { success: false, error: 'Run log not found' }, 404); return; }
      sendJSON(c.res, { success: true, data: entry });
    },
  });

  // ── Serve images extracted from stream history (auth-scoped to the
  // requesting user's own pi env; name is a server-generated hash). ──
  route({
    method: 'GET', path: RE.image, template: `${API_PREFIX}/images/{name}`,
    role: 'chat', tag: 'Session', summary: 'An image attachment from stream history (name: hist-<hash>.<ext>)',
    handler: async (c, m) => {
      const name = m![1];
      if (!/^hist-[a-f0-9]{16}\.[a-z0-9]{2,5}$/.test(name)) {
        sendJSON(c.res, { success: false, error: 'Bad image name' }, 400);
        return;
      }
      const file = join(getPiEnvDir(c.user), 'uploads', name);
      if (!existsSync(file)) { sendJSON(c.res, { success: false, error: 'Not found' }, 404); return; }
      const ext = name.split('.').pop() || 'png';
      c.res.writeHead(200, { 'Content-Type': IMAGE_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
      c.res.end(readFileSync(file));
    },
  });

  // ── Serve files shared via pi-filetools' save_file tool (auth-scoped
  // to the requesting user's own pi env; server-generated hash name). ──
  route({
    method: 'GET', path: RE.file, template: `${API_PREFIX}/files/{name}`,
    role: 'chat', tag: 'Session', summary: 'A file shared by the agent (name: file-<hash>-<orig>, served as attachment)',
    handler: async (c, m) => {
      const name = decodeURIComponent(m![1]);
      if (!/^file-[a-f0-9]{16}-[A-Za-z0-9._-]{1,80}$/.test(name)) {
        sendJSON(c.res, { success: false, error: 'Bad file name' }, 400);
        return;
      }
      const file = join(getPiEnvDir(c.user), 'uploads', name);
      if (!existsSync(file)) { sendJSON(c.res, { success: false, error: 'Not found' }, 404); return; }
      const origName = name.slice('file-'.length + 16 + 1);
      c.res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': statSync(file).size,
        'Content-Disposition': `attachment; filename="${origName.replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      c.res.end(readFileSync(file));
    },
  });

  // ── Event stream (SSE) ──
  routes.push({
    method: 'GET', path: API.events, template: `${API_PREFIX}/events`,
    role: 'chat', tag: 'Events', summary: 'Live event stream (SSE) for the viewed session',
    handler: async (c) => {
      // Reuse the client's id (query param, header, or cookie) so a PWA
      // reconnect keeps its identity and hub binding.
      const clientId = c.url.searchParams.get('clientId')
        || c.clientId
        || `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Set clientId as a cookie so subsequent HTTP requests can identify
      // which SSE connection they belong to. The frontend never sees this.
      c.res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        // Behind reverse proxies: without this nginx buffers the stream, and
        // small stream_delta frames sit in its buffer for seconds (streaming
        // appears frozen until a large event flushes it).
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
        'Set-Cookie': `autere-client-id=${clientId}; Path=/; SameSite=Lax`,
      });
      // Register with the user's client hub: events for whichever session
      // this client views (bound by bootstrap/activate) are routed here.
      registerClient(c.user, clientId, c.res);

      // SSE carries LIVE events only — no connect-time replays. The client
      // fetches everything it needs once via GET /bootstrap at (re)load
      // time (and on SSE reconnect). Heartbeats keep the stream alive.
    },
  });

  // ── Request dispatch ──

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // CORS for API clients (scripts, TUI on another origin)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Autere-Client-Id');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ── Base path (reverse-proxy prefix) detection/stripping ──
      let basePath = detectBasePath(req);
      let requestPath = req.url || '/';
      if (!basePath) basePath = detectBasePathFromURL(requestPath);
      if (basePath && requestPath.startsWith(basePath)) {
        requestPath = requestPath.slice(basePath.length) || '/';
        req.url = requestPath;
      }
      const url = new URL(requestPath, `http://localhost:${PORT}`);

      // ── Static files (no auth required) ──
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(getDashboardHTML(basePath));
        return;
      }
      if (!url.pathname.startsWith(`${API_PREFIX}/`) && !url.pathname.includes('..')) {
        let staticPath = join(__dirname, '..', '..', 'dist', url.pathname);
        if (!existsSync(staticPath)) staticPath = join(__dirname, '..', '..', 'public', url.pathname);
        if (existsSync(staticPath)) {
          const ext = staticPath.split('.').pop();
          // Vite bundles live under /assets/ with content-hashed filenames —
          // safe to cache forever. Everything else (index.html, sw.js,
          // logo, manifest) must revalidate so deploys are picked up.
          const cacheControl = url.pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache, no-store, must-revalidate';
          res.writeHead(200, { 'Content-Type': STATIC_MIME[ext || ''] || 'application/octet-stream', 'Cache-Control': cacheControl });
          res.end(readFileSync(staticPath));
          return;
        }
        // SPA fallback: the dashboard serves unknown non-API paths
        if (!url.pathname.startsWith('/api/')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
          res.end(getDashboardHTML(basePath));
          return;
        }
      }

      // ── Unauthenticated routes ──
      const pub = matchRoute(publicRoutes, req.method || 'GET', url.pathname);
      if (pub) {
        await runHandler(pub.route, pub.match, {
          req, res, url, user: '', token: '', clientId: null, session: undefined, viewed: new Set(),
        });
        return;
      }

      // ── Authentication ──
      if (requireAuth(req, res)) return;
      const token = getTokenFromRequest(req);
      const user = getUser(req);
      if (!token || !user) {
        sendJSON(res, { success: false, error: 'No user' }, 401);
        return;
      }
      const clientId = getClientId(req);

      // ── Forced password change: block everything but logout and
      // change-password until the user picks a new password (first login /
      // admin reset). ──
      if (getAuthEnabled() && userMustChangePassword(user)) {
        const path = url.pathname;
        const isChange = req.method === 'POST' && path === API.auth.changePassword;
        const isLogout = req.method === 'POST' && path === API.auth.logout;
        if (!isChange && !isLogout) {
          sendJSON(res, { success: false, error: 'Password change required', mustChangePassword: true }, 403);
          return;
        }
      }

      // ── Route match + role check ──
      const match = matchRoute(routes, req.method || 'GET', url.pathname);
      if (!match) {
        const allowed = allowedMethods(routes, url.pathname);
        if (allowed.length > 0) {
          res.writeHead(405, { 'Allow': allowed.join(', '), 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Method ${req.method} not allowed` }));
          return;
        }
        sendJSON(res, { success: false, error: 'Not found' }, 404);
        return;
      }
      if (!hasRole(user, match.route.role)) {
        sendJSON(res, { success: false, error: `Requires ${match.route.role} role` }, 403);
        return;
      }

      // ── Per-client session binding: one client (autere-client-id cookie)
      // views one pi session at a time; its API calls and SSE events route
      // to THAT session's process. Binding alone never spawns pi — an idle
      // session is a disk entry until something needs the process. ──
      const boundFile = getClientSession(user, clientId);
      const session = boundFile ? pm.get(user, boundFile) : undefined;
      const viewed = viewedSessions(user);

      await runHandler(match.route, match.match, { req, res, url, user, token, clientId, session, viewed });
    } catch (err: any) {
      // A handler must never crash the server — log and answer 500.
      log.http.error(`Request handler error: ${err?.stack || err}`);
      try {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Internal error: ${err?.message || err}` }));
      } catch {}
    }
  });

  // ── Periodic polling for extensions and sessions ──
  readExtensions();
  sessionRefreshInterval = setInterval(async () => {
    const prevExt = JSON.stringify(extensionsState);
    await readExtensions();
    if (JSON.stringify(extensionsState) !== prevExt) {
      // Push the updated extension list to every running process's state
      // and broadcast to all connected clients of all users.
      for (const session of pm.allSessions()) {
        session.state.extensionsState = [...extensionsState];
      }
      for (const u of hubUsers()) {
        broadcastToUser(u, { type: 'extensions', data: extensionsState });
      }
    }
    // Per-user session refresh, with live active/streaming flags. File-less
    // brand-new sessions stay listable (pi only writes the file on the first
    // message) while their process runs or a client views them, so a
    // subsequent activation doesn't 404 with "Session not found".
    for (const u of hubUsers()) {
      broadcastToUser(u, { type: 'sessions', data: pm.listSessions(u, viewedSessions(u)) });
    }
  }, 2000);

  // ── Heartbeat ──
  const heartbeatInterval = setInterval(() => {
    for (const u of hubUsers()) {
      broadcastToUser(u, { type: 'heartbeat', data: { ts: Date.now() } });
    }
  }, 3000);

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      log.http.error(`Port ${PORT} is already in use — exiting.`);
      process.exit(1);
    } else {
      log.http.error('Server error:', err);
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    log.http.info(`Dashboard running at http://localhost:${PORT}`);
  });

  process.on('SIGTERM', () => shutdown(server, pm, sessionRefreshInterval, heartbeatInterval, scheduler));
  process.on('SIGINT', () => shutdown(server, pm, sessionRefreshInterval, heartbeatInterval, scheduler));

  return server;
}

function shutdown(server: ReturnType<typeof createServer> | null, pm: ProcessManager, sessionRefreshInterval: ReturnType<typeof setInterval> | null, heartbeatInterval: ReturnType<typeof setInterval> | null, scheduler?: Scheduler) {
  if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (scheduler) scheduler.stop();
  if (server) server.close();
  pm.terminateAll().catch(() => {});
}
