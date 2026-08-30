/**
 * HTTP server and API routes for autere dashboard.
 *
 * All pi operations are performed via RPC commands to the pi process,
 * instead of using the pi extension API.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { PI_DIR } from './constants.js';
import type { MonitorRpcClient } from './rpc-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  sessionState, sessionStats, streamHistory, recentMessages, activeTools,
  availableModels, extensionsState, availableSessions,
  sseClients, newSessionCreating, setNewSessionCreating,
  currentStreamText, currentStreamRole, activeStreamIdx,
  setActiveStreamIdx, setCurrentStreamText, setCurrentStreamRole,
  historyLoadedSessionId, setHistoryLoadedSessionId, setAvailableModels,
  resetSessionState
} from './state.js';
import { broadcast, dedupStreamHistory, sendJSON, getDashboardHTML, readSessionUsage, readSessionHistory, filterScopedModels } from './utils.js';
import { checkAuth, requireAuth, parseCookies, generateToken, addAuthToken, removeAuthToken, saveAuthTokens, getAuthEnabled, getAuthTokenExpiry, getAuthPassword } from './auth.js';
import { readExtensions } from './extensions.js';
import { readSessions } from './sessions.js';

// ── Base path detection from proxy headers ──

/**
 * Detect the base path from reverse-proxy headers.
 *
 * Priority:
 *  1. X-Forwarded-Prefix / X-Forwarded-Base  (explicit path prefix)
 *  2. X-Forwarded-Proto + X-Forwarded-Host    (reconstruct origin)
 *  3. Host header                              (reconstruct origin)
 *  4. nothing (returns '')
 *
 * Returns a string like "/monitor" (no trailing slash).
 */
function detectBasePath(req: IncomingMessage): string {
  // 1. Explicit prefix header (set by Traefik, custom nginx rules, etc.)
  const prefix = (req.headers['x-forwarded-path'] || req.headers['x-forwarded-prefix'] || req.headers['x-forwarded-base'] || '') as string;
  if (prefix) {
    return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  }

  // 2. Reconstruct origin from forwarded headers — only useful if the
  //    original URL path is longer than what the backend sees.
  const proto = (req.headers['x-forwarded-proto'] || '') as string;
  const host  = (req.headers['x-forwarded-host'] || req.headers['host'] || '') as string;
  if (proto && host) {
    // If the backend is mounted at a sub-path that isn't part of the
    // proxy rewrite, we can't guess it from headers alone.  Return ''
    // and let the caller fall back to URL-based stripping.
    //
    // However, when the proxy forwards the *full* original path, the
    // backend receives something like "/monitor/api/state".  In that
    // case detectBasePathFromURL() (called below) will figure it out.
  }

  return '';
}

/**
 * If no proxy prefix header is present, try to infer the base path by
 * checking whether the request URL contains a known internal route
 * (e.g. /api/, /events) that is preceded by extra path segments.
 *
 * E.g. request URL "/monitor/api/state" → base path "/monitor".
 */
function detectBasePathFromURL(requestPath: string): string {
  // Match everything before a known internal route
  const match = requestPath.match(/^(.+)\/(?:api\/|events)/);
  if (match && match[1]) {
    return match[1];  // e.g. "/monitor"
  }
  return '';
}

// ── HTTP server setup ──

