/**
 * Helper to start autere backend for e2e tests.
 * Uses a random port to avoid conflicts with the default.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { startMockRouter } from './mock-router';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');

let testEnvsDir: string | null = null;

/** Remove the isolated per-run env dir. Runs create sessions there; they
 *  must not leak into /tmp (or anywhere else) after the run. */
function cleanupEnvsDir(): void {
  if (process.env.AUTERE_KEEP_ENVS) { console.log(`[e2e] AUTERE_KEEP_ENVS set — envs kept at ${testEnvsDir}`); return; }
  if (!testEnvsDir) return;
  try {
    rmSync(testEnvsDir, { recursive: true, force: true });
    console.log(`[e2e] Removed test env dir ${testEnvsDir}`);
  } catch (err) {
    console.log(`[e2e] Failed to remove test env dir: ${err}`);
  }
}

// Use a random available port
function getAvailablePort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

const TEST_PORT = getAvailablePort();

export { TEST_PORT };

let backendProcess: ChildProcess | null = null;
let testModels: string[] = [];
/** Mock router (CI/none-live path) — stopped with the backend. */
let mockRouterStop: (() => Promise<void>) | null = null;

/** Working model list probed before spawn (may be empty if no 9router). */
export function getTestModels(): string[] { return testModels; }

/** Probe the router (live or mock) for models that can actually serve
 *  completions. E2e envs have no user model settings, so pi would otherwise
 *  fall back to its builtin default (provider openai), which unroutable
 *  without creds — every model-turn test would fail. Returns up to 2
 *  working model ids (two so the model-selection spec has something to
 *  switch to). SYNC probe — the async completion check is unnecessary:
 *  both paths already resolve model availability from /v1/models, and a
 *  failed turn probe would make the whole suite skip model tests anyway. */


/** Probe the router for model ids → AUTERE_TEST_MODELS (pi env settings).
 *  Live routers: only ids that answer a tiny completion count as working
 *  (first two) — advertised ≠ routable. The mock is always routable. */
async function probeTestModels(base: string, verifyCompletion: boolean): Promise<string[]> {
  // Live routers 401 completions without a key — same resolution priority as
  // pi-9router-ext (env key, then $HOME/.pi/agent/9router-config.json).
  let apiKey = process.env.NINE_ROUTER_API_KEY || '';
  if (!apiKey) {
    try {
      apiKey = (JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', '9router-config.json'), 'utf-8')) as { apiKey?: string }).apiKey || '';
    } catch {}
  }
  const auth: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { console.log(`[e2e] probe: models endpoint HTTP ${res.status}`); return []; }
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id);
    let working = ids;
    if (verifyCompletion) {
      working = [];
      for (const id of ids) {
        try {
          const r = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
            signal: AbortSignal.timeout(15000),
          });
          if (r.ok) working.push(id);
        } catch {}
        if (working.length >= 2) break;
      }
    }
    const out = (verifyCompletion ? working : ids).slice(0, 2);
    console.log(`[e2e] probe models: ${out.join(',')} (candidates: ${ids.length})`);
    return out;
  } catch (err: any) {
    console.log(`[e2e] probe failed: ${err?.message || err}`);
    return [];
  }
}

/** Pre-seed pi-9router-ext's discovery cache so the 9router provider
 *  registers instantly and deterministically from the mock (no live
 *  router, no models.dev dependency at registration time). Cache
 *  identity: baseUrl must equal NINE_ROUTER_BASE_URL; apiKeyHash must
 *  equal sha256(NINE_ROUTER_API_KEY) — a fixed dummy key set below so
 *  the dev box's $HOME config (real router key) can't make the cache
 *  mismatch and force a live discovery (which aborts on models.dev). */
const MOCK_ROUTER_API_KEY = '9router-no-api-key'; // hash: sha256:282d99...47c
const MOCK_ROUTER_MODELS: { id: string; [k: string]: unknown }[] = [
  {
    id: 'mock-chat', object: 'model', owned_by: 'mock',
    capabilities: { vision: false, pdf: false, audioInput: false, videoInput: false, imageOutput: false, audioOutput: false, search: false, tools: true, reasoning: false, thinkingFormat: 'openai', thinkingCanDisable: true, thinkingRange: null },
    context_length: 128000, max_completion_tokens: 8192,
  },
  {
    id: 'mock-chat-mini', object: 'model', owned_by: 'mock',
    capabilities: { vision: false, pdf: false, audioInput: false, videoInput: false, imageOutput: false, audioOutput: false, search: false, tools: true, reasoning: false, thinkingFormat: 'openai', thinkingCanDisable: true, thinkingRange: null },
    context_length: 128000, max_completion_tokens: 4096,
  },
];

