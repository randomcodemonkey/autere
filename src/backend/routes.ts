/**
 * HTTP server and API routes for autere dashboard.
 *
 * All pi operations are performed via RPC commands to per-user pi processes.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { ProcessManager } from './process-manager.js';
import { getUser, getUserRole, hasRole, checkAuth, requireAuth, parseCookies, generateToken, addAuthToken, removeAuthToken, saveAuthTokens, getAuthEnabled, getAuthTokenExpiry, getAuthPassword, getTokenFromRequest, setLastSession } from './auth.js';
import { readExtensions } from './extensions.js';
import { readSessions } from './sessions.js';
import { sendJSON, getDashboardHTML, readSessionUsage, readSessionHistory, filterScopedModels } from './utils.js';
import { extensionsState, availableSessions } from './state.js';
import type { SessionInfo } from './types.js';

/**
 * Resolve a session by id, tolerating id drift: pi rewrites the session
 * header (with a fresh id) in the same file when a session is resumed,
 * while the filename keeps the original id. So an id known to the
 * frontend (bookmark / client tracking) may match a filename but no
 * longer match the header id that readSessions() uses. Fall back to a
 * filename match in that case.
 */
export function findSession(sessionId: string): SessionInfo | undefined {
  const byId = availableSessions.find(s => s.id === sessionId);
  if (byId) return byId;
  const lower = sessionId.toLowerCase();
  return availableSessions.find(s => basename(s.sessionFile).toLowerCase().includes(lower));
}
import { getUserSetting, getAllUserSettings, saveUserSettings, getUserSettingsSchema } from './user-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Local dedup function that accepts a history array ──
function dedupHistory(history: any[]): any[] {
  const byKey = new Map<string, any>();
  const order: string[] = [];
  for (const msg of history) {
    if (msg.streaming) {
      const key = `streaming-${msg.role}-${msg.timestamp || 0}`;
      byKey.set(key, msg);
      order.push(key);
      continue;
    }
    const isThinking = msg.role === 'thinking';
    const contentKey = isThinking
      ? `${msg.role}|${msg.text?.slice(0, 200) || ''}`
      : `${msg.role}|${msg.text || ''}|${msg.timestamp || 0}`;
    byKey.set(contentKey, msg);
    order.push(contentKey);
  }
  return order.map(key => byKey.get(key)!);
}

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

