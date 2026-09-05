/**
 * Per-user session management.
 *
 * Each UserSession encapsulates a pi RPC process, its state,
 * event handlers, and SSE clients for a single authenticated user.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { ServerResponse } from 'http';
import { MonitorRpcClient } from './rpc-client.js';
import { filterScopedModels, autoSessionName } from './utils.js';
import { log, userLog } from './logger.js';
import { getLastSession, setLastSession } from './auth.js';
import { ensurePiEnv, getPiEnvDir } from './pi-env.js';
import { readSessions } from './sessions.js';
import type { SessionInfo } from './types.js';
import { getHistoryLimit, getUserSetting } from './user-settings.js';
import { registerSessionPeer, isSessionActiveElsewhere, deliverToPeers } from './session-peers.js';
import {
  isRmCommand,
  extractRmPaths,
  formatToolResult,
  splitImageEntry,
  readMessageEntries,
  buildStreamHistoryFromMessages,
  accumulateUsage,
  extractImages,
} from './stream-history.js';
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

  /** Whether this process was launched with --session pointing at an existing session */
  private resumedExistingSession: boolean;

  // Per-user peer registry membership (see session-peers.ts)
  private unregisterPeer: (() => void) | null = null;
  /** This user's pi environment dir (images extracted from history land here) */
  private piEnvDir!: string;

  constructor(token: string, user: string, rpcOptions: { provider?: string; model?: string; args?: string[]; resumeLastSession?: boolean }, idleTimeoutMs: number = 30 * 60 * 1000, envUser?: string) {
    this.token = token;
    this.user = user;
    // Chat history buffer size (messages). Settings saves restart the pi
    // process, so snapshotting here always reflects the current setting.
    this.historyLimit = getHistoryLimit(user);
    // Per-user pi environment: isolated agent dir (settings, sessions,
    // extension state) seeded from the global ~/.pi/agent as defaults.
    const piEnvDir = ensurePiEnv(envUser || user);
    this.piEnvDir = piEnvDir;
    // Resume this token's last session if known (unless disabled, e.g. e2e tests)
    const args = [...(rpcOptions.args || [])];
    // Track whether this process resumes an existing session — if not, pi
    // starts a brand-new session and we auto-name it (see start()).
    this.resumedExistingSession = false;
    if (rpcOptions.resumeLastSession !== false) {
      const lastSession = getLastSession(envUser || user, token);
      if (lastSession && !args.includes('--session') && !args.includes('--continue') && !args.includes('-c')) {
        args.push('--session', lastSession);
        this.resumedExistingSession = true;
      }
    }
    this.rpc = new MonitorRpcClient({ ...rpcOptions, args, agentDir: piEnvDir });
    this.state = createInitialState();
    this._idleTimeoutMs = idleTimeoutMs;
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
    const fresh = readSessions(this.user);
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
    for (const e of entries) this.tagEntry(e);
    this.historyBuffers.set(sessionId || '__none__', entries);
  }

  /** Monotonic id source for history entries (stable React keys client-side) */
  private entrySeq = 0;

  /** Assign a stable id to a history entry (idempotent) */
  private tagEntry(e: any): any {
    if (e && !e.id) e.id = `e${++this.entrySeq}`;
    // UI-only buffer: replace inline base64 images with on-disk refs so
    // stream_history broadcasts stay small. The history buffer exists only
    // to render the dashboard — pi's own session file keeps the originals.
    // Re-broadcasting multi-MB base64 on every history event caused backend
    // memory spikes and client jank. Files are content-hashed, so repeated
    // broadcasts of the same image cost nothing.
    if (e && Array.isArray(e.images) && e.images.some((img: any) => img?.data)) {
      e.images = e.images.map((img: any) => {
        if (!img?.data) return img;
        const ext = ((img.mimeType || 'image/png').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
        const hash = createHash('sha1').update(img.data).digest('hex').slice(0, 16);
        const name = `hist-${hash}.${ext}`;
        try {
          const file = join(this.piEnvDir, 'uploads', name);
          if (!existsSync(file)) {
            mkdirSync(join(this.piEnvDir, 'uploads'), { recursive: true });
            writeFileSync(file, Buffer.from(img.data, 'base64'));
          }
          return { mimeType: img.mimeType, url: `/api/images/${name}` };
        } catch (err) {
          log.userSession.error('failed to persist history image:', err);
          return { mimeType: img.mimeType, data: img.data }; // fall back to inline
        }
      });
    }
    return e;
  }

  /** This user's pi environment dir (used by the /api/images route) */
  getEnvDir(): string {
    return this.piEnvDir;
  }

  /**
   * Record a just-sent user message in the history buffer and broadcast it
   * as a targeted upsert. This is what retires the client's optimistic
   * pending copy — pi does not emit message_end for user messages, so
   * without this the pending indicator would linger until turn end.
   */
  addUserEntry(text: string): void {
    const sessionId = this.state.sessionState.sessionId;
    const buf = this.historyFor(sessionId);
    const entry = this.tagEntry({ role: 'user', text, streaming: false, timestamp: Date.now() });
    buf.push(entry);
    this.broadcastHistoryUpsert(sessionId, [entry]);
  }

  /**
   * Assign stable ids to raw history entries (bootstrap/session-file
   * reads) so live `history_upsert` events can match them client-side.
   */
  withStableIds(entries: any[]): any[] {
    for (const e of entries) this.tagEntry(e);
    return entries;
  }


  /**
   * The session this UserSession's pi is currently DRIVING while streaming
   * (peer-hub interface), or null when idle. This is the sole source of
   * "active" state — no filesystem involvement.
   */
  getDrivenSessionId(): string | null {
    const s = this.state.sessionState;
    return s.isStreaming ? s.sessionId : null;
  }

  /**
   * Peer-hub delivery: write an SSE event to this UserSession's clients
   * viewing sessionId WITHOUT forwarding it onward (no recursion).
   */
  deliverToSession(sessionId: string | null, data: any): void {
    this.writeToSessionClients(sessionId, data);
  }

  /** SSE payload describing whether ANOTHER of the user's devices is
   *  currently driving sessionId. Sent on client connect / bootstrap / switch. */
  sessionActivityPayload(sessionId: string | null): { type: string; data: { sessionId: string | null; active: boolean } } {
    return {
      type: 'session_activity',
      data: { sessionId, active: isSessionActiveElsewhere(this.user, this, sessionId) },
    };
  }

  /** Tell the user's other devices that this process started/stopped driving sessionId */
  private notifyPeersSessionActivity(active: boolean): void {
    const sessionId = this.state.sessionState.sessionId;
    if (!sessionId) return;
    deliverToPeers(this.user, this, sessionId, {
      type: 'session_activity',
      data: { sessionId, active },
    });
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

  /** Content event types forwarded to the user's other devices in real time */
  private static readonly FORWARDED_EVENT_TYPES = new Set(['stream_history', 'history_upsert', 'history_remove', 'stats', 'tool_start', 'tool_end']);

  /**
   * Broadcast an SSE event only to clients viewing a specific session.
   * Content events (history/stats/tools) are ALSO forwarded to this user's
   * other UserSessions — that is what makes messages appear instantly on
   * another device that is viewing the same session while it is driven here.
   * `status` is deliberately not forwarded: the other device renders its own
   * state and learns about activity via the `session_activity` event.
   */
  broadcastToSession(sessionId: string | null, data: any) {
    this.writeToSessionClients(sessionId, data);
    if (sessionId && data && UserSession.FORWARDED_EVENT_TYPES.has(data.type)) {
      deliverToPeers(this.user, this, sessionId, data);
    }
  }

  /**
   * Targeted history mutation event: upsert entries by stable id (replace
   * in place or append). Replaces the old full-buffer `stream_history`
   * broadcasts on live mutations — those resync only on reconnect, reload,
   * and session switch now.
   */
  private broadcastHistoryUpsert(sessionId: string | null, entries: any[]): void {
    const list = entries.filter(Boolean);
    if (list.length === 0) return;
    this.broadcastToSession(sessionId, { type: 'history_upsert', sessionId, data: list });
  }

  /** Cap the buffer, telling clients which entries were dropped */
  private trimHistory(sessionId: string | null, buf: any[]): void {
    if (buf.length > this.historyLimit) {
      const removedIds = buf.slice(0, buf.length - this.historyLimit).map((e) => e.id).filter(Boolean);
      buf.splice(0, buf.length - this.historyLimit);
      if (removedIds.length > 0) {
        this.broadcastToSession(sessionId, { type: 'history_remove', sessionId, data: removedIds });
      }
    }
  }

  /** Write an SSE event to this UserSession's clients viewing sessionId */
  private writeToSessionClients(sessionId: string | null, data: any) {
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

    // Join the per-user session-activity hub so other devices of this user
    // see this process's streaming activity (and receive forwarded events)
    this.unregisterPeer = registerSessionPeer(this.user, this);

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
    // Leave the peer hub FIRST and tell the user's other devices that this
    // process's session is no longer being driven (device went away).
    this.unregisterPeer?.();
    this.unregisterPeer = null;
    const stoppedSessionId = this.state.sessionState.sessionId;
    if (stoppedSessionId) {
      deliverToPeers(this.user, this, stoppedSessionId, {
        type: 'session_activity',
        data: { sessionId: stoppedSessionId, active: false },
      });
    }
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

      // (Activity state is derived purely from each process's own streaming
      // state — see session-peers.ts. No filesystem involvement.)

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
          // Idle → active: tell the user's other devices immediately
          this.notifyPeersSessionActivity(true);
          break;
        case 'agent_end':
        case 'agent_settled':
          s.sessionState.isStreaming = false;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          // Active → idle: other devices drop their 'Active elsewhere' instantly
          this.notifyPeersSessionActivity(false);
          // Turn finished — send a full history snapshot as a safety resync.
          // The UI is idle now, so the larger payload costs nothing, and it
          // guarantees clients converge to ground truth after every turn
          // (heals any drift from missed/dropped targeted events).
          this.broadcastToSession(s.sessionState.sessionId, { type: 'stream_history', sessionId: s.sessionState.sessionId, data: this.historyFor(s.sessionState.sessionId).slice(-this.historyLimit) });
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
          this.notifyPeersSessionActivity(false);
          break;
        case 'turn_start':
          s.sessionState.isStreaming = true;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          this.notifyPeersSessionActivity(true);
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
          this.broadcastHistoryUpsert(sessionId, [buf[idx]]); // finalize prior stream
        }
        const entry = this.tagEntry({ role: 'thinking', text: s.currentThinkingText, streaming: true, timestamp: Date.now() });
        buf.push(entry);
        this.broadcastHistoryUpsert(sessionId, [entry]);
        s.activeStreamIdx = buf.length - 1;
      } else {
        buf[idx].text = s.currentThinkingText;
      }
      // Delta events send ONLY the streaming entry's text — never the full
      // history buffer. Re-broadcasting history (with multi-MB base64 images)
      // on every token caused multi-GB memory churn and client jank.
      this.broadcastToSession(sessionId, { type: 'stream_delta', sessionId, role: 'thinking', text: s.currentThinkingText });
    } else if (evt.type === 'thinking_end') {
      s.isThinking = false;
      const text = evt.content || s.currentThinkingText;
      // Find the last thinking entry and finalize it
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].role === 'thinking' && buf[i].streaming) {
          buf[i].streaming = false;
          if (text) buf[i].text = text;
          this.broadcastHistoryUpsert(sessionId, [buf[i]]);
          break;
        }
      }
      s.activeStreamIdx = null;
      s.currentThinkingText = '';
    } else if (evt.type === 'text_delta') {
      const delta = evt.delta;
      const idx = s.activeStreamIdx;
      if (idx === null || buf[idx]?.role !== 'assistant') {
        if (idx !== null && buf[idx]) {
          buf[idx].streaming = false;
          this.broadcastHistoryUpsert(sessionId, [buf[idx]]); // finalize prior stream
        }
        s.currentStreamRole = 'assistant';
        s.currentStreamText = '';
        const entry = this.tagEntry({ role: 'assistant', text: '', streaming: true, timestamp: Date.now() });
        buf.push(entry);
        this.broadcastHistoryUpsert(sessionId, [entry]);
        s.activeStreamIdx = buf.length - 1;
      }
      s.currentStreamText += delta || '';
      buf[s.activeStreamIdx!].text = s.currentStreamText;
      this.broadcastToSession(sessionId, { type: 'stream_delta', sessionId, role: 'assistant', text: s.currentStreamText });
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
    const msgImages = extractImages(event.message.content);

    if (rawRole === 'assistant') {
      log.userSession.forSession(s.sessionState.sessionId).debug(
        `assistant message_end: text_len=${text.length}, content_types=[${(event.message.content || []).map((c: any) => c.type).join(',')}]`);
    }

    // Skip toolResult, thinking, and user messages — they are handled by
    // handleToolEnd, handleMessageUpdate, and addUserEntry (sent at prompt
    // time) respectively. Handling user messages here too would duplicate
    // the entry in the buffer.
    if (rawRole === 'toolResult' || rawRole === 'thinking' || rawRole === 'user') {
      // Still update stats
      accumulateUsage(s.sessionStats, event.message.usage);
      this.broadcastToSession(s.sessionState.sessionId, { type: 'stats', data: { ...s.sessionStats } });
      return;
    }

    // Finalize any streaming thinking messages
    const buf = this.historyFor(s.sessionState.sessionId);
    const sessionId = s.sessionState.sessionId;
    const upserts: any[] = [];
    for (const m of buf) {
      if (m.streaming && m.role === 'thinking') {
        m.streaming = false;
        upserts.push(m);
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
        ...(msgImages.length > 0 ? { images: [...(buf[streamingIdx].images || []), ...msgImages] } : {}),
      };
      upserts.push(buf[streamingIdx]);
    } else if (text || msgImages.length > 0) {
      const entry = this.tagEntry({
        role: rawRole,
        text,
        streaming: false,
        timestamp: Date.now(),
        ...(msgImages.length > 0 ? { images: msgImages } : {}),
      });
      buf.push(entry);
      upserts.push(entry);
    }

    // Keep only the last historyLimit messages (clients are told which
    // entries were dropped via history_remove)
    this.trimHistory(sessionId, buf);

    // Targeted event — full stream_history snapshots only happen on
    // reconnect/reload/session switch now
    this.broadcastHistoryUpsert(sessionId, upserts);

    // Detect errors — skip toolResult errors (handled by handleToolEnd instead)
    const msg = event.message;
    let errorText: string | null = null;
    if (msg.role !== 'toolResult' && (msg.stopReason === 'error' || msg.errorMessage)) {
      errorText = msg.errorMessage || 'An error occurred';
    }
    if (errorText) {
      const entry = this.tagEntry({ role: 'system', text: errorText, streaming: false, timestamp: Date.now(), isError: true });
      buf.push(entry);
      this.broadcastHistoryUpsert(sessionId, [entry]);
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
      const entry = this.tagEntry({
        role: 'toolCall',
        text: cmd,
        streaming: true,
        timestamp: Date.now(),
        toolCallId: event.toolCallId,
        toolCall: { name: event.toolName, cmd },
      });
      buf.push(entry);
      this.broadcastHistoryUpsert(s.sessionState.sessionId, [entry]);
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
        // Tool results with images split into the original (text/toolCall)
        // entry plus a pseudo 'image' entry so pictures render as
        // first-class chat content, not hidden inside a collapsed result.
        const entries = splitImageEntry(entry);
        // Stamp the originating call id on the result entry so clients can
        // match it against the streaming toolCall entry even when ids differ
        // (e.g. after a bootstrap snapshot re-read from the session file).
        (entries[0] as any).toolCallId = event.toolCallId;
        const buf = this.historyFor(s.sessionState.sessionId);
        const idx = buf.findIndex((e: any) => e.role === 'toolCall' && e.toolCallId === event.toolCallId);
        if (idx >= 0) {
          (entries[0] as any).id = buf[idx].id ?? this.tagEntry(entries[0]).id; // keep the toolCall's id — no client remount
          buf.splice(idx, 1, ...entries.map((e2) => this.tagEntry(e2)));
        } else {
          entries.forEach((e2) => this.tagEntry(e2));
          buf.push(...entries);
        }
        this.broadcastHistoryUpsert(s.sessionState.sessionId, entries);
        const sessionId = s.sessionState.sessionId;
        this.trimHistory(sessionId, buf);
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

}