function seedRouterConfig(routerUrl: string): void {
  try {
    const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pi');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, '9router-discovery-cache.json'), JSON.stringify({
      baseUrl: routerUrl,
      apiKeyHash: 'sha256:282d99225081e9e01dac21235a3836d28a1567c0f66f3ed2f076bbdfd043c47c',
      ts: Date.now(),
      models: MOCK_ROUTER_MODELS,
      webRoutes: [],
    }), { mode: 0o600 });
  } catch (err) {
    console.log(`[e2e] seeding pi-9router-ext discovery cache failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Record of the previous test run's backend group. If a runner is SIGKILLed
// (no cleanup handlers run), its detached backend lives on — the next run
// reaps it from here.
const RUN_RECORD = join(tmpdir(), 'autere-e2e-last-run.json');

function reapPreviousRun(): void {
  try {
    // pids may carry positive pids (detached pi processes, recorded at
    // spawn time) and negative pgids (the backend's process group).
    // Repo-scoped sweep too: hard-killed runs from before the run record
    // existed (or cleared tmp) still leave pi/cmdline orphans matching
    // the test backend's unique cmdline marker.
    const { pids } = JSON.parse(readFileSync(RUN_RECORD, 'utf-8')) as { pids: number[] };
    killPids(pids, 'SIGKILL');
  } catch {}
  // Cmdline-marker sweep, scoped to THIS test's unique flags (isolated
  // env dir path baked into the cmdline via AUTERE_PI_ENVS_DIR? No — env
  // vars aren't in /proc cmdline; the test PORT arg is though; a random
  // 30000-50000 port is unlikely to collide with a live backend).
  try {
    execSync(
      `pkill -KILL -f "tsx src/backend/index.ts --port 3" 2>/dev/null; pkill -KILL -f "tsx ../src/backend/index.ts --port 3" 2>/dev/null`,
      { stdio: 'ignore' }
    );
  } catch {}
  try { rmSync(RUN_RECORD, { force: true }); } catch {}
}

/** Isolated env dir for this run — exposed so run-e2e can pass it to the
 *  cypress process (tests use it to locate/seed per-env data). */
export function getTestEnvsDir(): string {
  if (!testEnvsDir) throw new Error('test envs dir not initialized — call startBackend first');
  return testEnvsDir;
}

/**
 * Recursively collect all descendant PIDs of the given PID via the /proc/ps
 * parent-child tree. Must be called BEFORE killing the parent — once the
 * parent dies, children are reparented to PID 1 and can no longer be found
 * by ppid lookups.
 */
/** Append pids to the run record so the next run reaps them if this one
 *  dies before cleanup (merge, dedupe). */
function reapRecord(pids: number[]): void {
  try {
    let cur: number[] = [];
    try { cur = (JSON.parse(readFileSync(RUN_RECORD, 'utf-8')) as { pids: number[] }).pids; } catch {}
    writeFileSync(RUN_RECORD, JSON.stringify({ pids: [...new Set([...cur, ...pids])] }));
  } catch {}
}

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

export async function startBackend(): Promise<void> {
  // Kill anything a hard-killed previous run left behind
  reapPreviousRun();

  // Router selection: a live 9router (dev machine) when reachable, else an
  // in-process mock (OpenAI-compatible) — real agent turns work in CI
  // without any network dependency. The backend's own preflight targets
  // AUTERE_NINE_ROUTER_URL, so the mock must be reachable before that URL
  // is handed to the backend (it would otherwise spawn+kill a real
  // 9router on the runner).
  let routerPort: number | null = null;
  const liveRouter = process.env.AUTERE_NINE_ROUTER_URL;
  try {
    if (liveRouter) {
      const res = await fetch(`${liveRouter.replace(/\/+$/, '')}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(String(res.status));
      routerPort = new URL(liveRouter).port ? Number(new URL(liveRouter).port) : 20128;
      console.log(`[e2e] Using live 9router at ${liveRouter}`);
    }
  } catch {
    // not reachable / not set — fall through to the mock
  }
  let stopMock: (() => Promise<void>) | null = null;
  if (routerPort === null) {
    const mock = await startMockRouter(0);
    if (!mock) throw new Error('[e2e] mock router failed to start');
    routerPort = mock.port;
    stopMock = mock.stop;
    console.log(`[e2e] Using mock router on port ${mock.port}`);
  }
  const routerUrl = `http://127.0.0.1:${routerPort}`;
  mockRouterStop = stopMock;

  const probed = await probeTestModels(routerUrl, !stopMock);
  testModels = probed;
  // Seed the discovery cache only for the mock (live routers own their
  // own config+key in $HOME — the ext discovers them itself).
  if (stopMock) seedRouterConfig(routerUrl);

  if (backendProcess) return;

  // Start autere backend on test port with auth disabled
  // Isolated pi envs dir: tests must not read/write real user sessions
  // (the default ~/.autere/pi-envs/admin is shared with the real
  // dashboard instance for the admin user).
  testEnvsDir = mkdtempSync(join(tmpdir(), 'autere-e2e-envs-'));

  const args = [
    'src/backend/index.ts',
    '--port', String(TEST_PORT),
    '--autere-auth', 'false',
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
    // Users registry must not seed the real ~/.autere/autere-users.json
    AUTERE_USERS_FILE: join(testEnvsDir, 'autere-users.json'),
    // AUTERE_DIR covers per-user settings (gitRepositories etc.) —
    // without it e2e writes into the REAL ~/.autere/users/<user>!
    // 9router: piggyback on the live one (dev env) or the in-process mock
    // (CI / no live router). The backend preflight fetches this URL and —
    // when unreachable — spawns a real 9router binary, so the mock is
    // started BEFORE the backend when live-router probing failed.
    AUTERE_NINE_ROUTER_URL: routerUrl,
    // pi-9router-ext reads NINE_ROUTER_BASE_URL (its config-file fallback
    // would point pi at the default/dev router) — pointed at the same URL
    // so the backend never spawns a real 9router and pi talks to the mock.
    NINE_ROUTER_BASE_URL: routerUrl,
    ...(stopMock ? { NINE_ROUTER_API_KEY: MOCK_ROUTER_API_KEY } : {}),
    AUTERE_DIR: join(testEnvsDir, 'autere-state'),
    // sandbox points at docker + the real home volume — off for tests
    AUTERE_SANDBOX_IMAGE: 'off',
    // Orphan record sharing: pi processes spawned by this backend
    // append their pids to the run record (rpc-client reads it), so a
    // SIGKILLed runner's detached pi is reaped by the next run.
    AUTERE_RUN_RECORD_FILE: RUN_RECORD,
    // Harness-provisioned model list (see probeTestModels) — applied to
    // the test env's pi settings by the backend (pi-env.ts).
    ...(testModels.length > 0 ? { AUTERE_TEST_MODELS: testModels.join(',') } : {}),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
  });

  // Persist the group AND enable orphan recording so the next run can
  // reap it if this one is SIGKILLed. Positive pids are added by the
  // backend itself (rpc-client) as pi processes appear — they live in
  // their OWN detached groups, so a group kill of the backend never
  // reaches them.
  if (backendProcess.pid) {
  try {
    writeFileSync(RUN_RECORD, JSON.stringify({ pids: [-backendProcess.pid] }));
  } catch {}
  }

  const proc = backendProcess;

  return new Promise((resolve, reject) => {
    let started = false;
    const timeout = setTimeout(() => {
    if (!started) {
      reject(new Error('Backend startup timeout'));
    }
  }, 30000);

    proc.stdout?.on('data', (data) => {
    const output = data.toString();
    console.log('[e2e stdout]', output.trim());
    
    if (output.includes('Dashboard running at') && !started) {
      started = true;
      clearTimeout(timeout);
      console.log('[e2e] Backend started successfully');
      resolve();
    }
  });

    proc.stderr?.on('data', (data) => {
    const output = data.toString();
    console.log('[e2e stderr]', output.trim());
  });

    proc.on('error', (error) => {
    if (!started) {
      clearTimeout(timeout);
      reject(error);
    }
  });

    proc.on('exit', (code) => {
    console.log(`[e2e] Backend exited with code ${code}`);
    backendProcess = null;
    if (!started) {
      clearTimeout(timeout);
      reject(new Error(`Backend exited with code ${code}`));
    }
  });
  });
}

