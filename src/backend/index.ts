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
import { spawn, ChildProcess } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AUTERE_DIR } from './constants.js';

// ── 9router management ──

/** Spawn and keep-alive the local 9router (replaces the supervisord
 *  program). Only called when pi runs against the 9router provider. */
let routerProcess: ChildProcess | null = null;

function start9router(): void {
  const logDir = join(AUTERE_DIR, 'log');
  // AUTERE_NINE_ROUTER_URL determines both the pre-flight check target and the
  // port 9router is spawned on (from the URL). Default: localhost:20128.
  const routerUrl = new URL(process.env.AUTERE_NINE_ROUTER_URL || 'http://localhost:20128');
  const routerPort = routerUrl.port || '20128';
  const spawnRouter = () => {
    try {
      mkdirSync(logDir, { recursive: true });
      const out = openSync(join(logDir, '9router.out.log'), 'a');
      const err = openSync(join(logDir, '9router.err.log'), 'a');
      routerProcess = spawn('9router', ['-n', '-t', '-l', '--skip-update', '-p', routerPort], {
        stdio: ['ignore', out, err],
      });
      log.server.info(`9router started (pid ${routerProcess.pid})`);
      routerProcess.on('exit', (code, signal) => {
        routerProcess = null;
        if (code === 0 && signal === null) {
          // Clean exit — almost certainly the port is already taken by an
          // existing 9router instance (do not respaw-loop into a port clash).
          log.server.info('9router exited cleanly — assuming another instance owns the port, not restarting');
          return;
        }
        log.server.error(`9router exited (code ${code}, signal ${signal}) — restarting in 3s`);
        setTimeout(spawnRouter, 3000);
      });
    } catch (err) {
      log.server.error(`Failed to start 9router: ${err}`);
    }
  };
  // Port already serving? Then an external (e.g. supervisord-managed)
  // instance exists — do not spawn a second one on the same port.
  fetch(routerUrl, { signal: AbortSignal.timeout(2000) })
    .then(() => {
      log.server.info(`9router already running on :${routerPort} — skipping spawn`);
    })
    .catch(() => spawnRouter());
}

function stop9router(): void {
  if (routerProcess) {
    log.server.info('Stopping 9router');
    routerProcess.kill('SIGTERM');
  }
}

// ── CLI argument parsing ──

function parseArgs(): {
  port: number;
  autereAuth: boolean;
  auterePassword: string;
  piProvider?: string;
  piModel?: string;
  piArgs: string[];
  idleTimeoutMinutes: number;
  newSession: boolean;
} {
  const args = process.argv.slice(2);
  // Configuration is env-first (docker run -e); CLI args override for dev.
  let port = parseInt(process.env.AUTERE_PORT || '', 10) || 3456;
  let autereAuth = process.env.AUTERE_AUTH !== undefined ? process.env.AUTERE_AUTH !== 'false' : true;
  let auterePassword = process.env.INITIAL_PASSWORD || '';
  let piProvider = process.env.AUTERE_PROVIDER || undefined;
  let piModel = process.env.AUTERE_MODEL || undefined;
  let idleTimeoutMinutes = parseInt(process.env.AUTERE_IDLE_TIMEOUT || '', 10) || 30;
  let newSession = false;
  const piArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      port = parseInt(args[++i]) || 3456;
    } else if (arg === '--autere-auth' && args[i + 1]) {
      autereAuth = args[++i] !== 'false';
    } else if (arg === '--autere-password' && args[i + 1]) {
      auterePassword = args[++i];
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

  return { port, autereAuth, auterePassword, piProvider, piModel, piArgs, idleTimeoutMinutes, newSession };
}

// ── Main ──

async function main() {
  const config = parseArgs();

  // Override auth config via environment / flags
  process.env.AUTERE_AUTH = String(config.autereAuth);
  if (config.auterePassword) {
    process.env.INITIAL_PASSWORD = config.auterePassword;
  }

  // Create a mock pi object for resolveAuth
  const mockPi = {
    getFlag: (name: string) => {
      if (name === 'autere-auth') return config.autereAuth;
      if (name === 'autere-password') return config.auterePassword;
      return null;
    }
  };

  try {
    resolveAuth(mockPi as any);
  } catch (err: any) {
    log.server.error(err.message);
    process.exit(1);
  }

  // Run the local 9router alongside the backend — but only when pi is
  // configured for the 9router provider (nothing else talks to it).
  if (!config.piProvider || config.piProvider === '9router') {
    start9router();
    process.on('SIGTERM', stop9router);
    process.on('SIGINT', stop9router);
    process.on('exit', stop9router);
  }

  const pm = new ProcessManager({
    model: config.piModel,
    args: config.piArgs,
    idleTimeoutMs: config.idleTimeoutMinutes * 60 * 1000,
    resumeLastSession: !config.newSession,
  });

  // Start the scheduler — spawns dedicated pi processes per scheduled run
  const scheduler = new Scheduler({
    model: config.piModel,
    args: config.piArgs,
  });
  scheduler.start();

  // Start the HTTP server
  createMonitorServer(config.port, pm, scheduler);

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
