/**
 * Per-user session management.
 *
 * Each UserSession encapsulates a pi RPC process, its state,
 * event handlers, and SSE clients for a single authenticated user.
 */

import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import type { ServerResponse } from 'http';
import { MonitorRpcClient } from './rpc-client.js';
import { filterScopedModels } from './utils.js';
import { getLastSession, setLastSession } from './auth.js';

/**
 * Read messages directly from a session JSONL file.
 * Used for external activity detection where RPC cached messages are stale.
 */
function readMessagesFromFile(sessionFile: string, limit: number = 100): any[] {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const messages: any[] = [];
    // Read from end (most recent) up to limit
    for (let i = lines.length - 1; i >= 0 && messages.length < limit; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'message') messages.unshift(obj);
      } catch {}
    }
    return messages;
  } catch { return []; }
}

// ── Helpers for detecting rm commands ──

function isRmCommand(command?: string): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  return /^\S*\brm\b/.test(trimmed);
}

function extractRmPaths(command: string): string[] {
  const paths: string[] = [];
  const parts = command.trim().split(/\s+/);
  let seenRm = false;
  for (const part of parts) {
    if (!seenRm) {
      if (/rm$/.test(part)) seenRm = true;
      continue;
    }
    if (part.startsWith('-')) continue;
    paths.push(part);
  }
  return paths;
}

/**
 * Shared formatting for tool results into stream history entries.
 * Used by both live tool_end events and history loading from session files.
 */
function formatToolResult(
  toolName: string,
  toolArgs: any,
  resultContent: any[] | undefined,
  isError: boolean,
  timestamp?: number,
  resultDetails?: any,
  rmSnapshots?: Record<string, string>,
): { role: string; text: string; streaming: boolean; timestamp?: number; isError?: boolean } | null {
  let text = '';
  let role: string;

  if (toolName === 'edit') {
    // Edit tools: content.text as header, details.diff as body
    const header = resultContent
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n') || '';
    const diff = resultDetails?.diff || '';
    text = diff ? header + '\n\n' + diff : header;
    role = 'edit';
  } else if (toolName === 'write') {
    // Write as edit with all lines shown as added
    const filePath = toolArgs.path || '';
    const content = toolArgs.content || '';
    const lines = typeof content === 'string' ? content.split('\n') : [];
    const diffLines = lines.map((line: string) => '+ ' + line);
    const header = filePath ? `Write ${filePath}` : 'Write';
    text = header + '\n' + diffLines.join('\n');
    role = 'edit';
  } else if (toolName === 'bash' && isRmCommand(toolArgs.command)) {
    // Rm commands as edit with removed lines
    const paths = extractRmPaths(toolArgs.command);
    const parts: string[] = [];
    for (const p of paths) {
      let content = '';
      // Use snapshot if available (live events), otherwise try to read (history)
      if (rmSnapshots && p in rmSnapshots) {
        content = rmSnapshots[p];
      } else {
        try { if (existsSync(p)) content = readFileSync(p, 'utf-8'); } catch {}
      }
      const lines = content.split('\n');
      const diffLines = lines.map((line: string) => '- ' + line);
      parts.push(`Delete ${p}\n` + diffLines.join('\n'));
    }
    text = parts.length > 0 ? parts.join('\n\n') : paths.map(p => `Delete ${p}`).join(', ');
    role = 'edit';
  } else if (resultContent) {
    text = resultContent
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
    role = 'toolResult';
  } else {
    return null;
  }

  const prefix = isError ? `[${toolName} error]` : '';
  const displayText = prefix ? (text ? prefix + ' ' + text : prefix) : text;
  if (!displayText) return null;

  return { role, text: displayText, streaming: false, timestamp, ...(isError ? { isError: true } : {}) };
}

// ── Per-user state types ──

export interface UserSessionState {
  sessionState: any;
  sessionStats: any;
  streamHistory: any[];
  recentMessages: any[];
  activeTools: Map<string, any>;
  recentTools: any[];
  availableModels: any[];
  availableSessions: any[];
  extensionsState: any[];
  newSessionCreating: boolean;
  historyLoadedSessionId: string | null;
  currentStreamText: string;
  currentStreamRole: string;
  activeStreamIdx: number | null;
  currentThinkingText: string;
  isThinking: boolean;
}

