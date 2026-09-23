/**
 * Per-user session management.
 *
 * Each UserSession encapsulates a pi RPC process, its state,
 * event handlers, and SSE clients for a single authenticated user.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { createHash } from 'crypto';
import { MonitorRpcClient } from './rpc-client.js';
import { filterScopedModels, autoSessionName, readSessionUsage } from './utils.js';
import { log, userLog } from './logger.js';
import { ensurePiEnv } from './pi-env.js';
import { getEditIgnorePaths, getHistoryLimit, getImagePreviewQuality, getImageStreamFix, getSendImagesToChatModel, getUserSetting, getTokenPricing, getRatesForModel, computeTokenCost, writeReserveTokensConfig, annotateContextUsage } from './user-settings.js';
import { deliverToSession } from './client-hub.js';
import { getActivePersona } from './personas.js';
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
  extensionsState: any[];
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
      /** Persona bound to the current session ({ id, name }) — null when none */
      persona: null,
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
    extensionsState: [],
    currentStreamText: '',
    activeStreamId: null,
    currentThinkingText: '',
    isThinking: false,
  };
}

// ── UserSession ──

export class UserSession {
  /** The user this session (and its pi env) belongs to */
  readonly user: string;
  /** Session file this process is bound to (null until pi reports a fresh session) */
  sessionFile: string | null;
  /** Chat history buffer size (messages) — from the user's settings */
  readonly historyLimit: number;
  readonly rpc: MonitorRpcClient;
  readonly state: UserSessionState;
  // Stream-health tracking: a turn whose provider stream hangs (upstream stall,
  // invalid JSON, dead socket) never emits message_end/turn_end/agent_end, so
  // the only trace would be a truncated message in the UI. The stall watchdog
  // below turns that silence into a WARN in autere's logs.
  private lastRpcEventAt: number = 0;
  private stallWarned: boolean = false;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  // Stream history buffer for THIS session — one process, one session.
  private historyBuf: any[] = [];
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity: number = Date.now();
  private _idleTimeoutMs: number;
  private _onIdle: (() => void) | null = null;

