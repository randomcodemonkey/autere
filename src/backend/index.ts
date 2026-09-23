/**
 * autere backend — standalone Node.js server.
 *
 * Manages per-user pi processes and provides a web dashboard for
 * monitoring and interacting with the agents.
 */

import { ProcessManager } from './process-manager.js';
import { resolveAuth } from './auth.js';
import { createMonitorServer } from './routes.js';
import { Scheduler } from './scheduler.js';
import { log } from './logger.js';

// ── CLI argument parsing ──

function parseArgs(): {
  port: number;
  monitorAuth: boolean;
  monitorPassword: string;
  piProvider?: string;
  piModel?: string;
  piArgs: string[];
  idleTimeoutMinutes: number;
  newSession: boolean;
} {
  const args = process.argv.slice(2);
  let port = 3456;
  let monitorAuth = true;
  let monitorPassword = process.env.PI_MONITOR_PASSWORD || '';
  let piProvider: string | undefined;
  let piModel: string | undefined;
  let idleTimeoutMinutes = 30;
  let newSession = false;
  const piArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      port = parseInt(args[++i]) || 3456;
    } else if (arg === '--monitor-auth' && args[i + 1]) {
      monitorAuth = args[++i] !== 'false';
    } else if (arg === '--monitor-password' && args[i + 1]) {
      monitorPassword = args[++i];
    } else if (arg === '--provider' && args[i + 1]) {
      piProvider = args[++i];
    } else if (arg === '--model' && args[i + 1]) {
      piModel = args[++i];
    } else if (arg === '--idle-timeout' && args[i + 1]) {
      idleTimeoutMinutes = parseInt(args[++i]) || 30;
    } else if (arg === '--new-session') {
      // Always start pi with a brand-new session — never resume the last
      // active session. Used by e2e tests so they never attach to (and
      // broadcast into) a session that real users may also be viewing.
      newSession = true;
    } else {
      piArgs.push(arg);
    }
  }

  return { port, monitorAuth, monitorPassword, piProvider, piModel, piArgs, idleTimeoutMinutes, newSession };
}

// ── Main ──

async function main() {
  const config = parseArgs();

  // Override auth config via environment / flags
  process.env.PI_MONITOR_AUTH = String(config.monitorAuth);
  if (config.monitorPassword) {
    process.env.PI_MONITOR_PASSWORD = config.monitorPassword;
  }

  // Create a mock pi object for resolveAuth
  const mockPi = {
    getFlag: (name: string) => {
      if (name === 'monitor-auth') return config.monitorAuth;
      if (name === 'monitor-password') return config.monitorPassword;
      return null;
    }
  };

  try {
    resolveAuth(mockPi as any);
  } catch (err: any) {
    log.server.error(err.message);
    process.exit(1);
  }

  const pm = new ProcessManager({
    provider: config.piProvider,
    model: config.piModel,
    args: config.piArgs,
    idleTimeoutMs: config.idleTimeoutMinutes * 60 * 1000,
    resumeLastSession: !config.newSession,
  });

  // Start the scheduler — spawns dedicated pi processes per scheduled run
  const scheduler = new Scheduler({
    provider: config.piProvider,
    model: config.piModel,
    args: config.piArgs,
  });
  scheduler.start();

  // Start the HTTP server
  createMonitorServer(config.port, pm, scheduler, config.piProvider);

  // A stray rejection in an async handler must never take the server down
  process.on('unhandledRejection', (reason) => {
    log.server.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  });

  log.server.info(`Dashboard running at http://localhost:${config.port}`);
  log.server.info(`pi processes will be spawned on user login (idle timeout: ${config.idleTimeoutMinutes}min)`);

  // TEMP DEBUG: event-loop lag monitor — stalls starve SSE heartbeats and
  // make the frontend flip to 'disconnected'.
  setInterval(() => {
    const start = Date.now();
    setImmediate(() => {
      const lag = Date.now() - start;
      if (lag > 800) log.server.warn(`EVENT LOOP LAG: ${lag}ms`);
    });
  }, 1000);
}

main().catch((err) => {
  log.server.error('Fatal error:', err);
  process.exit(1);
});
