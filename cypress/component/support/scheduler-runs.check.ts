/**
 * Scheduler run listing reads the small summary sidecar, never the full
 * run log (which carries prompt/result/log and grows to hundreds of KB):
 * 1. listRuns prefers <runId>.summary.json and returns only summary fields
 * 2. legacy runs (full record only) still list
 * 3. hasRuns is a directory check, no parsing
 *
 * Run: npx tsx cypress/component/support/scheduler-runs.check.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');
const stateDir = mkdtempSync(join(tmpdir(), 'sched-runs-'));
process.env.AUTERE_DIR = stateDir; // constants capture this at import time
process.env.AUTERE_PI_ENVS_DIR = join(stateDir, 'pi-envs');

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

const { listRuns, hasRuns } = await import(join(REPO, 'src/backend/scheduler.ts'));

const runsDir = join(stateDir, 'users', 'tester', 'scheduled-task-logs');
const taskDir = join(runsDir, 'task-1');
mkdirSync(taskDir, { recursive: true });

const summary = (runId: string, startedAt: number, status: string) => ({
  runId, taskId: 'task-1', taskName: 't', trigger: 'manual', startedAt, status,
});
// New-format run: full log + summary sidecar
const full = {
  ...summary('run-1', 1000, 'success'),
  finishedAt: 2000,
  prompt: 'x'.repeat(50_000),
  log: Array.from({ length: 500 }, (_, i) => ({ t: i, line: `line ${i}` })),
};
writeFileSync(join(taskDir, 'run-1.json'), JSON.stringify(full, null, 2));
writeFileSync(join(taskDir, 'run-1.summary.json'), JSON.stringify(summary('run-1', 1000, 'success'), null, 2));
// Legacy run: no summary sidecar
writeFileSync(join(taskDir, 'run-2.json'), JSON.stringify({ ...summary('run-2', 3000, 'error'), error: 'boom', log: [] }, null, 2));

const runs = listRuns('tester', 'task-1');
check('both runs listed (new + legacy)', runs.length === 2);
check('newest first', runs[0]?.runId === 'run-2');
const run1 = runs.find((r) => r.runId === 'run-1')!;
check('summary fields returned', run1.taskName === 't' && run1.status === 'success' && run1.startedAt === 1000);
check('no log in the list payload', !('log' in (run1 as any)));
check('no prompt in the list payload', !('prompt' in (run1 as any)));
check('legacy record keeps its error', runs[0]?.error === 'boom');

check('hasRuns true for a task with runs', hasRuns('tester', 'task-1'));
check('hasRuns false for an unknown task', !hasRuns('tester', 'nope'));
check('hasRuns rejects unsafe ids', !hasRuns('tester', '../task-1'));

rmSync(stateDir, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll scheduler run-listing checks passed');
process.exit(0);
