/**
 * Process manager — manages pi processes, one per pi agent session.
 *
 * Keyed by user + session file: a user can have many sessions running in
 * parallel (each its own pi RPC process), and every dashboard client talks
 * to whichever session it is viewing (routing via client-hub.ts).
 */

import { UserSession } from './user-session.js';
import { findSession } from '../shared/find-session.js';
import { readSessions } from './sessions.js';
import { log } from './logger.js';
import type { SessionInfo } from './types.js';

export interface ProcessManagerOptions {
  provider?: string;
  model?: string;
  args?: string[];
  idleTimeoutMs?: number;
  /** Whether a client without a session binding may fall back to its last session */
  resumeLastSession?: boolean;
}

export class ProcessManager {
  /** user → (session file → pi process for that session) */
  private sessions = new Map<string, Map<string, UserSession>>();
  /** Spawns in flight, keyed user::sessionFile — prevents double spawns */
  private starting = new Map<string, Promise<UserSession>>();
  private options: ProcessManagerOptions;
  private defaultIdleTimeoutMs: number;
  // Deferred pi restarts (settings saved while a turn was running), keyed
  // user::sessionFile. Each process applies its own restart at turn end.
  private pendingRestarts = new Set<string>();

  /** Queue a deferred settings restart for every STREAMING session process
   *  of the user (idle ones are restarted immediately by the caller) — each
   *  applies when its own current turn ends; restarting mid-turn kills it. */
  queueRestart(user: string): void {
    const map = this.sessions.get(user);
    if (!map) return;
    for (const [sessionFile, session] of map) {
      if (session.state.sessionState.isStreaming || session.state.sessionState.compacting) {
        this.pendingRestarts.add(`${user}::${sessionFile}`);
      }
    }
  }

  /** Whether login-time fallback may resume the auth session's last pi session */
  readonly resumeLastSession: boolean;

  constructor(options: ProcessManagerOptions = {}) {
    this.options = options;
    this.defaultIdleTimeoutMs = options.idleTimeoutMs || 30 * 60 * 1000; // 30 min default
    this.resumeLastSession = options.resumeLastSession !== false;
  }

  private key(user: string, sessionFile: string): string {
    return `${user}::${sessionFile}`;
  }

