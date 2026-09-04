/**
 * Per-user session management.
 *
 * Each UserSession encapsulates a pi RPC process, its state,
 * event handlers, and SSE clients for a single authenticated user.
 */

import { existsSync, readFileSync } from 'fs';
import type { ServerResponse } from 'http';
import { MonitorRpcClient } from './rpc-client.js';
import { filterScopedModels, autoSessionName } from './utils.js';
import { log, userLog } from './logger.js';
import { getLastSession, setLastSession, hasRole } from './auth.js';
import { ensurePiEnv } from './pi-env.js';
import { readSessions } from './sessions.js';
import type { SessionInfo } from './types.js';
import { getHistoryLimit, getUserSetting } from './user-settings.js';
import { registerExternalActivityInterest, notifyExternalActivity, notifyExternalActivityEnd, type ExternalActivityInterest } from './external-activity.js';
import {
  isRmCommand,
  extractRmPaths,
  formatToolResult,
  readMessageEntries,
  buildStreamHistoryFromMessages,
  accumulateUsage,
} from './stream-history.js';
import { ExternalActivityWatcher } from './external-watcher.js';
import { formatToolArgs } from '../shared/format.js';

// ── Per-user state types ──

export interface UserSessionState {
  sessionState: any;
  sessionStats: any;
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
      steerPending: 0,
      followUpPending: 0,
    },
    sessionStats: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsage: null,
    },
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
  /** Chat history buffer size (messages) — from the user's settings */
  readonly historyLimit: number;
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

  // External activity detection — watches session files for writes by other pi processes
  private consecutiveEventsFromPi: number = 0;
  private externalWatcher: ExternalActivityWatcher;

  // Isolation mode: exclude legacy global sessions from this user's listing
  private isolatedSessions: boolean;

  /** Whether this process was launched with --session pointing at an existing session */
  private resumedExistingSession: boolean;

  // Cross-process instant external-activity notification (see external-activity.ts)
  private externalInterest: ExternalActivityInterest;
  private unregisterExternalInterest: (() => void) | null = null;

  constructor(token: string, user: string, rpcOptions: { provider?: string; model?: string; args?: string[]; resumeLastSession?: boolean; isolatedSessions?: boolean }, idleTimeoutMs: number = 30 * 60 * 1000, envUser?: string) {
    this.token = token;
    this.user = user;
    // Chat history buffer size (messages). Settings saves restart the pi
    // process, so snapshotting here always reflects the current setting.
    this.historyLimit = getHistoryLimit(user);
    // Isolation mode (e.g. e2e tests): exclude legacy global sessions from listing
    this.isolatedSessions = rpcOptions.isolatedSessions === true;
    // Per-user pi environment: isolated agent dir (settings, sessions,
    // extension state) seeded from the global ~/.pi/agent as defaults.
    const piEnvDir = ensurePiEnv(envUser || user);
    // Resume this token's last session if known (unless disabled, e.g. e2e tests)
    const args = [...(rpcOptions.args || [])];
    // Track whether this process resumes an existing session — if not, pi
    // starts a brand-new session and we auto-name it (see start()).
    this.resumedExistingSession = false;
    if (rpcOptions.resumeLastSession !== false) {
      const lastSession = getLastSession(token);
      if (lastSession && !args.includes('--session') && !args.includes('--continue') && !args.includes('-c')) {
        args.push('--session', lastSession);
        this.resumedExistingSession = true;
      }
    }
    this.rpc = new MonitorRpcClient({ ...rpcOptions, args, agentDir: piEnvDir });
    this.state = createInitialState();
    this._idleTimeoutMs = idleTimeoutMs;
    this.externalInterest = {
      getSessionFile: () => this.state.sessionState.sessionFile,
      onExternalActivity: () => this.handleInstantExternalActivity(),
      onExternalActivityEnd: () => this.handleExternalActivityEnd(),
    };

    this.externalWatcher = new ExternalActivityWatcher({
      getViewedSessions: () => {
        const viewed: { sessionId: string; sessionFile: string | undefined; isCurrent: boolean }[] = [];
        if (this.state.sessionState.sessionId) {
          viewed.push({
            sessionId: this.state.sessionState.sessionId,
            sessionFile: this.state.sessionState.sessionFile || undefined,
            isCurrent: true,
          });
        }
        for (const [, clientSessionId] of this.sseClients) {
          if (!clientSessionId || viewed.some(v => v.sessionId === clientSessionId)) continue;
          const isCurrent = clientSessionId === this.state.sessionState.sessionId;
          viewed.push({
            sessionId: clientSessionId,
            sessionFile: isCurrent
              ? this.state.sessionState.sessionFile || undefined
              : this.state.availableSessions.find((si: SessionInfo) => si.id === clientSessionId)?.sessionFile,
            isCurrent,
          });
        }
        return viewed;
      },
      hasRecentPiEvent: () => this.consecutiveEventsFromPi > 0,
      consumePiEvent: () => { this.consecutiveEventsFromPi--; },
      onCurrentExternalActivity: (sessionId) => {
        this.state.sessionState.externalActivity = true;
        this.broadcastToSession(sessionId, { type: 'status', data: { ...this.state.sessionState } });
      },
      onViewedExternalActivity: (sessionId) => {
        this.broadcastToSession(sessionId, { type: 'external_activity', data: { sessionId, active: true } });
      },
      onExpired: (sessionId, isCurrent) => {
        if (isCurrent) {
          this.state.sessionState.externalActivity = false;
          log.userSession.forSession(sessionId).debug('External activity cleared (60s timeout)');
          this.broadcastToSession(sessionId, { type: 'status', data: { ...this.state.sessionState } });
        } else {
          this.broadcastToSession(sessionId, { type: 'external_activity', data: { sessionId, active: false } });
        }
      },
      onHistoryReload: (sessionId, entries) => {
        this.setHistoryFor(sessionId, entries);
        this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: entries });
      },
    });
  }

  /**
   * Refresh this user's session list from disk (user env dir, plus the
   * legacy global dir unless in isolation mode). Preserves in-memory
   * entries for sessions currently active/viewed whose files don't exist
   * on disk yet (pi writes the file on the first message).
   */
  refreshSessions(): SessionInfo[] {
    // Legacy global sessions (~/.pi/agent/sessions) are only included for
    // admin-role users — that directory is admin's home agent dir, so
    // exposing it to other users would leak admin's sessions (chat
    // history!) into their session list. Non-admin users only ever see
    // their own env's sessions.
    const fresh = readSessions(this.user, hasRole(this.user, 'admin') && !this.isolatedSessions);
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

  /**
   * Broadcast an SSE event to all connected clients.
   * (Prefer broadcastToSession() — most events should only reach the
   * clients viewing the session they belong to.)
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
    if (sessionId) this.externalWatcher.clear(sessionId);
    if (sessionId) {
      this.broadcastToSession(sessionId, { type: 'external_activity', data: { sessionId, active: false } });
    }
  }

  /** Another process's pi finished its turn on OUR current session — drop
   *  the 'Active elsewhere' flag immediately instead of waiting out the
   *  watcher's 60s expiry. */
  private handleExternalActivityEnd(): void {
    const s = this.state;
    const sessionId = s.sessionState.sessionId;
    if (!sessionId) return;
    if (s.sessionState.externalActivity) {
      log.userSession.forSession(sessionId).info('External activity ended (turn finished notification)');
      s.sessionState.externalActivity = false;
      this.broadcastToSession(sessionId, { type: 'status', data: { ...s.sessionState } });
    }
    this.clearExternalActivity(sessionId);
  }

  /**
   * Whether a client's tracked session id refers to the same session as the
   * broadcast target. Exact match — or an alias: pi sometimes reports an
   * internal id that differs from the file-derived id (id drift), so two
   * ids resolving to the same session file are the same session. Without
   * this, an 'active elsewhere' viewer whose tracked id drifted never
   * matches the broadcast target and silently stops receiving messages.
   */
  private clientViewsSession(clientSessionId: string | null, sessionId: string | null): boolean {
    if (clientSessionId === sessionId) return true;
    if (!clientSessionId || !sessionId) return false;
    const fileOf = (id: string) =>
      this.state.availableSessions.find(si => si.id === id)?.sessionFile;
    const cf = fileOf(clientSessionId);
    const tf = fileOf(sessionId);
    return !!cf && !!tf && cf === tf;
  }

  /** Broadcast an SSE event only to clients viewing a specific session */
  broadcastToSession(sessionId: string | null, data: any) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const [client, clientSessionId] of this.sseClients) {
      if (this.clientViewsSession(clientSessionId, sessionId)) {
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

    // Start watching session files for external writes
    this.externalWatcher.start();

    // Register for instant cross-session external-activity notifications
    this.unregisterExternalInterest = registerExternalActivityInterest(this.externalInterest);

    // Auto-name brand-new sessions spawned by the dashboard:
    // "[ui] - <user locale + timezone date+time>". Locale and IANA time zone
    // were persisted by /api/new-session (setUserSetting); Intl performs the
    // zone conversion — the backend never guesses the user's offset.
    if (!this.resumedExistingSession && !this.state.sessionState.sessionName) {
      try {
        const locale = getUserSetting(this.user, 'locale', '');
        const timeZone = getUserSetting(this.user, 'timeZone', '');
        const autoName = autoSessionName('[ui]', {
          locale: typeof locale === 'string' && locale ? locale : undefined,
          timeZone: typeof timeZone === 'string' && timeZone ? timeZone : undefined,
        });
        await this.rpc.setSessionName(autoName);
        this.state.sessionState.sessionName = autoName;
      } catch (err) {
        log.userSession.error('Failed to auto-name new session:', err);
      }
    }

    userLog(this.user).info('pi process started');
  }

  /** Stop the pi RPC process */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.externalWatcher.stop();
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
          buf.push(...buildStreamHistoryFromMessages(messages));
          if (buf.length > this.historyLimit) buf.splice(0, buf.length - this.historyLimit);
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
          // Our pi's turn ended — viewers in OTHER processes watching this
          // session can drop their 'Active elsewhere' state immediately.
          notifyExternalActivityEnd(s.sessionState.sessionFile, this.externalInterest);
          break;
        case 'queue_update':
          // pi reports its actual steering/follow-up queues — the
          // authoritative pending counts for the chat buttons.
          s.sessionState.steerPending = Array.isArray(event.steering) ? event.steering.length : 0;
          s.sessionState.followUpPending = Array.isArray(event.followUp) ? event.followUp.length : 0;
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
          notifyExternalActivityEnd(s.sessionState.sessionFile, this.externalInterest);
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
          const rawMessages = readMessageEntries(s.sessionState.sessionFile, this.historyLimit);
          if (rawMessages.length > 0) {
            this.setHistoryFor(s.sessionState.sessionId, buildStreamHistoryFromMessages(rawMessages).slice(-this.historyLimit));
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
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', sessionId: s.sessionState.sessionId, data: buf.slice(-this.historyLimit) });
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
      this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-this.historyLimit) });
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
      this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-this.historyLimit) });
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
      this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-this.historyLimit) });
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
      accumulateUsage(s.sessionStats, event.message.usage);
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
    if (buf.length > this.historyLimit) {
      buf.splice(0, buf.length - this.historyLimit);
    }

    this.broadcastToSession(sessionId, {
      type: 'stream_history',
      sessionId,
      data: buf.slice(-this.historyLimit),
    });

    // Detect errors — skip toolResult errors (handled by handleToolEnd instead)
    const msg = event.message;
    let errorText: string | null = null;
    if (msg.role !== 'toolResult' && (msg.stopReason === 'error' || msg.errorMessage)) {
      errorText = msg.errorMessage || 'An error occurred';
    }
    if (errorText) {
      buf.push({ role: 'system', text: errorText, streaming: false, timestamp: Date.now(), isError: true });
      this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-this.historyLimit) });
    }

    // Update stats
    accumulateUsage(s.sessionStats, event.message.usage);

    this.broadcastToSession(s.sessionState.sessionId, { type: 'stats', data: { ...s.sessionStats } });
    this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });

    this.rpc.getSessionStats().then(stats => {
      if (stats.contextUsage) s.sessionStats.contextUsage = stats.contextUsage;
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stats', data: { ...s.sessionStats } });
    }).catch((err) => { log.userSession.forSession(s.sessionState.sessionId).error('handleMessageEnd: failed to get session stats:', err); });
  }

  private handleToolStart(event: any): void {
    const s = this.state;
    const cmd = formatToolArgs(event.toolName, event.args);

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

    // Show the tool call directly in the chat as a streaming toolCall entry;
    // handleToolEnd replaces it with the connected toolResult.
    {
      const buf = this.historyFor(s.sessionState.sessionId);
      buf.push({
        role: 'toolCall',
        text: cmd,
        streaming: true,
        timestamp: Date.now(),
        toolCallId: event.toolCallId,
        toolCall: { name: event.toolName, cmd },
      });
      this.broadcastToSession(s.sessionState.sessionId, {
        type: 'stream_history',
        sessionId: s.sessionState.sessionId,
        data: buf.slice(-this.historyLimit),
      });
    }
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

    // Add tool result to stream history — replacing the streaming toolCall
    // entry so call and result render as one connected unit
    if (event.result || event.isError) {
      const entry = formatToolResult(
        event.toolName,
        tool?.args || {},
        event.result?.content,
        event.isError,
        Date.now(),
        event.result?.details,
        tool?.rmSnapshots,
        { name: event.toolName, cmd },
      );
      if (entry) {
        const buf = this.historyFor(s.sessionState.sessionId);
        const idx = buf.findIndex((e: any) => e.role === 'toolCall' && e.toolCallId === event.toolCallId);
        if (idx >= 0) buf.splice(idx, 1, entry);
        else buf.push(entry);
        const sessionId = s.sessionState.sessionId;
        if (buf.length > 50) buf.splice(0, buf.length - 50);
        this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: buf.slice(-this.historyLimit) });
      }
    }
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

  // ── External activity detection ──

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
    this.externalWatcher.flagActivity(sessionId);
    this.broadcastToSession(sessionId, { type: 'status', data: { ...s.sessionState } });

    // Reload the stream history directly from the file so viewers see the
    // other process's messages immediately.
    try {
      if (existsSync(sessionFile)) {
        const rawMessages = readMessageEntries(sessionFile);
        if (rawMessages.length > 0) {
          const built = buildStreamHistoryFromMessages(rawMessages);
          if (built.length > 50) built.splice(0, built.length - 50);
          this.setHistoryFor(sessionId, built);
          this.broadcastToSession(sessionId, { type: 'stream_history', sessionId, data: built });
        }
      }
    } catch (err) {
      log.userSession.forSession(sessionId).error('handleInstantExternalActivity: failed to reload history:', err);
    }
  }
}
