/**
 * autere backend — standalone Node.js server.
 *
 * Manages per-user pi processes and provides a web dashboard for
 * monitoring and interacting with the agents.
 */

import { ProcessManager } from './process-manager.js';
import { resolveAuth } from './auth.js';
import { createMonitorServer } from './routes.js';

// ── CLI argument parsing ──

function parseArgs(): {
  port: number;
  monitorAuth: boolean;
  monitorPassword: string;
  piProvider?: string;
  piModel?: string;
  piArgs: string[];
  idleTimeoutMinutes: number;
} {
  const args = process.argv.slice(2);
  let port = 3456;
  let monitorAuth = true;
  let monitorPassword = process.env.PI_MONITOR_PASSWORD || '';
  let piProvider: string | undefined;
  let piModel: string | undefined;
  let idleTimeoutMinutes = 30;
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
    } else {
      piArgs.push(arg);
    }
  }

  return { port, monitorAuth, monitorPassword, piProvider, piModel, piArgs, idleTimeoutMinutes };
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
    console.error(err.message);
    process.exit(1);
  }

  // Create the process manager
  const pm = new ProcessManager({
    provider: config.piProvider,
    model: config.piModel,
    args: config.piArgs,
    idleTimeoutMs: config.idleTimeoutMinutes * 60 * 1000,
  });

  // Start the HTTP server
  createMonitorServer(config.port, pm);

  console.log(`[autere] Dashboard running at http://localhost:${config.port}`);
  console.log(`[autere] Pi processes will be spawned on user login (idle timeout: ${config.idleTimeoutMinutes}min)`);
}

main().catch((err) => {
  console.error('[autere] Fatal error:', err);
  process.exit(1);
});
