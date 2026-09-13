/**
 * Per-user session management.
 *
 * Each UserSession encapsulates a pi RPC process, its state,
 * event handlers, and SSE clients for a single authenticated user.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { createHash } from 'crypto';
import type { ServerResponse } from 'http';
import { MonitorRpcClient } from './rpc-client.js';
import { filterScopedModels, autoSessionName, readSessionUsage } from './utils.js';
import { log, userLog } from './logger.js';
import { getLastSession } from './auth.js';
import { ensurePiEnv } from './pi-env.js';
import { readSessions } from './sessions.js';
import type { SessionInfo } from './types.js';
import { getEditIgnorePaths, getHistoryLimit, getImagePreviewQuality, getImageStreamFix, getSendImagesToChatModel, getUserSetting, getTokenPricing, getRatesForModel, computeTokenCost } from './user-settings.js';
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
  activeStreamId: string | null;
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
      // Set by /api/abort-compaction, consumed by the late compact()
      // rejection: user-initiated aborts surface as a chat notice, not an
      // error popup (shared per-session, so every client is covered).
      compactionAborted: false,
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
    activeStreamId: null,
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
  // Stream-health tracking: a turn whose provider stream hangs (upstream stall,
  // invalid JSON, dead socket) never emits message_end/turn_end/agent_end, so
  // the only trace would be a truncated message in the UI. The stall watchdog
  // below turns that silence into a WARN in autere's logs.
  private lastRpcEventAt: number = 0;
  private stallWarned: boolean = false;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  // Stream history buffers, one per session. A single shared buffer would mix
  // messages from different sessions when clients view or switch sessions.
  private historyBuffers: Map<string, any[]> = new Map();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity: number = Date.now();
  private _idleTimeoutMs: number;
  private _onIdle: (() => void) | null = null;

  /** Whether this process was launched with --session pointing at an existing session */
  private resumedExistingSession: boolean;
  /** Session file pi was spawned with (--session) — used to seed UI state before pi finishes loading it */
  private resumedSessionFile: string | null = null;

  // Per-user peer registry membership (see session-peers.ts)
  private unregisterPeer: (() => void) | null = null;
  /** This user's pi environment dir (images extracted from history land here) */
  private piEnvDir!: string;
  /** Cumulative session cost (pi-reported + fallback-priced + image ops) */
  private sessionCost = 0;

  /**
   * Set the session cost total (e.g. computed from session-file usage on
   * switch/reload). Keeps the live accumulator in sync so the next streamed
   * message CONTINUES from this value instead of resetting to it.
   */
  setCostTotal(cost: number): void {
    this.sessionCost = cost;
    this.state.sessionStats.cost = cost;
  }

  /**
   * Cost of one assistant message: pi's own figure when it could price the
   * model (its baked-in catalog), else the user's configured rates for the
   * actual model id, else the user's default rates. Adds to the cumulative
   * session total and broadcasts it.
   */
  private accumulateMessageCost(modelId: string | undefined, usage: any): void {
    let msgCost = 0;
    const piCost = Number(usage?.cost?.total);
    if (Number.isFinite(piCost) && piCost > 0) {
      msgCost = piCost; // pi catalog price
    } else {
      const pricing = getTokenPricing(this.user);
      if (pricing) {
        const rates = getRatesForModel(pricing, modelId);
        if (rates) msgCost = computeTokenCost(usage || {}, rates);
      }
    }
    if (msgCost > 0) {
      this.sessionCost += msgCost;
      this.state.sessionStats.cost = this.sessionCost;
      this.broadcastToSession(this.state.sessionState.sessionId, { type: 'stats', data: { ...this.state.sessionStats } });
    }
  }

  /** Add the configured flat cost for a completed image tool call */
  private accumulateImageCost(toolName: string): void {
    if (toolName !== 'generate_image' && toolName !== 'edit_image') return;
    const pricing = getTokenPricing(this.user);
    if (!pricing || pricing.image === undefined) return;
    this.sessionCost += pricing.image;
    this.state.sessionStats.cost = this.sessionCost;
    this.broadcastToSession(this.state.sessionState.sessionId, { type: 'stats', data: { ...this.state.sessionStats } });
  }

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
        this.resumedSessionFile = lastSession;
      }
    }
    this.rpc = new MonitorRpcClient({ ...rpcOptions, args, agentDir: piEnvDir, editIgnorePaths: getEditIgnorePaths(user), sendImagesToChatModel: getSendImagesToChatModel(user), imagePreviewQuality: getImagePreviewQuality(user), imageStreamFix: getImageStreamFix(user) });
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
      if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = null; }
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
      try { client.write(msg); } catch (err) {
        log.userSession.warn(`SSE write failed, dropping client: ${err}`);
        this.sseClients.delete(client);
      }
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
   * Publish an image (already saved in uploads under a hist-* name) as a
   * first-class chat image entry — used for image_saved entries from
   * pi-images and for user attachments whose base64 is stripped before the
   * LLM context.
   */
  pushImageEntry(name: string, mimeType?: string): void {
    const imgEntry = this.tagEntry({
      role: 'image',
      text: '',
      streaming: false,
      timestamp: Date.now(),
      images: [{ mimeType: mimeType || 'image/png', url: `/api/images/${name}` }],
    });
    const buf = this.historyFor(this.state.sessionState.sessionId);
    buf.push(imgEntry);
    this.broadcastHistoryUpsert(this.state.sessionState.sessionId, [imgEntry]);
  }

  /**
   * Record a just-sent user message in the history buffer and broadcast it
   * as a targeted upsert. This is what retires the client's optimistic
   * pending copy — pi does not emit message_end for user messages, so
   * without this the pending indicator would linger until turn end.
   */
  addUserEntry(text: string, queued = false): void {
    const sessionId = this.state.sessionState.sessionId;
    const buf = this.historyFor(sessionId);
    const entry = this.tagEntry({ role: 'user', text, streaming: false, timestamp: Date.now(), ...(queued ? { pending: true } : {}) });
    buf.push(entry);
    this.broadcastHistoryUpsert(sessionId, [entry]);
  }

  /**
   * Cancel one queued (steer/follow-up) user message by text. pi's RPC only
   * offers all-or-nothing clear_queue — which returns the dropped texts — so
   * we clear, prune the match, and re-queue the rest in order.
   * ponytail: re-queue is text-only; a queued message with image attachments
   * would lose them. Add image round-tripping if that ever matters.
   */
  async cancelPending(text: string): Promise<boolean> {
    const cleared = await this.rpc.clearQueue();
    let cancelled = false;
    const prune = (arr: string[]) => {
      const idx = arr.indexOf(text);
      if (idx >= 0) { arr.splice(idx, 1); cancelled = true; }
    };
    prune(cleared.steering);
    prune(cleared.followUp);
    for (const t of cleared.steering) await this.rpc.steer(t);
    for (const t of cleared.followUp) await this.rpc.followUp(t);
    if (!cancelled) return false;
    // Drop the pending copy from the history buffer (optimistic client
    // copies are removed by the caller)
    const sessionId = this.state.sessionState.sessionId;
    const buf = this.historyFor(sessionId);
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].role === 'user' && (buf[i] as any).pending && buf[i].text === text) {
        const [removed] = buf.splice(i, 1);
        this.broadcastToSession(sessionId, { type: 'history_remove', sessionId, data: [removed.id] });
        break;
      }
    }
    return true;
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
  private static readonly FORWARDED_EVENT_TYPES = new Set(['stream_history', 'history_upsert', 'history_remove', 'stream_delta', 'stats', 'tool_start', 'tool_end']);

  /** Streaming with no RPC events for this long triggers the stall WARN */
  private static readonly STALL_WARN_MS = 120_000;

  /** Event types known to be benign — anything else hits the default WARN */
  private static readonly KNOWN_EVENT_TYPES = new Set([
    'session_start', 'session_info_changed', 'agent_start', 'agent_end', 'agent_settled',
    'queue_update', 'message_start', 'message_update', 'message_end', 'tool_execution_start',
    'tool_execution_end', 'model_select', 'entry_appended', 'compaction_start', 'compaction_end',
    'turn_start', 'extension_ui_request', 'extension_error', 'auto_retry_start', 'auto_retry_end',
  ]);

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
    if (buf.length <= this.historyLimit) return;
    // Trim from the front, but NEVER drop user entries: a single turn can
    // produce 50+ tool/thinking/edit entries, and evicting the user's own
    // messages from the trailing window makes the dashboard lose the
    // conversation (the agent_end snapshot then confirms the loss).
    const excess = buf.length - this.historyLimit;
    const removedIds: any[] = [];
    let removed = 0;
    let i = 0;
    while (i < buf.length && removed < excess) {
      if (buf[i].role === 'user') { i++; continue; }
      if (buf[i].id) removedIds.push(buf[i].id);
      buf.splice(i, 1);
      removed++;
    }
    if (removedIds.length > 0) {
      this.broadcastToSession(sessionId, { type: 'history_remove', sessionId, data: removedIds });
    }
  }

  /** Write an SSE event to this UserSession's clients viewing sessionId */
  private writeToSessionClients(sessionId: string | null, data: any) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const [client, clientSessionId] of this.sseClients) {
      if (this.clientViewsSession(clientSessionId, sessionId)) {
        try { client.write(msg); } catch (err) {
          log.userSession.warn(`SSE write failed, dropping client: ${err}`);
          this.sseClients.delete(client);
        }
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

    // pi loads its --session file asynchronously: right after spawn its
    // get_state/stats can still be null/zero (seen as boot st=in0 msgs=0
    // sess=? after an idle respawn). Seed the UI state from the session
    // file we spawned pi with — only filling what pi hasn't reported yet.
    if (this.resumedSessionFile && existsSync(this.resumedSessionFile)) {
      const st = this.state.sessionState;
      if (!st.sessionId) st.sessionId = basename(this.resumedSessionFile, '.jsonl');
      st.sessionFile = st.sessionFile || this.resumedSessionFile;
      const fileStats = readSessionUsage(this.resumedSessionFile);
      if (!st.messageCount) st.messageCount = fileStats.messageCount;
      if (!st.requestCount) st.requestCount = fileStats.requestCount;
      const tok = this.state.sessionStats.tokens;
      if (!tok.input && !tok.output && !tok.cacheRead && !tok.cacheWrite) {
        this.state.sessionStats.tokens = fileStats.tokens;
        log.userSession.info(`Seeded state from resumed session file (${st.messageCount} messages, in=${fileStats.tokens.input})`);
      }
    }

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
        // Seed the cumulative cost from pi (covers pi-catalog-priced history);
        // new messages accumulate on top (see handleMessageEnd/handleToolEnd).
        this.setCostTotal(stats.cost || 0);
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
      this.lastRpcEventAt = Date.now();
      this.stallWarned = false;
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
          // Overlap detection: a new run starting while the previous one never
          // emitted agent_end means the previous stream was aborted or hung —
          // usually an upstream/provider failure. Without this the orphaned
          // run is invisible in the logs (only DEBUG lines, no end).
          if (s.sessionState.isStreaming) {
            log.userSession.forSession(s.sessionState.sessionId).warn(
              'agent_start while previous run never ended — previous stream was aborted or hung (truncated message likely shown)');
          }
          // Fresh run — tool entries from a previous run are dead (their
          // tool_execution_end never arrived) and must not pollute cmd lookups.
          s.activeTools.clear();
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
          // Clear any stale streaming flags first: entries left streaming by
          // an abort/error path would otherwise blink forever in every
          // snapshot (they are only finalized on the happy path).
          for (const e of this.historyFor(s.sessionState.sessionId)) {
            if (e.streaming) e.streaming = false;
          }
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
        case 'tool_execution_update':
          // Partial tool results (e.g. streaming bash output) — deliberately
          // not rendered: the final result arrives via tool_execution_end, and
          // these events still feed the stall watchdog (lastRpcEventAt).
          // Implement partial-output streaming here if the UI ever wants it.
          break;
        case 'tool_execution_end':
          this.handleToolEnd(event);
          break;
        case 'model_select':
          this.handleModelSelect(event);
          break;
        case 'entry_appended': {
          // pi-filetools announces shared files (save_file tool) and
          // bash-driven file edits via pi.appendEntry — surface them as
          // 'file' pseudo-entries (downloadable cards) and 'edit' entries
          // (diff cards) respectively.
          const entry = event.entry;
          if (entry?.customType === 'file_saved' && entry.data?.savedName) {
            // Images broadcast as 'image' entries (inline preview) — the mime
            // type from save_file is reliable; everything else is a file card.
            const isImage = (entry.data.mimeType || '').startsWith('image/');
            const fileEntry = this.tagEntry(isImage ? {
              role: 'image',
              text: '',
              streaming: false,
              timestamp: Date.now(),
              images: [{ mimeType: entry.data.mimeType, url: `/api/files/${encodeURIComponent(entry.data.savedName)}` }],
            } : {
              role: 'file',
              text: '',
              streaming: false,
              timestamp: Date.now(),
              file: entry.data,
            });
            const buf = this.historyFor(s.sessionState.sessionId);
            buf.push(fileEntry);
            this.broadcastHistoryUpsert(s.sessionState.sessionId, [fileEntry]);
          } else if (entry?.customType === 'file_change' && entry.data?.diff) {
            const editEntry = this.tagEntry({
              role: 'edit',
              text: entry.data.diff,
              streaming: false,
              timestamp: Date.now(),
            });
            const buf = this.historyFor(s.sessionState.sessionId);
            buf.push(editEntry);
            this.broadcastHistoryUpsert(s.sessionState.sessionId, [editEntry]);
          } else if (entry?.customType === 'image_saved' && entry.data?.name) {
            this.pushImageEntry(entry.data.name, entry.data.mimeType);
          }
          break;
        }
        case 'compaction_start':
          s.sessionState.compacting = true;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          break;
        case 'compaction_end':
          s.sessionState.compacting = false;
          s.sessionState.isStreaming = false;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          this.notifyPeersSessionActivity(false);
          // Context shrank — refresh usage stats immediately (pi updates them
          // at compaction, we otherwise only re-fetch on message_end).
          this.rpc.getSessionStats().then(stats => {
            if (stats.contextUsage) s.sessionStats.contextUsage = stats.contextUsage;
            this.broadcastToSession(s.sessionState.sessionId, { type: 'stats', data: { ...s.sessionStats } });
          }).catch(() => {});
          break;
        case 'turn_start':
          s.sessionState.isStreaming = true;
          this.broadcastToSession(s.sessionState.sessionId, { type: 'status', data: { ...s.sessionState } });
          this.notifyPeersSessionActivity(true);
          break;
        case 'extension_error':
          log.userSession.forSession(s.sessionState.sessionId).warn(
            `extension error in ${event.extensionPath || 'unknown extension'}: ${event.error || JSON.stringify(event.event)}`);
          break;
        case 'auto_retry_start':
          log.userSession.forSession(s.sessionState.sessionId).warn(
            `auto retry ${event.attempt}/${event.maxAttempts} scheduled in ${event.delayMs}ms`);
          break;
        case 'auto_retry_end':
          if (!event.success) {
            log.userSession.forSession(s.sessionState.sessionId).warn(
              `auto retry failed after ${event.attempt} attempt(s): ${event.finalError || 'unknown error'}`);
          }
          break;
        default:
          // Unknown event types must not vanish silently — pi may add error-
          // bearing events (extension_error, retries, provider aborts) that
          // diagnostics depend on. KNOWN_EVENT_TYPES filters out the benign
          // ones we deliberately ignore.
          if (!UserSession.KNOWN_EVENT_TYPES.has(event.type)) {
            log.userSession.forSession(s.sessionState.sessionId).warn(
              `unhandled RPC event type: ${event.type}`);
          }
          break;
      }

      this.touch();
    });

    // Stall watchdog: while a turn is streaming, WARN if no RPC events have
    // arrived for STALL_WARN_MS. Covers the "assistant message frozen/truncated"
    // case where the upstream stream stalls without ever erroring.
    this.lastRpcEventAt = Date.now();
    this.stallTimer = setInterval(() => {
      if (s.sessionState.isStreaming && !this.stallWarned
          && Date.now() - this.lastRpcEventAt > UserSession.STALL_WARN_MS) {
        this.stallWarned = true;
        log.userSession.forSession(s.sessionState.sessionId).warn(
          `turn stalled: no RPC events for ${Math.round((Date.now() - this.lastRpcEventAt) / 1000)}s while streaming — provider stream may have hung`);
      }
    }, 30_000);
  }

  private handleSessionStart(_event: any): void {
    const s = this.state;
    const rpc = this.rpc;

    // Reset streaming state — a new session has begun
    s.activeStreamId = null;
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
      let lastSessionModel: string | null = null;
      try {
        if (s.sessionState.sessionFile && existsSync(s.sessionState.sessionFile)) {
          const rawMessages = readMessageEntries(s.sessionState.sessionFile, this.historyLimit);
          if (rawMessages.length > 0) {
            this.setHistoryFor(s.sessionState.sessionId, buildStreamHistoryFromMessages(rawMessages).slice(-this.historyLimit));
          }
          // The model the session ACTUALLY used — pi's getState().model can
          // report its CLI default instead of the resumed session's model,
          // which made the UI show e.g. mimo-v2.5-all for a glm session.
          for (let i = rawMessages.length - 1; i >= 0; i--) {
            const m: any = (rawMessages[i] as any).message;
            if (m?.role === 'assistant' && m.model) { lastSessionModel = m.model; break; }
          }
        }
      } catch {}

      s.sessionState.sessionName = state.sessionName || null;
      s.sessionState.isStreaming = state.isStreaming;
      s.sessionState.compacting = state.isCompacting;
      if (state.model) {
        // Prefer the model observed in the session file over pi's reported
        // default (see lastSessionModel above).
        const id = lastSessionModel || state.model.id;
        s.sessionState.model = {
          provider: state.model.provider,
          id,
          name: (lastSessionModel ? lastSessionModel.replace(/^[a-z0-9-]+\//i, '') : state.model.name) || id,
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
      // Track the streaming entry by stable id, NOT index — trimHistory
      // shifts the buffer mid-turn and a numeric index goes stale (leaving
      // the old thinking entry streaming forever + spawning a duplicate).
      const cur = s.activeStreamId ? buf.find((m: any) => m.id === s.activeStreamId) : undefined;
      if (!cur || cur.role !== 'thinking') {
        if (cur) {
          cur.streaming = false;
          this.broadcastHistoryUpsert(sessionId, [cur]); // finalize prior stream
        }
        const entry = this.tagEntry({ role: 'thinking', text: s.currentThinkingText, streaming: true, timestamp: Date.now() });
        buf.push(entry);
        this.broadcastHistoryUpsert(sessionId, [entry]);
        s.activeStreamId = entry.id;
      } else {
        cur.text = s.currentThinkingText;
      }
      // Delta events send ONLY the streaming entry's text — never the full
      // history buffer. Re-broadcasting history (with multi-MB base64 images)
      // on every token caused multi-GB memory churn and client jank.
      this.broadcastToSession(sessionId, { type: 'stream_delta', sessionId, data: { role: 'thinking', text: s.currentThinkingText } });
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
      s.activeStreamId = null;
      s.currentThinkingText = '';
    } else if (evt.type === 'text_delta') {
      const delta = evt.delta;
      const cur = s.activeStreamId ? buf.find((m: any) => m.id === s.activeStreamId) : undefined;
      if (!cur || cur.role !== 'assistant') {
        if (cur) {
          cur.streaming = false;
          this.broadcastHistoryUpsert(sessionId, [cur]); // finalize prior stream
        }
        s.currentStreamText = '';
        const entry = this.tagEntry({ role: 'assistant', text: '', streaming: true, timestamp: Date.now() });
        buf.push(entry);
        this.broadcastHistoryUpsert(sessionId, [entry]);
        s.activeStreamId = entry.id;
      }
      s.currentStreamText += delta || '';
      const active = buf.find((m: any) => m.id === s.activeStreamId)!;
      active.text = s.currentStreamText;
      this.broadcastToSession(sessionId, { type: 'stream_delta', sessionId, data: { role: 'assistant', text: s.currentStreamText } });
    }

    // Update usage if present
    // Token/cost stats are accumulated ONCE per finalized message in
    // handleMessageEnd — message_update events stream partial per-request
    // usage, and overwriting the cumulative totals with them (or adding
    // them per delta) would corrupt the session totals.
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
      const stop = event.message.stopReason;
      log.userSession.forSession(s.sessionState.sessionId).debug(
        `assistant message_end: text_len=${text.length}, stop=${stop}, content_types=[${(event.message.content || []).map((c: any) => c.type).join(',')}]`);
      if (stop === 'error' || stop === 'aborted') {
        log.userSession.forSession(s.sessionState.sessionId).warn(
          `assistant stream ended with stop=${stop}: ${event.message.errorMessage || '(no error message)'}`);
      }
    }

    // Skip toolResult, thinking, and user messages — they are handled by
    // handleToolEnd, handleMessageUpdate, and addUserEntry (sent at prompt
    // time) respectively. Handling user messages here too would duplicate
    // the entry in the buffer.
    if (rawRole === 'toolResult' || rawRole === 'thinking' || rawRole === 'user') {
      // A queued (steer/follow-up) user message reaching message_end means
      // pi has now processed it — retire its pending flag. The entry itself
      // was already added by addUserEntry at send time (no duplicate here).
      if (rawRole === 'user' && text) {
        const buf = this.historyFor(s.sessionState.sessionId);
        const entry = [...buf].reverse().find((e: any) => e.role === 'user' && e.text === text && e.pending);
        if (entry) {
          entry.pending = false;
          // A queued follow-up was appended at SEND time, mid-turn — buried
          // under the rest of the old turn's output. Now that pi consumes
          // it, move it to the end of the buffer so it sits directly above
          // the new turn it starts. Clients: remove from old spot (by id),
          // then upsert (appends at end).
          const idx = buf.indexOf(entry);
          const moved = idx >= 0 && idx !== buf.length - 1;
          if (moved) buf.splice(idx, 1);
          buf.push(entry);
          if (moved) {
            this.broadcastToSession(s.sessionState.sessionId, { type: 'history_remove', sessionId: s.sessionState.sessionId, data: [entry.id] });
          }
          this.broadcastHistoryUpsert(s.sessionState.sessionId, [entry]);
        }
      }
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

    // Update stats + accumulate cost once per finalized message
    accumulateUsage(s.sessionStats, event.message.usage);
    if (rawRole === 'assistant' && event.message.usage) {
      this.accumulateMessageCost(event.message.model, event.message.usage);
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
    const cmd = formatToolArgs(event.toolName, event.args);

    // Parallel tool calls are normal (pi executes them concurrently) — every
    // start registers its own entry and every end resolves by its own
    // toolCallId. Stale entries from dead runs are cleared on agent_start;
    // clearing them here would break the cmd lookup for the FIRST call of a
    // parallel pair (its card would render without the command line).
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
    this.accumulateImageCost(event.toolName);
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
