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
import { getUser, getUserRole, hasRole, checkAuth, requireAuth, parseCookies, generateToken, addAuthToken, removeAuthToken, saveAuthTokens, getAuthEnabled, getAuthTokenExpiry, getAuthPassword, getTokenFromRequest, setLastSession, isRegisteredUser } from './auth.js';
import { readExtensions } from './extensions.js';
import { sendJSON, getDashboardHTML, readSessionUsage, readSessionHistory, filterScopedModels, autoSessionName } from './utils.js';
import { extensionsState } from './state.js';
import { getTokenPricing, getRatesForModel, computeTokenCost } from './user-settings.js';
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

import { findSession } from './sessions.js';
import { getUserSetting, getAllUserSettings, saveUserSettings, setUserSetting, getUserSettingsSchema, getAvailablePackages, getEnabledPackages, getSendImagesToChatModel, getImagePreviewQuality } from './user-settings.js';
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

export function createMonitorServer(PORT: number, pm: ProcessManager, scheduler?: Scheduler): ReturnType<typeof createServer> | null {
  let sessionRefreshInterval: ReturnType<typeof setInterval> | null = null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
          if (password !== getAuthPassword()) {
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
          res.end(JSON.stringify({ success: true }));
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
      sendJSON(res, { success: true, data: { authEnabled: getAuthEnabled(), authenticated: checkAuth(req), user, role: user ? getUserRole(user) : null } });
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

    // Ensure user has a pi process running (keyed by token)
    let session: import('./user-session.js').UserSession;
    try {
      session = await pm.getOrCreate(token, user);
    } catch (err) {
      sendJSON(res, { success: false, error: `Failed to start pi process: ${err}` }, 500);
      return;
    }

    // ── Serve images extracted from stream history (auth-scoped to the
    // requesting user's own pi env; name is a server-generated hash). ──
    if (url.pathname.startsWith('/api/images/') && req.method === 'GET') {
      const name = url.pathname.slice('/api/images/'.length);
      if (!/^hist-[a-f0-9]{16}\.[a-z0-9]{2,5}$/.test(name)) {
        sendJSON(res, { success: false, error: 'Bad image name' }, 400);
        return;
      }
      const file = join(session.getEnvDir(), 'uploads', name);
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
      const file = join(session.getEnvDir(), 'uploads', name);
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

    const { sessionState, sessionStats, activeTools, recentTools,
            availableModels } = session.state;
    const rpc = session.rpc;

    // ── Bootstrap payload builder ──
    // Shared by GET /api/bootstrap and the switch-by-id response: everything
    // the UI needs to (re)render for a session in one shape.
    const buildBootstrapData = (targetSessionId?: string | null) => {
      const target =
        (targetSessionId && findSession(targetSessionId, session.state.availableSessions)) ||
        findSession(sessionState.sessionId, session.state.availableSessions) ||
        null;
      const historySessionId = target?.id ?? sessionState.sessionId;
      let streamHistory: ReturnType<typeof readSessionHistory> = [];
      if (target?.sessionFile && existsSync(target.sessionFile)) {
        try { streamHistory = session.withStableIds(readSessionHistory(target.sessionFile, session.historyLimit)); } catch (err) {
          log.http.error('bootstrap: failed to read session history:', err);
        }
      }
      return {
        sessionState: { ...sessionState },
        sessionStats: { ...sessionStats },
        // Whether ANOTHER of the user's devices is currently driving this
        // session — computed live from the peer registry (session-peers.ts)
        sessionActivity: session.sessionActivityPayload(historySessionId).data,
        activeTools: activeToolsSnapshot(session),
        recentTools: [...recentTools],
        streamHistory,
        historySessionId,
        availableSessions: session.refreshSessions(),
        availableModels,
        extensions: extensionsState,
      };
    };

    // ── API endpoints ──

    if (url.pathname === '/api/state') {
      sendJSON(res, { success: true, data: sessionState });
      return;
    }
    if (url.pathname === '/api/stats') {
      sendJSON(res, { success: true, data: sessionStats });
      return;
    }
    if (url.pathname === '/api/tools') {
      const tools = Array.from(activeTools.entries()).map(([id, tool]) => ({ id, ...tool }));
      sendJSON(res, { success: true, data: tools });
      return;
    }
    if (url.pathname === '/api/extensions') {
      sendJSON(res, { success: true, data: extensionsState });
      return;
    }
    if (url.pathname === '/api/models') {
      if (availableModels.length === 0) {
        try {
          const models = await rpc.getAvailableModels();
          const scoped = filterScopedModels(models);
          session.state.availableModels = scoped.map((m: any) => ({
            provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined,
          }));
        } catch (err) {
          log.http.error('Failed to fetch models on demand:', err);
        }
      }
      sendJSON(res, { success: true, data: availableModels });
      return;
    }

    if (url.pathname === '/api/set-model' && req.method === 'POST') {
      try {
        const { provider, modelId } = await readBody(req);
        {
          if (!provider || !modelId) {
            sendJSON(res, { success: false, error: 'provider and modelId are required' }, 400);
            return;
          }
          const model = await rpc.setModel(provider, modelId);
          if (model) {
            sessionState.model = { provider: model.provider, id: model.id, name: model.name || model.id };
            session.broadcast({ type: 'status', data: { ...sessionState } });
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
        await pm.terminate(token);
        session = await pm.getOrCreate(token, user);
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to restart pi process: ${err}` }, 500);
      }
      return;
    }

    if (url.pathname === '/api/restart-backend' && req.method === 'POST') {
      if (!hasRole(user, 'admin')) {
        sendJSON(res, { success: false, error: 'Admin role required' }, 403);
        return;
      }
      sendJSON(res, { success: true });
      setTimeout(() => { try { if (typeof process.exit === 'function') process.exit(0); } catch {} }, 200);
      return;
    }

    if (url.pathname === '/api/abort' && req.method === 'POST') {
      log.http.forSession(sessionState.sessionId).info('Abort requested');
      try {
        await rpc.abort();
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to abort: ${err}` });
      }
      return;
    }

    if (url.pathname === '/api/compact' && req.method === 'POST') {
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
          session.broadcastToSession(sessionState.sessionId, { type: 'status', data: { ...sessionState } });
        }
        if (sessionState.compactionAborted) {
          // User-initiated abort — not an error. Shared per-session flag, so
          // no client on this session gets the error popup. Transient notice:
          // not persisted to pi's session file, gone after reload.
          sessionState.compactionAborted = false;
          session.broadcastToSession(sessionState.sessionId, {
            type: 'history_upsert',
            sessionId: sessionState.sessionId,
            data: [{ id: `sys-${Date.now()}`, role: 'system', text: 'Compaction aborted', streaming: false, timestamp: Date.now() }],
          });
        } else {
          session.broadcastToSession(sessionState.sessionId, { type: 'error', data: { message: `Compaction failed: ${err}` } });
        }
      });
      return;
    }

    if (url.pathname === '/api/abort-compaction' && req.method === 'POST') {
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
        session.broadcastToSession(sessionState.sessionId, { type: 'status', data: { ...sessionState } });
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
      sendJSON(res, {
        success: true,
        data: {
          autereStartedAt: Date.now() - Math.round(process.uptime() * 1000),
          piStartedAt: sessionState.connected ? sessionState.startTime : null,
        },
      });
      return;
    }

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      sendJSON(res, { success: true, data: session.refreshSessions() });
      return;
    }

    if (url.pathname === '/api/sessions/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const sessions = session.refreshSessions();
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
          if (sessionId === sessionState.sessionId) {
            sendJSON(res, { success: false, error: 'Cannot delete the active session' }, 400);
            return;
          }
          const sess = findSession(sessionId, session.state.availableSessions);
          if (!sess) {
            sendJSON(res, { success: false, error: 'Session not found' }, 404);
            return;
          }
          const deletedDir = join(homedir(), '.autere', 'deleted-sessions');
          mkdirSync(deletedDir, { recursive: true });
          renameSync(sess.sessionFile, join(deletedDir, basename(sess.sessionFile)));
          const idx = session.state.availableSessions.indexOf(sess);
          if (idx !== -1) session.state.availableSessions.splice(idx, 1);
          session.broadcast({ type: 'sessions', data: session.state.availableSessions });
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
      sendJSON(res, { success: true, data: buildBootstrapData(requested) });
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/history$/);
    if (historyMatch && req.method === 'GET') {
      const sessionId = historyMatch[1];
      const sess = findSession(sessionId, session.state.availableSessions);
      if (!sess) { sendJSON(res, { success: false, error: 'Session not found' }, 404); return; }
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const isActive = sess.id === sessionState.sessionId;
      sendJSON(res, {
        success: true,
        data: readSessionHistory(sess.sessionFile, Math.min(limit, 100)),
        activeTools: isActive ? activeToolsSnapshot(session) : [],
      });
      return;
    }

    if (url.pathname === '/api/sessions/switch-by-id' && req.method === 'POST') {
      try {
        {
          const { sessionId } = await readBody(req);
          if (!sessionId || typeof sessionId !== 'string') {
            sendJSON(res, { success: false, error: 'sessionId is required' }, 400);
            return;
          }
          log.http.forSession(sessionState.sessionId).info(`switch-by-id request: ${sessionId}`);
          let sess = findSession(sessionId, session.state.availableSessions);
          if (!sess && sessionId === sessionState.sessionId && sessionState.sessionFile) {
            // The active session may not be in availableSessions yet (its file
            // hasn't been written to disk). Allow switching to it anyway.
            sess = {
              id: sessionId,
              sessionFile: sessionState.sessionFile,
              sessionName: sessionState.sessionName || null,
              parentSession: null,
              createdAt: Date.now(),
              lastActivity: Date.now(),
              cwd: null,
            };
          }
          if (!sess) {
            session.broadcast({ type: 'error', data: { message: `Session not found: ${sessionId}` } });
            sendJSON(res, { success: false, error: 'Session not found' }, 404);
            return;
          }

          // pi refuses to load a session whose stored working directory no
          // longer exists (MissingSessionCwdError). Reject BEFORE mutating any
          // state — otherwise the backend would report the new session while
          // pi silently stayed on the old one, leaving the UI stuck until a
          // resync. The response must go out before pi is touched.
          if (sess.cwd && !existsSync(sess.cwd)) {
            sendJSON(res, {
              success: false,
              error: `Cannot switch: session's working directory no longer exists (${sess.cwd})`,
            }, 400);
            return;
          }

          // Read clientId from cookie to update this client's session tracking
          const cookies = parseCookies(req.headers.cookie || '');
          const clientId = cookies['autere-client-id'];
          if (clientId) {
            session.setClientSessionByClientId(clientId, sessionId);
          }

          // Load history for the response — do NOT call setAllClientsSession
          // here because that would make "active elsewhere" tabs receive
          // this session's history via broadcastToSession.
          const alreadyActive =
            sessionState.sessionId === sessionId ||
            (Boolean(sessionState.sessionFile) && sessionState.sessionFile === sess.sessionFile);

          const history = readSessionHistory(sess.sessionFile, session.historyLimit);
          session.setHistoryFor(sess.id, history);

          // Update shared state so live streaming goes to the right place
          session.state.currentStreamText = '';
          sessionState.sessionId = sess.id;
          sessionState.sessionFile = sess.sessionFile;
          sessionState.sessionName = sess.sessionName;
          // Pending queue counts (and compacting) live in pi for the active
          // session — zeroing them when the switch is a no-op (alreadyActive,
          // e.g. the reload race that re-switches to the same session) would
          // desync the badges from pi's real queue until the next change.
          if (!alreadyActive) {
            sessionState.compacting = false;
            sessionState.steerPending = 0;
            sessionState.followUpPending = 0;
          }

          const fileStats = readSessionUsage(sess.sessionFile);
          sessionState.messageCount = fileStats.messageCount;
          sessionState.requestCount = fileStats.requestCount;
          sessionStats.tokens = fileStats.tokens;
          sessionStats.cost = 0;
          {
            const pricing = getTokenPricing(user);
            const rates = pricing && getRatesForModel(pricing, sess.modelId || null);
            if (rates) session.setCostTotal(computeTokenCost(fileStats.tokens, rates));
          }
          sessionStats.contextUsage = null;

          // Tell pi to switch session (synchronous — the response reflects
          // pi's real state; a failure here must not leave state mutated)
          if (!alreadyActive) {
            await rpc.switchSession(sess.sessionFile);
            setLastSession(user, token, sess.sessionFile);
          }

          // Fetch stats AFTER switch so contextUsage reflects the new session
          try {
            const rpcStats = await rpc.getSessionStats();
            if (rpcStats.contextUsage) sessionStats.contextUsage = rpcStats.contextUsage;
            if (rpcStats.cost) session.setCostTotal(rpcStats.cost);
            if (!sessionStats.cost) {
              const pricing = getTokenPricing(user);
              const rates = pricing && getRatesForModel(pricing, null);
              if (rates) session.setCostTotal(computeTokenCost(sessionStats.tokens, rates));
            }
          } catch (err) { log.http.error('Post-switch stats failed:', err); }
          // No pricing info anywhere (pi reported 0, no rates configured):
          // the accumulator must still be zeroed or the next streamed message
          // adds on top of the previous session's total.
          if (!sessionStats.cost) session.setCostTotal(0);

          log.http.forSession(sessionState.sessionId).info(`switch-by-id done: alreadyActive=${alreadyActive}`);
          // Same payload shape as GET /api/bootstrap — the requesting client
          // applies it with the exact same code path. alreadyActive: pi was
          // already in this session, so its in-flight tools belong to it.
          // Switching to a different session abandons (cancels) the previous
          // turn — no tools carry over.
          const bootstrapData = buildBootstrapData(sess.id);
          if (!alreadyActive) bootstrapData.activeTools = [];
          sendJSON(res, { success: true, data: bootstrapData });
        }
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to switch session: ${err}` }, 500);
      }
      return;
    }

    if (url.pathname === '/api/new-session' && req.method === 'POST') {
      try {
        session.state.newSessionCreating = true;

        // If pi is mid-turn, new_session gets CANCELLED by pi (it refuses to
        // switch while streaming). Earlier this silently "succeeded" with the
        // OLD session's state — messages then went to the previous session.
        // Abort in-flight work first so the switch actually happens.
        if (rpc.isStreaming || sessionState.isStreaming) {
          log.http.forSession(sessionState.sessionId).info('Aborting in-flight work before creating new session');
          try { await rpc.abort(); } catch {}
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // 1. Create new session in pi over RPC
        const result = await rpc.newSession();
        if (result.cancelled) {
          throw new Error('pi refused to create a new session (agent busy) — try again');
        }

        // 2. Get the state pi reports AFTER creating the session
        const state = await rpc.getState();
        if (!state.sessionId || !state.sessionFile) {
          throw new Error('pi created session but did not return a sessionId or sessionFile');
        }

        // Auto-name UI-created sessions. The NAME IS GENERATED IN THE FRONTEND
        // (browser locale + IANA timezone via Intl) and sent in the request
        // body — the backend never formats times for display. Locale/timeZone
        // are persisted per user so spawn-time auto-naming (user-session.ts)
        // and task-run naming (scheduler.ts) can target the user's zone.
        if (!state.sessionName) {
          let sessionName: string | undefined;
          try {
            const body = await readBody(req);
            if (body && typeof body.sessionName === 'string' && body.sessionName.trim()) {
              sessionName = body.sessionName.trim();
            }
            const locale = body && typeof body.locale === 'string' ? body.locale.trim() : '';
            const timeZone = body && typeof body.timeZone === 'string' ? body.timeZone.trim() : '';
            if (locale) setUserSetting(user, 'locale', locale);
            if (timeZone) setUserSetting(user, 'timeZone', timeZone);
          } catch {
            // Empty or invalid body (e.g. tests posting without JSON) — fallback naming applies
          }
          if (!sessionName) {
            // Fallback: use the user's persisted locale/timeZone (Intl does the tz conversion)
            sessionName = autoSessionName('[ui]', {
              locale: getUserSetting(user, 'locale', '') || undefined,
              timeZone: getUserSetting(user, 'timeZone', '') || undefined,
            });
          }
          try {
            await rpc.setSessionName(sessionName);
            state.sessionName = sessionName;
          } catch (err) {
            log.http.error('Failed to auto-name new session:', err);
          }
        }

        // All clients must follow pi to the new session — the pi process
        // is now on this session, so live streaming events are for it.
        session.setAllClientsSession(state.sessionId);

        // 3. Update our in-memory state with the session pi confirmed.
        // Also reset usage counters — the new session starts with zero
        // messages and zero tokens; keeping the previous session's usage
        // would make the Usage card lie about the brand-new session.
        sessionState.sessionId = state.sessionId;
        sessionState.sessionFile = state.sessionFile;
        sessionState.sessionName = state.sessionName || null;
        sessionState.isStreaming = state.isStreaming;
        sessionState.compacting = state.isCompacting;
        sessionState.messageCount = 0;
        sessionState.requestCount = 0;
        sessionState.steerPending = 0;
        sessionState.followUpPending = 0;
        sessionStats.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        sessionStats.cost = 0;
        session.setCostTotal(0); // reset the live accumulator too, or the next message adds on top of the old session's total
        sessionStats.contextUsage = null;
        if (state.model) {
          sessionState.model = { provider: state.model.provider, id: state.model.id, name: state.model.name || state.model.id };
        }
        setLastSession(user, token, state.sessionFile);

        // 4. Inject the new session into availableSessions so switch-by-id can find it.
        //    The session file doesn't exist on disk yet — pi only writes it on first message.
        const newSessionInfo: SessionInfo = {
          id: state.sessionId,
          sessionFile: state.sessionFile,
          sessionName: state.sessionName || null,
          parentSession: null,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          cwd: null,
        };
        session.state.availableSessions.unshift(newSessionInfo);

        session.setHistoryFor(state.sessionId, []);

        // Push the reset state to connected clients (handleSessionStart's
        // broadcast may have raced ahead of this reset with stale counts).
        session.broadcastToSession(state.sessionId, { type: 'status', data: { ...sessionState } });

        session.state.newSessionCreating = false;

        // Return navigate URL in response — do NOT broadcast via SSE
        // because broadcast() sends to ALL clients, not just the one that
        // requested the new session.
        log.http.info(`New session created -> /session/${state.sessionId}`);
        // Include the fresh session state so the requesting client can update
        // its badge immediately — the SSE status broadcast is dropped by
        // clients still viewing the previous session (stale-snapshot guard).
        sendJSON(res, { success: true, navigateUrl: `/session/${state.sessionId}`, sessionState: { ...sessionState } });
      } catch (err) {
        session.state.newSessionCreating = false;
        log.http.error('/api/new-session failed:', err);
        // Broadcast error so the frontend can show it to the user
        session.broadcast({ type: 'error', data: { message: `Failed to create new session: ${err}` } });
        sendJSON(res, { success: false, error: `Failed to start new session: ${err}` });
      }
      return;
    }

    if (url.pathname === '/api/session-name' && req.method === 'POST') {
      try {
        {
          const { name } = await readBody(req);
          if (typeof name !== 'string') {
            sendJSON(res, { success: false, error: 'name must be a string' }, 400);
            return;
          }
          const trimmed = name.trim();
          sessionState.sessionName = trimmed || null;
          session.broadcastToSession(sessionState.sessionId, { type: 'status', data: { ...sessionState } });
          const sess = session.state.availableSessions.find(s => s.id === sessionState.sessionId);
          if (sess) sess.sessionName = trimmed || null;
          session.broadcast({ type: 'sessions', data: session.state.availableSessions });
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
          saveUserSettings(user, settings);
          // Restart the pi process for this auth session
          await pm.terminate(token);
          session = await pm.getOrCreate(token, user);
          sendJSON(res, { success: true });
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
          const { message, type, images } = await readBody(req);
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
        sendJSON(res, { success: false, error: `Failed to send message: ${err}` }, 400);
      }
      return;
    }

    if (url.pathname === '/api/cancel-pending' && req.method === 'POST') {
      try {
        const { text } = await readBody(req);
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
      // Generate a unique client ID for this SSE connection
      const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      // Track which session this client is viewing (starts with current session)
      session.sseClients.set(res, sessionState.sessionId);
      session.registerClientId(clientId, res);

      // Requirement: a newly connected client immediately learns whether the
      // session it is viewing is active elsewhere (another of the user's
      // devices driving it). Reconnects (device wake-up) get a fresh answer
      // here, since the SSE stream itself carries no replays.
      try {
        res.write(`data: ${JSON.stringify(session.sessionActivityPayload(sessionState.sessionId))}\n\n`);
      } catch (err) {
        log.http.error('Failed to send initial session_activity:', err);
      }

      // SSE carries LIVE events only — no connect-time replays. The client
      // fetches everything it needs once via GET /api/bootstrap at (re)load
      // time (and on SSE reconnect). Heartbeats keep the stream alive.
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // ── Periodic polling for extensions and sessions ──
  readExtensions();
  sessionRefreshInterval = setInterval(async () => {
    const prevExt = JSON.stringify(extensionsState);
    await readExtensions();
    if (JSON.stringify(extensionsState) !== prevExt) {
      // Broadcast to all sessions
      for (const token of pm.activeTokens()) {
        const session = pm.get(token);
        if (session) {
          session.state.extensionsState = [...extensionsState];
          session.broadcast({ type: 'extensions', data: extensionsState });
        }
      }
    }
    // Per-user session refresh: each user sees only their own env's sessions
    // (plus the legacy global dir unless in isolation mode). refreshSessions()
    // preserves in-memory entries for newly created sessions whose files
    // don't exist on disk yet (pi only writes the file on the first message),
    // so a subsequent switch-by-id doesn't 404 with "Session not found".
    for (const token of pm.activeTokens()) {
      const session = pm.get(token);
      if (session) {
        const sessions = session.refreshSessions();
        session.broadcast({ type: 'sessions', data: sessions });
      }
    }
  }, 2000);

  // ── Heartbeat ──
  const heartbeatInterval = setInterval(() => {
    for (const token of pm.activeTokens()) {
      const session = pm.get(token);
      if (session) session.broadcast({ type: 'heartbeat', data: { ts: Date.now() } });
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
