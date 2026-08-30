import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { PI_DIR } from './constants.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { sessionState, sessionStats, streamHistory, recentMessages, activeTools, availableModels, extensionsState, availableSessions, currentModelRegistry, sseClients, setNewSessionCreating, setActiveStreamIdx, setCurrentStreamText, setCurrentStreamRole, setHistoryLoadedSessionId } from './state.js';
import { broadcast, dedupStreamHistory, sendJSON, getDashboardHTML, readSessionUsage, readSessionHistory } from './utils.js';
import { checkAuth, requireAuth, parseCookies, generateToken, addAuthToken, removeAuthToken, saveAuthTokens, getAuthEnabled, getAuthTokenExpiry, getAuthPassword } from './auth.js';
import { readExtensions } from './extensions.js';
import { readSessions } from './sessions.js';
import { startExternalMonitoring, stopExternalMonitoring } from './external-activity.js';
// ── HTTP server setup ──
export function createMonitorServer(PORT, piRef) {
    let whatsappInterval = null;
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url || '/', `http://localhost:${PORT}`);
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
                        'Set-Cookie': `pi-monitor-token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(getAuthTokenExpiry() / 1000)}`
                    });
                    res.end(JSON.stringify({ success: true }));
                }
                catch (err) {
                    sendJSON(res, { success: false, error: `Invalid login request: ${err}` }, 400);
                }
            });
            return;
        }
        if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
            const cookies = parseCookies(req.headers.cookie || '');
            if (cookies['pi-monitor-token']) {
                removeAuthToken(cookies['pi-monitor-token']);
                saveAuthTokens();
            }
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': 'pi-monitor-token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
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
            res.end(getDashboardHTML());
            return;
        }
        if (url.pathname.startsWith('/') && !url.pathname.includes('..')) {
            let staticPath = join(__dirname, '..', '..', 'dist', url.pathname);
            if (!existsSync(staticPath)) {
                staticPath = join(__dirname, '..', '..', 'public', url.pathname);
            }
            if (existsSync(staticPath)) {
                const ext = staticPath.split('.').pop();
                const mime = { js: 'application/javascript', css: 'text/css', json: 'application/json', png: 'image/png', svg: 'image/svg+xml' };
                res.writeHead(200, { 'Content-Type': mime[ext || ''] || 'application/octet-stream' });
                res.end(readFileSync(staticPath));
                return;
            }
            // SPA fallback
            if (!url.pathname.startsWith('/api/') && url.pathname !== '/events') {
                res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
                res.end(getDashboardHTML());
                return;
            }
        }
        // ── Require auth for all API / SSE endpoints ──
        if (requireAuth(req, res))
            return;
        // ── API endpoints ──
        if (url.pathname === '/api/reconnect-whatsapp' && req.method === 'POST') {
            try {
                try {
                    await piRef.sendUserMessage('/whatsapp reconnect', { expandPromptTemplates: true });
                }
                catch (sendErr) {
                    console.error('[pi-monitor] WhatsApp reconnect send failed, trying followUp:', sendErr);
                    piRef.sendUserMessage('/whatsapp reconnect', { deliverAs: 'followUp', expandPromptTemplates: true });
                }
                const waConfigPath = join(PI_DIR, 'extensions', 'whatsapp-pi', 'config.json');
                if (existsSync(waConfigPath)) {
                    try {
                        const waConfig = JSON.parse(readFileSync(waConfigPath, 'utf-8'));
                        const newStatus = waConfig.status === 'connected' ? 'connected' : 'error';
                        const waExt = extensionsState.find(e => e.name === 'whatsapp-pi');
                        if (waExt && waExt.status !== newStatus) {
                            waExt.status = newStatus;
                            broadcast({ type: 'extensions', data: extensionsState });
                        }
                    }
                    catch (configErr) {
                        console.error('[pi-monitor] Failed to read WhatsApp config after reconnect:', configErr);
                    }
                }
                sendJSON(res, { success: true });
            }
            catch (err) {
                sendJSON(res, { success: false, error: `Failed to reconnect WhatsApp: ${err}` }, 500);
            }
            return;
        }
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
                    if (!currentModelRegistry) {
                        sendJSON(res, { success: false, error: 'Model registry not available' });
                        return;
                    }
                    const model = currentModelRegistry.find(provider, modelId);
                    if (!model) {
                        sendJSON(res, { success: false, error: `Model not found: ${provider}/${modelId}` }, 404);
                        return;
                    }
                    try {
                        piRef.sendUserMessage(`/__pi-monitor-set-model ${provider}:::${modelId}`, { expandPromptTemplates: true });
                    }
                    catch (sendErr) {
                        console.error('[pi-monitor] Set model send failed, trying followUp:', sendErr);
                        piRef.sendUserMessage(`/__pi-monitor-set-model ${provider}:::${modelId}`, { deliverAs: 'followUp', expandPromptTemplates: true });
                    }
                    sendJSON(res, { success: true });
                }
                catch (err) {
                    sendJSON(res, { success: false, error: 'Invalid request body' }, 400);
                }
            });
            return;
        }
        if (url.pathname === '/api/restart' && req.method === 'POST') {
            sendJSON(res, { success: true });
            setTimeout(() => {
                try {
                    if (typeof process.exit === 'function')
                        process.exit(0);
                }
                catch { }
            }, 200);
            return;
        }
        if (url.pathname === '/api/abort' && req.method === 'POST') {
            try {
                piRef.sendUserMessage('/__pi-monitor-abort', { expandPromptTemplates: true });
                sendJSON(res, { success: true });
            }
            catch (sendErr) {
                console.error('[pi-monitor] Abort send failed, trying followUp:', sendErr);
                try {
                    piRef.sendUserMessage('/__pi-monitor-abort', { deliverAs: 'followUp', expandPromptTemplates: true });
                    sendJSON(res, { success: true });
                }
                catch {
                    sendJSON(res, { success: false, error: 'Abort not available' });
                }
            }
            return;
        }
        if (url.pathname === '/api/compact' && req.method === 'POST') {
            if (sessionState.compacting) {
                sendJSON(res, { success: false, error: 'Compaction already in progress' }, 409);
                return;
            }
            try {
                piRef.sendUserMessage('/__pi-monitor-compact', { expandPromptTemplates: true });
                sendJSON(res, { success: true });
            }
            catch (sendErr) {
                console.error('[pi-monitor] Compact send failed, trying followUp:', sendErr);
                try {
                    piRef.sendUserMessage('/__pi-monitor-compact', { deliverAs: 'followUp', expandPromptTemplates: true });
                    sendJSON(res, { success: true });
                }
                catch {
                    sendJSON(res, { success: false, error: 'Compact not available' });
                }
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
            req.on('end', () => {
                try {
                    const { sessionId } = JSON.parse(body);
                    if (!sessionId || typeof sessionId !== 'string') {
                        sendJSON(res, { success: false, error: 'sessionId is required' }, 400);
                        return;
                    }
                    const session = availableSessions.find(s => s.id === sessionId);
                    if (!session) {
                        sendJSON(res, { success: false, error: 'Session not found' }, 404);
                        return;
                    }
                    if (sessionState.sessionId === sessionId) {
                        sendJSON(res, { success: true, alreadyActive: true });
                        return;
                    }
                    const history = readSessionHistory(session.sessionFile, 30);
                    streamHistory.length = 0;
                    sessionState.compacting = false;
                    if (history.length > 0) {
                        streamHistory.push({ role: 'system', text: `— Loaded ${history.length} messages from session —`, streaming: false, timestamp: Date.now() });
                        streamHistory.push(...history);
                        setHistoryLoadedSessionId(session.id);
                    }
                    else {
                        streamHistory.push({ role: 'system', text: '— Switching session —', streaming: false, timestamp: Date.now() });
                    }
                    setCurrentStreamText('');
                    setCurrentStreamRole('');
                    sessionState.sessionId = session.id;
                    sessionState.sessionFile = session.sessionFile;
                    sessionState.sessionName = session.sessionName;
                    const fileStats = readSessionUsage(session.sessionFile);
                    sessionState.messageCount = fileStats.messageCount;
                    sessionState.requestCount = fileStats.requestCount;
                    sessionStats.tokens = fileStats.tokens;
                    sessionStats.cost = 0;
                    broadcast({ type: 'status', data: { ...sessionState } });
                    broadcast({ type: 'stats', data: { ...sessionStats } });
                    broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
                    process.stdin.push(JSON.stringify({ type: 'switch_session', sessionPath: session.sessionFile }) + '\n');
                    sendJSON(res, { success: true });
                }
                catch (err) {
                    sendJSON(res, { success: false, error: 'Invalid request body' }, 400);
                }
            });
            return;
        }
        if (url.pathname === '/api/sessions/switch' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
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
                    }
                    else {
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
                    process.stdin.push(JSON.stringify({ type: 'switch_session', sessionPath: sessionFile }) + '\n');
                    sendJSON(res, { success: true });
                }
                catch (err) {
                    sendJSON(res, { success: false, error: `Failed to switch session: ${err}` }, 500);
                }
            });
            return;
        }
        if (url.pathname === '/api/new-session' && req.method === 'POST') {
            try {
                setNewSessionCreating(true);
                broadcast({ type: 'new_session_creating' });
                try {
                    piRef.sendUserMessage('/__pi-monitor-new-session', { expandPromptTemplates: true });
                }
                catch (sendErr) {
                    console.error('[pi-monitor] New session send failed, trying followUp:', sendErr);
                    piRef.sendUserMessage('/__pi-monitor-new-session', { deliverAs: 'followUp', expandPromptTemplates: true });
                }
                sendJSON(res, { success: true });
            }
            catch (err) {
                setNewSessionCreating(false);
                sendJSON(res, { success: false, error: `Failed to start new session: ${err}` });
            }
            return;
        }
        if (url.pathname === '/api/session-name' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
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
                    if (sess)
                        sess.sessionName = trimmed || null;
                    broadcast({ type: 'sessions', data: availableSessions });
                    const piAny = piRef;
                    if (piAny?.setSessionName) {
                        piAny.setSessionName(trimmed);
                    }
                    sendJSON(res, { success: true });
                }
                catch (err) {
                    sendJSON(res, { success: false, error: `Failed to set session name: ${err}` }, 400);
                }
            });
            return;
        }
        if (url.pathname === '/api/send' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const { message } = JSON.parse(body);
                    if (!message || typeof message !== 'string' || !message.trim()) {
                        sendJSON(res, { success: false, error: 'Message is required' }, 400);
                        return;
                    }
                    const text = message.trim();
                    streamHistory.push({ role: 'user', text, streaming: false, timestamp: Date.now() });
                    broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
                    piRef.sendUserMessage(text, { deliverAs: 'followUp' });
                    sendJSON(res, { success: true });
                }
                catch (err) {
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
            if (streamHistory.length === 0 && sessionState.sessionFile) {
                const existingHistory = readSessionHistory(sessionState.sessionFile, 50);
                if (existingHistory.length > 0) {
                    streamHistory.push(...existingHistory);
                }
                const fileStats = readSessionUsage(sessionState.sessionFile);
                sessionState.messageCount = fileStats.messageCount;
                sessionState.requestCount = fileStats.requestCount;
                sessionStats.tokens = fileStats.tokens;
                sessionStats.cost = 0;
            }
            res.write(`data: ${JSON.stringify({ type: 'status', data: sessionState })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'stats', data: sessionStats })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'stream_history', data: dedupStreamHistory().slice(-50) })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'extensions', data: extensionsState })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'models', data: availableModels })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'sessions', data: availableSessions })}\n\n`);
            return;
        }
        res.writeHead(404);
        res.end('Not Found');
    });
    // ── Periodic polling ──
    readExtensions();
    readSessions();
    whatsappInterval = setInterval(() => {
        const prevExt = JSON.stringify(extensionsState);
        readExtensions();
        if (JSON.stringify(extensionsState) !== prevExt) {
            broadcast({ type: 'extensions', data: extensionsState });
        }
        readSessions();
    }, 2000);
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[pi-monitor] Port ${PORT} is already in use — dashboard server not started.`);
        }
        else {
            console.error(`[pi-monitor] Server error:`, err);
        }
    });
    server.listen(PORT, () => {
        console.log(`[pi-monitor] Dashboard running at http://localhost:${PORT}`);
        startExternalMonitoring();
    });
    process.on('SIGTERM', () => shutdown(server, whatsappInterval));
    process.on('SIGINT', () => shutdown(server, whatsappInterval));
    return server;
}
function shutdown(server, whatsappInterval) {
    if (whatsappInterval) {
        clearInterval(whatsappInterval);
    }
    stopExternalMonitoring();
    if (server) {
        server.close();
    }
}
