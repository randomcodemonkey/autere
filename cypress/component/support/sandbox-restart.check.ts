/**
 * Focused tests for the sandbox-restart fixes (real implementations):
 * 1. sandboxWorkPathToHost — docker work path → host dir mapping
 * 2. process-manager persist/inherit of per-session spawn opts (cwd/workdirs)
 *
 * Run: npx tsx cypress/component/support/sandbox-restart.check.ts
 * (assert-based self-check — no cypress/canvas needed)
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), `sandbox-restart-test-${Date.now()}`);

// ── Isolate the user's pi env dir + allowedDirs registry ──
const envsDir = join(testDir, 'pi-envs');
mkdirSync(envsDir, { recursive: true });
process.env.AUTERE_PI_ENVS_DIR = envsDir;

const usersFile = join(testDir, 'users.json');
writeFileSync(usersFile, JSON.stringify({
  tester: { passwordHash: 's2:aa:bb', role: 'control', allowedDirs: [{ path: '/host/workdir-a', access: 'rw' }] },
  admin2: { passwordHash: 's2:aa:bb', role: 'admin', allowedDirs: [{ path: '/host/other', access: 'rw' }] },
  'plain-admin': { passwordHash: 's2:aa:bb', role: 'admin', allowedDirs: [] },
}));
process.env.AUTERE_USERS_FILE = usersFile;
process.env.AUTERE_SANDBOX_IMAGE = 'off';
process.env.HOME = '/home/autere';

let failures = 0;
function assert(label: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

try {
  // ── 1. sandboxWorkPathToHost ──
  const { sandboxWorkPathToHost } = await import('../../../src/backend/pi-env.js');
  const { initUserRegistry } = await import('../../../src/backend/users.js');
  initUserRegistry({ adminPassword: 'x' });

  assert('maps a named workdir back to the host dir',
    sandboxWorkPathToHost('tester', '/home/autere/work/workdir-a') === '/host/workdir-a');
  assert('whole-home fallback for an admin without allowedDirs',
    sandboxWorkPathToHost('plain-admin', '/home/autere/work/autere') === '/home/autere');
  assert('admin with allowedDirs does NOT get the whole-home fallback',
    sandboxWorkPathToHost('admin2', '/home/autere/work/autere') === null);
  assert('rejects paths outside the work base',
    sandboxWorkPathToHost('tester', '/other/place') === null);
  assert('rejects deeper nesting (not a per-session root)',
    sandboxWorkPathToHost('tester', '/home/autere/work/workdir-a/sub') === null);
  assert('unknown root name → null',
    sandboxWorkPathToHost('tester', '/home/autere/work/nope') === null);
  assert('the work base itself → null',
    sandboxWorkPathToHost('tester', '/home/autere/work') === null);

  // ── 2. ProcessManager spawn-opts persistence (cwd/workdirs inherit) ──
  // (Sandbox image off: this check exercises the cwd/workdirs inheritance
  // plumbing (spawn-opts persistence + resume), not docker planning — the
  // sandbox mount planning itself is exercised in e2e with a live docker.)
  const { ProcessManager } = await import('../../../src/backend/process-manager.js');
  const pm = new ProcessManager({ idleTimeoutMs: 1000 });

  // Create with cwd + workdirs → must be persisted under the resolved file.
  // cwd must EXIST (spawn() fails with ENOENT otherwise) — real temp dirs.
  const wd = join(testDir, 'workdir-a');
  mkdirSync(wd, { recursive: true });
  const s1 = await pm.getOrCreate('tester', null, { cwd: wd, workdirs: [wd] });
  const resolved = s1.routedSessionFile();
  if (!resolved) { console.log('✗ no session file resolved after create'); process.exit(1); }
  const saved = JSON.parse(readFileSync(join(envsDir, 'tester', 'spawn-opts.json'), 'utf-8'));
  assert('spawn opts persisted under the resolved session file',
    JSON.stringify(saved[resolved]) === JSON.stringify({ cwd: wd, workdirs: [wd] }));

  // Resume the same file WITHOUT opts → must inherit cwd+workdirs.
  // Assert on UserSession's rpc spawn options (what the docker wrapper gets).
  const s2 = await pm.getOrCreate('tester', resolved, {});
  const rpc = (s2 as any).rpc;
  const workdirs = (rpc?.options?.workdirs as string[] | undefined) || [];
  assert('resume without opts inherits the persisted cwd', rpc?.options?.cwd === wd);
  assert('resume without opts inherits the persisted workdirs', workdirs.length === 1 && workdirs[0] === wd);

  // Explicit opts WIN over persisted ones — on the RESPAWN path.
  // (With the process still running, getOrCreate returns the live one.)
  await pm.terminate('tester', resolved);
  const wd2 = join(testDir, 'workdir-b');
  mkdirSync(wd2, { recursive: true });
  const s3 = await pm.getOrCreate('tester', resolved, { cwd: wd2 });
  assert('explicit opts override the persisted ones', (s3 as any).rpc?.options?.cwd === wd2);

  // Overriden opts are now the persisted ones (they were saved at spawn)
  const saved3 = JSON.parse(readFileSync(join(envsDir, 'tester', 'spawn-opts.json'), 'utf-8'));
  assert('override was re-persisted', saved3[resolved].cwd === wd2);

  // terminate() must stop the process
  await pm.terminate('tester', resolved);
  assert('process stopped after terminate', !s2.isRunning);
} finally {
  rmSync(testDir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll sandbox-restart checks passed');
