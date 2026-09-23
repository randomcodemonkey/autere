/**
 * HTTP server and API routes for autere dashboard.
 *
 * All pi operations are performed via RPC commands to per-user pi processes.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { ProcessManager } from './process-manager.js';
import { getUser, getUserRole, hasRole, requiredRole, verifyCredentials, checkAuth, requireAuth, parseCookies, generateToken, addAuthToken, removeAuthToken, removeUserTokens, saveAuthTokens, getAuthEnabled, getAuthTokenExpiry, getTokenFromRequest, setLastSession, getLastSession, isRegisteredUser, userMustChangePassword } from './auth.js';
import { getClientSession, setClientSession, registerClient, broadcastToUser, viewedSessions, hubUsers } from './client-hub.js';
import { listUsers, createUser, updateUser, deleteUser, changeOwnPassword } from './users.js';
import { withDedupSections, withJanitorSections } from './extension-handlers.js';
import { readExtensions } from './extensions.js';
import { sendJSON, getDashboardHTML, readSessionHistory, filterScopedModels } from './utils.js';
import { getScopedModelCatalog } from './model-catalog.js';
import { getPiEnvDir } from './pi-env.js';
import { listPersonas, savePersonas, validatePersona, setActivePersona, getActivePersona, type Persona } from './personas.js';
import { readMessageEntries } from './stream-history.js';
import { getHistoryLimit } from './user-settings.js';
import { getRouterConfig } from './image-models.js';
import { extensionsState } from './state.js';
import { pathIsIgnored } from '../shared/edit-ignore.js';
import { userFileRoots, browseList, browseRead, browseWrite, browseDelete, type BrowseResult } from './files.js';
import { log } from './logger.js';
import type { SessionInfo } from './types.js';

// Serialize the in-flight tool executions pi is currently running. Sent
// with history responses so a client joining mid-turn (e.g. opening the
// session in a new browser) sees the active tools immediately instead of
// waiting for the next tool_start event.
function activeToolsSnapshot(session: { state: { activeTools: Map<string, any> } }) {
  const out: Array<{ id: string; name: string; cmd: string; args: any; startTime: number }> = [];
  for (const [id, t] of session.state.activeTools) {
    out.push({ id, name: t.name, cmd: t.cmd, args: t.args || {}, startTime: t.startTime });
  }
  return out;
}

import { getAllUserSettings, saveUserSettings, setUserSetting, getUserSettingsSchema, getAvailablePackages, getEnabledPackages, getSendImagesToChatModel, getImagePreviewQuality, getEditIgnorePaths } from './user-settings.js';
import {
  Scheduler,
  listTasks, getTask, saveTask, deleteTask, validateTaskInput,
  listRuns, readRunLog,
  type ScheduledTask,
} from './scheduler.js';
import { randomUUID, createHash } from 'crypto';

// ── Image attachment limits (/api/send) ──
const MAX_ATTACHED_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per image (decoded)

/** Read and parse a JSON request body */
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Base path detection ──


// ── Client identity: each browser tab sends a stable id (header on API
// calls, query param on SSE) — routing to that tab's viewed session. ──
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
  const match = requestPath.match(/^(.+)\/(?:api\/|events)/);
  if (match && match[1]) return match[1];
  return '';
}

// ── HTTP server setup ──

