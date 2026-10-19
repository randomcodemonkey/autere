/**
 * Sandbox workdirs inheritance through the real pi-autere tool: pi creates a
 * recurring task from a sandboxed parent session, then its manual run must
 * get the same work area.
 *
 * Reproduces the reported volume layout: five distinct workdirs under
 * /home/autere/code, which is a Docker volume mounted into the backend.
 * The sandbox must mount every workdir into both the parent and task run.
 *
 * Requires a local image built from this checkout (skips otherwise):
 *   docker build -f docker/Dockerfile -t autere-e2e:head .
 *   AUTERE_E2E_SANDBOX_IMAGE=autere-e2e:head npx tsx cypress/e2e/support/run-one.ts cypress/e2e/tasks-sandbox.cy.ts
 */

import { waitForBackend } from './support/helpers';

// This is a Docker volume mounted from the host into the backend container.
const WORKROOT = '/home/autere/code';
const WORKAREA = '/home/autere/work';
const WORKDIR = `${WORKROOT}/.e2e-task-workdirs-${Date.now()}`;
const WORKDIRS = Array.from({ length: 5 }, (_, i) => `${WORKDIR}/repo-${i + 1}`);
const SANDBOX_MARKERS = WORKDIRS.map((_, i) => `${WORKAREA}/repo-${i + 1}/.e2e-marker`);
const MARKER_CONTENTS = WORKDIRS.map((_, i) => `marker-${i + 1}`);

describe('autere — scheduled task sandbox workdirs', () => {
  const TASK_NAME = 'e2e-wd-task-' + Date.now();
  let sessionId = '';

  before(function() {
    this.timeout(120000);
    if (!Cypress.env('e2eSandboxImage')) this.skip();
    waitForBackend();
    // Make five sibling roots on the backend's host-mounted Docker volume.
    cy.exec(`mkdir -p ${WORKDIRS.join(' ')} && ${WORKDIRS.map((dir, i) =>
      `printf 'marker-${i + 1}\\n' > ${dir}/.e2e-marker`,
    ).join(' && ')}`);
    cy.request('PUT', '/api/v1/users/admin', { allowedDirs: [] });
    // Per-session workdirs are the only roots; each must get its own mount.
    cy.request({ method: 'POST', url: '/api/v1/sessions', body: { workdirs: WORKDIRS }, timeout: 60000 }).then((res) => {
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
      cy.wait(1000);
      pollRuns(taskId, done);
    });
  }

  function waitForSessionIdle(remaining = 120): Cypress.Chainable<void> {
    return cy.request(`/api/v1/session/state?sessionId=${encodeURIComponent(sessionId)}`).then((res) => {
      if (!res.body.data?.isStreaming) return;
      if (remaining <= 0) throw new Error('parent session did not become idle');
      return cy.wait(500, { log: false }).then(() => waitForSessionIdle(remaining - 1));
    });
  }

  function sendPrompt(message: string): Cypress.Chainable<Cypress.Response<unknown>> {
    return cy.request({
      method: 'POST', url: '/api/v1/session/messages', failOnStatusCode: false,
      body: { sessionId, message, type: 'prompt' },
    }).then((res) => res.status === 409
      ? cy.wait(1000).then(() => sendPrompt(message))
      : res);
  }

  function pollCreatedTask(name: string, remaining = 90): Cypress.Chainable<any> {
    return cy.request('/api/v1/scheduler/tasks').then((res) => {
      const task = res.body.data?.tasks?.find((candidate: any) =>
        candidate.name === name && candidate.prompt.includes('[autere] Background run'));
      if (task) return cy.wrap(task, { log: false });
      if (remaining <= 0) throw new Error(`pi-autere did not finish creating task ${name}`);
      return cy.wait(500, { log: false }).then(() => pollCreatedTask(name, remaining - 1));
    });
  }

  function assertTaskSandbox(beforeIds: string[], remaining = 120): void {
    cy.task('sandboxProbe', { beforeIds, markerPaths: SANDBOX_MARKERS }).then((found: { workdir: string; workMounts: string[]; markerContents: (string | null)[] }[]) => {
      if (found.length) {
        expect(found[0].workMounts, 'all parent workdirs mounted').to.have.members(
          WORKDIRS.map((_, i) => `${WORKAREA}/repo-${i + 1}`),
        );
        expect(found[0].workdir, 'task run starts in first parent workdir').to.eq(`${WORKAREA}/repo-1`);
        if (JSON.stringify(found[0].markerContents) !== JSON.stringify(MARKER_CONTENTS)) {
          if (remaining <= 0) throw new Error(`child workdir contents mismatch: ${JSON.stringify(found[0].markerContents)}`);
          cy.wait(250);
          assertTaskSandbox(beforeIds, remaining - 1);
          return;
        }
        expect(found[0].markerContents, 'child sees files from all five volume subpaths').to.deep.eq(MARKER_CONTENTS);
        return;
      }
      if (remaining <= 0) throw new Error('scheduled-task sandbox did not expose the parent workdir');
      cy.wait(250);
      assertTaskSandbox(beforeIds, remaining - 1);
    });
  }

  it('inherits parent workdirs through pi-autere for a recurring task', function() {
    this.timeout(180000);
    cy.task<string | null>('awaitSandboxHeaderCwd', sessionId)
      .should('match', /^\/home\/autere\/work\//);
    waitForSessionIdle();

    const expectedMounts = WORKDIRS.map((_, i) => `${WORKAREA}/repo-${i + 1}`);
    cy.task('sandboxProbe', { beforeIds: [], markerPaths: SANDBOX_MARKERS }).then((found: { workdir: string; workMounts: string[]; markerContents: (string | null)[] }[]) => {
      const parent = found.find((container) => container.workdir === `${WORKAREA}/repo-1`);
      expect(parent, 'parent sandbox container').to.exist;
      expect(parent!.workMounts, 'all five parent workdirs mounted').to.have.members(expectedMounts);
      expect(parent!.markerContents, 'parent sees files from all five volume subpaths').to.deep.eq(MARKER_CONTENTS);
    });
    cy.exec('docker ps -q').then(({ stdout: before }) => {
      const beforeIds = before.trim().split('\n').filter(Boolean);
      // The mock model emits an actual tool call. pi-autere runs inside the
      // sandboxed parent session and resolves its own session id from context.
      sendPrompt(`E2E_AUTERE_SCHEDULE_TASK:${TASK_NAME}`).its('status').should('eq', 200);
      pollCreatedTask(TASK_NAME).then((task) => {
        expect(task.workdirs).to.deep.eq(WORKDIRS);
        expect(task.cwd).to.eq(WORKDIRS[0]);
        expect(task.once).to.not.eq(true);

        // Run the recurring task manually so its dedicated sandbox process
        // can be inspected; only containers created after this point count.
        cy.request('POST', `/api/v1/scheduler/tasks/${task.id}/run`).then((res) => {
          expect(res.status).to.eq(202);
        });
        assertTaskSandbox(beforeIds);
        pollRuns(task.id, (run) => expect(run.status).to.eq('success'));
      });
    });
  });
});
