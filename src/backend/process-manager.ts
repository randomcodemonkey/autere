/**
 * Process manager — manages per-token pi process instances.
 *
 * Each auth token gets its own pi process, so multiple browser tabs
 * for the same user operate independently.
 */

import { UserSession } from './user-session.js';
import { log } from './logger.js';

export interface ProcessManagerOptions {
  provider?: string;
  model?: string;
  args?: string[];
  idleTimeoutMs?: number;
  /** Resume the token's last session on pi startup (default true) */
  resumeLastSession?: boolean;
    /** Exclude legacy global sessions from listing (isolation mode) */
  isolatedSessions?: boolean;
}

export class ProcessManager {
  private sessions = new Map<string, UserSession>();
  private options: ProcessManagerOptions;
  private defaultIdleTimeoutMs: number;

  constructor(options: ProcessManagerOptions = {}) {
    this.options = options;
    this.defaultIdleTimeoutMs = options.idleTimeoutMs || 30 * 60 * 1000; // 30 min default
  }

  /** Get or create a session for a token */
  async getOrCreate(token: string, user: string): Promise<UserSession> {
    let session = this.sessions.get(token);
    if (session && session.isRunning) {
      session.touch();
      return session;
    }

    // Stop old session if it exists but isn't running
    if (session) {
      this.sessions.delete(token);
    }

    // Create new session
    session = new UserSession(token, user, {
      provider: this.options.provider,
      model: this.options.model,
      args: this.options.args,
      resumeLastSession: this.options.resumeLastSession,
      isolatedSessions: this.options.isolatedSessions,
    }, this.defaultIdleTimeoutMs, user);

    session.onIdle(() => {
      log.processMgr.info(`Terminating idle session for token "${token.slice(0, 8)}…"`);
      this.terminate(token);
    });

    this.sessions.set(token, session);

    try {
      await session.start();
    } catch (err) {
      log.processMgr.error(`Failed to start pi process for token "${token.slice(0, 8)}…":`, err);
      this.sessions.delete(token);
      throw err;
    }

    return session;
  }

  /** Get an existing session for a token (returns undefined if not found) */
  get(token: string): UserSession | undefined {
    return this.sessions.get(token);
  }

  /** Terminate a token's session */
  async terminate(token: string): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) return;
    this.sessions.delete(token);
    await session.stop();
  }

  /** Terminate all sessions */
  async terminateAll(): Promise<void> {
    const tokens = [...this.sessions.keys()];
    for (const token of tokens) {
      await this.terminate(token);
    }
  }

  /** List active tokens */
  activeTokens(): string[] {
    return [...this.sessions.keys()];
  }
}
