/**
 * Helper to start autere backend for e2e tests.
 * Uses a random port to avoid conflicts with the default.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');

// Use a random available port
function getAvailablePort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

const TEST_PORT = getAvailablePort();

export { TEST_PORT };

let backendProcess: ChildProcess | null = null;

/**
 * Recursively collect all descendant PIDs of the given PID via the /proc/ps
 * parent-child tree. Must be called BEFORE killing the parent — once the
 * parent dies, children are reparented to PID 1 and can no longer be found
 * by ppid lookups.
 */
function collectDescendants(pid: number, acc: number[] = []): number[] {
  try {
    const pids = execSync(
      `ps -o pid= --ppid ${pid} 2>/dev/null || true`,
      { encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean).map(Number);

    for (const childPid of pids) {
      acc.push(childPid);
      collectDescendants(childPid, acc);
    }
  } catch {}
  return acc;
}

/**
 * Kill a list of PIDs with the given signal, ignoring failures (already dead).
 */
function killPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      console.log(`[e2e] Killed leftover pid ${pid} (${signal})`);
    } catch {}
  }
}

export function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (backendProcess) {
      resolve();
      return;
    }

    // Start autere backend on test port with auth disabled
    // Isolated pi envs dir: tests must not read/write real user sessions
    // (the default ~/.autere/pi-envs/admin is shared with the real
    // dashboard instance for the admin user).
    const testEnvsDir = mkdtempSync(join(tmpdir(), 'autere-e2e-envs-'));
    const args = [
      'src/backend/index.ts',
      '--port', String(TEST_PORT),
      '--monitor-auth', 'false',
      // Always start a fresh pi session — resuming the last session would
      // attach to whatever state a previous run left behind.
      '--new-session',
    ];

    console.log(`[e2e] Starting autere backend on port ${TEST_PORT}...`);

    // Spawn detached so we get a process group we can safely kill later
    backendProcess = spawn('npx', ['tsx', ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PI_MONITOR_AUTH: 'false',
        AUTERE_PI_ENVS_DIR: testEnvsDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        reject(new Error('Backend startup timeout'));
      }
    }, 30000);

    backendProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      console.log('[e2e stdout]', output.trim());
      
      if (output.includes('Dashboard running at') && !started) {
        started = true;
        clearTimeout(timeout);
        console.log('[e2e] Backend started successfully');
        resolve();
      }
    });

    backendProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      console.log('[e2e stderr]', output.trim());
    });

    backendProcess.on('error', (error) => {
      if (!started) {
        clearTimeout(timeout);
        reject(error);
      }
    });

    backendProcess.on('exit', (code) => {
      console.log(`[e2e] Backend exited with code ${code}`);
      backendProcess = null;
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Backend exited with code ${code}`));
      }
    });
  });
}

export function stopBackend(): Promise<void> {
  return new Promise((resolve) => {
    if (!backendProcess) {
      console.log('[e2e] No backend process to stop');
      resolve();
      return;
    }

    const pid = backendProcess.pid;
    console.log(`[e2e] Stopping autere backend (pid=${pid})...`);

    // CRITICAL: collect the full descendant tree BEFORE killing anything.
    // pi is spawned detached (own process group), so the backend's group
    // kill never reaches it; and once the backend dies, its children are
    // reparented to PID 1 and can no longer be found by ppid lookups.
    const descendants = pid ? collectDescendants(pid) : [];
    if (descendants.length > 0) {
      console.log(`[e2e] Backend descendants: ${descendants.join(', ')}`);
    }

    backendProcess.on('exit', () => {
      backendProcess = null;
      console.log('[e2e] Backend stopped');
    });

    // Kill only the process group we created (detached spawn gives us a unique pgid).
    // The backend handles SIGTERM and terminates its pi children itself.
    if (backendProcess.pid) {
      try {
        process.kill(-backendProcess.pid, 'SIGTERM');
      } catch (err) {
        console.error('[e2e] Failed to kill process group:', err);
        try { backendProcess.kill('SIGTERM'); } catch {}
      }
    } else {
      backendProcess.kill('SIGTERM');
    }

    // Force kill after 3 seconds if still alive, then clean up ALL
    // descendants (by recorded PID — valid even after reparenting).
    const forceKillTimer = setTimeout(() => {
      if (backendProcess) {
        console.log('[e2e] Force killing backend...');
        const killPid = backendProcess.pid;
        try {
          if (killPid) {
            process.kill(-killPid, 'SIGKILL');
          }
        } catch (err) {
          console.error('[e2e] Failed to force kill:', err);
        }
        backendProcess = null;
      }
      // Kill any descendants still alive — graceful shutdown may have been
      // interrupted by the force kill, leaving pi processes orphaned.
      killPids(descendants, 'SIGKILL');
      // Last-resort sweep scoped to this test run's port argument, in case
      // anything escaped both the group kill and the descendant tree.
      if (pid) {
        try {
          execSync(`pkill -KILL -f "index.ts --port ${TEST_PORT} " 2>/dev/null || true`);
        } catch {}
      }
      resolve();
    }, 3000);

    // Also resolve if the process exits normally before the force-kill timer
    backendProcess.on('exit', () => {
      clearTimeout(forceKillTimer);
      // Kill any descendants that outlived the backend
      killPids(descendants, 'SIGTERM');
      setTimeout(() => {
        killPids(descendants, 'SIGKILL');
        resolve();
      }, 500);
    });
  });
}