function createInitialState(): UserSessionState {
  return {
    sessionState: {
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
      compacting: false,
    },
    sessionStats: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsage: null,
    },
    streamHistory: [],
    recentMessages: [],
    activeTools: new Map(),
    recentTools: [],
    availableModels: [],
    availableSessions: [],
    extensionsState: [],
    newSessionCreating: false,
    historyLoadedSessionId: null,
    currentStreamText: '',
    currentStreamRole: '',
    activeStreamIdx: null,
    currentThinkingText: '',
    isThinking: false,
  };
}

// ── UserSession ──

export class UserSession {
  readonly token: string;
  readonly user: string;
  readonly rpc: MonitorRpcClient;
  readonly state: UserSessionState;
  readonly sseClients: Map<ServerResponse, string | null> = new Map(); // client -> sessionId they're viewing
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity: number = Date.now();
  private _idleTimeoutMs: number;
  private _onIdle: (() => void) | null = null;

  // External activity detection — watches the session file for writes by other pi processes
  private externalCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownFileSize: number = 0;
  private lastExternalActivityTime: number = 0;
  private consecutiveEventsFromPi: number = 0;

  constructor(token: string, user: string, rpcOptions: { provider?: string; model?: string; args?: string[] }, idleTimeoutMs: number = 30 * 60 * 1000) {
    this.token = token;
    this.user = user;
    // Resume this token's last session if known
    const args = [...(rpcOptions.args || [])];
    const lastSession = getLastSession(token);
    if (lastSession && !args.includes('--session') && !args.includes('--continue') && !args.includes('-c')) {
      args.push('--session', lastSession);
    }
    this.rpc = new MonitorRpcClient({ ...rpcOptions, args });
    this.state = createInitialState();
    this._idleTimeoutMs = idleTimeoutMs;
  }

  /** Set callback for when session goes idle */
  onIdle(cb: () => void) {
    this._onIdle = cb;
  }

  /** Mark activity and reset idle timer */
  touch() {
    this.lastActivity = Date.now();
    this.resetIdleTimer();
  }

