import React from 'react';
import { ScheduledTasksCard } from '../../src/frontend/components/ScheduledTasksCard';
import type { ScheduledTask, TaskRunRecord } from '../../src/frontend/types';

const TASK: ScheduledTask = {
  id: 'task-1',
  name: 'Daily report',
  schedule: '0 9 * * *',
  prompt: 'Write a report',
  seedScript: 'echo seed-data',
  resultScript: 'tee /tmp/out.txt',
  enabled: true,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

const DISABLED_TASK: ScheduledTask = {
  ...TASK,
  id: 'task-2',
  name: 'Disabled task',
  enabled: false,
};

const RUN: TaskRunRecord = {
  runId: 'run-1',
  taskId: 'task-1',
  taskName: 'Daily report',
  trigger: 'schedule',
  startedAt: Date.now(),
  finishedAt: Date.now() + 5000,
  status: 'success',
};

const RUNNING_RUN: TaskRunRecord = {
  ...RUN,
  runId: 'run-2',
  taskId: 'task-2',
  taskName: 'Disabled task',
  trigger: 'manual',
  status: 'running',
};

const RUN_LOG = {
  ...RUN,
  prompt: 'Write a report\n\nData:\nseed-data',
  seedOutput: 'seed-data',
  agentResult: 'The report content',
  resultScriptOutput: 'saved',
  log: ['[t1] Run started (trigger: schedule)', '[t2] Run completed successfully'],
};

let responseData: any;

function installFetchStub(win: any, handler: (u: string, init: any) => any) {
  win.fetch = (input: any, init: any) =>
    Promise.resolve({ json: () => Promise.resolve(handler(String(input), init)) });
}

function stubFetch() {
  // Component tests run in an already-loaded page — cy.intercept and
  // window:before:load don't apply, so stub window.fetch directly.
  cy.window({ log: false }).then((win) => {
    installFetchStub(win, (u) => {
      if (u.includes('/api/scheduler/tasks') && !u.includes('/run') && !u.includes('/runs/')) {
        return { success: true, data: responseData };
      }
      if (u.includes('/runs/')) {
        return { success: true, data: RUN_LOG };
      }
      return { success: true };
    });
  });
}

describe('ScheduledTasksCard', () => {
  describe('list view', () => {
    it('shows the empty state when there are no tasks', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-empty').should('contain', 'No scheduled tasks yet');
    });

    it('renders tasks with name, schedule description and cron expression', () => {
      stubFetch();
      responseData = { tasks: [TASK], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-task').should('have.length', 1);
      cy.get('.scheduled-task-name').should('contain', 'Daily report');
      cy.get('.scheduled-task-schedule').should('contain', 'Daily at 09:00');
      cy.get('.scheduled-task-schedule').should('contain', '0 9 * * *');
    });

    it('shows enabled/disabled state', () => {
      stubFetch();
      responseData = { tasks: [TASK, DISABLED_TASK], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-enabled-dot.on').should('exist');
      cy.get('.scheduled-enabled-dot.off').should('exist');
    });

    it('shows seed and result script summaries', () => {
      stubFetch();
      responseData = { tasks: [TASK], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-task-detail').should('contain', 'echo seed-data');
      cy.get('.scheduled-task-detail').should('contain', 'tee /tmp/out.txt');
    });

    it('shows a loading state initially', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-loading').should('contain', 'Loading scheduled tasks');
      cy.get('.scheduled-empty').should('exist');
    });

    it('shows the New Task button', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-new-btn').should('contain', 'New Task');
    });

    it('shows not-connected warning when SSE is down', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={false} />);
      cy.get('.settings-error').should('contain', 'Not connected');
    });
  });

  describe('runs', () => {
    it('expands runs and lists statuses', () => {
      stubFetch();
      responseData = { tasks: [TASK], runs: [RUN] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-runs').should('not.exist');
      cy.get('.scheduled-toggle-runs-btn').click();
      cy.get('.scheduled-runs').should('exist');
      cy.get('.sched-run-status').should('contain', 'success');
      cy.get('.sched-run-trigger').should('contain', 'schedule');
    });

    it('shows running status for in-flight runs', () => {
      stubFetch();
      responseData = { tasks: [TASK, DISABLED_TASK], runs: [RUNNING_RUN] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-toggle-runs-btn').eq(1).click();
      cy.get('.sched-run-status').should('contain', 'running');
      cy.get('.sched-run-status.sched-run-running').should('exist');
    });

    it('disables Run now while a run is in flight', () => {
      stubFetch();
      responseData = { tasks: [DISABLED_TASK], runs: [RUNNING_RUN] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-run-btn').should('be.disabled');
      cy.get('.scheduled-run-btn').should('contain', 'Running…');
    });

    it('opens the run log viewer', () => {
      stubFetch();
      responseData = { tasks: [TASK], runs: [RUN] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-toggle-runs-btn').click();
      cy.get('.sched-run-log-btn').click();
      // Modal with log content
      cy.get('.modal-status', { timeout: 5000 }).should('exist');
    });

    it('Run now triggers a run request and refreshes', () => {
      let runRequested = false;
      cy.window({ log: false }).then((win) => {
        installFetchStub(win, (u, init) => {
          if (u.endsWith('/run') && init?.method === 'POST') {
            runRequested = true;
            return { success: true, data: { runId: 'run-x' } };
          }
          return { success: true, data: { tasks: [TASK], runs: [] } };
        });
      });
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-run-btn').click();
      cy.wrap(null).should(() => {
        expect(runRequested).to.be.true;
      });
    });
  });

  describe('form', () => {
    it('opens an empty form for new tasks', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-new-btn').click();
      cy.get('.card-title').should('contain', 'New Scheduled Task');
      cy.get('.scheduled-input-name').should('have.value', '');
      cy.get('.scheduled-input-schedule').should('have.value', '*/15 * * * *');
      cy.get('.scheduled-input-prompt').should('have.value', '');
    });

    it('prefills the form when editing a task', () => {
      stubFetch();
      responseData = { tasks: [TASK], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-edit-btn').click();
      cy.get('.card-title').should('contain', 'Edit Scheduled Task');
      cy.get('.scheduled-input-name').should('have.value', 'Daily report');
      cy.get('.scheduled-input-prompt').should('have.value', 'Write a report');
      cy.get('.scheduled-input-seed').should('have.value', 'echo seed-data');
    });

    it('shows a human description of the schedule', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-new-btn').click();
      cy.get('.scheduled-input-schedule').clear();
      cy.get('.scheduled-input-schedule').type('*/5 * * * *');
      cy.get('.settings-description').should('contain', 'Every 5 minutes');
    });

    it('validates the cron schedule and disables save', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-new-btn').click();
      cy.get('.scheduled-input-name').type('Test');
      cy.get('.scheduled-input-prompt').type('Do things');
      cy.get('.scheduled-input-schedule').clear();
      cy.get('.scheduled-input-schedule').type('not-a-cron');
      cy.get('.scheduled-cron-error').should('exist');
      cy.get('.scheduled-save-btn').should('be.disabled');
    });

    it('requires name and prompt', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-new-btn').click();
      cy.get('.scheduled-input-schedule').clear();
      cy.get('.scheduled-input-schedule').type('*/5 * * * *');
      cy.get('.scheduled-input-prompt').type('Do things');
      cy.get('.scheduled-save-btn').click();
      cy.get('.scheduled-error').should('contain', 'Name and prompt are required');
    });

    it('saves a new task and returns to the list', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-new-btn').click();
      cy.get('.scheduled-input-name').type('Test');
      cy.get('.scheduled-input-prompt').type('Do things');
      cy.get('.scheduled-save-btn').click();
      cy.get('.scheduled-card .card-title').should('contain', 'Scheduled Tasks');
    });

    it('cancel returns to the list without saving', () => {
      stubFetch();
      responseData = { tasks: [], runs: [] };
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-new-btn').click();
      cy.get('.scheduled-cancel-btn').click();
      cy.get('.scheduled-card .card-title').should('contain', 'Scheduled Tasks');
    });

    it('keeps the form open and shows the server error on failure', () => {
      cy.window({ log: false }).then((win) => {
        installFetchStub(win, (u, init) => {
          if (u.includes('/api/scheduler/tasks') && init?.method === 'POST') {
            return { success: false, error: 'Invalid schedule: bad minute field' };
          }
          return { success: true, data: { tasks: [], runs: [] } };
        });
      });
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-new-btn').click();
      cy.get('.scheduled-input-name').type('Test');
      cy.get('.scheduled-input-prompt').type('Do things');
      cy.get('.scheduled-save-btn').click();
      cy.get('.scheduled-error').should('contain', 'Invalid schedule');
      cy.get('.card-title').should('contain', 'New Scheduled Task');
    });
  });

  describe('delete', () => {
    it('delete button uses the danger styling and confirms', () => {
      stubFetch();
      responseData = { tasks: [TASK], runs: [] };
      let confirmMsg = '';
      cy.window({ log: false }).then((win) => {
        (win as any).confirm = (msg: string) => { confirmMsg = msg; return true; };
      });
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-delete-btn').should('have.class', 'btn-danger');
      cy.get('.scheduled-delete-btn').click();
      cy.wrap(null).should(() => {
        expect(confirmMsg).to.include('Daily report');
      });
    });

    it('does not delete when confirm() is dismissed', () => {
      let deleteRequested = false;
      stubFetch();
      responseData = { tasks: [TASK], runs: [] };
      cy.window({ log: false }).then((win) => {
        (win as any).confirm = () => false;
        const origFetch = win.fetch;
        (win as any).fetch = (input: any, init: any) => {
          if (String(input).includes('/api/scheduler/tasks/') && init?.method === 'DELETE') {
            deleteRequested = true;
          }
          return origFetch.call(win, input, init);
        };
      });
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-delete-btn').click();
      cy.wrap(null).should(() => {
        expect(deleteRequested).to.be.false;
      });
    });

    it('asks for confirmation and deletes', () => {
      stubFetch();
      responseData = { tasks: [TASK], runs: [] };
      cy.on('window:confirm', (msg) => {
        expect(msg).to.include('Daily report');
        return true;
      });
      cy.mount(<ScheduledTasksCard sseConnected={true} />);
      cy.get('.scheduled-delete-btn').click();
      cy.get('.scheduled-task').should('have.length', 1); // refresh stub still returns the task
    });
  });
});
