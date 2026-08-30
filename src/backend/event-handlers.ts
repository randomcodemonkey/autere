/**
 * RPC event handlers for autere.
 *
 * Translates RPC events from the pi process into internal state updates
 * and SSE broadcasts to connected dashboard clients.
 */

import type { MonitorRpcClient } from './rpc-client.js';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { filterScopedModels } from './utils.js';

// Module-level RPC client reference for use in event handlers
let _rpcRef: MonitorRpcClient | null = null;
import {
  sessionState, sessionStats, streamHistory, recentMessages, activeTools, recentTools,
  availableModels, historyLoadedSessionId,
  setHistoryLoadedSessionId, setAvailableModels, resetSessionState,
  newSessionCreating, setNewSessionCreating,
  activeStreamIdx, currentStreamText, currentStreamRole,
  setActiveStreamIdx, setCurrentStreamText, setCurrentStreamRole,
  sseClients
} from './state.js';
import { broadcast, dedupStreamHistory, extractFullText, extractPreview, formatToolArgs } from './utils.js';
import { readSessions } from './sessions.js';

// ── RPC event handlers ──

export function registerRpcEventHandlers(rpc: MonitorRpcClient) {
  _rpcRef = rpc;
  rpc.onEvent((event: JsonAgentSessionEvent) => {
    handleRpcEvent(rpc, event);
  });
}

function handleRpcEvent(rpc: MonitorRpcClient, event: any) {
  if (event.type !== 'message_update') {
    console.log(`[autere] RPC event: ${event.type}`);
  }
  switch (event.type) {
    case 'session_start':
      handleSessionStart(rpc, event);
      break;
    case 'session_info_changed':
      handleSessionInfoChanged(event);
      break;
    case 'agent_start':
      handleAgentStart();
      break;
    case 'agent_end':
      handleAgentEnd(event);
      break;
    case 'agent_settled':
      handleAgentSettled();
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event);
      break;
    case 'tool_execution_start':
      handleToolStart(event);
      break;
    case 'tool_execution_end':
      handleToolEnd(event);
      break;
    case 'model_select':
      handleModelSelect(event).catch(err => console.error('[autere] model_select handler error:', err));
      break;
    case 'compaction_start':
      handleCompactionStart();
      break;
    case 'compaction_end':
      handleCompactionEnd(event);
      break;
    case 'turn_start':
      handleTurnStart();
      break;
  }
}

// ── Session lifecycle ──

async function handleSessionStart(rpc: MonitorRpcClient, _event: any) {
  console.log(`[autere] === session_start event received ===`);
  try {
    // Get current state from RPC
    const state = await rpc.getState();
    const sessionId = state.sessionId;
    const sessionFile = state.sessionFile;
    const prevSessionId = sessionState.sessionId;
    const alreadyLoaded = streamHistory.length > 0 && prevSessionId === sessionId;

    // Update sessionState fields BEFORE any broadcasts so the frontend
    // always sees the correct sessionId.  session_start fires during
    // rpc.newSession(), racing with the /api/new-session handler.
    if (sessionId) {
      sessionState.sessionId = sessionId;
    }
    if (sessionFile) {
      sessionState.sessionFile = sessionFile;
    }
    sessionState.sessionName = state.sessionName || null;
    sessionState.isStreaming = state.isStreaming;
    sessionState.compacting = state.isCompacting;

    // Set model from RPC state
    if (state.model) {
      sessionState.model = {
        provider: state.model.provider,
        id: state.model.id,
        name: state.model.name || state.model.id
      };
    }

    // Clear the new-session-creating flag when a genuinely new session starts
    if (newSessionCreating && sessionId && sessionId !== prevSessionId) {
      setNewSessionCreating(false);
      broadcast({ type: 'status', data: { ...sessionState } });
      broadcast({ type: 'stats', data: { ...sessionStats } });
      broadcast({ type: 'models', data: availableModels });
      readSessions();
    }

    if (!alreadyLoaded) {
      resetSessionState();
    }

    // Get session stats
    try {
      const stats = await rpc.getSessionStats();
      sessionState.messageCount = stats.userMessages || 0;
      sessionState.requestCount = stats.userMessages || 0;
      sessionStats.tokens = stats.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      sessionStats.cost = stats.cost || 0;
      if (stats.contextUsage) {
        sessionStats.contextUsage = stats.contextUsage;
      }
    } catch (err) {
      console.error('[autere] Failed to get session stats:', err);
    }

    // Get available models — filter to scoped models only
    try {
      const models = await rpc.getAvailableModels();
      const scoped = filterScopedModels(models);
      console.log(`[autere] Got ${models.length} total models, ${scoped.length} scoped:`, scoped.map((m: any) => `${m.provider}/${m.id}`).join(', '));
      setAvailableModels(scoped.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        thinkingLevel: undefined
      })));
    } catch (err) {
      console.error('[autere] Failed to get available models:', err);
    }

    // Skip broadcasting status while a new session is being created —
    // the /api/new-session handler will broadcast the correct status
    // after it has fetched the new session state.
    // Also skip if the sessionId changed (stale session_start event) —
    // we only want to broadcast if the sessionId is still the same
    // as what was already in sessionState before this handler ran.
    if (!newSessionCreating && sessionId === prevSessionId) {
      broadcast({ type: 'status', data: { ...sessionState } });
      broadcast({ type: 'stats', data: { ...sessionStats } });
      broadcast({ type: 'models', data: availableModels });
      readSessions();
    }
  } catch (err) {
    console.error('[autere] Failed to handle session_start:', err);
  }
}

