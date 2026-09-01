/**
 * Helper to start autere backend for e2e tests.
 * Uses a random port to avoid conflicts with the default.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
 * Kill any orphaned pi RPC processes that are children of the given PID.
 * Called after stopping the backend to clean up processes that may have
 * escaped the process group kill (pi is spawned with detached: true).
 */
function killOrphanedChildren(parentPid: number): void {
  try {
    // Find all child PIDs recursively via the /proc tree or pgrep
    // Use ps to find processes whose PPID is the parent or any of its children
    const pids = execSync(
      `ps -o pid= --ppid ${parentPid} 2>/dev/null || true`,
      { encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean).map(Number);

    for (const childPid of pids) {
      // Recursively kill grandchildren too (e.g. pi spawned by the backend)
      killOrphanedChildren(childPid);
      try {
        process.kill(childPid, 'SIGTERM');
        console.log(`[e2e] Killed orphaned child pid ${childPid}`);
      } catch {}
    }
  } catch {}
}

export function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (backendProcess) {
      resolve();
      return;
    }

    // Start autere backend on test port with auth disabled
    const args = [
      'src/backend/index.ts',
      '--port', String(TEST_PORT),
      '--monitor-auth', 'false',
      // Always start a fresh pi session — the shared ~/.pi environment means
      // resuming the last session would attach to a session real users may
      // also be viewing, leaking test messages into their chat.
      '--new-session',
    ];

    console.log(`[e2e] Starting autere backend on port ${TEST_PORT}...`);

    // Spawn detached so we get a process group we can safely kill later
    backendProcess = spawn('npx', ['tsx', ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PI_MONITOR_AUTH: 'false',
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

    backendProcess.on('exit', () => {
      backendProcess = null;
      console.log('[e2e] Backend stopped');
    });

    // Kill only the process group we created (detached spawn gives us a unique pgid)
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

    // Force kill after 3 seconds if still alive, then clean up orphans
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

        // Clean up any orphaned child processes (pi RPC etc.)
        if (killPid) {
          killOrphanedChildren(killPid);
        }
      }
      resolve();
    }, 3000);

    // Also resolve if the process exits normally before the force-kill timer
    backendProcess.on('exit', () => {
      clearTimeout(forceKillTimer);
      // Clean up orphans even on normal exit
      if (pid) {
        killOrphanedChildren(pid);
      }
      resolve();
    });
  });
}
