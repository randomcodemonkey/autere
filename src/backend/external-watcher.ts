/**
 * External activity watcher.
 *
 * Detects writes to session files made by OTHER pi processes (e.g. the
 * operator running `pi` in a terminal on the same session an autere user
 * is viewing). Polls file sizes on an interval; the UserSession wires the
 * callbacks to broadcasts and history reloads.
 *
 * Cross-process *instant* notifications (another autere-managed pi) arrive
 * via external-activity.ts and are recorded here through flagActivity() so
 * both paths share the same 60s expiry bookkeeping.
 */

import { existsSync, statSync } from 'fs';
import { log } from './logger.js';
import { buildStreamHistoryFromMessages, readMessageEntries } from './stream-history.js';

export interface ViewedSession {
  sessionId: string;
  sessionFile: string | undefined;
  isCurrent: boolean;
}

export interface WatcherDeps {
  /** Sessions currently being viewed (pi's current + all client views). */
  getViewedSessions(): ViewedSession[];
  /** Whether our pi process produced events since the last poll. */
  hasRecentPiEvent(): boolean;
  /** Consume one "our pi wrote this" credit. */
  consumePiEvent(): void;
  /** External write detected on pi's CURRENT session. */
  onCurrentExternalActivity(sessionId: string): void;
  /** External write detected on a non-current viewed session. */
  onViewedExternalActivity(sessionId: string): void;
  /** External flag expired after 60s of no external writes. */
  onExpired(sessionId: string, isCurrent: boolean): void;
  /** A session's history should be reloaded from its file. */
  onHistoryReload(sessionId: string, entries: any[]): void;
}

const EXPIRY_MS = 60_000;
const MAX_TRACKED_FILES = 100;

export class ExternalActivityWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKnownFileSizes: Map<string, number> = new Map(); // sessionFile -> size
  private activitySessions: Map<string, number> = new Map(); // sessionId -> last external activity ts

  constructor(private readonly deps: WatcherDeps) {}

  start(intervalMs = 3000): void {
    this.stop();
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Record external activity on a session (resets its 60s expiry timer). */
  flagActivity(sessionId: string): void {
    this.activitySessions.set(sessionId, Date.now());
  }

  /** Forget tracked state for a session (e.g. pi switched to it). */
  clear(sessionId: string): void {
    this.activitySessions.delete(sessionId);
  }

  private check(): void {
    try {
      const viewed = this.deps.getViewedSessions();
      const now = Date.now();

      // Clear external flags after 60s of no external writes
      for (const [sessionId, ts] of this.activitySessions) {
        if (now - ts > EXPIRY_MS) {
          this.activitySessions.delete(sessionId);
          this.deps.onExpired(sessionId, viewed.some(v => v.sessionId === sessionId && v.isCurrent));
        }
      }

      for (const v of viewed) {
        if (!v.sessionFile || !existsSync(v.sessionFile)) continue;

        const currentSize = statSync(v.sessionFile).size;
        const lastKnown = this.lastKnownFileSizes.get(v.sessionFile);
        this.lastKnownFileSizes.set(v.sessionFile, currentSize);
        if (lastKnown === undefined || currentSize <= lastKnown) continue;

        if (v.isCurrent) {
          // File grew — did we receive events from our pi process recently?
          if (this.deps.hasRecentPiEvent()) {
            this.deps.consumePiEvent();
            continue;
          }
          // No events from pi recently — external process wrote to the file
          log.userSession.forSession(v.sessionId).info(
            `External activity detected (file grew from ${lastKnown} to ${currentSize} bytes)`);
          this.deps.onCurrentExternalActivity(v.sessionId);
        } else {
          log.userSession.forSession(v.sessionId).info(
            `External activity detected on viewed session (file grew from ${lastKnown} to ${currentSize} bytes)`);
          this.deps.onViewedExternalActivity(v.sessionId);
        }
        this.activitySessions.set(v.sessionId, now);

        // Reload the stream history for THIS session directly from its file
        // (RPC cached messages may be stale/other-session).
        const rawMessages = readMessageEntries(v.sessionFile);
        if (rawMessages.length > 0) {
          const built = buildStreamHistoryFromMessages(rawMessages);
          if (built.length > 50) built.splice(0, built.length - 50);
          this.deps.onHistoryReload(v.sessionId, built);
        }
      }

      // Drop size tracking for files we no longer care about
      if (this.lastKnownFileSizes.size > MAX_TRACKED_FILES) this.lastKnownFileSizes.clear();
    } catch (e) {
      log.userSession.error('Failure in external activity check:', e);
    }
  }
}
