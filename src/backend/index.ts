/**
 * autere backend — standalone Node.js server.
 *
 * Spawns pi in RPC mode and provides a web dashboard for monitoring
 * and interacting with the agent. Communicates with pi via JSON lines
 * on stdin/stdout (RPC protocol).
 */

import { MonitorRpcClient } from './rpc-client.js';
import { sessionState, sessionStats, setAvailableModels } from './state.js';
import { resolveAuth } from './auth.js';
import { createMonitorServer } from './routes.js';
import { registerRpcEventHandlers, disconnectAllClients } from './event-handlers.js';
import { filterScopedModels } from './utils.js';

// ── CLI argument parsing ──

function parseArgs(): {
  port: number;
  monitorAuth: boolean;
  monitorPassword: string;
  piProvider?: string;
  piModel?: string;
  piArgs: string[];
} {
  const args = process.argv.slice(2);
  let port = 3456;
  let monitorAuth = true;
  let monitorPassword = process.env.PI_MONITOR_PASSWORD || '';
  let piProvider: string | undefined;
  let piModel: string | undefined;
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
    } else {
      // Pass remaining args to pi
      piArgs.push(arg);
    }
  }

  return { port, monitorAuth, monitorPassword, piProvider, piModel, piArgs };
}

// ── Main ──

async function main() {
  const config = parseArgs();

  // Override auth config via environment / flags
  process.env.PI_MONITOR_AUTH = String(config.monitorAuth);
  if (config.monitorPassword) {
    process.env.PI_MONITOR_PASSWORD = config.monitorPassword;
  }

  // Create a mock pi object for resolveAuth (it just needs getFlag)
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

  // Create the RPC client
  const rpc = new MonitorRpcClient({
    provider: config.piProvider,
    model: config.piModel,
    args: config.piArgs,
  });

  // Register RPC event handlers
  registerRpcEventHandlers(rpc);

  // Start the RPC process
  try {
    await rpc.start();
  } catch (err: any) {
    console.error('[autere] Failed to start pi RPC process:', err.message);
    process.exit(1);
  }

  // Mark as connected
  sessionState.connected = true;
  sessionState.startTime = Date.now();

  // Fetch initial state proactively — RPC mode may not emit session_start until first prompt
  try {
    console.log('[autere] Fetching initial state from RPC...');
    const state = await rpc.getState();
    console.log(`[autere] Initial state: sessionId=${state.sessionId}, model=${state.model?.provider}/${state.model?.id}`);

    if (state.sessionId) sessionState.sessionId = state.sessionId;
    if (state.sessionFile) sessionState.sessionFile = state.sessionFile;
    sessionState.sessionName = state.sessionName || null;
    sessionState.isStreaming = state.isStreaming;
    sessionState.compacting = state.isCompacting;
    if (state.model) {
      sessionState.model = {
        provider: state.model.provider,
        id: state.model.id,
        name: state.model.name || state.model.id
      };
    }

    // Fetch stats
    try {
      const stats = await rpc.getSessionStats();
      sessionState.messageCount = stats.userMessages || 0;
      sessionState.requestCount = stats.userMessages || 0;
      sessionStats.tokens = stats.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      sessionStats.cost = stats.cost || 0;
      if (stats.contextUsage) sessionStats.contextUsage = stats.contextUsage;
    } catch (err) {
      console.error('[autere] Failed to get initial session stats:', err);
    }

    // Fetch models — filter to scoped models only
    try {
      const models = await rpc.getAvailableModels();
      const scoped = filterScopedModels(models);
      console.log(`[autere] Got ${models.length} total models, ${scoped.length} scoped:`, scoped.map((m: any) => `${m.provider}/${m.id}`).join(', '));
      setAvailableModels(scoped.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        thinkingLevel: undefined
      })));
    } catch (err) {
      console.error('[autere] Failed to get available models:', err);
    }
  } catch (err) {
    console.error('[autere] Failed to fetch initial state:', err);
  }

  // Start the HTTP server
  createMonitorServer(config.port, rpc);

  // Handle process exit — clean up RPC process
  const cleanup = async () => {
    disconnectAllClients();
    try {
      await rpc.stop();
    } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // If RPC process exits unexpectedly, restart or exit
  const checkInterval = setInterval(() => {
    if (!rpc.isRunning) {
      console.error('[autere] RPC process exited unexpectedly');
      clearInterval(checkInterval);
      cleanup();
    }
  }, 5000);

  console.log(`[autere] Pi RPC client connected. Dashboard at http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error('[autere] Fatal error:', err);
  process.exit(1);
});