function handleSessionInfoChanged(event: any) {
  sessionState.sessionName = event.name || null;
  broadcast({ type: 'status', data: { ...sessionState } });
}

// ── Agent lifecycle ──

function handleAgentStart() {
  sessionState.isStreaming = true;
  broadcast({ type: 'status', data: { ...sessionState } });
}

function handleAgentEnd(event: any) {
  sessionState.isStreaming = false;
  broadcast({ type: 'status', data: { ...sessionState } });
  event; // keep ref alive
}

function handleAgentSettled() {
  sessionState.isStreaming = false;
  broadcast({ type: 'status', data: { ...sessionState } });
}

function handleTurnStart() {
  sessionState.requestCount++;
  broadcast({ type: 'status', data: { ...sessionState } });
}

// ── Message streaming ──

let currentThinkingText = '';
let isThinking = false;

function handleMessageUpdate(event: any) {
  const evt = event.assistantMessageEvent;
  if (!evt) return;

  if (evt.type === 'thinking_start') {
    isThinking = true;
    currentThinkingText = '';
  } else if (evt.type === 'thinking_delta') {
    currentThinkingText += evt.delta;
    const idx = activeStreamIdx;
    if (idx === null || streamHistory[idx]?.role !== 'thinking') {
      if (idx !== null && streamHistory[idx]) {
        streamHistory[idx].streaming = false;
      }
      streamHistory.push({ role: 'thinking', text: currentThinkingText, streaming: true, timestamp: Date.now() });
      setActiveStreamIdx(streamHistory.length - 1);
    } else {
      streamHistory[idx].text = currentThinkingText;
    }
    broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
  } else if (evt.type === 'thinking_end') {
    isThinking = false;
    const text = evt.content || currentThinkingText;
    const idx = activeStreamIdx;
    if (idx !== null && streamHistory[idx]?.role === 'thinking' && streamHistory[idx]?.streaming) {
      streamHistory[idx].streaming = false;
      streamHistory[idx].text = text;
    } else if (text) {
      streamHistory.push({ role: 'thinking', text, streaming: false, timestamp: Date.now() });
    }
    setActiveStreamIdx(null);
    currentThinkingText = '';
    broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
  } else if (evt.type === 'text_delta') {
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
    streamHistory[activeStreamIdx!].text = currentStreamText;
    broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
  }

  // Update context usage from usage in event
  const usage = event.usage;
  if (usage && (usage.input > 0 || usage.output > 0)) {
    // We don't have contextWindow here, so we just update token counts
    // The actual context usage will be updated on message_end via getSessionStats
    sessionStats.tokens.input = usage.input || 0;
    sessionStats.tokens.output = usage.output || 0;
    sessionStats.tokens.cacheRead = usage.cacheRead || 0;
    sessionStats.tokens.cacheWrite = usage.cacheWrite || 0;
    if (usage.cost) {
      sessionStats.cost = usage.cost.total || 0;
    }
  }
}