  private resetIdleTimer() {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      console.log(`[autere] User "${this.user}" idle timeout, terminating pi process`);
      this._onIdle?.();
    }, this._idleTimeoutMs);
  }

  /** Broadcast an SSE event to all connected clients */
  /**
   * Broadcast an SSE event to clients viewing the current session.
   * Automatically injects sessionId into event data if not already present,
   * so only clients viewing that session receive the event.
   */
  broadcast(data: any) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const [client] of this.sseClients) {
      try { client.write(msg); } catch {}
    }
  }

  /** Broadcast an SSE event only to clients viewing a specific session */
  broadcastToSession(sessionId: string | null, data: any) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const [client, clientSessionId] of this.sseClients) {
      if (clientSessionId === sessionId) {
        try { client.write(msg); } catch {}
      }
    }
  }

  /** Update all clients to view the given session */
  setAllClientsSession(sessionId: string | null) {
    for (const [client] of this.sseClients) {
      this.sseClients.set(client, sessionId);
    }
  }

  /** Start the pi RPC process and register event handlers */
  async start(): Promise<void> {
    await this.rpc.start();
    this.state.sessionState.connected = true;
    this.state.sessionState.startTime = Date.now();

    // Register event handlers
    this.registerEventHandlers();

    // Fetch initial state
    await this.fetchInitialState();

    // Start idle timer
    this.resetIdleTimer();

    // Start watching session file for external writes
    this.startExternalActivityWatch();

    console.log(`[autere] User "${this.user}" pi process started`);
  }

  /** Stop the pi RPC process */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.stopExternalActivityWatch();
    try {
      await this.rpc.stop();
    } catch (err) {
      console.error('[autere] UserSession.stop: failed to stop RPC:', err);
    }
    // Disconnect all SSE clients
    for (const [client] of this.sseClients) {
      try { client.end(); } catch {}
    }
    this.sseClients.clear();
    console.log(`[autere] User "${this.user}" pi process stopped`);
  }

  /** Whether the pi process is running */
  get isRunning(): boolean {
    return this.rpc.isRunning;
  }

  // ── Private ──

  private async fetchInitialState(): Promise<void> {
    try {
      const state = await this.rpc.getState();
      if (state.sessionId) this.state.sessionState.sessionId = state.sessionId;
      if (state.sessionFile) this.state.sessionState.sessionFile = state.sessionFile;
      this.state.sessionState.sessionName = state.sessionName || null;
      this.state.sessionState.isStreaming = state.isStreaming;
      this.state.sessionState.compacting = state.isCompacting;
      if (state.model) {
        this.state.sessionState.model = {
          provider: state.model.provider,
          id: state.model.id,
          name: state.model.name || state.model.id,
        };
      }

      try {
        const stats = await this.rpc.getSessionStats();
        this.state.sessionState.messageCount = stats.userMessages || 0;
        this.state.sessionState.requestCount = stats.userMessages || 0;
        this.state.sessionStats.tokens = stats.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        this.state.sessionStats.cost = stats.cost || 0;
        if (stats.contextUsage) this.state.sessionStats.contextUsage = stats.contextUsage;
      } catch (err) {
        console.error('[autere] UserSession.fetchInitialState: failed to get session stats:', err);
      }

      try {
        const models = await this.rpc.getAvailableModels();
        const scoped = filterScopedModels(models);
        this.state.availableModels = scoped.map((m: any) => ({
          provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined,
        }));
      } catch (err) {
        console.error('[autere] UserSession.fetchInitialState: failed to get available models:', err);
      }

      // Load session history
      try {
        const messages = await this.rpc.getMessages();
        if (messages && messages.length > 0) {
          this.state.streamHistory = this.buildStreamHistoryFromMessages(messages);
          if (this.state.streamHistory.length > 50) {
            this.state.streamHistory.splice(0, this.state.streamHistory.length - 50);
          }
        }
      } catch (err) {
        console.error('[autere] UserSession.fetchInitialState: failed to load session history:', err);
      }
    } catch (err) {
      console.error(`[autere] User "${this.user}" failed to fetch initial state:`, err);
    }
  }

  private registerEventHandlers(): void {
    const s = this.state;
    const rpc = this.rpc;

    rpc.onEvent((event: any) => {
      if (event.type !== 'message_update') {
        console.log(`[autere] User "${this.user}" RPC event: ${event.type}`);
      }

      // We received an event from pi — this process is active, clear external flag
      if (this.state.sessionState.externalActivity) {
        this.state.sessionState.externalActivity = false;
        this.broadcast({ type: 'status', data: { ...this.state.sessionState } });
      }
      this.consecutiveEventsFromPi++;

      switch (event.type) {
        case 'session_start':
          this.handleSessionStart(event);
          break;
        case 'session_info_changed':
          this.handleSessionInfoChanged(event);
          break;
        case 'agent_start':
          s.sessionState.isStreaming = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'agent_end':
        case 'agent_settled':
          s.sessionState.isStreaming = false;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'message_update':
          this.handleMessageUpdate(event);
          break;
        case 'message_end':
          this.handleMessageEnd(event);
          break;
        case 'tool_execution_start':
          this.handleToolStart(event);
          break;
        case 'tool_execution_end':
          this.handleToolEnd(event);
          break;
        case 'model_select':
          this.handleModelSelect(event);
          break;
        case 'compaction_start':
          s.sessionState.compacting = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'compaction_end':
          s.sessionState.compacting = false;
          s.sessionState.isStreaming = false;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'turn_start':
          s.sessionState.isStreaming = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
      }

      this.touch();
    });
  }

  private handleSessionStart(event: any): void {
    const s = this.state;
    const rpc = this.rpc;

    rpc.getState().then(state => {
      if (state.sessionId) s.sessionState.sessionId = state.sessionId;
      if (state.sessionFile) s.sessionState.sessionFile = state.sessionFile;
      s.sessionState.sessionName = state.sessionName || null;
      s.sessionState.isStreaming = state.isStreaming;
      s.sessionState.compacting = state.isCompacting;
      if (state.model) {
        s.sessionState.model = {
          provider: state.model.provider,
          id: state.model.id,
          name: state.model.name || state.model.id,
        };
      }
      this.broadcast({ type: 'status', data: { ...s.sessionState } });
    }).catch((err) => { console.error('[autere] UserSession.handleSessionStart: failed to get state:', err); });
  }

  private handleSessionInfoChanged(event: any): void {
    const s = this.state;
    if (event.sessionName !== undefined) {
      s.sessionState.sessionName = event.sessionName;
      this.broadcast({ type: 'status', data: { ...s.sessionState } });
    }
  }

  private handleMessageUpdate(event: any): void {
    const s = this.state;
    const evt = event.assistantMessageEvent;
    if (!evt) return;

    if (evt.type === 'thinking_start') {
      s.isThinking = true;
      s.currentThinkingText = '';
    } else if (evt.type === 'thinking_delta') {
      s.currentThinkingText += evt.delta || '';
      const idx = s.activeStreamIdx;
      if (idx === null || s.streamHistory[idx]?.role !== 'thinking') {
        if (idx !== null && s.streamHistory[idx]) {
          s.streamHistory[idx].streaming = false;
        }
        s.streamHistory.push({ role: 'thinking', text: s.currentThinkingText, streaming: true, timestamp: Date.now() });
        s.activeStreamIdx = s.streamHistory.length - 1;
      } else {
        s.streamHistory[idx].text = s.currentThinkingText;
      }
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', data: s.streamHistory.slice(-50) });
    } else if (evt.type === 'thinking_end') {
      s.isThinking = false;
      const text = evt.content || s.currentThinkingText;
      // Find the last thinking entry and finalize it
      for (let i = s.streamHistory.length - 1; i >= 0; i--) {
        if (s.streamHistory[i].role === 'thinking' && s.streamHistory[i].streaming) {
          s.streamHistory[i].streaming = false;
          if (text) s.streamHistory[i].text = text;
          break;
        }
      }
      s.activeStreamIdx = null;
      s.currentThinkingText = '';
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', data: s.streamHistory.slice(-50) });
    } else if (evt.type === 'text_delta') {
      const delta = evt.delta;
      const idx = s.activeStreamIdx;
      if (idx === null || s.streamHistory[idx]?.role !== 'assistant') {
        if (idx !== null && s.streamHistory[idx]) {
          s.streamHistory[idx].streaming = false;
        }
        s.currentStreamRole = 'assistant';
        s.currentStreamText = '';
        s.streamHistory.push({ role: 'assistant', text: '', streaming: true, timestamp: Date.now() });
        s.activeStreamIdx = s.streamHistory.length - 1;
      }
      s.currentStreamText += delta || '';
      s.streamHistory[s.activeStreamIdx!].text = s.currentStreamText;
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', data: s.streamHistory.slice(-50) });
    }

    // Update usage if present
    if (event.usage) {
      const usage = event.usage;
      if (usage.input) s.sessionStats.tokens.input = usage.input || 0;
      if (usage.output) s.sessionStats.tokens.output = usage.output || 0;
      if (usage.cacheRead) s.sessionStats.tokens.cacheRead = usage.cacheRead || 0;
      if (usage.cacheWrite) s.sessionStats.tokens.cacheWrite = usage.cacheWrite || 0;
      if (usage.cost) s.sessionStats.cost = usage.cost.total || 0;
    }
  }

  private handleMessageEnd(event: any): void {
    const s = this.state;
    if (!event.message) return;

    s.sessionState.messageCount++;

    const rawRole = event.message.role || '';
    const text = event.message.content
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('') || '';

    // Debug: log all assistant messages from pi
    if (rawRole === 'assistant') {
      const contentTypes = (event.message.content || []).map((c: any) => c.type);
      console.log(`[autere] assistant message_end: text_len=${text.length}, content_types=[${contentTypes}]`);
      if (text) console.log(`[autere] assistant message text: ${text}`);
    }

    // Skip toolResult and thinking messages — they are handled by handleToolEnd and handleMessageUpdate
    if (rawRole === 'toolResult' || rawRole === 'thinking') {
      // Still update stats
      const usage = event.message.usage;
      if (usage) {
        if (usage.input) s.sessionStats.tokens.input = (s.sessionStats.tokens.input || 0) + usage.input;
        if (usage.output) s.sessionStats.tokens.output = (s.sessionStats.tokens.output || 0) + usage.output;
        if (usage.cacheRead) s.sessionStats.tokens.cacheRead = (s.sessionStats.tokens.cacheRead || 0) + usage.cacheRead;
        if (usage.cacheWrite) s.sessionStats.tokens.cacheWrite = (s.sessionStats.tokens.cacheWrite || 0) + usage.cacheWrite;
        if (usage.cost) s.sessionStats.cost = (s.sessionStats.cost || 0) + (usage.cost.total || 0);
      }
      this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
      return;
    }

    // Finalize any streaming thinking messages
    for (const msg of s.streamHistory) {
      if (msg.streaming && msg.role === 'thinking') {
        msg.streaming = false;
      }
    }

    // Update stream history
    const streamingIdx = s.streamHistory.findIndex(
      (m: any) => m.streaming && m.role === rawRole
    );

    if (streamingIdx >= 0) {
      s.streamHistory[streamingIdx] = {
        ...s.streamHistory[streamingIdx],
        text,
        streaming: false,
        timestamp: Date.now(),
      };
    } else if (text) {
      s.streamHistory.push({
        role: rawRole,
        text,
        streaming: false,
        timestamp: Date.now(),
      });
    }

    // Keep only last 50 messages
    if (s.streamHistory.length > 50) {
      s.streamHistory.splice(0, s.streamHistory.length - 50);
    }

    this.broadcast({
      type: 'stream_history',
      data: s.streamHistory.slice(-50),
    });

    // Detect errors — skip toolResult errors (handled by handleToolEnd instead)
    const msg = event.message;
    let errorText: string | null = null;
    if (msg.role !== 'toolResult' && (msg.stopReason === 'error' || msg.errorMessage)) {
      errorText = msg.errorMessage || 'An error occurred';
    }
    if (errorText) {
      s.streamHistory.push({ role: 'system', text: errorText, streaming: false, timestamp: Date.now(), isError: true });
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', data: s.streamHistory.slice(-50) });
    }

    // Update stats
    const usage = event.message.usage;
    if (usage) {
      if (usage.input) s.sessionStats.tokens.input = (s.sessionStats.tokens.input || 0) + usage.input;
      if (usage.output) s.sessionStats.tokens.output = (s.sessionStats.tokens.output || 0) + usage.output;
      if (usage.cacheRead) s.sessionStats.tokens.cacheRead = (s.sessionStats.tokens.cacheRead || 0) + usage.cacheRead;
      if (usage.cacheWrite) s.sessionStats.tokens.cacheWrite = (s.sessionStats.tokens.cacheWrite || 0) + usage.cacheWrite;
      if (usage.cost) s.sessionStats.cost = (s.sessionStats.cost || 0) + (usage.cost.total || 0);
    }

    this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
    this.broadcast({ type: 'status', data: { ...s.sessionState } });

    this.rpc.getSessionStats().then(stats => {
      if (stats.contextUsage) s.sessionStats.contextUsage = stats.contextUsage;
      this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
    }).catch((err) => { console.error('[autere] UserSession.handleMessageEnd: failed to get session stats:', err); });
  }

  private handleToolStart(event: any): void {
    const s = this.state;
    const cmd = this.formatToolArgs(event.toolName, event.args);

    // Close any previously active tool (it terminated without sending tool_end)
    for (const [id, tool] of s.activeTools) {
      s.recentTools.unshift({ name: tool.name, isError: false, timestamp: Date.now(), args: tool.args });
      if (s.recentTools.length > 5) s.recentTools.length = 5;
      this.broadcastToSession(s.sessionState.sessionId, { type: 'tool_end', data: { id, name: tool.name, isError: false, cmd: tool.cmd, recentTools: s.recentTools } });
    }
    s.activeTools.clear();

    const toolEntry: any = { name: event.toolName, args: event.args, cmd, startTime: Date.now() };

    // For rm commands, snapshot file content before deletion
    if (event.toolName === 'bash' && isRmCommand(event.args?.command)) {
      const paths = extractRmPaths(event.args.command);
      const snapshots: Record<string, string> = {};
      for (const p of paths) {
        try {
          if (existsSync(p)) snapshots[p] = readFileSync(p, 'utf-8');
        } catch {}
      }
      toolEntry.rmSnapshots = snapshots;
    }

    s.activeTools.set(event.toolCallId, toolEntry);
    this.broadcastToSession(s.sessionState.sessionId, { type: 'tool_start', data: { id: event.toolCallId, name: event.toolName, cmd } });
  }

  private handleToolEnd(event: any): void {
    const s = this.state;
    const tool = s.activeTools.get(event.toolCallId);
    const cmd = tool?.cmd || '';
    const args = tool?.args || {};
    s.activeTools.delete(event.toolCallId);
    s.recentTools.unshift({ name: event.toolName, isError: event.isError, timestamp: Date.now(), args });
    if (s.recentTools.length > 5) s.recentTools.length = 5;
    this.broadcastToSession(s.sessionState.sessionId, { type: 'tool_end', data: { id: event.toolCallId, name: event.toolName, isError: event.isError, cmd, recentTools: s.recentTools } });

    // Add tool result to stream history
    if (event.result || event.isError) {
      const entry = formatToolResult(
        event.toolName,
        tool?.args || {},
        event.result?.content,
        event.isError,
        Date.now(),
        event.result?.details,
        tool?.rmSnapshots,
      );
      if (entry) {
        s.streamHistory.push(entry);
        if (s.streamHistory.length > 50) s.streamHistory.splice(0, s.streamHistory.length - 50);
        this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', data: s.streamHistory.slice(-50) });
      }
    }
  }

  private buildStreamHistoryFromMessages(rawMessages: any[]): any[] {
    const messages = rawMessages.map((m: any) => m.message || m).filter(Boolean);

    // Build a map of toolCallId -> tool call args from assistant messages
    const toolCallArgs = new Map<string, any>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'toolCall' && block.id && block.arguments) {
            toolCallArgs.set(block.id, { name: block.name, args: block.arguments });
          }
        }
      }
    }

    return messages
      .map((msg: any) => {
        const role = msg.role || '';
        const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : undefined;

        if (role === 'toolResult') {
          const call = msg.toolCallId ? toolCallArgs.get(msg.toolCallId) : undefined;
          const toolArgs = call?.args || {};
          return formatToolResult(msg.toolName, toolArgs, msg.content, msg.isError, timestamp, msg.details);
        }

        const text = msg.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || '';
        return { role, text, streaming: false, timestamp };
      })
      .filter((m: any) => m?.text);
  }

  private handleModelSelect(event: any): void {
    const s = this.state;
    if (event.model) {
      s.sessionState.model = {
        provider: event.model.provider,
        id: event.model.id,
        name: event.model.name || event.model.id,
      };
      this.broadcast({ type: 'status', data: { ...s.sessionState } });
    }
  }

  private formatToolArgs(name: string, args: any): string {
    if (!args) return '';
    if (name === 'bash' && typeof args.command === 'string') return args.command;
    if (name === 'read' && typeof args.path === 'string') return args.path;
    if (name === 'write' && typeof args.path === 'string') return args.path;
    if (name === 'edit' && typeof args.path === 'string') return args.path;
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  }

  // ── External activity detection ──

  private startExternalActivityWatch(): void {
    const sessionFile = this.state.sessionState.sessionFile;
    if (sessionFile && existsSync(sessionFile)) {
      try {
        this.lastKnownFileSize = statSync(sessionFile).size;
      } catch {}
    }
    this.externalCheckTimer = setInterval(() => {
      this.checkExternalActivity();
    }, 3000);
  }

  private stopExternalActivityWatch(): void {
    if (this.externalCheckTimer) {
      clearInterval(this.externalCheckTimer);
      this.externalCheckTimer = null;
    }
    if (this.state.sessionState.externalActivity) {
      this.state.sessionState.externalActivity = false;
      this.broadcast({ type: 'status', data: { ...this.state.sessionState } });
    }
  }

  private checkExternalActivity(): void {
    const s = this.state;
    const sessionFile = s.sessionState.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) return;

    try {
      const stats = statSync(sessionFile);
      const currentSize = stats.size;

      // Clear external activity if no external writes for 60 seconds
      if (s.sessionState.externalActivity && this.lastExternalActivityTime > 0 && Date.now() - this.lastExternalActivityTime > 60_000) {
        s.sessionState.externalActivity = false;
        console.log('[autere] External activity cleared (60s timeout)');
        this.broadcast({ type: 'status', data: { ...s.sessionState } });
        return;
      }

      // File size decreased (e.g. after compaction) or first check — just record it
      if (currentSize <= this.lastKnownFileSize) {
        this.lastKnownFileSize = currentSize;
        return;
      }

      // File grew — did we receive events from pi recently?
      if (this.consecutiveEventsFromPi > 0) {
        this.lastKnownFileSize = currentSize;
        this.consecutiveEventsFromPi--;
        return;
      }

      // No events from pi recently — external process wrote to the file
      console.log(`[autere] External activity detected: file grew from ${this.lastKnownFileSize} to ${currentSize}`);
      s.sessionState.externalActivity = true;
      this.lastExternalActivityTime = Date.now();
      this.lastKnownFileSize = currentSize;
      this.broadcast({ type: 'status', data: { ...s.sessionState } });

      // Reload stream history directly from file (RPC returns cached messages from local pi process)
      const rawMessages = readMessagesFromFile(sessionFile);
      if (rawMessages.length > 0) {
        const oldLen = s.streamHistory.length;
        s.streamHistory = this.buildStreamHistoryFromMessages(rawMessages);
        const newLen = s.streamHistory.length;
        if (s.streamHistory.length > 50) s.streamHistory.splice(0, s.streamHistory.length - 50);
        console.log(`[autere] External reload: ${oldLen} -> ${newLen} messages`);
        this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', data: s.streamHistory.slice(-50) });
      }
    } catch (e) {
      console.log(`[autere] Failure in checkExternalActivity: ${e}`);
    }
  }
}
