/**
 * Minimal structured logger for the autere backend.
 *
 * Log line format (single line, greppable):
 *   2026-09-01T12:34:56.789Z INFO  [scope] [session=01a0…] message
 *
 * - `scope` identifies the emitting module (e.g. rpc, user-session, http).
 * - `sessionId` is included whenever it is known, always in the same place.
 * - Level is controlled by AUTERE_LOG_LEVEL (error|warn|info|debug), defaults
 *   to debug (all logs) for now. Less verbose levels are filtered out cheaply
 *   before any string formatting happens.
 */

type Level = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel(): Level {
  const raw = (process.env.AUTERE_LOG_LEVEL || 'debug').toLowerCase();
  return (['error', 'warn', 'info', 'debug'] as Level[]).includes(raw as Level)
    ? (raw as Level)
    : 'debug';
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class Logger {
  constructor(private readonly scope: string, private readonly sessionId?: string) {}

  /**
   * Create a logger bound to a specific session id — every line from it
   * carries the same `[session=…]` field in the same position.
   */
  forSession(sessionId: string | null | undefined): Logger {
    return new Logger(this.scope, sessionId || undefined);
  }

  private emit(level: Level, message: string, ...args: unknown[]): void {
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[currentLevel()]) return;
    const parts = [timestamp(), level.toUpperCase().padEnd(5), `[${this.scope}]`];
    if (this.sessionId) parts.push(`[session=${this.sessionId}]`);
    parts.push(message);
    // Errors are formatted compactly; other args passed through to console
    const flat = args.map(a => (a instanceof Error ? formatErr(a) : a));
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(parts.join(' '), ...flat);
  }

  error(message: string, ...args: unknown[]): void { this.emit('error', message, ...args); }
  warn(message: string, ...args: unknown[]): void { this.emit('warn', message, ...args); }
  info(message: string, ...args: unknown[]): void { this.emit('info', message, ...args); }
  debug(message: string, ...args: unknown[]): void { this.emit('debug', message, ...args); }
}

/** Module-level loggers */
export const log = {
  auth: new Logger('auth'),
  extHandlers: new Logger('ext-handlers'),
  extensions: new Logger('extensions'),
  extActivity: new Logger('ext-activity'),
  http: new Logger('http'),
  notifications: new Logger('notifications'),
  piEnv: new Logger('pi-env'),
  processMgr: new Logger('process-mgr'),
  rpc: new Logger('rpc'),
  scheduler: new Logger('scheduler'),
  sessions: new Logger('sessions'),
  settings: new Logger('settings'),
  utils: new Logger('utils'),
  server: new Logger('server'),
  userSession: new Logger('user-session'),
};

/** Helper for user-scoped messages: `userLog('alice').info('…')` */
export function userLog(user: string): Logger {
  return new Logger(`user:${user}`);
}
