// ── Core mutable state ──
export let sessionState = {
    model: null,
    thinkingLevel: 'off',
    isStreaming: false,
    messageCount: 0,
    requestCount: 0,
    pendingMessageCount: 0,
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    connected: false,
    startTime: Date.now(),
    externalActivity: false,
    compacting: false
};
export let sessionStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    contextUsage: null
};
// ── Stream history ──
export let streamHistory = [];
export let currentStreamText = '';
export let currentStreamRole = '';
export let activeStreamIdx = null;
// ── Message / tool tracking ──
export let recentMessages = [];
export let activeTools = new Map();
export let recentTools = [];
// ── Models ──
export let availableModels = [];
// ── Extensions ──
export let extensionsState = [];
// ── Sessions ──
export let availableSessions = [];
export let sessionsRetryTimeout = null;
// ── SSE clients ──
export const sseClients = new Set();
// ── Model registry reference (safe to keep — it's not session-bound) ──
export let currentModelRegistry = null;
// ── Session creation flag ──
export let newSessionCreating = false;
// ── History loaded marker ──
export let historyLoadedSessionId = null;
// ── External activity tracking ──
export let lastEventTime = Date.now();
export let lastKnownFileSize = 0;
export let externalCheckInterval = null;
export let externalWatchActive = false;
export let currentPollInterval = 15_000;
export let consecutiveNoMessagePolls = 0;
export let lastExternalActivityTime = 0;
// ── Setters for state ──
export function setCurrentModelRegistry(registry) { currentModelRegistry = registry; }
export function setNewSessionCreating(val) { newSessionCreating = val; }
export function setHistoryLoadedSessionId(id) { historyLoadedSessionId = id; }
export function setAvailableModels(models) { availableModels = models; }
export function setLastEventTime(t) { lastEventTime = t; }
export function setLastKnownFileSize(s) { lastKnownFileSize = s; }
export function setExternalCheckInterval(i) { externalCheckInterval = i; }
export function setExternalWatchActive(a) { externalWatchActive = a; }
export function setCurrentPollInterval(p) { currentPollInterval = p; }
export function setSessionsRetryTimeout(t) { sessionsRetryTimeout = t; }
export function setConsecutiveNoMessagePolls(n) { consecutiveNoMessagePolls = n; }
export function setLastExternalActivityTime(t) { lastExternalActivityTime = t; }
export function setActiveStreamIdx(i) { activeStreamIdx = i; }
export function setCurrentStreamText(t) { currentStreamText = t; }
export function setCurrentStreamRole(r) { currentStreamRole = r; }
export function resetSessionState() {
    sessionState.messageCount = 0;
    sessionState.requestCount = 0;
    sessionState.isStreaming = false;
    sessionStats.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    sessionStats.cost = 0;
    sessionStats.contextUsage = null;
    recentMessages.length = 0;
    activeTools.clear();
    recentTools.length = 0;
    streamHistory.length = 0;
    currentStreamText = '';
    currentStreamRole = '';
    activeStreamIdx = null;
    historyLoadedSessionId = null;
}