  /** Whether this process was launched with --session pointing at an existing session */
  private resumedExistingSession: boolean;
  /** Session file pi was spawned with (--session) — used to seed UI state before pi finishes loading it */
  private resumedSessionFile: string | null = null;

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
      this.broadcast({ type: 'stats', data: { ...this.state.sessionStats } });
    }
  }

  /** Add the configured flat cost for a completed image tool call */
  private accumulateImageCost(toolName: string): void {
    if (toolName !== 'generate_image' && toolName !== 'edit_image') return;
    const pricing = getTokenPricing(this.user);
    if (!pricing || pricing.image === undefined) return;
    this.sessionCost += pricing.image;
    this.state.sessionStats.cost = this.sessionCost;
    this.broadcast({ type: 'stats', data: { ...this.state.sessionStats } });
  }

  constructor(user: string, sessionFile: string | null, rpcOptions: { provider?: string; model?: string; args?: string[] }, idleTimeoutMs: number = 30 * 60 * 1000) {
    this.user = user;
    this.sessionFile = sessionFile;
    // Chat history buffer size (messages). Settings saves restart the pi
    // process, so snapshotting here always reflects the current setting.
    this.historyLimit = getHistoryLimit(user);
    // Per-user pi environment: isolated agent dir (settings, sessions,
    // extension state) seeded from the global ~/.pi/agent as defaults.
    const piEnvDir = ensurePiEnv(user);
    this.piEnvDir = piEnvDir;
    // Reserve-context policy file for the pi-token-reserve extension — kept
    // current on every spawn so the extension always matches the setting.
    writeReserveTokensConfig(user);
    // Bind the process to its session: --session <file> when resuming, or a
    // brand-new session when sessionFile is null (auto-named in start()).
    const args = [...(rpcOptions.args || [])];
    this.resumedExistingSession = false;
    if (sessionFile && !args.includes('--session') && !args.includes('--continue') && !args.includes('-c')) {
      args.push('--session', sessionFile);
      this.resumedExistingSession = true;
      this.resumedSessionFile = sessionFile;
    }
    this.rpc = new MonitorRpcClient({ ...rpcOptions, args, agentDir: piEnvDir, editIgnorePaths: getEditIgnorePaths(user), sendImagesToChatModel: getSendImagesToChatModel(user), imagePreviewQuality: getImagePreviewQuality(user), imageStreamFix: getImageStreamFix(user) });
    this.state = createInitialState();
    this._idleTimeoutMs = idleTimeoutMs;
  }

  /** Set callback for when session goes idle */
  onIdle(cb: () => void) {
    this._onIdle = cb;
  }

  /** Settable by ProcessManager: fired when a turn ends (agent_end/
   * agent_settled) — used for deferred settings restarts. */
  onTurnEnd: (() => void) | null = null;

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
   * Broadcast an SSE event to all clients viewing THIS session (the hub
   * routes by session file — clients viewing other sessions of the same
   * user are untouched, and no cross-process forwarding exists).
   */
  broadcast(data: any) {
    deliverToSession(this.user, this.routedSessionFile(), data);
  }

  /** The session file events are routed by: spawn target or pi-reported. */
  routedSessionFile(): string | null {
    return this.sessionFile || this.state.sessionState.sessionFile || null;
  }

  /** Get the stream history buffer for this session */
  history(): any[] {
    return this.historyBuf;
  }

  /** Replace the stream history buffer for this session */
  setHistory(entries: any[]) {
    for (const e of entries) this.tagEntry(e);
    this.historyBuf = entries;
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
    const buf = this.history();
    buf.push(imgEntry);
    this.broadcastHistoryUpsert([imgEntry]);
  }

  /**
   * Record a just-sent user message in the history buffer and broadcast it
   * as a targeted upsert. This is what retires the client's optimistic
   * pending copy — pi does not emit message_end for user messages, so
   * without this the pending indicator would linger until turn end.
   */
  addUserEntry(text: string, queued = false): void {
    const buf = this.history();
    const entry = this.tagEntry({ role: 'user', text, streaming: false, timestamp: Date.now(), ...(queued ? { pending: true } : {}) });
    buf.push(entry);
    this.broadcastHistoryUpsert([entry]);
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
    const buf = this.history();
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].role === 'user' && (buf[i] as any).pending && buf[i].text === text) {
        const [removed] = buf.splice(i, 1);
        this.broadcast({ type: 'history_remove', sessionId, data: [removed.id] });
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


  /** Streaming with no RPC events for this long triggers the stall WARN */
  private static readonly STALL_WARN_MS = 120_000;

  /** Event types known to be benign — anything else hits the default WARN */
  private static readonly KNOWN_EVENT_TYPES = new Set([
    'session_start', 'session_info_changed', 'agent_start', 'agent_end', 'agent_settled',
    'queue_update', 'message_start', 'message_update', 'message_end', 'tool_execution_start',
    'tool_execution_end', 'model_select', 'entry_appended', 'compaction_start', 'compaction_end',
    'turn_start', 'turn_end', 'extension_ui_request', 'extension_error', 'auto_retry_start', 'auto_retry_end',
  ]);

  /**
   * Targeted history mutation event: upsert entries by stable id (replace
   * in place or append). Replaces the old full-buffer `stream_history`
   * broadcasts on live mutations — those resync only on reconnect, reload,
   * and session switch now.
   */
  private broadcastHistoryUpsert(entries: any[]): void {
    const list = entries.filter(Boolean);
    if (list.length === 0) return;
    this.broadcast({ type: 'history_upsert', sessionId: this.state.sessionState.sessionId, data: list });
  }

  /** Cap the buffer, telling clients which entries were dropped */
  private trimHistory(buf: any[]): void {
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
      this.broadcast({ type: 'history_remove', sessionId: this.state.sessionState.sessionId, data: removedIds });
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
      // One file pass, priced at the user's configured rates so the cost
      // seed below doesn't need a second read.
      const pricing = getTokenPricing(this.user);
      const fileStats = readSessionUsage(this.resumedSessionFile, (modelId, usage) => {
        const rates = pricing ? getRatesForModel(pricing, modelId) : null;
        return rates ? computeTokenCost(usage || {}, rates) : 0;
      });
      if (!st.messageCount) st.messageCount = fileStats.messageCount;
      if (!st.requestCount) st.requestCount = fileStats.requestCount;
      const tok = this.state.sessionStats.tokens;
      if (!tok.input && !tok.output && !tok.cacheRead && !tok.cacheWrite) {
        this.state.sessionStats.tokens = fileStats.tokens;
        log.userSession.info(`Seeded state from resumed session file (${st.messageCount} messages, in=${fileStats.tokens.input})`);
      }
      // pi's reported cost is 0 whenever the provider returns no cost data
      // (e.g. free-tier routing). Seed from the file so respawns (restart /
      // idle-stop / lazy spawn) don't reset the displayed cost to just the
      // post-respawn turns.
      if (!this.state.sessionStats.cost && fileStats.cost > 0) {
        this.setCostTotal(fileStats.cost);
        log.userSession.info(`Seeded session cost from file: $${fileStats.cost.toFixed(2)}`);
      }
    }

    // Start idle timer
    this.resetIdleTimer();

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
    try {
      await this.rpc.stop();
    } catch (err) {
      userLog(this.user).error('Failed to stop RPC:', err);
    }
    // Clients stay connected to the hub — they may simply switch to another
    // session's process. Only their own actions terminate the connection.
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
      this.state.sessionState.persona = getActivePersona(this.user, state.sessionFile);
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
        // Messages = all message entries in the session file (incl. tool
        // results); Requests = assistant messages = LLM requests. These must
        // match the session-file seed below and readSessionUsage semantics.
        this.state.sessionState.messageCount = stats.totalMessages || stats.userMessages || 0;
        this.state.sessionState.requestCount = stats.assistantMessages || stats.userMessages || 0;
        this.state.sessionStats.tokens = stats.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        // Seed the cumulative cost from pi (covers pi-catalog-priced history);
        // new messages accumulate on top (see handleMessageEnd/handleToolEnd).
        this.setCostTotal(stats.cost || 0);
        if (stats.contextUsage) this.state.sessionStats.contextUsage = annotateContextUsage(this.user, stats.contextUsage, this.state.sessionState.model);
      } catch (err) {
        log.userSession.error('fetchInitialState: failed to get session stats:', err);
      }

      // Model catalog loads ASYNC — a wedged provider/router must not delay
      // spawn completion (getOrCreate holds the session's spawn lock until
      // start() resolves; the /api/models endpoint fetches on demand anyway).
      this.rpc.getAvailableModels()
        .then((models) => {
          const scoped = filterScopedModels(models);
          this.state.availableModels = scoped.map((m: any) => ({
            provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined,
          }));
        })
        .catch((err) => {
          log.userSession.error('fetchInitialState: failed to get available models:', err);
        });

      // Load session history into the buffer for this specific session
      try {
        const messages = await this.rpc.getMessages();
        if (messages && messages.length > 0) {
          const buf = this.history();
          buf.push(...buildStreamHistoryFromMessages(messages));
          if (buf.length > this.historyLimit) buf.splice(0, buf.length - this.historyLimit);
        }
      } catch (err) {
        log.userSession.error('fetchInitialState: failed to load session history:', err);
      }
      // History must NEVER be lost to a failed/empty RPC path: fall back to
      // the session file (its message entries always have array content).
      if (this.history().length === 0) {
        try {
          const file = this.state.sessionState.sessionFile;
          if (file && existsSync(file)) {
            const raw = readMessageEntries(file, this.historyLimit);
            if (raw.length > 0) this.setHistory(buildStreamHistoryFromMessages(raw).slice(-this.historyLimit));
            log.userSession.info(`fetchInitialState: history fallback from session file (${raw.length} entries)`);
          }
        } catch (err) {
          log.userSession.error('fetchInitialState: session-file history fallback failed:', err);
        }
      }

      // pi resolves model + session asynchronously after spawn (seen as zeroed
      // stats after an idle respawn) — the stats fetch above can still miss
      // contextUsage, leaving the UI at 0 until the next message. One delayed
      // re-fetch heals it; broadcast so already-connected UIs see it.
      const bootedSessionId = this.state.sessionState.sessionId;
      setTimeout(() => {
        this.rpc.getSessionStats()
          .then((stats) => {
            if (!stats?.contextUsage || this.state.sessionState.sessionId !== bootedSessionId) return;
            this.state.sessionStats.contextUsage = annotateContextUsage(this.user, stats.contextUsage, this.state.sessionState.model);
            this.broadcast({ type: 'stats', data: { ...this.state.sessionStats } });
          })
          .catch(() => {});
      }, 2000);
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
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'agent_end':
        case 'agent_settled':
          s.sessionState.isStreaming = false;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          // Turn finished — send a full history snapshot as a safety resync.
          // The UI is idle now, so the larger payload costs nothing, and it
          // guarantees clients converge to ground truth after every turn
          // (heals any drift from missed/dropped targeted events).
          // Clear any stale streaming flags first: entries left streaming by
          // an abort/error path would otherwise blink forever in every
          // snapshot (they are only finalized on the happy path).
          for (const e of this.history()) {
            if (e.streaming) e.streaming = false;
          }
          this.broadcast({ type: 'stream_history', sessionId: s.sessionState.sessionId, data: this.history().slice(-this.historyLimit) });
          // Turn is over — a deferred settings restart (queued while this
          // turn was running) may now safely replace the pi process.
          this.onTurnEnd?.();
          break;
        case 'queue_update':
          // pi reports its actual steering/follow-up queues — the
          // authoritative pending counts for the chat buttons.
          s.sessionState.steerPending = Array.isArray(event.steering) ? event.steering.length : 0;
          s.sessionState.followUpPending = Array.isArray(event.followUp) ? event.followUp.length : 0;
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
            const buf = this.history();
            buf.push(fileEntry);
            this.broadcastHistoryUpsert([fileEntry]);
          } else if (entry?.customType === 'file_change' && entry.data?.diff) {
            const editEntry = this.tagEntry({
              role: 'edit',
              text: entry.data.diff,
              streaming: false,
              timestamp: Date.now(),
            });
            const buf = this.history();
            buf.push(editEntry);
            this.broadcastHistoryUpsert([editEntry]);
          } else if (entry?.customType === 'image_saved' && entry.data?.name) {
            this.pushImageEntry(entry.data.name, entry.data.mimeType);
          }
          break;
        }
        case 'compaction_start':
          s.sessionState.compacting = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'compaction_end':
          s.sessionState.compacting = false;
          s.sessionState.isStreaming = false;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          // Context shrank — refresh usage stats immediately (pi updates them
          // at compaction, we otherwise only re-fetch on message_end).
          this.rpc.getSessionStats().then(stats => {
            if (stats.contextUsage) s.sessionStats.contextUsage = annotateContextUsage(this.user, stats.contextUsage, s.sessionState.model);
            this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
          }).catch(() => {});
          break;
        case 'turn_start':
          s.sessionState.isStreaming = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'extension_error':
          log.userSession.forSession(s.sessionState.sessionId).warn(
            `extension error in ${event.extensionPath || 'unknown extension'}: ${event.error || JSON.stringify(event.event)}`);
          break;
        case 'auto_retry_start':
          log.userSession.forSession(s.sessionState.sessionId).warn(
            `auto retry ${event.attempt}/${event.maxAttempts} scheduled in ${event.delayMs}ms`);
          // Flatten the retry gap: the failed turn already hit agent_end
          // (isStreaming = false), but from the UI's point of view the turn is
          // still in progress — keep streaming status instead of blinking idle
          // for the delay window.
          s.sessionState.isStreaming = true;
          this.broadcast({ type: 'status', data: { ...s.sessionState } });
          break;
        case 'auto_retry_end':
          if (!event.success) {
            log.userSession.forSession(s.sessionState.sessionId).warn(
              `auto retry failed after ${event.attempt} attempt(s): ${event.finalError || 'unknown error'}`);
            s.sessionState.isStreaming = false;
            this.broadcast({ type: 'status', data: { ...s.sessionState } });
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
            this.setHistory(buildStreamHistoryFromMessages(rawMessages).slice(-this.historyLimit));
          }
          // The model the session ACTUALLY used — pi's getState().model can
          // report its CLI default instead of the resumed session's model,
          // which made the UI show e.g. mimo-v2.5-all for a glm session.
          for (let i = rawMessages.length - 1; i >= 0; i--) {
            const m: any = (rawMessages[i] as any).message;
            if (m?.role === 'assistant' && m.model) { lastSessionModel = m.model; break; }
          }
        }
      } catch (err) {
        log.userSession.error('handleSessionStart: session-file history load failed:', err);
      }

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
      this.broadcast({ type: 'status', data: { ...s.sessionState } });
      const buf = this.history();
      this.broadcast({ type: 'stream_history', sessionId: s.sessionState.sessionId, data: buf.slice(-this.historyLimit) });
    }).catch((err) => { log.userSession.error('handleSessionStart: failed to get state:', err); });
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

    // All history mutations apply to the CURRENT session's buffer. Events
    // arriving while sessionId is null (mid-session-switch) go to a detached
    // buffer that nobody is viewing — this prevents leaking one session's
    // content into another session's history.
    const buf = this.history();
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
          this.broadcastHistoryUpsert([cur]); // finalize prior stream
        }
        const entry = this.tagEntry({ role: 'thinking', text: s.currentThinkingText, streaming: true, timestamp: Date.now() });
        buf.push(entry);
        this.broadcastHistoryUpsert([entry]);
        s.activeStreamId = entry.id;
      } else {
        cur.text = s.currentThinkingText;
      }
      // Delta events send ONLY the streaming entry's text — never the full
      // history buffer. Re-broadcasting history (with multi-MB base64 images)
      // on every token caused multi-GB memory churn and client jank.
      this.broadcast({ type: 'stream_delta', sessionId, data: { role: 'thinking', text: s.currentThinkingText } });
    } else if (evt.type === 'thinking_end') {
      s.isThinking = false;
      const text = evt.content || s.currentThinkingText;
      // Find the last thinking entry and finalize it
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].role === 'thinking' && buf[i].streaming) {
          buf[i].streaming = false;
          if (text) buf[i].text = text;
          this.broadcastHistoryUpsert([buf[i]]);
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
          this.broadcastHistoryUpsert([cur]); // finalize prior stream
        }
        s.currentStreamText = '';
        const entry = this.tagEntry({ role: 'assistant', text: '', streaming: true, timestamp: Date.now() });
        buf.push(entry);
        this.broadcastHistoryUpsert([entry]);
        s.activeStreamId = entry.id;
      }
      s.currentStreamText += delta || '';
      const active = buf.find((m: any) => m.id === s.activeStreamId)!;
      active.text = s.currentStreamText;
      this.broadcast({ type: 'stream_delta', sessionId, data: { role: 'assistant', text: s.currentStreamText } });
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
      // Each finalized assistant message is one LLM request (matches the
      // readSessionUsage/pi getSessionStats seeding semantics).
      s.sessionState.requestCount++;
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
        const buf = this.history();
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
            this.broadcast({ type: 'history_remove', sessionId: s.sessionState.sessionId, data: [entry.id] });
          }
          this.broadcastHistoryUpsert([entry]);
        }
      }
      // Still update stats
      accumulateUsage(s.sessionStats, event.message.usage);
      this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
      return;
    }

    // Finalize any streaming thinking messages
    const buf = this.history();
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
    this.trimHistory(buf);

    // Targeted event — full stream_history snapshots only happen on
    // reconnect/reload/session switch now
    this.broadcastHistoryUpsert(upserts);

    // Detect errors — skip toolResult errors (handled by handleToolEnd instead)
    const msg = event.message;
    let errorText: string | null = null;
    if (msg.role !== 'toolResult' && (msg.stopReason === 'error' || msg.errorMessage)) {
      errorText = msg.errorMessage || 'An error occurred';
    }
    if (errorText) {
      const entry = this.tagEntry({ role: 'system', text: errorText, streaming: false, timestamp: Date.now(), isError: true });
      buf.push(entry);
      this.broadcastHistoryUpsert([entry]);
    }

    // Update stats + accumulate cost once per finalized message
    accumulateUsage(s.sessionStats, event.message.usage);
    if (rawRole === 'assistant' && event.message.usage) {
      this.accumulateMessageCost(event.message.model, event.message.usage);
    }

    this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
    this.broadcast({ type: 'status', data: { ...s.sessionState } });

    this.rpc.getSessionStats().then(stats => {
      if (stats.contextUsage) s.sessionStats.contextUsage = annotateContextUsage(this.user, stats.contextUsage, s.sessionState.model);
      this.broadcast({ type: 'stats', data: { ...s.sessionStats } });
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
    this.broadcast({ type: 'tool_start', data: { id: event.toolCallId, name: event.toolName, cmd } });

    // Show the tool call directly in the chat as a streaming toolCall entry;
    // handleToolEnd replaces it with the connected toolResult.
    {
      const buf = this.history();
      const entry = this.tagEntry({
        role: 'toolCall',
        text: cmd,
        streaming: true,
        timestamp: Date.now(),
        toolCallId: event.toolCallId,
        toolCall: { name: event.toolName, cmd },
      });
      buf.push(entry);
      this.broadcastHistoryUpsert([entry]);
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
    this.broadcast({ type: 'tool_end', data: { id: event.toolCallId, name: event.toolName, isError: event.isError, cmd, recentTools: s.recentTools } });

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
        const buf = this.history();
        const idx = buf.findIndex((e: any) => e.role === 'toolCall' && e.toolCallId === event.toolCallId);
        if (idx >= 0) {
          (entries[0] as any).id = buf[idx].id ?? this.tagEntry(entries[0]).id; // keep the toolCall's id — no client remount
          buf.splice(idx, 1, ...entries.map((e2) => this.tagEntry(e2)));
        } else {
          entries.forEach((e2) => this.tagEntry(e2));
          buf.push(...entries);
        }
        this.broadcastHistoryUpsert(entries);
        this.trimHistory(buf);
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
      this.broadcast({ type: 'status', data: { ...s.sessionState } });
    }
  }

}