  /**
   * Get the running process for a session file, or spawn one bound to it.
   * sessionFile=null spawns a fresh session (pi picks id/file; the entry is
   * filed under the resolved file once start() completes).
   */
  async getOrCreate(user: string, sessionFile: string | null): Promise<UserSession> {
    if (sessionFile) {
      const existing = this.sessions.get(user)?.get(sessionFile);
      if (existing && existing.isRunning) {
        existing.touch();
        return existing;
      }
      if (existing) this.sessions.get(user)!.delete(sessionFile);
    }

    // Concurrent callers (e.g. two tabs bootstrapping the same session) must
    // share one spawn — otherwise two pi processes race for the session.
    const k = `${user}::${sessionFile || 'new'}`;
    const inFlight = this.starting.get(k);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const session = new UserSession(user, sessionFile, {
        provider: this.options.provider,
        model: this.options.model,
        args: this.options.args,
      }, this.defaultIdleTimeoutMs);

      session.onIdle(() => {
        log.processMgr.info(`Idle timeout, terminating session process (${user}, ${sessionFile ? sessionFile.slice(-20) : 'new'})`);
        this.terminate(user, session.routedSessionFile());
      });

      // Deferred settings restart: applied when the current turn ends —
      // restarting mid-turn would kill an active session. Fires on the first
      // turn end after queueing, BEFORE any new turn can start.
      session.onTurnEnd = () => {
        const key = `${user}::${session.routedSessionFile()}`;
        if (!this.pendingRestarts.delete(key)) return;
        log.processMgr.info(`Applying deferred settings restart for session (${user})`);
        this.terminate(user, session.routedSessionFile())
          .then(() => this.getOrCreate(user, session.routedSessionFile()))
          .catch((err) => log.processMgr.error(`Deferred settings restart failed: ${err}`));
      };

      try {
        // Startup watchdog: pi waits on its provider/router at spawn — when
        // that is wedged (hung upstream), start() must not hold the in-flight
        // spawn lock forever (every later getOrCreate for the session would
        // hang with it). Kill the straggler and fail fast instead.
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('pi RPC startup timeout (60s) — provider may be wedged')), 90_000);
        });
        await Promise.race([session.start(), timeout]);
      } catch (err) {
        log.processMgr.error(`Failed to start pi process for session (${user}):`, err);
        session.stop().catch(() => {});
        throw err;
      }

      let map = this.sessions.get(user);
      if (!map) {
        map = new Map();
        this.sessions.set(user, map);
      }
      // Fresh spawn: file pi's session under its resolved session file. A
      // concurrent same-key 'new' caller may already have filed an entry —
      // keep the first (shared via the starting promise) and drop the dupe.
      const resolvedFile = session.routedSessionFile();
      if (resolvedFile) {
        const dupe = map.get(resolvedFile);
        if (dupe && dupe !== session && dupe.isRunning) {
          // Another process won the race — stop this redundant one.
          session.stop().catch(() => {});
          return dupe;
        }
        map.set(resolvedFile, session);
      }
      return session;
    })();

    this.starting.set(k, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(k);
    }
  }

  /** Get an existing running process for a session file */
  get(user: string, sessionFile: string | null): UserSession | undefined {
    if (!sessionFile) return undefined;
    const session = this.sessions.get(user)?.get(sessionFile);
    return session && session.isRunning ? session : undefined;
  }

  /** Terminate one session's process (no-op when not running) */
  async terminate(user: string, sessionFile: string | null): Promise<void> {
    const map = this.sessions.get(user);
    if (!map || !sessionFile) return;
    const session = map.get(sessionFile);
    if (!session) return;
    map.delete(sessionFile);
    await session.stop();
  }

  /** Terminate every process of a user (user deleted / shutdown) */
  async terminateByUser(user: string): Promise<void> {
    const map = this.sessions.get(user);
    if (!map) return;
    this.sessions.delete(user);
    for (const session of map.values()) {
      await session.stop();
    }
  }

  /** Terminate all processes (shutdown) */
  async terminateAll(): Promise<void> {
    for (const user of [...this.sessions.keys()]) {
      await this.terminateByUser(user);
    }
  }

  /** All running session processes (for periodic broadcasts) */
  allSessions(): UserSession[] {
    const out: UserSession[] = [];
    for (const map of this.sessions.values()) {
      for (const session of map.values()) {
        if (session.isRunning) out.push(session);
      }
    }
    return out;
  }

  /** Users that currently have at least one session process */
  activeUsers(): string[] {
    return [...this.sessions.keys()].filter((u) => (this.sessions.get(u)?.size || 0) > 0);
  }

  /**
   * Refresh the user's session list from disk (their pi env sessions dir).
   * Stamps live flags from the running processes and keeps in-memory entries
   * for brand-new sessions whose files don't exist on disk yet (pi only
   * writes the file on the first message) while at least one client views
   * them or their process is running.
   */
  refreshSessions(user: string, viewed: Set<string | null>): SessionInfo[] {
    const fresh = this.readSessionsForUser(user);
    const diskIds = new Set(fresh.map(s => s.sessionFile));
    const map = this.sessions.get(user);
    const synthetic: SessionInfo[] = [];
    for (const session of map?.values() || []) {
      const file = session.routedSessionFile();
      if (!file || diskIds.has(file)) continue;
      const info = this.syntheticInfo(session);
      if (info) synthetic.push(info);
    }
    // A session whose process died before its file was written, but that a
    // client still views (e.g. just-created, zero messages) — keep listing
    // it so the UI doesn't lose its current entry mid-view.
    for (const s of this.syntheticCache.get(user)?.values() || []) {
      if (!diskIds.has(s.sessionFile) && viewed.has(s.sessionFile) && !synthetic.some((x) => x.sessionFile === s.sessionFile)) {
        synthetic.push({ ...s });
      }
    }
    return [...synthetic, ...fresh];
  }

  /** Cache of file-less session infos per user (survives process restarts) */
  private syntheticCache = new Map<string, Map<string, SessionInfo>>();

  /** Build/lookup a SessionInfo for a session with no file on disk yet */
  private syntheticInfo(session: UserSession): SessionInfo | null {
    const file = session.routedSessionFile();
    if (!file) return null;
    const st = session.state.sessionState;
    const info: SessionInfo = {
      id: st.sessionId || file.replace(/\.jsonl$/, '').split('/').pop() || file,
      sessionFile: file,
      sessionName: st.sessionName || null,
      parentSession: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      cwd: null,
    };
    let cache = this.syntheticCache.get(session.user);
    if (!cache) {
      cache = new Map();
      this.syntheticCache.set(session.user, cache);
    }
    const prev = cache.get(file);
    const merged = prev ? { ...prev, sessionName: info.sessionName ?? prev.sessionName, lastActivity: Math.max(prev.lastActivity, info.lastActivity) } : info;
    cache.set(file, merged);
    return { ...merged };
  }

  /** Invalidate a synthetic entry once its file exists on disk */
  private pruneSynthetic(user: string, sessionFile: string): void {
    this.syntheticCache.get(user)?.delete(sessionFile);
  }

  /**
   * Sessions list for the user, with live flags: active (process running)
   * and streaming (its turn is in flight). Disk entries carry the flags;
   * synthetic (file-less) entries are always active.
   */
  listSessions(user: string, viewed: Set<string | null>): SessionInfo[] {
    const map = this.sessions.get(user);
    const sessions = this.refreshSessions(user, viewed);
    for (const s of sessions) {
      const session = map?.get(s.sessionFile);
      // isRunning check: a pi process that died (crash/OOM) must not keep
      // the session flagged active/streaming — get() already filters it.
      const running = !!session && session.isRunning;
      s.active = running || this.syntheticCache.get(user)?.has(s.sessionFile) || false;
      s.streaming = running ? session!.state.sessionState.isStreaming || session!.state.sessionState.compacting : false;
      s.compacting = running && session!.state.sessionState.compacting;
    }
    return sessions;
  }

  /** Resolve a session (by id or alias) from the user's list */
  findSession(user: string, sessionId: string, viewed: Set<string | null>) {
    return findSession(sessionId, this.listSessions(user, viewed));
  }


  /** Register a just-created session so it is listable before pi writes the file */
  registerSynthetic(user: string, info: SessionInfo): void {
    let cache = this.syntheticCache.get(user);
    if (!cache) {
      cache = new Map();
      this.syntheticCache.set(user, cache);
    }
    cache.set(info.sessionFile, info);
  }

  readSessionsForUser(user: string): SessionInfo[] {
    const fresh = readSessions(user);
    for (const s of fresh) this.pruneSynthetic(user, s.sessionFile);
    return fresh;
  }
}