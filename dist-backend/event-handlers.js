import { sessionState, sessionStats, streamHistory, recentMessages, activeTools, recentTools, availableModels, setAvailableModels, resetSessionState, activeStreamIdx, currentStreamText, setActiveStreamIdx, setCurrentStreamText, setCurrentStreamRole, setCurrentModelRegistry } from './state.js';
import { broadcast, dedupStreamHistory, extractFullText, extractPreview, formatToolArgs, readSessionUsage, readSessionHistory } from './utils.js';
import { readSessions } from './sessions.js';
import { updateLastEventTime, stopExternalMonitoring } from './external-activity.js';
// ── Pi event handlers ──
export function registerEventHandlers(pi, piRef) {
    // ── Session lifecycle ──
    pi.on('session_start', (_event, ctx) => {
        // NOTE: Do NOT store ctx as currentCtx — it becomes stale after
        // newSession/switchSession/fork/reload. Store only safe references
        // like the model registry.
        const sessionId = ctx?.sessionManager?.getSessionId?.();
        const sessionFile = ctx?.sessionManager?.getSessionFile?.();
        const prevSessionId = sessionState.sessionId;
        const alreadyLoaded = streamHistory.length > 0 && prevSessionId === sessionId;
        if (sessionId) {
            sessionState.sessionId = sessionId;
        }
        if (sessionFile) {
            sessionState.sessionFile = sessionFile;
        }
        sessionState.sessionName = ctx?.sessionManager?.getSessionName?.() || null;
        if (!alreadyLoaded) {
            resetSessionState();
            if (sessionFile) {
                const existingHistory = readSessionHistory(sessionFile, 50);
                if (existingHistory.length > 0) {
                    streamHistory.push(...existingHistory);
                }
                const fileStats = readSessionUsage(sessionFile);
                sessionState.messageCount = fileStats.messageCount;
                sessionState.requestCount = fileStats.requestCount;
                sessionStats.tokens = fileStats.tokens;
                sessionStats.cost = 0;
            }
        }
        broadcast({ type: 'status', data: { ...sessionState } });
        broadcast({ type: 'stats', data: { ...sessionStats } });
        broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
        readSessions();
        // Capture model from context
        if (ctx?.model) {
            sessionState.model = {
                provider: ctx.model.provider,
                id: ctx.model.id,
                name: ctx.model.name || ctx.model.id
            };
        }
        // Capture available scoped models and store the model registry for set-model
        if (ctx?.scopedModels && ctx.scopedModels.length > 0) {
            setAvailableModels(ctx.scopedModels.map((m) => ({
                provider: m.model.provider,
                id: m.model.id,
                name: m.model.name || m.model.id,
                thinkingLevel: m.thinkingLevel
            })));
        }
        else if (ctx?.modelRegistry) {
            try {
                setCurrentModelRegistry(ctx.modelRegistry);
                const allModels = ctx.modelRegistry.getAvailable();
                if (allModels && allModels.length > 0) {
                    setAvailableModels(allModels.map((m) => ({
                        provider: m.provider,
                        id: m.id,
                        name: m.name || m.id,
                        thinkingLevel: undefined
                    })));
                }
            }
            catch (err) {
                console.error('[pi-monitor] Failed to read model registry:', err);
            }
        }
        broadcast({ type: 'models', data: availableModels });
    });
    pi.on('session_info_changed', (event, _ctx) => {
        sessionState.sessionName = event.name || null;
        broadcast({ type: 'status', data: { ...sessionState } });
    });
    pi.on('session_shutdown', () => {
        stopExternalMonitoring();
        sessionState.compacting = false;
        disconnectAllClients();
        piRef; // keep ref alive
    });
    pi.on('session_before_compact', () => {
        sessionState.compacting = true;
        broadcast({ type: 'status', data: { ...sessionState } });
    });
    pi.on('session_compact', (event) => {
        sessionState.compacting = false;
        const sessionFile = sessionState.sessionFile;
        if (sessionFile) {
            const fileStats = readSessionUsage(sessionFile);
            sessionState.messageCount = fileStats.messageCount;
            sessionState.requestCount = fileStats.requestCount;
            sessionStats.tokens = fileStats.tokens;
        }
        broadcast({ type: 'status', data: { ...sessionState } });
        broadcast({ type: 'stats', data: { ...sessionStats } });
        event; // keep ref alive
    });
    // ── Model selection ──
    pi.on('model_select', (event, ctx) => {
        if (event.model) {
            sessionState.model = {
                provider: event.model.provider,
                id: event.model.id,
                name: event.model.name || event.model.id
            };
            broadcast({ type: 'status', data: { ...sessionState } });
        }
        if (ctx?.scopedModels && ctx.scopedModels.length > 0) {
            setAvailableModels(ctx.scopedModels.map((m) => ({
                provider: m.model.provider,
                id: m.model.id,
                name: m.model.name || m.model.id,
                thinkingLevel: m.thinkingLevel
            })));
            broadcast({ type: 'models', data: availableModels });
        }
        else if (ctx?.modelRegistry) {
            try {
                setCurrentModelRegistry(ctx.modelRegistry);
                const allModels = ctx.modelRegistry.getAvailable();
                if (allModels && allModels.length > 0) {
                    setAvailableModels(allModels.map((m) => ({
                        provider: m.provider,
                        id: m.id,
                        name: m.name || m.id,
                        thinkingLevel: undefined
                    })));
                    broadcast({ type: 'models', data: availableModels });
                }
            }
            catch (err) {
                console.error('[pi-monitor] Failed to read model registry:', err);
            }
        }
    });
    // ── Turn / agent lifecycle ──
    pi.on('turn_start', () => {
        updateLastEventTime();
        sessionState.requestCount++;
        broadcast({ type: 'status', data: { ...sessionState } });
    });
    pi.on('agent_start', (_event, ctx) => {
        updateLastEventTime();
        sessionState.isStreaming = true;
        if (!sessionState.model && ctx?.model) {
            sessionState.model = {
                provider: ctx.model.provider,
                id: ctx.model.id,
                name: ctx.model.name || ctx.model.id
            };
        }
        broadcast({ type: 'status', data: { ...sessionState } });
    });
    pi.on('agent_end', (event, ctx) => {
        updateLastEventTime();
        sessionState.isStreaming = false;
        const usage = ctx?.getContextUsage?.();
        if (usage) {
            sessionStats.contextUsage = {
                tokens: usage.tokens || 0,
                contextWindow: usage.contextWindow || 0,
                percent: usage.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : 0
            };
            broadcast({ type: 'stats', data: { ...sessionStats } });
        }
        broadcast({ type: 'status', data: { ...sessionState } });
        event; // keep ref alive
    });
    pi.on('agent_settled', () => {
        updateLastEventTime();
        sessionState.isStreaming = false;
        broadcast({ type: 'status', data: { ...sessionState } });
    });
    // ── Message streaming ──
    let currentThinkingText = '';
    let isThinking = false;
    pi.on('message_update', (event, ctx) => {
        updateLastEventTime();
        const evt = event.assistantMessageEvent;
        if (!evt)
            return;
        if (evt.type === 'thinking_start') {
            isThinking = true;
            currentThinkingText = '';
        }
        else if (evt.type === 'thinking_delta') {
            currentThinkingText += evt.delta;
            const idx = activeStreamIdx;
            if (idx === null || streamHistory[idx]?.role !== 'thinking') {
                if (idx !== null && streamHistory[idx]) {
                    streamHistory[idx].streaming = false;
                }
                streamHistory.push({ role: 'thinking', text: currentThinkingText, streaming: true, timestamp: Date.now() });
                setActiveStreamIdx(streamHistory.length - 1);
            }
            else {
                streamHistory[idx].text = currentThinkingText;
            }
            broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
        }
        else if (evt.type === 'thinking_end') {
            isThinking = false;
            const text = evt.content || currentThinkingText;
            const idx = activeStreamIdx;
            if (idx !== null && streamHistory[idx]?.role === 'thinking' && streamHistory[idx]?.streaming) {
                streamHistory[idx].streaming = false;
                streamHistory[idx].text = text;
            }
            else if (text) {
                streamHistory.push({ role: 'thinking', text, streaming: false, timestamp: Date.now() });
            }
            setActiveStreamIdx(null);
            currentThinkingText = '';
            broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
        }
        else if (evt.type === 'text_delta') {
            const delta = evt.delta;
            const idx = activeStreamIdx;
            if (idx === null || streamHistory[idx]?.role !== 'assistant') {
                if (idx !== null && streamHistory[idx]) {
                    streamHistory[idx].streaming = false;
                }
                setCurrentStreamRole('assistant');
                setCurrentStreamText('');
                streamHistory.push({ role: 'assistant', text: '', streaming: true, timestamp: Date.now() });
                setActiveStreamIdx(streamHistory.length - 1);
            }
            setCurrentStreamText(currentStreamText + delta);
            streamHistory[activeStreamIdx].text = currentStreamText;
            broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
        }
        const usage = ctx?.getContextUsage?.();
        if (usage) {
            sessionStats.contextUsage = {
                tokens: usage.tokens || 0,
                contextWindow: usage.contextWindow || 0,
                percent: usage.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : 0
            };
            broadcast({ type: 'stats', data: { ...sessionStats } });
        }
    });
    pi.on('message_end', (event) => {
        updateLastEventTime();
        if (!event.message)
            return;
        sessionState.messageCount++;
        recentMessages.push({
            role: event.message.role,
            timestamp: event.message.timestamp,
            preview: extractPreview(event.message)
        });
        if (recentMessages.length > 50)
            recentMessages.shift();
        broadcast({ type: 'message', data: event.message });
        const msgUsage = event.message.usage;
        if (msgUsage) {
            if (msgUsage.input)
                sessionStats.tokens.input = (sessionStats.tokens.input || 0) + msgUsage.input;
            if (msgUsage.output)
                sessionStats.tokens.output = (sessionStats.tokens.output || 0) + msgUsage.output;
            if (msgUsage.cacheRead)
                sessionStats.tokens.cacheRead = (sessionStats.tokens.cacheRead || 0) + msgUsage.cacheRead;
            if (msgUsage.cacheWrite)
                sessionStats.tokens.cacheWrite = (sessionStats.tokens.cacheWrite || 0) + msgUsage.cacheWrite;
            if (msgUsage.cost)
                sessionStats.cost = (sessionStats.cost || 0) + (msgUsage.cost.total || 0);
        }
        broadcast({ type: 'stats', data: { ...sessionStats } });
        broadcast({ type: 'status', data: { ...sessionState } });
        const msgTimestamp = event.message.timestamp ? new Date(event.message.timestamp).getTime() : Date.now();
        const fullText = extractFullText(event.message);
        const msgRole = event.message.role || '';
        // Find last streaming entry with matching role (search backward)
        let foundIdx = null;
        for (let i = streamHistory.length - 1; i >= 0; i--) {
            if (streamHistory[i].streaming && streamHistory[i].role === msgRole) {
                foundIdx = i;
                break;
            }
        }
        if (foundIdx !== null) {
            streamHistory[foundIdx].streaming = false;
            streamHistory[foundIdx].text = fullText || streamHistory[foundIdx].text;
            streamHistory[foundIdx].timestamp = msgTimestamp;
            if (activeStreamIdx !== null && activeStreamIdx !== foundIdx && streamHistory[activeStreamIdx]?.streaming) {
                streamHistory[activeStreamIdx].streaming = false;
            }
        }
        else if (fullText) {
            streamHistory.push({ role: msgRole, text: fullText, streaming: false, timestamp: msgTimestamp });
        }
        setActiveStreamIdx(null);
        setCurrentStreamText('');
        setCurrentStreamRole('');
        // Detect errors
        const msg = event.message;
        let errorText = null;
        if (msg.role === 'toolResult' && msg.isError) {
            const toolName = msg.toolName || 'tool';
            const textContent = msg.content?.find((c) => c.type === 'text');
            const errDetail = textContent?.text || '';
            errorText = `[${toolName} error]${errDetail ? ' ' + errDetail : ''}`;
        }
        else if (msg.stopReason === 'error' || msg.errorMessage) {
            errorText = msg.errorMessage || 'An error occurred';
        }
        if (errorText) {
            streamHistory.push({ role: 'system', text: errorText, streaming: false, timestamp: msgTimestamp, isError: true });
            broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
        }
        broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
    });
    // ── Tool execution ──
    pi.on('tool_execution_start', (event) => {
        updateLastEventTime();
        const cmd = formatToolArgs(event.toolName, event.args);
        activeTools.set(event.toolCallId, { name: event.toolName, args: event.args, cmd, startTime: Date.now() });
        broadcast({ type: 'tool_start', data: { id: event.toolCallId, name: event.toolName, cmd } });
    });
    pi.on('tool_execution_end', (event) => {
        updateLastEventTime();
        const tool = activeTools.get(event.toolCallId);
        const cmd = tool?.cmd || '';
        const args = tool?.args || {};
        activeTools.delete(event.toolCallId);
        recentTools.unshift({ name: event.toolName, isError: event.isError, timestamp: Date.now(), args });
        if (recentTools.length > 5)
            recentTools.length = 5;
        broadcast({ type: 'tool_end', data: { id: event.toolCallId, name: event.toolName, isError: event.isError, cmd, recentTools } });
    });
}
import { sseClients } from './state.js';
// ── Disconnect all SSE clients ──
function disconnectAllClients() {
    for (const client of sseClients) {
        try {
            client.end();
        }
        catch { }
    }
    sseClients.clear();
}