export function createMonitorServer(PORT: number, rpc: MonitorRpcClient): ReturnType<typeof createServer> | null {
  let sessionRefreshInterval: ReturnType<typeof setInterval> | null = null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Detect base path from proxy headers ──
    let basePath = detectBasePath(req);
    let requestPath = req.url || '/';

    // If no explicit prefix header, infer from the URL itself
    if (!basePath) {
      basePath = detectBasePathFromURL(requestPath);
    }

    // Strip the base path prefix so downstream routing works as if
    // the server were mounted at /
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
          const { password } = JSON.parse(body);
          if (!getAuthEnabled()) {
            sendJSON(res, { success: true, message: 'Authentication disabled' });
            return;
          }
          if (password !== getAuthPassword()) {
            sendJSON(res, { success: false, error: 'Invalid password' }, 401);
            return;
          }
          const token = generateToken();
          addAuthToken(token);
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
      sendJSON(res, { success: true, data: { authEnabled: getAuthEnabled(), authenticated: checkAuth(req) } });
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
      if (!existsSync(staticPath)) {
        staticPath = join(__dirname, '..', '..', 'public', url.pathname);
      }
      if (existsSync(staticPath)) {
        const ext = staticPath.split('.').pop();
        const mime: Record<string, string> = { js: 'application/javascript', css: 'text/css', json: 'application/json', png: 'image/png', svg: 'image/svg+xml' };
        res.writeHead(200, { 'Content-Type': mime[ext || ''] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(readFileSync(staticPath));
        return;
      }
      // SPA fallback
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/events') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(getDashboardHTML(basePath));
        return;
      }
    }

    // ── Require auth for all API / SSE endpoints ──

    if (requireAuth(req, res)) return;

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
      // Fetch models on demand if list is empty — filter to scoped models only
      if (availableModels.length === 0) {
        try {
          const models = await rpc.getAvailableModels();
          const scoped = filterScopedModels(models);
          setAvailableModels(scoped.map((m: any) => ({
            provider: m.provider,
            id: m.id,
            name: m.name || m.id,
            thinkingLevel: undefined
          })));
        } catch (err) {
          console.error('[autere] Failed to fetch models on demand:', err);
        }
      }
      console.log(`[autere] /api/models returning ${availableModels.length} models:`, availableModels.map(m => `${m.provider}/${m.id}`));
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
          await rpc.setModel(provider, modelId);
          sendJSON(res, { success: true });
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to set model: ${err}` }, 500);
        }
      });
      return;
    }

    if (url.pathname === '/api/restart' && req.method === 'POST') {
      sendJSON(res, { success: true });
      setTimeout(() => {
        try { if (typeof process.exit === 'function') process.exit(0); } catch {}
      }, 200);
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
      try {
        await rpc.compact();
        sendJSON(res, { success: true });
      } catch (err) {
        sendJSON(res, { success: false, error: `Failed to compact: ${err}` });
      }
      return;
    }

    // ── Session management ──

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      sendJSON(res, { success: true, data: availableSessions });
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/history$/);
    if (historyMatch && req.method === 'GET') {
      const sessionId = historyMatch[1];
      const session = availableSessions.find(s => s.id === sessionId);
      if (!session) {
        sendJSON(res, { success: false, error: 'Session not found' }, 404);
        return;
      }
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const history = readSessionHistory(session.sessionFile, Math.min(limit, 100));
      sendJSON(res, { success: true, data: history });
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
          if (sessionState.sessionId === sessionId) {
            sendJSON(res, { success: true, alreadyActive: true });
            return;
          }
          const session = availableSessions.find(s => s.id === sessionId);
          if (!session) {
            sendJSON(res, { success: false, error: 'Session not found' }, 404);
            return;
          }

          const history = readSessionHistory(session.sessionFile, 30);
          streamHistory.length = 0;
          sessionState.compacting = false;
          if (history.length > 0) {
            streamHistory.push({ role: 'system', text: `— Loaded ${history.length} messages from session —`, streaming: false, timestamp: Date.now() });
            streamHistory.push(...history);
            setHistoryLoadedSessionId(session.id);
          } else {
            streamHistory.push({ role: 'system', text: '— Switching session —', streaming: false, timestamp: Date.now() });
          }
          setCurrentStreamText('');
          setCurrentStreamRole('');
          sessionState.sessionId = session.id;
          sessionState.sessionFile = session.sessionFile;
          sessionState.sessionName = session.sessionName;

          // Read basic stats from file first
          const fileStats = readSessionUsage(session.sessionFile);
          sessionState.messageCount = fileStats.messageCount;
          sessionState.requestCount = fileStats.requestCount;
          sessionStats.tokens = fileStats.tokens;
          sessionStats.cost = 0;
          sessionStats.contextUsage = null;
          
          // Also fetch full stats via RPC for contextUsage and cost
          try {
            const rpcStats = await rpc.getSessionStats();
            if (rpcStats.contextUsage) {
              sessionStats.contextUsage = rpcStats.contextUsage;
            }
            if (rpcStats.cost) {
              sessionStats.cost = rpcStats.cost;
            }
          } catch (err) {
            console.error('[autere] Failed to fetch session stats via RPC:', err);
          }

          broadcast({ type: 'status', data: { ...sessionState } });
          broadcast({ type: 'stats', data: { ...sessionStats } });
          broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });

          // Use RPC to switch session
          await rpc.switchSession(session.sessionFile);
          sendJSON(res, { success: true });
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to switch session: ${err}` }, 500);
        }
      });
      return;
    }

    if (url.pathname === '/api/sessions/switch' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { sessionFile } = JSON.parse(body);
          if (!sessionFile || typeof sessionFile !== 'string') {
            sendJSON(res, { success: false, error: 'sessionFile is required' }, 400);
            return;
          }
          const foundSession = availableSessions.find(s => s.sessionFile === sessionFile);
          const history = readSessionHistory(sessionFile, 30);
          streamHistory.length = 0;
          sessionState.compacting = false;
          if (history.length > 0) {
            streamHistory.push({ role: 'system', text: `— Loaded ${history.length} messages from session —`, streaming: false, timestamp: Date.now() });
            streamHistory.push(...history);
            setHistoryLoadedSessionId(foundSession?.id || null);
          } else {
            streamHistory.push({ role: 'system', text: '— Switching session —', streaming: false, timestamp: Date.now() });
          }
          setCurrentStreamText('');
          setCurrentStreamRole('');
          setActiveStreamIdx(null);
          sessionState.sessionId = foundSession?.id || null;
          sessionState.sessionFile = sessionFile;
          sessionState.sessionName = foundSession?.sessionName || null;

          const fileStats = readSessionUsage(sessionFile);
          sessionState.messageCount = fileStats.messageCount;
          sessionState.requestCount = fileStats.requestCount;
          sessionStats.tokens = fileStats.tokens;
          sessionStats.cost = 0;

          broadcast({ type: 'status', data: { ...sessionState } });
          broadcast({ type: 'stats', data: { ...sessionStats } });
          broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });

          // Use RPC to switch session
          await rpc.switchSession(sessionFile);
          sendJSON(res, { success: true });
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to switch session: ${err}` }, 500);
        }
      });
      return;
    }

    if (url.pathname === '/api/new-session' && req.method === 'POST') {
      try {
        setNewSessionCreating(true);
        resetSessionState();
        broadcast({ type: 'stream_history', data: [] });
        broadcast({ type: 'new_session_creating' });

        // Create new session via RPC
        await rpc.newSession();

        // Fetch the new session state from pi
        const state = await rpc.getState();
        const newSessionId = state.sessionId;
        const newSessionFile = state.sessionFile;
        const prevSessionId = sessionState.sessionId;

        console.log(`[autere] /api/new-session: created session ${newSessionId} (was ${prevSessionId})`);

        // Update server state
        if (newSessionId) sessionState.sessionId = newSessionId;
        if (newSessionFile) sessionState.sessionFile = newSessionFile;
        sessionState.sessionName = state.sessionName || null;
        sessionState.isStreaming = state.isStreaming;
        sessionState.compacting = state.isCompacting;
        if (state.model) {
          sessionState.model = {
            provider: state.model.provider,
            id: state.model.id,
            name: state.model.name || state.model.id
          };
        }

        // Fetch stats
        try {
          const stats = await rpc.getSessionStats();
          sessionState.messageCount = stats.userMessages || 0;
          sessionState.requestCount = stats.userMessages || 0;
          sessionStats.tokens = stats.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          sessionStats.cost = stats.cost || 0;
          if (stats.contextUsage) sessionStats.contextUsage = stats.contextUsage;
        } catch (statsErr) {
          console.error('[autere] Failed to get session stats after new session:', statsErr);
        }

        setNewSessionCreating(false);
        readSessions();

        // Broadcast updated state
        broadcast({ type: 'status', data: { ...sessionState } });
        broadcast({ type: 'stats', data: { ...sessionStats } });

        // Tell the frontend to navigate to the new session
        if (newSessionId) {
          broadcast({ type: 'navigate', data: { url: `/session/${newSessionId}` } });
        }

        sendJSON(res, { success: true });
      } catch (err) {
        setNewSessionCreating(false);
        console.error('[autere] /api/new-session failed:', err);
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
          broadcast({ type: 'status', data: { ...sessionState } });
          const sess = availableSessions.find(s => s.id === sessionState.sessionId);
          if (sess) sess.sessionName = trimmed || null;
          broadcast({ type: 'sessions', data: availableSessions });
          await rpc.setSessionName(trimmed);
          sendJSON(res, { success: true });
        } catch (err) {
          sendJSON(res, { success: false, error: `Failed to set session name: ${err}` }, 400);
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
          // Don't add user message here - it will be added via message_end event
          // streamHistory.push({ role: 'user', text, streaming: false, timestamp: Date.now() });
          // broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });

          // Route to the correct RPC command based on type and streaming state
          if (type === 'steer') {
            await rpc.steer(text);
          } else if (type === 'followUp') {
            await rpc.followUp(text);
          } else if (rpc.isStreaming) {
            // Default: use steer when streaming, prompt when idle
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
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));

      // Send initial state to newly connected client
      res.write(`data: ${JSON.stringify({ type: 'status', data: sessionState })}\n\n`);
      // Fetch fresh stats to ensure contextUsage is populated
      rpc.getSessionStats().then(stats => {
        if (stats.contextUsage) sessionStats.contextUsage = stats.contextUsage;
        if (stats.cost) sessionStats.cost = stats.cost;
        res.write(`data: ${JSON.stringify({ type: 'stats', data: sessionStats })}\n\n`);
      }).catch(() => {
        res.write(`data: ${JSON.stringify({ type: 'stats', data: sessionStats })}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ type: 'stream_history', data: dedupStreamHistory().slice(-50) })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'extensions', data: extensionsState })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'models', data: availableModels })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'sessions', data: availableSessions })}\n\n`);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // ── Periodic polling for extensions and sessions ──

  readExtensions();
  readSessions();
  sessionRefreshInterval = setInterval(async () => {
    const prevExt = JSON.stringify(extensionsState);
    await readExtensions();
    if (JSON.stringify(extensionsState) !== prevExt) {
      broadcast({ type: 'extensions', data: extensionsState });
    }
    readSessions();
  }, 2000);

  // ── Heartbeat — send periodic events so frontend can detect dead connections ──
  const heartbeatInterval = setInterval(() => {
    broadcast({ type: 'heartbeat', data: { ts: Date.now() } });
  }, 3000);

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[autere] Port ${PORT} is already in use — dashboard server not started.`);
    } else {
      console.error(`[autere] Server error:`, err);
    }
  });

  server.listen(PORT, () => {
    console.log(`[autere] Dashboard running at http://localhost:${PORT}`);
  });

  process.on('SIGTERM', () => shutdown(server, sessionRefreshInterval, heartbeatInterval));
  process.on('SIGINT', () => shutdown(server, sessionRefreshInterval, heartbeatInterval));

  return server;
}

function shutdown(server: ReturnType<typeof createServer> | null, sessionRefreshInterval: ReturnType<typeof setInterval> | null, heartbeatInterval: ReturnType<typeof setInterval> | null) {
  if (sessionRefreshInterval) { clearInterval(sessionRefreshInterval); }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); }
  if (server) { server.close(); }
}