export function createMonitorServer(PORT: number, pm: ProcessManager, scheduler?: Scheduler, provider?: string): ReturnType<typeof createServer> | null {
  let sessionRefreshInterval: ReturnType<typeof setInterval> | null = null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Detect base path ──
    let basePath = detectBasePath(req);
    let requestPath = req.url || '/';
    if (!basePath) basePath = detectBasePathFromURL(requestPath);
    if (basePath && requestPath.startsWith(basePath)) {
      requestPath = requestPath.slice(basePath.length) || '/';
      req.url = requestPath;
    }
    const url = new URL(requestPath, `http://localhost:${PORT}`);

    // ── Auth endpoints (no auth required) ──

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        (async () => {
          const { user, password } = await readBody(req);
          if (!getAuthEnabled()) {
            sendJSON(res, { success: true, message: 'Authentication disabled' });
            return;
          }
          if (!user || typeof user !== 'string') {
            sendJSON(res, { success: false, error: 'User is required' }, 400);
            return;
          }
          if (!isRegisteredUser(user)) {
            sendJSON(res, { success: false, error: 'Invalid user' }, 401);
            return;
          }
          if (!verifyCredentials(user, password)) {
            sendJSON(res, { success: false, error: 'Invalid password' }, 401);
            return;
          }
          const token = generateToken();
          addAuthToken(token, user);
          saveAuthTokens();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `autere-token=${token}; Path=${basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(getAuthTokenExpiry() / 1000)}`
          });
          res.end(JSON.stringify({ success: true, mustChangePassword: userMustChangePassword(user) }));
        })().catch((err) => {
          sendJSON(res, { success: false, error: `Invalid login request: ${err}` }, 400);
        });
      } catch (err) {
        sendJSON(res, { success: false, error: `Invalid login request: ${err}` }, 400);
      }
      return;
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const cookies = parseCookies(req.headers.cookie || '');
      if (cookies['autere-token']) {
        removeAuthToken(cookies['autere-token']);
        saveAuthTokens();
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `autere-token=; Path=${basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=0`
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (url.pathname === '/api/auth/status') {
      const user = getUser(req);
      sendJSON(res, { success: true, data: { authEnabled: getAuthEnabled(), authenticated: checkAuth(req), user, role: user ? getUserRole(user) : null, mustChangePassword: user && getAuthEnabled() ? userMustChangePassword(user) : false } });
      return;
    }

    // ── Static files (no auth required) ──

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(getDashboardHTML(basePath));
      return;
    }

    if (url.pathname.startsWith('/') && !url.pathname.includes('..')) {
      let staticPath = join(__dirname, '..', '..', 'dist', url.pathname);
      if (!existsSync(staticPath)) staticPath = join(__dirname, '..', '..', 'public', url.pathname);
      if (existsSync(staticPath)) {
        const ext = staticPath.split('.').pop();
        const mime: Record<string, string> = { js: 'application/javascript', css: 'text/css', json: 'application/json', png: 'image/png', svg: 'image/svg+xml' };
        // Vite bundles live under /assets/ with content-hashed filenames —
        // safe to cache forever. Everything else (index.html, sw.js,
        // logo, manifest) must revalidate so deploys are picked up.
        const cacheControl = url.pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache, no-store, must-revalidate';
        res.writeHead(200, { 'Content-Type': mime[ext || ''] || 'application/octet-stream', 'Cache-Control': cacheControl });
        res.end(readFileSync(staticPath));
        return;
      }
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/events') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(getDashboardHTML(basePath));
        return;
      }
    }

    // ── Require auth for all API / SSE endpoints ──
    if (requireAuth(req, res)) return;

    // ── Get token and their session ──
    const token = getTokenFromRequest(req);
    const user = getUser(req);
    if (!token || !user) {
      sendJSON(res, { success: false, error: 'No user' }, 401);
      return;
    }

    // ── Client identity: one browser connection = autere-client-id cookie ──
    const clientId = getClientId(req);

    // ── Change own password (any authenticated user; needs no pi session) ──
    if (url.pathname === '/api/auth/change-password' && req.method === 'POST') {
      try {
        const { oldPassword, newPassword } = await readBody(req);
        const err = changeOwnPassword(user, String(oldPassword ?? ''), String(newPassword ?? ''));
        if (err) {
          sendJSON(res, { success: false, error: err }, 400);
          return;
        }
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to change password: ${err}` }, 400);
      }
      return;
    }

    // ── Role-based authorization (chat < control < admin) ──
    const neededRole = requiredRole(req.method || 'GET', url.pathname);
    if (!hasRole(user, neededRole)) {
      sendJSON(res, { success: false, error: `Requires ${neededRole} role` }, 403);
      return;
    }

    // ── Forced password change: block everything but logout/change-password
    // until the user picks a new password (first login / admin reset). ──
    if (getAuthEnabled() && userMustChangePassword(user)) {
      const isChange = req.method === 'POST' && url.pathname === '/api/auth/change-password';
      const isLogout = req.method === 'POST' && url.pathname === '/api/auth/logout';
      if (!isChange && !isLogout) {
        sendJSON(res, { success: false, error: 'Password change required', mustChangePassword: true }, 403);
        return;
      }
    }

    // ── User management (admin only; needs no pi session) ──
    if (url.pathname === '/api/users' && req.method === 'GET') {
      sendJSON(res, { success: true, data: listUsers() });
      return;
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      try {
        const input = await readBody(req);
        const err = createUser(input);
        if (err) { sendJSON(res, { success: false, error: err }, 400); return; }
        sendJSON(res, { success: true, data: listUsers().find((u) => u.username === input.username) });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to create user: ${err}` }, 400);
      }
      return;
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([\w.-]+)$/);
    if (userMatch && req.method === 'POST') {
      try {
        const patch = await readBody(req);
        const err = updateUser(user, decodeURIComponent(userMatch[1]), patch);
        if (err) { sendJSON(res, { success: false, error: err }, 400); return; }
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to update user: ${err}` }, 400);
      }
      return;
    }
    if (userMatch && req.method === 'DELETE') {
      const name = decodeURIComponent(userMatch[1]);
      const err = deleteUser(user, name);
      if (err) { sendJSON(res, { success: false, error: err }, 400); return; }
      // Invalidate the deleted user's login tokens and stop their pi processes
      removeUserTokens(name);
      await pm.terminateByUser(name);
      sendJSON(res, { success: true });
      return;
    }

    // ── File browser (Edits view). list/read are chat-level; write/delete
    // get 'control' from requiredRole() — plus path/allowedDirs checks in
    // the handlers themselves. ──
    const sendBrowse = (r: BrowseResult<any>) => {
      if ('error' in r) sendJSON(res, { success: false, error: r.error }, r.status);
      else sendJSON(res, { success: true, data: r.data });
    };
    if (url.pathname === '/api/browse/roots' && req.method === 'GET') {
      sendBrowse({ data: userFileRoots(user) });
    } else if (url.pathname === '/api/browse/list' && req.method === 'GET') {
      sendBrowse(browseList(user, url.searchParams.get('path') || ''));
    } else if (url.pathname === '/api/browse/read' && req.method === 'GET') {
      sendBrowse(browseRead(user, url.searchParams.get('path') || ''));
    } else if (url.pathname === '/api/browse/write' && req.method === 'POST') {
      try {
        const { path, content } = await readBody(req);
        sendBrowse(browseWrite(user, path, content));
      } catch (err: any) {
        sendBrowse({ error: `Bad request: ${err.message}`, status: 400 });
      }
    } else if (url.pathname === '/api/browse/delete' && req.method === 'POST') {
      try {
        const { path } = await readBody(req);
        sendBrowse(browseDelete(user, path));
      } catch (err: any) {
        sendBrowse({ error: `Bad request: ${err.message}`, status: 400 });
      }
    }
    if (url.pathname.startsWith('/api/browse/')) return;

    if (url.pathname === '/api/new-session' && req.method === 'POST') {
      try {
        // Body is optional (tests may post without JSON). Read ONCE — a
        // second readBody on a consumed stream would hang forever.
        let body: any = {};
        try { body = await readBody(req); } catch {}

        // Persona for the new session — validated BEFORE creating anything,
        // so an invalid id fails cleanly without leaving a stray session.
        const personaId = typeof body?.personaId === 'string' && body.personaId ? body.personaId : '';
        let persona: Persona | null = null;
        if (personaId) {
          persona = listPersonas(user).find((p) => p.id === personaId) || null;
          if (!persona) {
            sendJSON(res, { success: false, error: `Unknown persona: ${personaId}` }, 400);
            return;
          }
        }

        // Spawn a DEDICATED process for the fresh session — the previous
        // session's process (if any, even mid-turn) keeps running untouched.
        const fresh = await pm.getOrCreate(user, null);
        const state = fresh.state.sessionState;
        if (!state.sessionId || !state.sessionFile) {
          throw new Error('pi started a new session but did not report a sessionId or sessionFile');
        }

        // The fresh process auto-names itself at spawn ("[ui] - …"). An
        // explicit name from the request body (frontend-generated with the
        // browser locale/timezone) overrides it; locale/timeZone are
        // persisted per user for spawn-time and task-run auto-naming.
        if (body && typeof body === 'object') {
          try {
            const locale = typeof body.locale === 'string' ? body.locale.trim() : '';
            const timeZone = typeof body.timeZone === 'string' ? body.timeZone.trim() : '';
            if (locale) setUserSetting(user, 'locale', locale);
            if (timeZone) setUserSetting(user, 'timeZone', timeZone);
          } catch {}
        }
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
        setClientSession(user, clientId, state.sessionFile);
        setLastSession(user, token, state.sessionFile);
        const viewedNow = viewedSessions(user);

        // Bind the chosen persona (if any) to the new session — the
        // pi-personas extension puts it into the system prompt every turn.
        setActivePersona(user, state.sessionFile, persona);
        state.persona = persona ? { id: persona.id, name: persona.name } : null;

        // Broadcast the updated sessions list (the new entry is file-less
        // until the first message) to all of the user's clients.
        broadcastToUser(user, { type: 'sessions', data: pm.listSessions(user, viewedNow) });

        log.http.info(`New session created -> /session/${state.sessionId}`);
        // Include the fresh session state so the requesting client can update
        // its badge immediately; the subsequent switch-by-id (URL navigation)
        // returns the full bootstrap payload from the new process.
        sendJSON(res, { success: true, navigateUrl: `/session/${state.sessionId}`, sessionState: { ...state } });
      } catch (err) {
        log.http.error('/api/new-session failed:', err);
        sendJSON(res, { success: false, error: `Failed to start new session: ${err}` });
      }
      return;
    }

    // ── Client → session routing ──
    // Every client (autere-client-id cookie) views one pi session at a time;
    // its API calls and SSE events route to THAT session's process. Fallback
    // order: the client's bound session → the auth session's last session
    // (unless disabled, e.g. e2e --new-session) → fresh spawn.
    let session: import('./user-session.js').UserSession | undefined;
    // Binding alone never spawns pi — an idle session is a disk entry until
    // something needs the process (send/compact/restart/load click).
    const boundFile = getClientSession(user, clientId);
    session = boundFile ? pm.get(user, boundFile) : undefined;
    const viewed = viewedSessions(user);

    // ── Serve images extracted from stream history (auth-scoped to the
    // requesting user's own pi env; name is a server-generated hash). ──
    if (url.pathname.startsWith('/api/images/') && req.method === 'GET') {
      const name = url.pathname.slice('/api/images/'.length);
      if (!/^hist-[a-f0-9]{16}\.[a-z0-9]{2,5}$/.test(name)) {
        sendJSON(res, { success: false, error: 'Bad image name' }, 400);
        return;
      }
      const file = join(getPiEnvDir(user), 'uploads', name);
      if (!existsSync(file)) {
        sendJSON(res, { success: false, error: 'Not found' }, 404);
        return;
      }
      const ext = name.split('.').pop() || 'png';
      const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
      res.end(readFileSync(file));
      return;
    }

    // ── Serve files shared via pi-filetools' save_file tool (auth-scoped
    // to the requesting user's own pi env; server-generated hash name). ──
    if (url.pathname.startsWith('/api/files/') && req.method === 'GET') {
      const name = decodeURIComponent(url.pathname.slice('/api/files/'.length));
      if (!/^file-[a-f0-9]{16}-[A-Za-z0-9._-]{1,80}$/.test(name)) {
        sendJSON(res, { success: false, error: 'Bad file name' }, 400);
        return;
      }
      const file = join(getPiEnvDir(user), 'uploads', name);
      if (!existsSync(file)) {
        sendJSON(res, { success: false, error: 'Not found' }, 404);
        return;
      }
      const origName = name.slice('file-'.length + 16 + 1);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': statSync(file).size,
        'Content-Disposition': `attachment; filename="${origName.replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      res.end(readFileSync(file));
      return;
    }

    let diskEntrySeq = 0;

    // ── Bootstrap payload builder ──
    // Shared by GET /api/bootstrap and the switch-by-id response: everything
    // the UI needs to (re)render for ONE session's process in one shape.
    // sess may be undefined when no session is bound/resolvable — a
    // degenerate payload is returned (the UI treats it as invalid snapshot).
    const buildBootstrapData = (sess?: import('./user-session.js').UserSession, disk?: import('./types.js').SessionInfo) => {
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
                model = { provider: String(m.model).split('/')[0] || '9router', id: m.model, name: String(m.model).replace(/^[a-z0-9-]+\//i, '') };
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
          availableSessions: pm.listSessions(user, viewed),
          availableModels: [],
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
        if (streamHistory.length === 0 && st?.sessionFile && existsSync(st.sessionFile)) {
          try { streamHistory = sess.withStableIds(readSessionHistory(st.sessionFile, sess.historyLimit)); } catch (err) {
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
        availableSessions: pm.listSessions(user, viewed),
        availableModels: sess?.state.availableModels ?? [],
        extensions: extensionsState,
      };
    };

    // ── API endpoints ──

    // Resolve the session process a request targets. An explicit sessionId
    // (the session the client is VIEWING, sent per call) wins — the hub
    // binding is established by bootstrap/switch and the first calls after a
    // (re)load can race it, so every session-scoped call carries its target.
    // spawn=true only for calls that NEED a live process (send/compact/
    // restart/set-model and the explicit "load" click). Everything else
    // resolves to the running process or undefined — viewing a session must
    // not spawn pi.
    const resolveTarget = async (explicitId?: unknown, spawn = false): Promise<import('./user-session.js').UserSession | undefined> => {
      if (typeof explicitId === 'string' && explicitId) {
        const sess = pm.findSession(user, explicitId, viewed);
        if (sess) {
          const running = pm.get(user, sess.sessionFile);
          if (running) return running;
          if (!spawn) return undefined;
          const t = await pm.getOrCreate(user, sess.sessionFile);
          setClientSession(user, clientId, t.routedSessionFile());
          return t;
        }
      }
      return session;
    };

    if (url.pathname === '/api/state') {
      const t = await resolveTarget(url.searchParams.get('sessionId'));
      sendJSON(res, { success: true, data: t?.state.sessionState ?? null });
      return;
    }
    if (url.pathname === '/api/stats') {
      const t = await resolveTarget(url.searchParams.get('sessionId'));
      sendJSON(res, { success: true, data: t?.state.sessionStats ?? null });
      return;
    }
    if (url.pathname === '/api/tools') {
      const t = await resolveTarget(url.searchParams.get('sessionId'));
      const tools = t ? Array.from(t.state.activeTools.entries()).map(([id, tool]) => ({ id, ...tool })) : [];
      sendJSON(res, { success: true, data: tools });
      return;
    }
    if (url.pathname === '/api/extensions') {
      // Dedup/janitor stats are per-user (each pi env has its own counters)
      // and are injected per request — global state must never carry them, or
      // any logged-in user could read other users' (user)names and counts.
      const data = extensionsState.map((e) => {
        if (e.name === 'pi-dedup') {
          const patched = withDedupSections(e, user);
          return { ...e, sections: patched.sections, status: patched.status, statusText: patched.statusText };
        }
        if (e.name === 'pi-janitor') {
          const patched = withJanitorSections(e, user);
          return { ...e, sections: patched.sections, status: patched.status, statusText: patched.statusText };
        }
        return e;
      });
      sendJSON(res, { success: true, data });
      return;
    }
    if (url.pathname === '/api/models') {
      const t = await resolveTarget(url.searchParams.get('sessionId'));
      if (t && t.state.availableModels.length === 0) {
        try {
          const models = await t.rpc.getAvailableModels();
          const scoped = filterScopedModels(models);
          t.state.availableModels = scoped.map((m: any) => ({
            provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined,
          }));
        } catch (err) {
          log.http.error('Failed to fetch models on demand:', err);
        }
      }
      let data = t?.state.availableModels ?? [];
      // Idle session (lazy spawn): no process to ask — serve the router's
      // catalog filtered by the scoped patterns instead of an empty list.
      if (data.length === 0) data = await getScopedModelCatalog(user, provider);
      sendJSON(res, { success: true, data });
      return;
    }

    if (url.pathname === '/api/set-model' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const t = await resolveTarget(body.sessionId, true);
        if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
        const { provider, modelId } = body;
        const { sessionState } = t.state;
        const rpc = t.rpc;
        {
          if (!provider || !modelId) {
            sendJSON(res, { success: false, error: 'provider and modelId are required' }, 400);
            return;
          }
          const model = await rpc.setModel(provider, modelId);
          if (model) {
            sessionState.model = { provider: model.provider, id: model.id, name: model.name || model.id };
            t.broadcast({ type: 'status', data: { ...sessionState } });
          }
          sendJSON(res, { success: true });
        }
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to set model: ${err}` }, 500);
      }
      return;
    }

    if (url.pathname === '/api/restart' && req.method === 'POST') {
      try {
        const t = await resolveTarget(url.searchParams.get('sessionId'), true);
        if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
        const file = t.routedSessionFile();
        await pm.terminate(user, file);
        const fresh = await pm.getOrCreate(user, file);
        setClientSession(user, clientId, fresh.routedSessionFile());
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to restart pi process: ${err}` }, 500);
      }
      return;
    }

    if (url.pathname === '/api/restart-backend' && req.method === 'POST') {
      sendJSON(res, { success: true });
      setTimeout(() => { try { if (typeof process.exit === 'function') process.exit(0); } catch {} }, 200);
      return;
    }

    if (url.pathname === '/api/abort' && req.method === 'POST') {
      const t = await resolveTarget(url.searchParams.get('sessionId'));
      if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
      log.http.forSession(t.state.sessionState.sessionId).info('Abort requested');
      try {
        await t.rpc.abort();
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to abort: ${err}` });
      }
      return;
    }

    if (url.pathname === '/api/compact' && req.method === 'POST') {
      const t = await resolveTarget(url.searchParams.get('sessionId'), true);
      if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
      const sessionState = t.state.sessionState;
      const rpc = t.rpc;
      const session = t;
      log.http.forSession(sessionState.sessionId).info('Compaction requested');
      if (sessionState.compacting) {
        sendJSON(res, { success: false, error: 'Compaction already in progress' }, 409);
        return;
      }
      // Respond immediately — compaction can take minutes and holding the
      // request open gets it killed by proxy timeouts (Apache etc.), making
      // the UI report "failed to compact" while compaction is merely slow.
      // pi's compaction_start/compaction_end events drive the UI state; a
      // genuine failure is surfaced via the SSE error event below.
      sendJSON(res, { success: true });
      sessionState.compactionAborted = false; // clear stale flag from any previous abort
      rpc.compact().catch((err) => {
        log.http.forSession(sessionState.sessionId).error('Compaction failed:', err);
        if (sessionState.compacting) {
          sessionState.compacting = false;
          sessionState.isStreaming = false;
          session.broadcast({ type: 'status', data: { ...sessionState } });
        }
        if (sessionState.compactionAborted) {
          // User-initiated abort — not an error. Shared per-session flag, so
          // no client on this session gets the error popup. Transient notice:
          // not persisted to pi's session file, gone after reload.
          sessionState.compactionAborted = false;
          session.broadcast({
            type: 'history_upsert',
            sessionId: sessionState.sessionId,
            data: [{ id: `sys-${Date.now()}`, role: 'system', text: 'Compaction aborted', streaming: false, timestamp: Date.now() }],
          });
        } else {
          session.broadcast({ type: 'error', data: { message: `Compaction failed: ${err}` } });
        }
      });
      return;
    }

    if (url.pathname === '/api/abort-compaction' && req.method === 'POST') {
      const t = await resolveTarget(url.searchParams.get('sessionId'));
      if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
      const sessionState = t.state.sessionState;
      const rpc = t.rpc;
      const session = t;
      log.http.forSession(sessionState.sessionId).info('Compaction abort requested');
      if (!sessionState.compacting || !sessionState.sessionFile) {
        sendJSON(res, { success: false, error: 'No compaction in progress' }, 409);
        return;
      }
      try {
        // pi exposes no RPC abort for compaction. switchSession to the SAME
        // file tears the session down (dispose() -> abortCompaction()) and
        // reloads it from disk — lossless, since no CompactionEntry is
        // written until compaction succeeds. Teardown discards queued
        // messages, so capture and re-queue them.
        // Flag BEFORE the switch: the old compact() promise rejects the
        // moment teardown fires, racing this handler's remaining awaits.
        sessionState.compactionAborted = true;
        const cleared = await rpc.clearQueue();
        await rpc.switchSession(sessionState.sessionFile);
        for (const t of cleared.steering) await rpc.steer(t);
        for (const t of cleared.followUp) await rpc.followUp(t);
        sessionState.compacting = false;
        session.broadcast({ type: 'status', data: { ...sessionState } });
        sendJSON(res, { success: true });
      } catch (err) {
        sessionState.compactionAborted = false; // switch failed — compaction may still be running
        sendJSON(res, { success: false, error: `Failed to abort compaction: ${err}` });
      }
      return;
    }

    // ── Session management ──

    // Uptime info for the status modal. autere start = process start; pi
    // start = when the user's pi RPC process was spawned (null if not
    // currently running). The frontend computes elapsed time locally so no
    // polling is needed.
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const t = await resolveTarget(url.searchParams.get('sessionId'));
      sendJSON(res, {
        success: true,
        data: {
          autereStartedAt: Date.now() - Math.round(process.uptime() * 1000),
          piStartedAt: t?.state.sessionState.connected ? t.state.sessionState.startTime : null,
        },
      });
      return;
    }

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      sendJSON(res, { success: true, data: pm.listSessions(user, viewed) });
      return;
    }

    if (url.pathname === '/api/sessions/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const sessions = pm.listSessions(user, viewed);
      if (q.length < 2) {
        sendJSON(res, { success: true, data: sessions });
        return;
      }
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
      sendJSON(res, { success: true, data: scored.map(({ s, match }) => ({ ...s, match })) });
      return;
    }

    if (url.pathname === '/api/sessions/delete' && req.method === 'POST') {
      try {
        {
          const { sessionId } = await readBody(req);
          if (!sessionId || typeof sessionId !== 'string') {
            sendJSON(res, { success: false, error: 'sessionId is required' }, 400);
            return;
          }
          const sess = pm.findSession(user, sessionId, viewed);
          if (!sess) {
            sendJSON(res, { success: false, error: 'Session not found' }, 404);
            return;
          }
          if (sess.sessionFile === (session?.routedSessionFile() ?? getClientSession(user, clientId))) {
            sendJSON(res, { success: false, error: 'Cannot delete the session you are viewing' }, 400);
            return;
          }
          // Stop a running process for the session before removing its file
          await pm.terminate(user, sess.sessionFile);
          const deletedDir = join(homedir(), '.autere', 'deleted-sessions');
          mkdirSync(deletedDir, { recursive: true });
          renameSync(sess.sessionFile, join(deletedDir, basename(sess.sessionFile)));
          broadcastToUser(user, { type: 'sessions', data: pm.listSessions(user, viewed) });
          sendJSON(res, { success: true });
        }
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to delete session: ${err}` }, 500);
      }
      return;
    }

    // ── Bootstrap: one request that returns everything the UI needs at
    // (re)load time — session state, stats, tools, chat history for the
    // requested (or current) session, sessions list, models, extensions.
    // The SSE stream carries LIVE events only; no connect-time replays.
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
      const requested = url.searchParams.get('sessionId');
      // Direct URL entry / reload: attach this client to the requested
      // session and return ITS payload — from the live process when one is
      // running, otherwise from the session file on disk. Viewing never
      // spawns pi (lazy: spawn happens on send/compact/restart/load click).
      // With no sessionId (landing on /): the auth session's last pi session
      // is the login-time default view — also without spawning.
      let diskInfo: import('./types.js').SessionInfo | undefined;
      const requestedInfo = requested ? pm.findSession(user, requested, viewed) : undefined;
      if (requestedInfo) diskInfo = requestedInfo;
      const fallbackFile = !requested && !session && pm.resumeLastSession && getAuthEnabled()
        ? getLastSession(user, token) : null;
      if (requestedInfo || fallbackFile) {
        const file = requestedInfo?.sessionFile ?? fallbackFile!;
        session = pm.get(user, file);
        setClientSession(user, clientId, session?.routedSessionFile() ?? file);
        if (!session && !requestedInfo) {
          diskInfo = pm.listSessions(user, viewedSessions(user)).find(i => i.sessionFile === file);
        }
      }
      sendJSON(res, { success: true, data: buildBootstrapData(session, !session ? diskInfo : undefined) });
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/history$/);
    if (historyMatch && req.method === 'GET') {
      const sessionId = historyMatch[1];
      const sess = pm.findSession(user, sessionId, viewed);
      if (!sess) { sendJSON(res, { success: false, error: 'Session not found' }, 404); return; }
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const bound = await resolveTarget(url.searchParams.get('sessionId'));
      const isActive = sess.id === bound?.state.sessionState.sessionId;
      sendJSON(res, {
        success: true,
        data: readSessionHistory(sess.sessionFile, Math.min(limit, 100)),
        activeTools: isActive && bound ? activeToolsSnapshot(bound) : [],
      });
      return;
    }

    const fileChangesMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/file-changes$/);
    if (fileChangesMatch && req.method === 'GET') {
      const sessionId = fileChangesMatch[1];
      const user = getUser(req);
      if (!user) { sendJSON(res, { success: false, error: 'Unauthorized' }, 401); return; }
      // Use the same findSession logic as /history to resolve id drift
      const sess = pm.findSession(user, sessionId, viewed);
      if (!sess) { sendJSON(res, { success: true, data: [] }); return; }
      // file-changes JSONL is named after the session filename
      const baseName = basename(sess.sessionFile, '.jsonl');
      const filePath = join(getPiEnvDir(user), 'file-changes', `${baseName}.jsonl`);
      if (!existsSync(filePath)) { sendJSON(res, { success: true, data: [] }); return; }
      try {
        const content = readFileSync(filePath, 'utf-8');
        const entries = content.split('\n').filter(Boolean).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        // Retroactive ignore filtering: rows written before an entry was
        // added (or before segment matching was fixed) must not resurface.
        const ignores = getEditIgnorePaths(user);
        sendJSON(res, { success: true, data: entries.filter((e: any) => !e?.path || !pathIsIgnored(e.path, ignores)) });
      } catch (err: any) {
        sendJSON(res, { success: false, error: err.message }, 500);
      }
      return;
    }

    if (url.pathname === '/api/sessions/switch-by-id' && req.method === 'POST') {
      try {
        {
          const { sessionId, spawn } = await readBody(req);
          if (!sessionId || typeof sessionId !== 'string') {
            sendJSON(res, { success: false, error: 'sessionId is required' }, 400);
            return;
          }
          log.http.forSession(session?.state.sessionState.sessionId ?? null).info(`switch-by-id request: ${sessionId}`);
          const curState = session?.state.sessionState;
          let sess = pm.findSession(user, sessionId, viewed);
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
          if (!sess) {
            sendJSON(res, { success: false, error: 'Session not found' }, 404);
            return;
          }

          // pi refuses to load a session whose stored working directory no
          // longer exists (MissingSessionCwdError). Reject BEFORE spawning —
          // otherwise the response reports the new session while pi never
          // started, leaving the UI stuck until a resync.
          if (sess.cwd && !existsSync(sess.cwd)) {
            sendJSON(res, {
              success: false,
              error: `Cannot switch: session's working directory no longer exists (${sess.cwd})`,
            }, 400);
            return;
          }

          // Bind this client to the target session. Lazy: only spawn when
          // the caller asked (the status card's "load" click) — plain
          // switching gets a disk-built payload. Switching never touches the
          // PREVIOUS session's process — a session that was streaming keeps
          // streaming in its own process, viewable by any client at any time.
          let target = pm.get(user, sess.sessionFile);
          if (!target && spawn === true) target = await pm.getOrCreate(user, sess.sessionFile);
          setClientSession(user, clientId, target?.routedSessionFile() ?? sess.sessionFile);
          if (target) {
            const boundFile = target.routedSessionFile();
            if (boundFile) setLastSession(user, token, boundFile);
          } else {
            setLastSession(user, token, sess.sessionFile);
          }

          log.http.info(`switch-by-id done: ${sessionId}${target ? ' (live)' : ' (idle)'}`);
          // Same payload shape as GET /api/bootstrap — the requesting client
          // applies it with the exact same code path.
          sendJSON(res, { success: true, data: buildBootstrapData(target, sess) });
        }
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to switch session: ${err}` }, 500);
      }
      return;
    }

    if (url.pathname === '/api/session-name' && req.method === 'POST') {
      try {
        {
          const body = await readBody(req);
          const t = await resolveTarget(body.sessionId);
          if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
          const { name } = body;
          const sessionState = t.state.sessionState;
          const rpc = t.rpc;
          const session = t;
          if (typeof name !== 'string') {
            sendJSON(res, { success: false, error: 'name must be a string' }, 400);
            return;
          }
          const trimmed = name.trim();
          sessionState.sessionName = trimmed || null;
          session.broadcast({ type: 'status', data: { ...sessionState } });
          broadcastToUser(user, { type: 'sessions', data: pm.listSessions(user, viewed) });
          await rpc.setSessionName(trimmed);
          sendJSON(res, { success: true });
        }
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to set session name: ${err}` }, 400);
      }
      return;
    }

    // ── User settings ──

    if (url.pathname === '/api/extensions/packages' && req.method === 'GET') {
      sendJSON(res, {
        success: true,
        data: {
          available: getAvailablePackages(),
          enabled: getEnabledPackages(user),
        },
      });
      return;
    }

    if (url.pathname === '/api/set-persona' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const t = await resolveTarget(body.sessionId);
        if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
        const sessionState = t.state.sessionState;
        const session = t;
        const { personaId } = body;
        let persona: Persona | null = null;
        if (personaId) {
          persona = listPersonas(user).find((p) => p.id === personaId) || null;
          if (!persona) {
            sendJSON(res, { success: false, error: 'Unknown persona' }, 400);
            return;
          }
        }
        if (!sessionState.sessionFile) {
          sendJSON(res, { success: false, error: 'No active session' }, 400);
          return;
        }
        setActivePersona(user, sessionState.sessionFile, persona);
        sessionState.persona = persona ? { id: persona.id, name: persona.name } : null;
        session.broadcast({ type: 'status', data: { ...sessionState } });
        sendJSON(res, { success: true, data: { persona: sessionState.persona } });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to set persona: ${err}` }, 500);
      }
      return;
    }

    // ── Personas (library CRUD + LLM-assisted prompt generation) ──

    if (url.pathname === '/api/personas' && req.method === 'GET') {
      sendJSON(res, { success: true, data: listPersonas(user) });
      return;
    }

    if (url.pathname === '/api/personas' && req.method === 'POST') {
      try {
        const input = await readBody(req);
        const validationError = validatePersona(input);
        if (validationError) {
          sendJSON(res, { success: false, error: validationError }, 400);
          return;
        }
        const personas = listPersonas(user);
        const saved: import('./personas.js').Persona = {
          id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
          name: input.name.trim(),
          description: typeof input.description === 'string' ? input.description.trim() : '',
          prompt: input.prompt.trim(),
        };
        const idx = personas.findIndex((p) => p.id === saved.id);
        if (idx >= 0) personas[idx] = saved; else personas.push(saved);
        savePersonas(user, personas);
        sendJSON(res, { success: true, data: saved });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to save persona: ${err}` }, 500);
      }
      return;
    }

    if (url.pathname === '/api/personas/delete' && req.method === 'POST') {
      try {
        const { id } = await readBody(req);
        const personas = listPersonas(user);
        const next = personas.filter((p) => p.id !== id);
        if (next.length === personas.length) {
          sendJSON(res, { success: false, error: 'Persona not found' }, 404);
          return;
        }
        savePersonas(user, next);
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to delete persona: ${err}` }, 500);
      }
      return;
    }

    // Generate a persona prompt from the user's notes using the CURRENT
    // session's model via 9router (OpenAI-compatible chat completions).
    if (url.pathname === '/api/personas/generate' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { text } = body;
        if (!text || typeof text !== 'string' || !text.trim()) {
          sendJSON(res, { success: false, error: 'text is required' }, 400);
          return;
        }
        const model = (await resolveTarget(body.sessionId))?.state.sessionState.model?.id;
        if (!model) {
          sendJSON(res, { success: false, error: 'No model selected' }, 400);
          return;
        }
        // Per-user env config first (the settings UI writes there), master as fallback
        let routerConfig = getRouterConfig();
        try {
          const envConfig = JSON.parse(readFileSync(join(getPiEnvDir(user), '9router-config.json'), 'utf-8'));
          if (envConfig?.baseUrl) {
            routerConfig = { baseUrl: String(envConfig.baseUrl).replace(/\/+$/, ''), apiKey: String(envConfig.apiKey || '') };
          }
        } catch {}
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
          sendJSON(res, { success: true, data: { prompt } });
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to generate persona prompt: ${err}` }, 500);
      }
      return;
    }

    if (url.pathname === '/api/settings/schema' && req.method === 'GET') {
      const schema = await getUserSettingsSchema(user);
      sendJSON(res, { success: true, data: schema });
      return;
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      const settings = getAllUserSettings(user);
      sendJSON(res, { success: true, data: settings });
      return;
    }

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      try {
        {
          const settings = await readBody(req);
          if (!settings || typeof settings !== 'object') {
            sendJSON(res, { success: false, error: 'Settings must be an object' }, 400);
            return;
          }
          // Save user settings
          const prev = getAllUserSettings(user);
          saveUserSettings(user, settings);
          // Reserve % and janitor sweep policy are applied live by their pi
          // extensions (mtime-cached config reads, per model/call — no
          // restart needed) — skip the restart when only those change, so
          // the running session is not interrupted.
          const onlyLiveApplyKeys = Object.keys(settings).every(
            (k) => k === 'reserveTokensPercent' || k === 'reserveTokensPercentByModel' || k.startsWith('janitor') || prev[k] === (settings as any)[k]
          );
          // Restart the pi process so it picks the settings up — but never
          // kill an active turn: while streaming/compacting, queue a deferred
          // restart that ProcessManager applies at the next turn end.
          if (onlyLiveApplyKeys) {
            sendJSON(res, { success: true });
          } else {
            // Restart EVERY running session process of the user so they pick
            // the settings up — but never kill an active turn: streaming
            // processes get a deferred restart applied at their own turn end,
            // idle ones restart immediately.
            let deferred = false;
            for (const s of pm.allSessions()) {
              if (s.user !== user) continue;
              if (s.state.sessionState.isStreaming || s.state.sessionState.compacting) { deferred = true; continue; }
              const f = s.routedSessionFile();
              try { await pm.terminate(user, f); await pm.getOrCreate(user, f); } catch (err) {
                log.http.error(`Settings restart failed for a session process: ${err}`);
              }
            }
            if (deferred) pm.queueRestart(user);
            sendJSON(res, { success: true, deferred });
          }
        }
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to save settings: ${err}` }, 500);
      }
      return;
    }

    // ── Scheduled tasks ──

    if (url.pathname === '/api/scheduler/tasks' && req.method === 'GET') {
      sendJSON(res, { success: true, data: { tasks: listTasks(user), runs: listRuns(user, undefined, 50) } });
      return;
    }

    if (url.pathname === '/api/scheduler/tasks' && req.method === 'POST') {
      try {
        const input = await readBody(req);
        const err = validateTaskInput(input);
        if (err) { sendJSON(res, { success: false, error: err }, 400); return; }
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
        saveTask(user, task);
        sendJSON(res, { success: true, data: task });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to create task: ${err}` }, 500);
      }
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/scheduler\/tasks\/([\w-]+)$/);
    if (taskMatch && req.method === 'POST') {
      try {
        const taskId = taskMatch[1];
        const existing = getTask(user, taskId);
        if (!existing) { sendJSON(res, { success: false, error: 'Task not found' }, 404); return; }
        const input = await readBody(req);
        const err = validateTaskInput(input);
        if (err) { sendJSON(res, { success: false, error: err }, 400); return; }
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
        saveTask(user, updated);
        sendJSON(res, { success: true, data: updated });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to update task: ${err}` }, 500);
      }
      return;
    }

    if (taskMatch && req.method === 'DELETE') {
      try {
        const deleted = deleteTask(user, taskMatch[1]);
        if (!deleted) { sendJSON(res, { success: false, error: 'Task not found' }, 404); return; }
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to delete task: ${err}` }, 500);
      }
      return;
    }

    const runNowMatch = url.pathname.match(/^\/api\/scheduler\/tasks\/([\w-]+)\/run$/);
    if (runNowMatch && req.method === 'POST') {
      if (!scheduler) { sendJSON(res, { success: false, error: 'Scheduler not available' }, 503); return; }
      try {
        const runId = await scheduler.runNow(user, runNowMatch[1]);
        sendJSON(res, { success: true, data: { runId } });
      } catch (err: any) {
        const alreadyRunning = /already running/.test(err?.message || '');
        sendJSON(res, { success: false, error: `Failed to run task: ${err}` }, alreadyRunning ? 409 : 404);
      }
      return;
    }

    if (url.pathname === '/api/scheduler/runs' && req.method === 'GET') {
      const taskId = url.searchParams.get('taskId') || undefined;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
      sendJSON(res, { success: true, data: listRuns(user, taskId, limit) });
      return;
    }

    const runLogMatch = url.pathname.match(/^\/api\/scheduler\/runs\/([\w-]+)\/([\w-]+)$/);
    if (runLogMatch && req.method === 'GET') {
      const entry = readRunLog(user, runLogMatch[1], runLogMatch[2]);
      if (!entry) { sendJSON(res, { success: false, error: 'Run log not found' }, 404); return; }
      sendJSON(res, { success: true, data: entry });
      return;
    }

    if (url.pathname === '/api/send' && req.method === 'POST') {
      try {
        {
          const body = await readBody(req);
          const t = await resolveTarget(body.sessionId, true);
          if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
          const sessionState = t.state.sessionState;
          const rpc = t.rpc;
          const session = t;
          const { message, type, images } = body;
          if ((!message || typeof message !== 'string' || !message.trim()) && !(Array.isArray(images) && images.length > 0)) {
            sendJSON(res, { success: false, error: 'Message is required' }, 400);
            return;
          }
          // Image attachments (base64, pi ImageContent format)
          let rpcImages: import('./rpc-client.js').RpcImage[] | undefined;
          if (images !== undefined) {
            if (!Array.isArray(images) || images.length > MAX_ATTACHED_IMAGES) {
              sendJSON(res, { success: false, error: `images must be an array of at most ${MAX_ATTACHED_IMAGES} items` }, 400);
              return;
            }
            rpcImages = [];
            for (const img of images) {
              const mime = typeof img?.mimeType === 'string' ? img.mimeType : '';
              const data = typeof img?.data === 'string' ? img.data : '';
              // Accept data: URLs too — strip the prefix
              const raw = data.startsWith('data:') ? data.replace(/^data:[^;]+;base64,/, '') : data;
              if (!mime.startsWith('image/')) {
                sendJSON(res, { success: false, error: 'Only image attachments are supported' }, 400);
                return;
              }
              if (!raw || Buffer.from(raw, 'base64').length === 0) {
                sendJSON(res, { success: false, error: 'Invalid image data' }, 400);
                return;
              }
              if (Buffer.from(raw, 'base64').length > MAX_IMAGE_BYTES) {
                sendJSON(res, { success: false, error: 'Image too large (max 8 MB)' }, 400);
                return;
              }
              rpcImages.push({ type: 'image', data: raw, mimeType: mime });
            }
            if (rpcImages.length === 0) rpcImages = undefined;
          }
          let text = (message || '').trim();
          log.http.forSession(sessionState.sessionId).info(
            `${type || 'prompt'}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"${rpcImages?.length ? ` [${rpcImages.length} image(s)]` : ''}`);
          const queued = type === 'steer' || type === 'followUp' || rpc.isStreaming;
          // pi only runs extension input hooks on the prompt() path — steer/
          // followUp bypass them, so queued messages with images must get the
          // same attachment intake here (save to uploads + path note) that
          // pi-filetools provides for prompts.
          if (queued && rpcImages && rpcImages.length > 0) {
            const sendPreviews = getSendImagesToChatModel(user);
            const preset = getImagePreviewQuality(user);
            try {
              const uploadsDir = join(session.getEnvDir(), 'uploads');
              mkdirSync(uploadsDir, { recursive: true });
              const stamp = Date.now();
              const paths: string[] = [];
              const previews: import('./rpc-client.js').RpcImage[] = [];
              for (const [i, img] of rpcImages.entries()) {
                const ext = (img.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
                const file = join(uploadsDir, `upload-${stamp}-${i + 1}.${ext}`);
                writeFileSync(file, Buffer.from(img.data, 'base64'));
                paths.push(file);
                // Publish under the hist-* name /api/images serves, and push
                // an image entry so the attachment still renders in chat.
                const name = `hist-${createHash('sha1').update(img.data).digest('hex').slice(0, 16)}.${ext}`;
                const histFile = join(uploadsDir, name);
                if (!existsSync(histFile)) writeFileSync(histFile, Buffer.from(img.data, 'base64'));
                session.pushImageEntry(name, img.mimeType);
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
            await rpc.steer(text);
          } else if (type === 'followUp') {
            await rpc.followUp(text);
          } else if (rpc.isStreaming) {
            await rpc.steer(text);
          } else {
            await rpc.prompt(text);
          }
          // Commit the user message into the stream history immediately —
          // retires the client's optimistic pending copy (pi never emits
          // message_end for user messages, so the old snapshot-based
          // retirement only fired at turn end).
          session.addUserEntry(text, queued);
          sendJSON(res, { success: true });
        }
      } catch (err) {
        log.http.error('Failed to send message:', err);
        sendJSON(res, { success: false, error: `Failed to send message: ${err}` }, 400);
      }
      return;
    }

    if (url.pathname === '/api/cancel-pending' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const t = await resolveTarget(body.sessionId);
        if (!t) { sendJSON(res, { success: false, error: 'No active session — reload the page' }, 409); return; }
        const session = t;
        const { text } = body;
        if (!text || typeof text !== 'string') {
          sendJSON(res, { success: false, error: 'text is required' }, 400);
          return;
        }
        const cancelled = await session.cancelPending(text.trim());
        sendJSON(res, { success: cancelled, error: cancelled ? undefined : 'No matching queued message' });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to cancel pending message: ${err}` }, 400);
      }
      return;
    }

    // ── SSE endpoint ──
    if (url.pathname === '/events') {
      // Reuse the client's id (query param from EventSource, header, or
      // cookie) so a PWA reconnect keeps its identity and hub binding.
      const clientId = url.searchParams.get('clientId')
        || getClientId(req)
        || `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Set clientId as a cookie so subsequent HTTP requests can identify
      // which SSE connection they belong to. The frontend never sees this.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        // Critical behind reverse proxies: without this nginx buffers the
        // stream, and small stream_delta frames sit in its buffer for seconds
        // (streaming appears frozen until a large event flushes it).
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
        'Set-Cookie': `autere-client-id=${clientId}; Path=/; SameSite=Lax`,
      });
      // Register with the user's client hub: events for whichever session
      // this client views (bound by bootstrap/switch-by-id) are routed here.
      registerClient(user, clientId, res);

      // SSE carries LIVE events only — no connect-time replays. The client
      // fetches everything it needs once via GET /api/bootstrap at (re)load
      // time (and on SSE reconnect). Heartbeats keep the stream alive.
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
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
    // subsequent switch-by-id doesn't 404 with "Session not found".
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
      log.http.error(`Port ${PORT} is already in use — dashboard server not started.`);
    } else {
      log.http.error('Server error:', err);
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