function handleMessageEnd(event: any) {
  if (!event.message) return;

  sessionState.messageCount++;
  recentMessages.push({
    role: event.message.role,
    timestamp: event.message.timestamp,
    preview: extractPreview(event.message)
  });
  if (recentMessages.length > 50) recentMessages.shift();
  broadcast({ type: 'message', data: event.message });

  const msgUsage = event.message.usage;
  if (msgUsage) {
    if (msgUsage.input) sessionStats.tokens.input = (sessionStats.tokens.input || 0) + msgUsage.input;
    if (msgUsage.output) sessionStats.tokens.output = (sessionStats.tokens.output || 0) + msgUsage.output;
    if (msgUsage.cacheRead) sessionStats.tokens.cacheRead = (sessionStats.tokens.cacheRead || 0) + msgUsage.cacheRead;
    if (msgUsage.cacheWrite) sessionStats.tokens.cacheWrite = (sessionStats.tokens.cacheWrite || 0) + msgUsage.cacheWrite;
    if (msgUsage.cost) sessionStats.cost = (sessionStats.cost || 0) + (msgUsage.cost.total || 0);
  }
  broadcast({ type: 'stats', data: { ...sessionStats } });
  broadcast({ type: 'status', data: { ...sessionState } });

  const msgTimestamp = event.message.timestamp
    ? new Date(event.message.timestamp).getTime()
    : Date.now();
  const fullText = extractFullText(event.message);
  const msgRole = event.message.role || '';

  // Find last streaming entry with matching role
  let foundIdx: number | null = null;
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
  } else if (fullText && msgRole !== 'toolResult') {
    // Skip toolResult messages here — they are added by handleToolEnd instead
    streamHistory.push({ role: msgRole, text: fullText, streaming: false, timestamp: msgTimestamp });
  }
  setActiveStreamIdx(null);
  setCurrentStreamText('');
  setCurrentStreamRole('');

  // Detect errors — skip toolResult errors (handled by handleToolEnd instead)
  const msg = event.message;
  let errorText: string | null = null;
  if (msg.role !== 'toolResult' && (msg.stopReason === 'error' || msg.errorMessage)) {
    errorText = msg.errorMessage || 'An error occurred';
  }
  if (errorText) {
    streamHistory.push({ role: 'system', text: errorText, streaming: false, timestamp: msgTimestamp, isError: true });
    broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
  }

  broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
  
  // Fetch updated session stats to get current contextUsage
  // This is async but we don't await it - let it update in the background
  if (_rpcRef) {
    _rpcRef.getSessionStats().then(stats => {
      if (stats.contextUsage) {
        sessionStats.contextUsage = stats.contextUsage;
        broadcast({ type: 'stats', data: { ...sessionStats } });
      }
    }).catch(err => {
      console.error('[autere] Failed to fetch session stats after message_end:', err);
    });
  }
}

// ── Tool execution ──

function handleToolStart(event: any) {
  const cmd = formatToolArgs(event.toolName, event.args);
  activeTools.set(event.toolCallId, { name: event.toolName, args: event.args, cmd, startTime: Date.now() });
  broadcast({ type: 'tool_start', data: { id: event.toolCallId, name: event.toolName, cmd } });
}

function handleToolEnd(event: any) {
  const tool = activeTools.get(event.toolCallId);
  const cmd = tool?.cmd || '';
  const args = tool?.args || {};
  activeTools.delete(event.toolCallId);
  recentTools.unshift({ name: event.toolName, isError: event.isError, timestamp: Date.now(), args });
  if (recentTools.length > 5) recentTools.length = 5;
  broadcast({ type: 'tool_end', data: { id: event.toolCallId, name: event.toolName, isError: event.isError, cmd, recentTools } });

  // Add tool result to stream history (for chat display)
  if (event.result || event.isError) {
    const toolName = event.toolName || 'tool';
    let text = '';
    
    // For edit tools: content.text as header, details.diff as body
    if (toolName === 'edit') {
      const header = event.result?.content
        ?.filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n') || '';
      const diff = event.result?.details?.diff || '';
      text = diff ? header + '\n\n' + diff : header;
    } else if (event.result?.content) {
      text = event.result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
    }
    
    const isError = event.isError || false;
    const role = toolName === 'edit' ? 'edit' : 'toolResult';
    const prefix = isError ? `[${toolName} error]` : (toolName === 'edit' ? '' : `[${toolName}]`);
    const displayText = prefix ? (text ? prefix + ' ' + text : prefix) : text;
    if (displayText) {
      streamHistory.push({ role, text: displayText, streaming: false, timestamp: Date.now(), isError });
      broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
    }
  }
}

// ── Model selection ──

async function handleModelSelect(event: any) {
  if (event.model) {
    sessionState.model = {
      provider: event.model.provider,
      id: event.model.id,
      name: event.model.name || event.model.id
    };
    broadcast({ type: 'status', data: { ...sessionState } });
  }
  // Refresh available models list — filter to scoped models only
  try {
    const rpc = _rpcRef;
    if (rpc) {
      const models = await rpc.getAvailableModels();
      const scoped = filterScopedModels(models);
      if (scoped.length > 0) {
        setAvailableModels(scoped.map((m: any) => ({
          provider: m.provider,
          id: m.id,
          name: m.name || m.id,
          thinkingLevel: undefined
        })));
        broadcast({ type: 'models', data: availableModels });
      }
    }
  } catch (err) {
    console.error('[autere] Failed to refresh models:', err);
  }
}

// ── Compaction ──

function handleCompactionStart() {
  sessionState.compacting = true;
  broadcast({ type: 'status', data: { ...sessionState } });
}

function handleCompactionEnd(event: any) {
  sessionState.compacting = false;
  broadcast({ type: 'status', data: { ...sessionState } });
  event; // keep ref alive
}

// ── Disconnect all SSE clients ──

export function disconnectAllClients() {
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  sseClients.clear();
}