export function createMonitorServer(PORT: number, pm: ProcessManager): ReturnType<typeof createServer> | null {
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
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { user, password } = JSON.parse(body);
          if (!getAuthEnabled()) {
            sendJSON(res, { success: true, message: 'Authentication disabled' });
            return;
          }
          // Validate user (for now only "admin" is supported)
          if (!user || typeof user !== 'string') {
            sendJSON(res, { success: false, error: 'User is required' }, 400);
            return;
          }
          if (user !== 'admin') {
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
        } catch (err) {
          sendJSON(res, { success: false, error: `Invalid login request: ${err}` }, 400);
        }
      });
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
        res.writeHead(200, { 'Content-Type': mime[ext || ''] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
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

    const { sessionState, sessionStats, recentMessages, activeTools, recentTools,
            availableModels } = session.state;
    const rpc = session.rpc;

    // ── API endpoints ──

    if (url.pathname === '/api/state') {
      sendJSON(res, { success: true, data: sessionState });
      return;
    }
    if (url.pathname === '/api/stats') {
      sendJSON(res, { success: true, data: sessionStats });
      return;
    }
    if (url.pathname === '/api/messages') {
      sendJSON(res, { success: true, data: recentMessages });
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
          console.error('[autere] Failed to fetch models on demand:', err);
        }
      }
      sendJSON(res, { success: true, data: availableModels });
      return;
    }

    if (url.pathname === '/api/set-model' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { provider, modelId } = JSON.parse(body);
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
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to set model: ${err}` }, 500);
        }
      });
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
      try {
        await rpc.abort();
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to abort: ${err}` });
      }
      return;
    }

    if (url.pathname === '/api/compact' && req.method === 'POST') {
      if (sessionState.compacting) {
        sendJSON(res, { success: false, error: 'Compaction already in progress' }, 409);
        return;
      }
      try { await rpc.compact(); sendJSON(res, { success: true }); }
      catch (err) { sendJSON(res, { success: false, error: `Failed to compact: ${err}` }); }
      return;
    }

    // ── Session management ──

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      sendJSON(res, { success: true, data: availableSessions });
      return;
    }

    if (url.pathname === '/api/sessions/delete' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { sessionId } = JSON.parse(body);
          if (!sessionId || typeof sessionId !== 'string') {
            sendJSON(res, { success: false, error: 'sessionId is required' }, 400);
            return;
          }
          if (sessionId === sessionState.sessionId) {
            sendJSON(res, { success: false, error: 'Cannot delete the active session' }, 400);
            return;
          }
          const sess = findSession(sessionId);
          if (!sess) {
            sendJSON(res, { success: false, error: 'Session not found' }, 404);
            return;
          }
          const deletedDir = join(homedir(), '.autere', 'deleted-sessions');
          mkdirSync(deletedDir, { recursive: true });
          renameSync(sess.sessionFile, join(deletedDir, basename(sess.sessionFile)));
          const idx = availableSessions.indexOf(sess);
          if (idx !== -1) availableSessions.splice(idx, 1);
          session.broadcast({ type: 'sessions', data: availableSessions });
          sendJSON(res, { success: true });
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to delete session: ${err}` }, 500);
        }
      });
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/history$/);
    if (historyMatch && req.method === 'GET') {
      const sessionId = historyMatch[1];
      const sess = findSession(sessionId);
      if (!sess) { sendJSON(res, { success: false, error: 'Session not found' }, 404); return; }
      const limit = parseInt(url.searchParams.get('limit') || '30');
      sendJSON(res, { success: true, data: readSessionHistory(sess.sessionFile, Math.min(limit, 100)) });
      return;
    }

    if (url.pathname === '/api/sessions/switch-by-id' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { sessionId } = JSON.parse(body);
          if (!sessionId || typeof sessionId !== 'string') {
            sendJSON(res, { success: false, error: 'sessionId is required' }, 400);
            return;
          }
          let sess = findSession(sessionId);
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

          const history = readSessionHistory(sess.sessionFile, 30);
          const loadedHistory = [];
          if (history.length > 0) {
            loadedHistory.push({ role: 'system', text: `— Loaded ${history.length} messages from session —`, streaming: false, timestamp: Date.now() });
            loadedHistory.push(...history);
            session.state.historyLoadedSessionId = sess.id;
          } else {
            loadedHistory.push({ role: 'system', text: '— Switching session —', streaming: false, timestamp: Date.now() });
          }

          // Update shared state so live streaming goes to the right place
          session.state.currentStreamText = '';
          session.state.currentStreamRole = '';
          sessionState.sessionId = sess.id;
          sessionState.sessionFile = sess.sessionFile;
          sessionState.sessionName = sess.sessionName;
          sessionState.compacting = false;
          session.setHistoryFor(sess.id, loadedHistory);
          // Pi is moving to this session — it's no longer "external" activity
          session.clearExternalActivity(sess.id);

          const fileStats = readSessionUsage(sess.sessionFile);
          sessionState.messageCount = fileStats.messageCount;
          sessionState.requestCount = fileStats.requestCount;
          sessionStats.tokens = fileStats.tokens;
          sessionStats.cost = 0;
          sessionStats.contextUsage = null;

          // Tell pi to switch session
          if (!alreadyActive) {
            await rpc.switchSession(sess.sessionFile);
            setLastSession(token, sess.sessionFile);
          }

          // Fetch stats AFTER switch so contextUsage reflects the new session
          try {
            const rpcStats = await rpc.getSessionStats();
            if (rpcStats.contextUsage) sessionStats.contextUsage = rpcStats.contextUsage;
            if (rpcStats.cost) sessionStats.cost = rpcStats.cost;
          } catch (err) { console.error("[autere] post-switch stats failed:", err); }

          // Return history in the response so the requesting client gets it
          // directly. Other clients keep their own session tracking unchanged.
          sendJSON(res, { success: true, streamHistory: dedupHistory(loadedHistory).slice(-50), sessionState: { ...sessionState }, sessionStats: { ...sessionStats } });
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to switch session: ${err}` }, 500);
        }
      });
      return;
    }

    if (url.pathname === '/api/new-session' && req.method === 'POST') {
      try {
        session.state.newSessionCreating = true;

        // 1. Create new session in pi over RPC
        await rpc.newSession();

        // 2. Get the state pi reports AFTER creating the session
        const state = await rpc.getState();
        if (!state.sessionId || !state.sessionFile) {
          throw new Error('pi created session but did not return a sessionId or sessionFile');
        }

        // All clients must follow pi to the new session — the pi process
        // is now on this session, so live streaming events are for it.
        session.setAllClientsSession(state.sessionId);

        // 3. Update our in-memory state with the session pi confirmed
        sessionState.sessionId = state.sessionId;
        sessionState.sessionFile = state.sessionFile;
        sessionState.sessionName = state.sessionName || null;
        sessionState.isStreaming = state.isStreaming;
        sessionState.compacting = state.isCompacting;
        if (state.model) {
          sessionState.model = { provider: state.model.provider, id: state.model.id, name: state.model.name || state.model.id };
        }
        setLastSession(token, state.sessionFile);

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
        availableSessions.unshift(newSessionInfo);

        session.setHistoryFor(state.sessionId, []);

        session.state.newSessionCreating = false;

        // Return navigate URL in response — do NOT broadcast via SSE
        // because broadcast() sends to ALL clients, not just the one that
        // requested the new session.
        sendJSON(res, { success: true, navigateUrl: `/session/${state.sessionId}` });
      } catch (err) {
        session.state.newSessionCreating = false;
        console.error('[autere] /api/new-session failed:', err);
        // Broadcast error so the frontend can show it to the user
        session.broadcast({ type: 'error', data: { message: `Failed to create new session: ${err}` } });
        sendJSON(res, { success: false, error: `Failed to start new session: ${err}` });
      }
      return;
    }

    if (url.pathname === '/api/session-name' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { name } = JSON.parse(body);
          if (typeof name !== 'string') {
            sendJSON(res, { success: false, error: 'name must be a string' }, 400);
            return;
          }
          const trimmed = name.trim();
          sessionState.sessionName = trimmed || null;
          session.broadcastToSession(sessionState.sessionId, { type: 'status', data: { ...sessionState } });
          const sess = availableSessions.find(s => s.id === sessionState.sessionId);
          if (sess) sess.sessionName = trimmed || null;
          session.broadcast({ type: 'sessions', data: availableSessions });
          await rpc.setSessionName(trimmed);
          sendJSON(res, { success: true });
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to set session name: ${err}` }, 400);
        }
      });
      return;
    }

    // ── User settings ──

    if (url.pathname === '/api/settings/schema' && req.method === 'GET') {
      const schema = getUserSettingsSchema(user);
      sendJSON(res, { success: true, data: schema });
      return;
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      const settings = getAllUserSettings(user);
      sendJSON(res, { success: true, data: settings });
      return;
    }

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const settings = JSON.parse(body);
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
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to save settings: ${err}` }, 500);
        }
      });
      return;
    }

    if (url.pathname === '/api/send' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { message, type } = JSON.parse(body);
          if (!message || typeof message !== 'string' || !message.trim()) {
            sendJSON(res, { success: false, error: 'Message is required' }, 400);
            return;
          }
          const text = message.trim();
          if (type === 'steer') {
            await rpc.steer(text);
          } else if (type === 'followUp') {
            await rpc.followUp(text);
          } else if (rpc.isStreaming) {
            await rpc.steer(text);
          } else {
            await rpc.prompt(text);
          }
          sendJSON(res, { success: true });
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to send message: ${err}` }, 400);
        }
      });
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
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Set-Cookie': `autere-client-id=${clientId}; Path=/; SameSite=Lax`,
      });
      // Track which session this client is viewing (starts with current session)
      session.sseClients.set(res, sessionState.sessionId);
      session.registerClientId(clientId, res);

      // Send initial state to newly connected client.
      // Do NOT send stream_history here — sessionState.sessionId reflects the
      // pi process's current session which may not be the session this client
      // is viewing. The frontend gets the correct history from the switch-by-id
      // response or the /api/sessions/:id/history endpoint.
      res.write(`data: ${JSON.stringify({ type: 'status', data: sessionState })}\n\n`);
      rpc.getSessionStats().then(stats => {
        if (stats.contextUsage) sessionStats.contextUsage = stats.contextUsage;
        if (stats.cost) sessionStats.cost = stats.cost;
        res.write(`data: ${JSON.stringify({ type: 'stats', data: sessionStats })}\n\n`);
      }).catch(() => {
        res.write(`data: ${JSON.stringify({ type: 'stats', data: sessionStats })}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ type: 'stream_history', data: [] })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'tool_end', data: { id: null, recentTools } })}\n\n`);
      // Log extensions being sent

      res.write(`data: ${JSON.stringify({ type: 'extensions', data: extensionsState })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'models', data: availableModels })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'sessions', data: availableSessions })}\n\n`);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // ── Periodic polling for extensions and sessions (global) ──
  readExtensions();
  availableSessions.length = 0;
  availableSessions.push(...readSessions());
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
    const newSessions = readSessions();
    // Preserve in-memory entries for newly created sessions whose files don't
    // exist on disk yet (pi only writes the session file on the first message).
    // Without this, the poller wipes the entry injected by /api/new-session
    // and a subsequent switch-by-id 404s with "Session not found".
    const diskIds = new Set(newSessions.map(s => s.id));
    const activeIds = new Set<string>();
    for (const token of pm.activeTokens()) {
      const s = pm.get(token);
      if (s?.state?.sessionState?.sessionId) activeIds.add(s.state.sessionState.sessionId);
    }
    const pending = availableSessions.filter(s => !diskIds.has(s.id) && activeIds.has(s.id));
    availableSessions.length = 0;
    availableSessions.push(...pending, ...newSessions);
    // Update all sessions with new session list
    for (const token of pm.activeTokens()) {
      const session = pm.get(token);
      if (session) {
        session.state.availableSessions = [...availableSessions];
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
      console.error(`[autere] Port ${PORT} is already in use — dashboard server not started.`);
    } else {
      console.error('[autere] Server error:', err);
    }
  });

  server.listen(PORT, () => {
    console.log(`[autere] Dashboard running at http://localhost:${PORT}`);
  });

  process.on('SIGTERM', () => shutdown(server, pm, sessionRefreshInterval, heartbeatInterval));
  process.on('SIGINT', () => shutdown(server, pm, sessionRefreshInterval, heartbeatInterval));

  return server;
}

function shutdown(server: ReturnType<typeof createServer> | null, pm: ProcessManager, sessionRefreshInterval: ReturnType<typeof setInterval> | null, heartbeatInterval: ReturnType<typeof setInterval> | null) {
  if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (server) server.close();
  pm.terminateAll().catch(() => {});
}