export async function stopBackend(): Promise<void> {
  const stop = async (resolve: () => void) => {
    const stopMock = async () => {
      if (mockRouterStop) {
        const s = mockRouterStop;
        mockRouterStop = null;
        await s();
        console.log('[e2e] Mock router stopped');
      }
    };
    if (!backendProcess) {
      console.log('[e2e] No backend process to stop');
      await stopMock();
      cleanupEnvsDir();
      resolve();
      return;
    }

    const pid = backendProcess.pid;
    console.log(`[e2e] Stopping autere backend (pid=${pid})...`);

    // Also record the full descendant tree BEFORE any killing — SIGKILLed
    // later runs have no cleanup path, so this list is what the next run
    // reaps (negative = group, positive = detached pi already recorded
    // by the backend via AUTERE_RUN_RECORD_FILE).
    const descendants = pid ? collectDescendants(pid) : [];
    if (descendants.length > 0) {
      console.log(`[e2e] Backend descendants: ${descendants.join(', ')}`);
      reapRecord(descendants);
    }

    backendProcess.on('exit', () => {
      backendProcess = null;
      cleanupEnvsDir();
      console.log('[e2e] Backend stopped');
    });
    void stopMock();

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
  };
  await new Promise<void>((resolve) => stop(resolve));
}
