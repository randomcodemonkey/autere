/**
 * Task-run sessions are owned by the Scheduler but must look like any other
 * session to the dashboard:
 * 1. adopt() lists the run as active/streaming (it used to be invisible)
 * 2. pm.get() resolves it, so viewing it attaches instead of spawning a
 *    duplicate pi process on the same session file
 * 3. release() drops it again once the run ends
 *
 * Run: npx tsx cypress/component/support/task-run-session.check.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'task-run-'));
process.env.AUTERE_DIR = dir;
process.env.AUTERE_PI_ENVS_DIR = join(dir, 'pi-envs');

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

const { ProcessManager } = await import(join(REPO, 'src/backend/process-manager.ts'));

const pm = new ProcessManager();
const file = join(dir, 'sessions', 'run-1.jsonl');
const fakeSession: any = {
  user: 'tester',
  routedSessionFile: () => file,
  isRunning: true,
  state: {
    sessionState: {
      sessionId: 'run-1', sessionFile: file, sessionName: '[task] - run',
      isStreaming: true, compacting: false,
    },
  },
  rpc: { getWorkdirs: () => [] },
};

pm.adopt('tester', fakeSession);
const listed = pm.listSessions('tester', new Set([file]));
const run = listed.find((s) => s.sessionFile === file);
check('adopted run is listed', !!run);
check('adopted run shows active', run?.active === true);
check('adopted run shows streaming', run?.streaming === true);
check('pm.get resolves the adopted run', pm.get('tester', file) === fakeSession);

pm.release('tester', fakeSession);
// A client still VIEWING it keeps the entry until it switches away; without
// viewers the run disappears from the list.
check('released run is gone', !pm.listSessions('tester', new Set()).some((s) => s.sessionFile === file));

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll task-run session checks passed');
process.exit(0);
