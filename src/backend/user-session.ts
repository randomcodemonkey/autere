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
import { log, userLog } from './logger.js';
import { getLastSession, setLastSession } from './auth.js';
import { ensurePiEnv } from './pi-env.js';
import { readSessions } from './sessions.js';
import type { SessionInfo } from './types.js';
import { registerExternalActivityInterest, notifyExternalActivity, type ExternalActivityInterest } from './external-activity.js';

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
  private clientIdMap: Map<string, ServerResponse> = new Map(); // clientId -> SSE response
  // Stream history buffers, one per session. A single shared buffer would mix
  // messages from different sessions when clients view or switch sessions.
  private historyBuffers: Map<string, any[]> = new Map();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity: number = Date.now();
  private _idleTimeoutMs: number;
  private _onIdle: (() => void) | null = null;

  // External activity detection — watches the session file for writes by other pi processes
  private externalCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownFileSizes: Map<string, number> = new Map(); // sessionFile -> size
  private externalActivitySessions: Map<string, number> = new Map(); // sessionId -> last external activity ts
  private consecutiveEventsFromPi: number = 0;

  // Isolation mode: exclude legacy global sessions from this user's listing
  private isolatedSessions: boolean;

  // Cross-process instant external-activity notification (see external-activity.ts)
  private externalInterest: ExternalActivityInterest;
  private unregisterExternalInterest: (() => void) | null = null;

  constructor(token: string, user: string, rpcOptions: { provider?: string; model?: string; args?: string[]; resumeLastSession?: boolean; isolatedSessions?: boolean }, idleTimeoutMs: number = 30 * 60 * 1000, envUser?: string) {
    this.token = token;
    this.user = user;
    // Isolation mode (e.g. e2e tests): exclude legacy global sessions from listing
    this.isolatedSessions = rpcOptions.isolatedSessions === true;
    // Per-user pi environment: isolated agent dir (settings, sessions,
    // extension state) seeded from the global ~/.pi/agent as defaults.
    const piEnvDir = ensurePiEnv(envUser || user);
    // Resume this token's last session if known (unless disabled, e.g. e2e tests)
    const args = [...(rpcOptions.args || [])];
    if (rpcOptions.resumeLastSession !== false) {
      const lastSession = getLastSession(token);
      if (lastSession && !args.includes('--session') && !args.includes('--continue') && !args.includes('-c')) {
        args.push('--session', lastSession);
      }
    }
    this.rpc = new MonitorRpcClient({ ...rpcOptions, args, agentDir: piEnvDir });
    this.state = createInitialState();
    this._idleTimeoutMs = idleTimeoutMs;
    this.externalInterest = {
      getSessionFile: () => this.state.sessionState.sessionFile,
      onExternalActivity: () => this.handleInstantExternalActivity(),
    };
  }

  /**
   * Refresh this user's session list from disk (user env dir, plus the
   * legacy global dir unless in isolation mode). Preserves in-memory
   * entries for sessions currently active/viewed whose files don't exist
   * on disk yet (pi writes the file on the first message).
   */
  refreshSessions(): SessionInfo[] {
    const fresh = readSessions(this.user, !this.isolatedSessions);
    const diskIds = new Set(fresh.map(s => s.id));
    const viewed = new Set<string | null>();
    viewed.add(this.state.sessionState.sessionId);
    for (const [, clientSessionId] of this.sseClients) {
      if (clientSessionId) viewed.add(clientSessionId);
    }
    const pending = this.state.availableSessions.filter(
      (s: SessionInfo) => !diskIds.has(s.id) && viewed.has(s.id),
    );
    this.state.availableSessions = [...pending, ...fresh];
    return this.state.availableSessions;
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
      userLog(this.user).info('Idle timeout, terminating pi process');
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

  /** Get (or create) the stream history buffer for a specific session */
  historyFor(sessionId: string | null): any[] {
    const key = sessionId || '__none__';
    let buf = this.historyBuffers.get(key);
    if (!buf) {
      buf = [];
      this.historyBuffers.set(key, buf);
    }
    return buf;
  }

  /** Replace the stream history buffer for a specific session */
  setHistoryFor(sessionId: string | null, entries: any[]) {
    this.historyBuffers.set(sessionId || '__none__', entries);
  }

  /** Clear the external-activity flag for a session and notify its viewers */
  clearExternalActivity(sessionId: string | null) {
    this.externalActivitySessions.delete(sessionId || '__none__');
    if (sessionId) {
      this.broadcastToSession(sessionId, { type: 'external_activity', data: { sessionId, active: false } });
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

  /** Register a client ID for an SSE connection */
  registerClientId(clientId: string, res: ServerResponse) {
    this.clientIdMap.set(clientId, res);
    // Clean up when connection closes
    res.on('close', () => {
      this.clientIdMap.delete(clientId);
      this.sseClients.delete(res);
    });
  }

  /** Update a specific client's session tracking by client ID */
  setClientSessionByClientId(clientId: string, sessionId: string | null) {
    const res = this.clientIdMap.get(clientId);
    if (res) {
      this.sseClients.set(res, sessionId);
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

    // Register for instant cross-session external-activity notifications
    this.unregisterExternalInterest = registerExternalActivityInterest(this.externalInterest);

    userLog(this.user).info('pi process started');
  }

  /** Stop the pi RPC process */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.stopExternalActivityWatch();
    this.unregisterExternalInterest?.();
    this.unregisterExternalInterest = null;
    try {
      await this.rpc.stop();
    } catch (err) {
      userLog(this.user).error('Failed to stop RPC:', err);
    }
    // Disconnect all SSE clients
    for (const [client] of this.sseClients) {
      try { client.end(); } catch {}
    }
    this.sseClients.clear();
    userLog(this.user).info('pi process stopped');
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
        log.userSession.error('fetchInitialState: failed to get session stats:', err);
      }

      try {
        const models = await this.rpc.getAvailableModels();
        const scoped = filterScopedModels(models);
        this.state.availableModels = scoped.map((m: any) => ({
          provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined,
        }));
      } catch (err) {
        log.userSession.error('fetchInitialState: failed to get available models:', err);
      }

      // Load session history into the buffer for this specific session
      try {
        const messages = await this.rpc.getMessages();
        if (messages && messages.length > 0) {
          const buf = this.historyFor(this.state.sessionState.sessionId);
          buf.push(...this.buildStreamHistoryFromMessages(messages));
          if (buf.length > 50) buf.splice(0, buf.length - 50);
        }
      } catch (err) {
        log.userSession.error('fetchInitialState: failed to load session history:', err);
      }
    } catch (err) {
      userLog(this.user).error('Failed to fetch initial state:', err);
    }
  }

  private registerEventHandlers(): void {
    const s = this.state;
    const rpc = this.rpc;

    rpc.onEvent((event: any) => {
      if (event.type !== 'message_update') {
        log.userSession.forSession(s.sessionState.sessionId).debug(`RPC event: ${event.type}`);
      }

      // We received an event from pi — this process is active, clear external flag
      if (this.state.sessionState.externalActivity) {
        this.state.sessionState.externalActivity = false;
        this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...this.state.sessionState } });
      }
      this.consecutiveEventsFromPi++;

      // Instantly notify other UserSession instances whose pi process is on
      // the same session file — they would otherwise only notice via the
      // 3s file-size poll.
      notifyExternalActivity(s.sessionState.sessionFile, this.externalInterest);

      switch (event.type) {
        case 'session_start':
          this.handleSessionStart(event);
          break;
        case 'session_info_changed':
          this.handleSessionInfoChanged(event);
          break;
        case 'agent_start':
          s.sessionState.isStreaming = true;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          break;
        case 'agent_end':
        case 'agent_settled':
          s.sessionState.isStreaming = false;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
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
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          break;
        case 'compaction_end':
          s.sessionState.compacting = false;
          s.sessionState.isStreaming = false;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          break;
        case 'turn_start':
          s.sessionState.isStreaming = true;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          break;
      }

      this.touch();
    });
  }

  private handleSessionStart(event: any): void {
    const s = this.state;
    const rpc = this.rpc;

    // Reset streaming state — a new session has begun
    s.activeStreamIdx = null;
    s.currentStreamText = '';
    s.currentThinkingText = '';

    // Invalidate the session key immediately: subsequent pi events belong to
    // the NEW session but we don't know its id until getState() resolves.
    // Keying them to the old sessionId would append the new session's content
    // to the old session's history buffer and stream it to old-session viewers.
    // With a null key they go to a detached buffer nobody views.
    s.sessionState.sessionId = null;

    rpc.getState().then(state => {
      if (state.sessionId) s.sessionState.sessionId = state.sessionId;
      if (state.sessionFile) s.sessionState.sessionFile = state.sessionFile;

      // Reload history for the new session so the buffer reflects its content
      try {
        if (s.sessionState.sessionFile && existsSync(s.sessionState.sessionFile)) {
          const rawMessages = readMessagesFromFile(s.sessionState.sessionFile, 50);
          if (rawMessages.length > 0) {
            this.setHistoryFor(s.sessionState.sessionId, this.buildStreamHistoryFromMessages(rawMessages).slice(-50));
          }
        }
      } catch {}

      // The new session is no longer "external" — pi is now on it
      this.clearExternalActivity(s.sessionState.sessionId);

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
      this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
      const buf = this.historyFor(s.sessionState.sessionId);
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', sessionId: s.sessionState.sessionId, data: buf.slice(-50) });
    }).catch((err) => { log.userSession.error('handleSessionStart: failed to get state:', err); });
  }

  private handleSessionInfoChanged(event: any): void {
    const s = this.state;
    if (event.sessionName !== undefined) {
      s.sessionState.sessionName = event.sessionName;
      this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
    }
  }

  private handleMessageUpdate(event: any): void {
    const s = this.state;
    const evt = event.assistantMessageEvent;
    if (!evt) return;

    // All history mutations apply to the CURRENT session's buffer. Events
    // arriving while sessionId is null (mid-session-switch) go to a detached
    // buffer that nobody is viewing — this prevents leaking one session's
    // content into another session's history.
    const buf = this.historyFor(s.sessionState.sessionId);
    const sessionId = s.sessionState.sessionId;

    if (evt.type === 'thinking_start') {
      s.isThinking = true;
      s.currentThinkingText = '';
    } else if (evt.type === 'thinking_delta') {
      s.currentThinkingText += evt.delta || '';
      const idx = s.activeStreamIdx;
      if (idx === null || buf[idx]?.role !== 'thinking') {
        if (idx !== null && buf[idx]) {
          buf[idx].streaming = false;
        }
        buf.push({ role: 'thinking', text: s.currentThinkingText, streaming: true, timestamp: Date.now() });
        s.activeStreamIdx = buf.length - 1;
      } else {
        buf[idx].text = s.currentThinkingText;
      }
      this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-50) });
    } else if (evt.type === 'thinking_end') {
      s.isThinking = false;
      const text = evt.content || s.currentThinkingText;
      // Find the last thinking entry and finalize it
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].role === 'thinking' && buf[i].streaming) {
          buf[i].streaming = false;
          if (text) buf[i].text = text;
          break;
        }
      }
      s.activeStreamIdx = null;
      s.currentThinkingText = '';
      this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-50) });
    } else if (evt.type === 'text_delta') {
      const delta = evt.delta;
      const idx = s.activeStreamIdx;
      if (idx === null || buf[idx]?.role !== 'assistant') {
        if (idx !== null && buf[idx]) {
          buf[idx].streaming = false;
        }
        s.currentStreamRole = 'assistant';
        s.currentStreamText = '';
        buf.push({ role: 'assistant', text: '', streaming: true, timestamp: Date.now() });
        s.activeStreamIdx = buf.length - 1;
      }
      s.currentStreamText += delta || '';
      buf[s.activeStreamIdx!].text = s.currentStreamText;
      this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-50) });
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

    if (rawRole === 'assistant') {
      log.userSession.forSession(s.sessionState.sessionId).debug(
        `assistant message_end: text_len=${text.length}, content_types=[${(event.message.content || []).map((c: any) => c.type).join(',')}]`);
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
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stats', data: { ...s.sessionStats } });
      return;
    }

    // Finalize any streaming thinking messages
    const buf = this.historyFor(s.sessionState.sessionId);
    const sessionId = s.sessionState.sessionId;
    for (const msg of buf) {
      if (msg.streaming && msg.role === 'thinking') {
        msg.streaming = false;
      }
    }

    // Update stream history
    const streamingIdx = buf.findIndex(
      (m: any) => m.streaming && m.role === rawRole
    );

    if (streamingIdx >= 0) {
      buf[streamingIdx] = {
        ...buf[streamingIdx],
        text,
        streaming: false,
        timestamp: Date.now(),
      };
    } else if (text) {
      buf.push({
        role: rawRole,
        text,
        streaming: false,
        timestamp: Date.now(),
      });
    }

    // Keep only last 50 messages
    if (buf.length > 50) {
      buf.splice(0, buf.length - 50);
    }

    this.broadcastToSession(sessionId, {
      type: 'stream_history',
      sessionId,
      data: buf.slice(-50),
    });

    // Detect errors — skip toolResult errors (handled by handleToolEnd instead)
    const msg = event.message;
    let errorText: string | null = null;
    if (msg.role !== 'toolResult' && (msg.stopReason === 'error' || msg.errorMessage)) {
      errorText = msg.errorMessage || 'An error occurred';
    }
    if (errorText) {
      buf.push({ role: 'system', text: errorText, streaming: false, timestamp: Date.now(), isError: true });
      this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-50) });
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

    this.broadcastToSession(s.sessionState.sessionId, { type: 'stats', data: { ...s.sessionStats } });
    this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });

    this.rpc.getSessionStats().then(stats => {
      if (stats.contextUsage) s.sessionStats.contextUsage = stats.contextUsage;
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stats', data: { ...s.sessionStats } });
    }).catch((err) => { log.userSession.forSession(s.sessionState.sessionId).error('handleMessageEnd: failed to get session stats:', err); });
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
        const buf = this.historyFor(s.sessionState.sessionId);
        const sessionId = s.sessionState.sessionId;
        buf.push(entry);
        if (buf.length > 50) buf.splice(0, buf.length - 50);
        this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-50) });
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
      .flatMap((msg: any) => {
        const role = msg.role || '';
        const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : undefined;

        if (role === 'toolResult') {
          const call = msg.toolCallId ? toolCallArgs.get(msg.toolCallId) : undefined;
          const toolArgs = call?.args || {};
          const formatted = formatToolResult(msg.toolName, toolArgs, msg.content, msg.isError, timestamp, msg.details);
          return formatted ? [formatted] : [];
        }

        // Assistant messages can contain a thinking block before the text
        // block. While streaming these render as separate entries (a
        // 'thinking' entry from deltas, then the assistant text at
        // message_end) — mirror that here.
        if (role === 'assistant' && Array.isArray(msg.content)) {
          const entries: any[] = [];
          const thinking = msg.content
            .filter((c: any) => c.type === 'thinking')
            .map((c: any) => c.thinking || '')
            .join('')
            .trim();
          if (thinking) {
            entries.push({ role: 'thinking', text: thinking, streaming: false, timestamp });
          }
          const text = msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
          if (text) {
            entries.push({ role, text, streaming: false, timestamp });
          }
          return entries;
        }

        const text = msg.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || '';
        return text ? [{ role, text, streaming: false, timestamp }] : [];
      });
  }

  private handleModelSelect(event: any): void {
    const s = this.state;
    if (event.model) {
      s.sessionState.model = {
        provider: event.model.provider,
        id: event.model.id,
        name: event.model.name || event.model.id,
      };
      this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
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
    this.externalCheckTimer = setInterval(() => {
      this.checkExternalActivity();
    }, 3000);
  }

  /**
   * Instant external-activity notification: another autere-managed pi process
   * just wrote to the session file we're currently on. Same effect as the
   * file-poll path in checkExternalActivity() but without the polling delay.
   */
  private handleInstantExternalActivity(): void {
    const s = this.state;
    const sessionId = s.sessionState.sessionId;
    const sessionFile = s.sessionState.sessionFile;
    if (!sessionId || !sessionFile) return;
    if (s.sessionState.externalActivity) return; // already flagged

    log.userSession.forSession(sessionId).info('External activity (instant notification)');
    s.sessionState.externalActivity = true;
    this.externalActivitySessions.set(sessionId, Date.now());
    this.broadcastToSession(sessionId, { type: 'status', data: { ...s.sessionState } });

    // Reload the stream history directly from the file so viewers see the
    // other process's messages immediately.
    try {
      if (existsSync(sessionFile)) {
        const rawMessages = readMessagesFromFile(sessionFile);
        if (rawMessages.length > 0) {
          const built = this.buildStreamHistoryFromMessages(rawMessages);
          if (built.length > 50) built.splice(0, built.length - 50);
          this.setHistoryFor(sessionId, built);
          this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: built });
        }
      }
    } catch (err) {
      log.userSession.forSession(sessionId).error('handleInstantExternalActivity: failed to reload history:', err);
    }
  }

  private stopExternalActivityWatch(): void {
    if (this.externalCheckTimer) {
      clearInterval(this.externalCheckTimer);
      this.externalCheckTimer = null;
    }
  }

  /**
   * Watch session files for writes by OTHER pi processes.
   *
   * Tracks the file of pi's CURRENT session (using consecutiveEventsFromPi
   * credits to distinguish our own writes) plus the files of every session
   * currently viewed by a connected client — growth of those files is always
   * external, since our pi process only writes to its current session.
   */
  private checkExternalActivity(): void {
    const s = this.state;

    try {
      // Build the set of sessions being viewed: pi's current session plus
      // every session any SSE client is viewing.
      const viewed = new Set<string | null>();
      viewed.add(s.sessionState.sessionId);
      for (const [, clientSessionId] of this.sseClients) {
        if (clientSessionId) viewed.add(clientSessionId);
      }

      const now = Date.now();

      // Clear external flags after 60s of no external writes
      for (const [sessionId, ts] of this.externalActivitySessions) {
        if (now - ts > 60_000) {
          this.externalActivitySessions.delete(sessionId);
          if (sessionId === s.sessionState.sessionId) {
            s.sessionState.externalActivity = false;
            log.userSession.forSession(sessionId).debug('External activity cleared (60s timeout)');
            this.broadcastToSession(sessionId, { type: 'status', data: { ...s.sessionState } });
          } else {
            this.broadcastToSession(sessionId, { type: 'external_activity', data: { sessionId, active: false } });
          }
        }
      }

      for (const sessionId of viewed) {
        if (!sessionId) continue;
        const isCurrent = sessionId === s.sessionState.sessionId;
        const sessionFile = isCurrent
          ? s.sessionState.sessionFile
          : s.availableSessions.find((si: any) => si.id === sessionId)?.sessionFile;
        if (!sessionFile || !existsSync(sessionFile)) continue;

        const currentSize = statSync(sessionFile).size;
        const lastKnown = this.lastKnownFileSizes.get(sessionFile);
        this.lastKnownFileSizes.set(sessionFile, currentSize);
        if (lastKnown === undefined || currentSize <= lastKnown) continue;

        if (isCurrent) {
          // File grew — did we receive events from our pi process recently?
          if (this.consecutiveEventsFromPi > 0) {
            this.consecutiveEventsFromPi--;
            continue;
          }
          // No events from pi recently — external process wrote to the file
          log.userSession.forSession(sessionId).info(`External activity detected (file grew from ${lastKnown} to ${currentSize} bytes)`);
          s.sessionState.externalActivity = true;
          this.externalActivitySessions.set(sessionId, Date.now());
          this.broadcastToSession(sessionId, { type: 'status', data: { ...s.sessionState } });
        } else {
          log.userSession.forSession(sessionId).info(`External activity detected on viewed session (file grew from ${lastKnown} to ${currentSize} bytes)`);
          this.externalActivitySessions.set(sessionId, Date.now());
          this.broadcastToSession(sessionId, { type: 'external_activity', data: { sessionId, active: true } });
        }

        // Reload the stream history for THIS session directly from its file and
        // stream it to its viewers (RPC cached messages may be stale/other-session).
        const rawMessages = readMessagesFromFile(sessionFile);
        if (rawMessages.length > 0) {
          const built = this.buildStreamHistoryFromMessages(rawMessages);
          if (built.length > 50) built.splice(0, built.length - 50);
          this.setHistoryFor(sessionId, built);
          this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: built });
        }
      }

      // Drop size tracking for files we no longer care about
      if (this.lastKnownFileSizes.size > 100) this.lastKnownFileSizes.clear();
    } catch (e) {
      log.userSession.error('Failure in checkExternalActivity:', e);
    }
  }
}
