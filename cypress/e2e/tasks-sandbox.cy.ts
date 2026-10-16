/**
 * Sandbox workdirs inheritance for scheduled tasks — reproduces the
 * reported failure: a session spawned with New-Session-modal workdirs
 * schedules a once task, and the run must get the same work area.
 *
 * Geometry that triggers the bug: the workdir is a SUBDIRECTORY of the
 * admin's allowedDirs root, so the session header's container cwd
 * ($HOME/work/<root>/<sub>) fails the basename-based host translation —
 * the session drops out of the sessions listing and the task creation
 * resolved nothing (no cwd/workdirs → run starts outside the work area).
 *
 * Requires AUTERE_E2E_SANDBOX_IMAGE (skips otherwise):
 *   AUTERE_E2E_SANDBOX_IMAGE=ghcr.io/randomcodemonkey/autere:0.4.1 \
 *     npx tsx cypress/e2e/support/run-one.ts cypress/e2e/tasks-sandbox.cy.ts
 */

import { waitForBackend } from './support/helpers';

// Volume-backed root (the repo checkout is a docker volume in this
// environment) — workdirs must live under it to be mountable.
const WORKROOT = '/home/autere/code/autere';
const WORKAREA = '/home/autere/work/autere'; // container dst of WORKROOT
const WORKDIR = WORKROOT + '/.e2e-sandbox-wd';
const PROJ = WORKDIR + '/proj';

describe('autere — scheduled task sandbox workdirs', () => {
  const TASK_NAME = 'e2e-wd-task-' + Date.now();
  let sessionId = '';

  before(function() {
    this.timeout(120000);
    if (!Cypress.env('e2eSandboxImage')) this.skip();
    waitForBackend();
    // allowedDirs root whose basename does NOT match the workdir's —
    // exactly the layout that breaks the container-cwd back-translation.
    cy.exec('mkdir -p ' + PROJ);
    cy.request('PUT', '/api/v1/users/admin', {
      allowedDirs: [{ path: WORKROOT, access: 'rw' }],
    });
    // Spawn a session restricted to the workdir (New-Session-modal path)
    cy.request('POST', '/api/v1/sessions', { workdirs: [PROJ] }).then((res) => {
      expect(res.body.success).to.eq(true);
      sessionId = res.body.navigateUrl.split('/').pop();
    });
    // Prompt it so pi flushes the session file with the sandbox cwd.
    // Retry: the fresh session may still be initializing (409 busy).
    const prompt = (): Cypress.Chainable<Cypress.Response<unknown>> =>
      cy.request({
        method: 'POST', url: '/api/v1/session/messages', failOnStatusCode: false,
        body: { sessionId, message: 'Reply with exactly: OK', type: 'prompt' },
      }).then((res) => (res.status === 409 ? cy.wait(2000).then(prompt) : res));
    prompt().its('status').should('eq', 200);
    // The header must carry the container work path (untranslated) — the
    // exact state that drops the session from the listings.
    cy.task<string | null>('awaitSandboxHeaderCwd', sessionId)
      .should('match', /^\/home\/autere\/work\//);
  });

  after(() => {
    if (!Cypress.env('e2eSandboxImage')) return;
    cy.exec('rm -rf ' + WORKDIR, { failOnNonZeroExit: false });
  });

  function pollRuns(taskId: string, done: (r: { status: string }) => void): void {
    cy.request(`/api/v1/scheduler/runs?taskId=${taskId}`).then((res) => {
      const run = res.body.data?.[0];
      if (run && run.status !== 'running') { done(run); return; }
      cy.wait(2000);
      pollRuns(taskId, done);
    });
  }

  it('inherits the parent session workdirs in a once task run', function() {
    this.timeout(180000);
    cy.exec('docker ps -q').then(({ stdout: before }) => {
      const beforeIds = before.trim().split('\n').filter(Boolean);

      // The task must capture the parent's workdirs + cwd (spawn state,
      // not the header round trip). Pre-fix this failed: the session is
      // unresolvable and the record gets no cwd/workdirs at all.
      cy.request('POST', '/api/v1/scheduler/tasks', {
        name: TASK_NAME, once: true, schedule: '* * * * *',
        prompt: 'Reply with exactly: OK', session: sessionId,
      }).then((res) => {
        expect(res.body.success).to.eq(true);
        expect(res.body.data.workdirs).to.deep.eq([PROJ]);
        expect(res.body.data.cwd).to.eq(PROJ);
        const taskId = res.body.data.id;

        // One-off tasks run immediately. While the run is live, probe for
        // its sandbox container (the parent also runs this image — only
        // NEW ids count) and assert the work area + start dir.
        const probe = (): void => {
          cy.task('sandboxProbe', beforeIds).then((found: { workdir: string; workMounts: string[] }[]) => {
            if (found.length) {
              expect(found[0].workMounts, 'work area mounted').to.include(WORKAREA);
              expect(found[0].workdir, 'run starts inside the project').to.eq(WORKAREA + '/.e2e-sandbox-wd/proj');
              return;
            }
            cy.request(`/api/v1/scheduler/runs?taskId=${taskId}`).then((r) => {
              if (r.body.data?.[0]?.status === 'running') {
                cy.wait(300);
                probe();
              }
              // run already finished without catching the container — the
              // container probe is best-effort; the record above is the
              // regression assertion.
            });
          });
        };
        probe();

        pollRuns(taskId, (run) => expect(run.status).to.eq('success'));
      });
    });
  });
});
