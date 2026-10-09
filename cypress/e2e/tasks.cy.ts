/**
 * Scheduled tasks e2e — create, run (one real agent turn), inspect the log,
 * edit, delete.
 */

import { waitForBackend, warmUpSession } from './support/helpers';

describe('autere — scheduled tasks', () => {
  const TASK_NAME = `e2e-task-${Date.now()}`;

  before(function() { this.timeout(60000); waitForBackend(); warmUpSession(); });
  beforeEach(() => { cy.visit('/'); });

  function openTasks() {
    cy.get('.view-btn-tasks').click();
    cy.get('.scheduled-card').should('be.visible');
  }

  it('navigates to tasks view from the menu', () => {
    openTasks();
    cy.get('#main-app').should('have.class', 'view-tasks');
  });

  it('shows the scheduled tasks card', () => {
    openTasks();
    cy.get('.scheduled-card .card-title').should('contain', 'Scheduled Tasks');
    cy.get('.scheduled-new-btn').should('contain', 'New Task');
  });

  it('creates a scheduled task with seed and result scripts', () => {
    openTasks();
    cy.get('.scheduled-new-btn').click();
    cy.get('.scheduled-input-name').type(TASK_NAME);
    cy.get('.scheduled-input-schedule').clear();
    cy.get('.scheduled-input-schedule').type('0 5 * * 1');
    cy.get('.scheduled-card').should('contain', '0 5 * * 1');
    cy.get('.scheduled-input-prompt').type('Reply with exactly: OK');
    cy.get('.scheduled-input-seed').type('echo e2e-seed-data');
    cy.get('.scheduled-input-result').type('cat > /dev/null && echo result-script-ok');
    cy.get('.scheduled-save-btn').click();
    cy.get('.scheduled-task', { timeout: 5000 }).should('contain', TASK_NAME);
    cy.get('.scheduled-task-detail').should('contain', 'echo e2e-seed-data');
  });

  it('runs the task now via the Run now button and records a log', function() {
    this.timeout(180000);
    openTasks();

    // Run the just-created task — the agent runs in a dedicated pi process
    cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
      .find('.scheduled-run-btn').click();

    // The run appears in the (auto-expanded) runs list, eventually succeeding
    // Runs render in a sibling row (auto-expanded after Run now)
    cy.get('.sched-run-status.sched-run-success', { timeout: 150000 }).should('exist');
  });

  it('shows the run log with seed output, agent result and result script output', () => {
    openTasks();
    cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
      .find('.scheduled-toggle-runs-btn').click();
    cy.get('.sched-run-log-btn', { timeout: 30000 }).first().click();

    cy.get('.modal-sched-log', { timeout: 5000 }).should('be.visible');
    cy.get('.sched-log-meta').should('contain', 'success');
    // Full log lines written by the backend
    cy.get('.sched-log-lines').should('contain', 'Run started (trigger: manual)');
    cy.get('.sched-log-lines').should('contain', 'Seed script produced');
    cy.get('.sched-log-lines').should('contain', 'Agent finished');
    cy.get('.sched-log-lines').should('contain', 'Result script produced');
    cy.get('.sched-log-lines').should('contain', 'pi agent stopped');
    // Run sessions are disposable by default — dropped with the run
    cy.get('.sched-log-lines').should('contain', 'Run session removed');
    // Seeded data reached the prompt; result script output captured
    cy.get('.sched-log-pre').should('contain', 'e2e-seed-data');
    cy.get('.sched-log-pre').should('contain', 'result-script-ok');
    cy.get('.modal-sched-log .modal-close').click();
    // Modal stays in the DOM when closed (hidden overlay) — assert invisibility
    cy.get('.modal-sched-log', { timeout: 5000 }).should('not.be.visible');
  });

  it('deletes the run session by default and keeps it with Save task sessions on', function() {
    this.timeout(180000);

    // Default: the completed run's session is gone from the session list
    cy.request('/api/v1/sessions').then((res) => {
      const taskSessions = (res.body.data || [])
        .filter((s: any) => String(s.sessionName || '').includes('[task]'));
      expect(taskSessions, 'run sessions after a default run').to.have.length(0);
    });

    // Opt in, run again, and the session survives
    openTasks();
    cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
      .find('.scheduled-edit-btn').click();
    cy.get('.scheduled-input-savesession').check({ force: true }); // styled switch: input is 0x0
    cy.get('.scheduled-save-btn').click();
    cy.get('.scheduled-task', { timeout: 5000 }).should('contain', TASK_NAME);
    cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
      .find('.scheduled-run-btn').click();
    // Two completed runs by now — the second one keeps its session
    cy.get('.sched-run-status.sched-run-success', { timeout: 150000 }).should('have.length', 2);

    cy.request('/api/v1/sessions').then((res) => {
      const taskSessions = (res.body.data || [])
        .filter((s: any) => String(s.sessionName || '').includes('[task]'));
      expect(taskSessions, 'run sessions with save on').to.have.length(1);
    });
  });

  it('edits an existing task', () => {
    openTasks();
    cy.get('.scheduled-task').contains(TASK_NAME).parents('.scheduled-task')
      .find('.scheduled-edit-btn').click();
    cy.get('.card-title').should('contain', 'Edit Scheduled Task');
    cy.get('.scheduled-input-name').clear();
    cy.get('.scheduled-input-name').type(`${TASK_NAME}-renamed`);
    cy.get('.scheduled-save-btn').click();
    cy.get('.scheduled-task', { timeout: 5000 }).should('contain', `${TASK_NAME}-renamed`);
  });

  it('deletes the task', () => {
    openTasks();
    cy.on('window:confirm', () => true);
    cy.get('.scheduled-task').contains(`${TASK_NAME}-renamed`).parents('.scheduled-task')
      .find('.scheduled-delete-btn').click();
    // The renamed task disappears from the list
    cy.contains('.scheduled-task', `${TASK_NAME}-renamed`, { timeout: 5000 }).should('not.exist');
  });
});
