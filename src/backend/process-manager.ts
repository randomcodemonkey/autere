/**
 * Process manager — manages per-user pi process instances.
 *
 * Spawns a pi process when a user logs in, terminates idle ones.
 */

import { UserSession } from './user-session.js';

export interface ProcessManagerOptions {
  provider?: string;
  model?: string;
  args?: string[];
  idleTimeoutMs?: number;
}

export class ProcessManager {
  private sessions = new Map<string, UserSession>();
  private options: ProcessManagerOptions;
  private defaultIdleTimeoutMs: number;

  constructor(options: ProcessManagerOptions = {}) {
    this.options = options;
    this.defaultIdleTimeoutMs = options.idleTimeoutMs || 30 * 60 * 1000; // 30 min default
  }

  /** Get or create a session for a user */
  async getOrCreate(user: string): Promise<UserSession> {
    let session = this.sessions.get(user);
    if (session && session.isRunning) {
      session.touch();
      return session;
    }

    // Stop old session if it exists but isn't running
    if (session) {
      this.sessions.delete(user);
    }

    // Create new session
    session = new UserSession(user, {
      provider: this.options.provider,
      model: this.options.model,
      args: this.options.args,
    }, this.defaultIdleTimeoutMs);

    session.onIdle(() => {
      console.log(`[autere] Terminating idle session for user "${user}"`);
      this.terminate(user);
    });

    this.sessions.set(user, session);

    try {
      await session.start();
    } catch (err) {
      console.error(`[autere] Failed to start pi process for user "${user}":`, err);
      this.sessions.delete(user);
      throw err;
    }

    return session;
  }

  /** Get an existing session for a user (returns null if not found) */
  get(user: string): UserSession | undefined {
    return this.sessions.get(user);
  }

  /** Terminate a user's session */
  async terminate(user: string): Promise<void> {
    const session = this.sessions.get(user);
    if (!session) return;
    this.sessions.delete(user);
    await session.stop();
  }

  /** Terminate all sessions */
  async terminateAll(): Promise<void> {
    const users = [...this.sessions.keys()];
    for (const user of users) {
      await this.terminate(user);
    }
  }

  /** List active users */
  activeUsers(): string[] {
    return [...this.sessions.keys()];
  }
}
