/**
 * Workdirs editing (Sessions view feature):
 * 1. SessionInfo.workdirs stamped by listSessions (live rpc + spawn opts)
 * 2. ProcessManager.setWorkdirs — persists opts, respawns, inherits
 * Run: npx tsx cypress/component/support/workdirs-edit.check.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');
// Env overrides BEFORE backend imports (constants capture at module load)
process.env.AUTERE_PI_ENVS_DIR = mkdtempSync(join(tmpdir(), 'wdenvs-'));
process.env.AUTERE_USERS_FILE = join(process.env.AUTERE_PI_ENVS_DIR, 'users.json');
writeFileSync(process.env.AUTERE_USERS_FILE, JSON.stringify({
  tester: { passwordHash: 's2:aa:bb', role: 'control', allowedDirs: [] },
  admin2: { passwordHash: 's2:aa:bb', role: 'admin', allowedDirs: [{ path: process.env.HOME!, access: 'rw' }] },
}));
process.env.AUTERE_SANDBOX_IMAGE = 'off';

let pass = 0, fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'OK ' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
};

const pmMod = await import(join(REPO, 'src/backend/process-manager.ts'));
const { ProcessManager } = pmMod as any;
const pm = new ProcessManager({ idleTimeoutMs: 60_000 });

// Create a session with workdirs, then read them via the SessionInfo path
const wd = mkdtempSync(join(tmpdir(), 'wd-'));
const s1 = await pm.getOrCreate('admin2', null, { cwd: wd, workdirs: [wd] });
const file = s1.routedSessionFile();
if (!file) { console.log('FAIL no session file'); process.exit(1); }
check('workdirs on live rpc', JSON.stringify(s1.rpc.getWorkdirs()) === JSON.stringify([wd]));

const infos = pm.listSessions('admin2', new Set([file]));
const mine = infos.find((s: any) => s.sessionFile === file);
check('SessionInfo.workdirs stamped', JSON.stringify(mine?.workdirs) === JSON.stringify([wd]));

// setWorkdirs: replace with a second dir → persisted + respawn inherits
const wd2 = mkdtempSync(join(tmpdir(), 'wd2-'));
const s2 = await pm.setWorkdirs('admin2', file, [wd2, wd]);
check('setWorkdirs respawn inherits', JSON.stringify(s2.rpc.getWorkdirs()) === JSON.stringify([wd2, wd]));
const saved = JSON.parse(readFileSync(join(process.env.AUTERE_PI_ENVS_DIR!, 'admin2', 'spawn-opts.json'), 'utf-8'))[file];
check('spawn opts re-persisted', JSON.stringify(saved) === JSON.stringify({ cwd: wd2, workdirs: [wd2, wd] }));

// Empty list → clears workdirs (host session), cwd falls back to saved
const s3 = await pm.setWorkdirs('admin2', file, []);
check('empty clears workdirs', JSON.stringify(s3.rpc.getWorkdirs()) === JSON.stringify([]));

// listSessions for a NOT-running session reads spawn opts
await pm.terminate('admin2', file);
const offline = pm.listSessions('admin2', new Set([file])).find((s: any) => s.sessionFile === file);
check('offline spawn-opts fall back', offline?.workdirs === undefined || Array.isArray(offline?.workdirs));

await pm.terminate('admin2', file).catch(() => {});
rmSync(join(process.env.AUTERE_PI_ENVS_DIR!), { recursive: true, force: true });
rmSync(wd, { recursive: true, force: true });
rmSync(wd2, { recursive: true, force: true });

if (fail) { console.log(`\n${fail} failure(s)`); process.exit(1); }
console.log('\nAll workdirs-edit checks passed');
