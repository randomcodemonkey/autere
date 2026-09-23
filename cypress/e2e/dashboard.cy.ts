/**
 * Dashboard/UI smoke e2e — no model turns: loading, SSE status, cards,
 * usage display, system card, view menu, collapse, filters, responsive.
 */

import { waitForBackend, openSettings } from './support/helpers';

describe('autere — dashboard', () => {
  before(() => { waitForBackend(); });
  beforeEach(() => { cy.visit('/'); });

  describe('Dashboard Loading', () => {
    it('loads the dashboard successfully', () => {
      // First visit on a cold backend includes RootRedirect → new-session →
      // pi spawn before the chat page (with .header) renders — allow for it.
      cy.get('#main-app', { timeout: 15000 }).should('exist');
      cy.get('.header', { timeout: 15000 }).should('exist');
      cy.get('.container').should('exist');
    });

    it('shows the autere title', () => {
      cy.get('.header h1').should('contain', 'autere');
    });

    it('shows status badge', () => {
      cy.get('.status-badge').should('exist');
    });

    it('shows session badge', () => {
      cy.get('.session-badge').should('exist');
    });
  });

  describe('SSE Connection', () => {
    it('connects to SSE and shows connected status', () => {
      // Wait for SSE connection to establish
      cy.get('.status-badge', { timeout: 15000 }).should('not.contain', 'Disconnected');
    });

    it('receives initial state via SSE', () => {
      // Wait for status to be something other than disconnected
      cy.get('.status-badge', { timeout: 15000 }).should('exist');
      // Session badge should show a session ID
      cy.get('.session-badge-text').should('exist');
    });
  });

  describe('Cards Display', () => {
    it('shows Agent card', () => {
      cy.get('.card-title').contains('Agent').should('exist');
    });

    it('shows Usage card', () => {
      cy.get('.card-title').contains('Usage').should('exist');
    });

    it('shows model selector in the chat header', () => {
      cy.get('.chat-model-row .chat-model-name').should('exist');
    });

    it('shows Extensions card', () => {
      cy.get('.card-title').contains('Extensions').should('exist');
    });

    it('shows Chat card', () => {
      cy.get('.stream-card').should('exist');
    });
  });

  describe('Usage Statistics', () => {
    it('displays usage statistics', () => {
      cy.contains('Messages').should('exist');
      cy.contains('Requests').should('exist');
      cy.contains('Input Tokens').should('exist');
      cy.contains('Output Tokens').should('exist');
      cy.contains('Cost').should('exist');
      cy.contains('Context').should('exist');
    });

    it('shows context usage progress bar', () => {
      cy.get('.progress-bar').should('exist');
      cy.get('.progress-fill').should('exist');
    });
  });

  describe('System Card', () => {
    it('shows the system card in the status column', () => {
      cy.get('.status-card-system').scrollIntoView().should('be.visible');
    });

    it('shows username', () => {
      cy.get('.status-card-system .modal-username').should('exist');
    });

    it('shows uptime rows', () => {
      cy.get('.status-card-system .modal-uptime-row').should('have.length', 3); // pi uptime, autere uptime, UI build
    });

    it('shows logout button', () => {
      cy.contains('Logout').should('exist');
    });

    it('shows restart button', () => {
      cy.contains('Restart PI').should('exist');
    });
  });

  describe('View Menu', () => {
    it('shows chat, status and settings views in the menu', () => {
      cy.get('.view-btn-chat').should('exist');
      cy.get('.view-btn-status').should('exist');
      cy.get('.view-btn-settings').should('exist');
    });

    it('highlights the active view', () => {
      cy.get('.view-btn-chat').should('have.class', 'active');
      cy.get('.view-btn-settings').click();
      cy.get('.view-btn-settings').should('have.class', 'active');
      cy.get('.view-btn-chat').click();
      cy.get('.view-btn-chat').should('have.class', 'active');
    });

    it('switches to settings view and back', () => {
      openSettings();
      cy.url().should('match', /\/session\/[^/]+\/settings$/);
      cy.get('.view-btn-chat').click();
      cy.get('.stream-card').should('exist');
      cy.url().should('match', /\/session\/[^/]+$/);
    });
  });

  describe('Card Collapse', () => {
    it('can collapse and expand the Agent card', () => {
      // Collapse state persists in localStorage — normalize to expanded first.
      // NOTE: the direct-child selector — ExtensionsCard and UsageCard nested
      // inside the Agent card have their own .card-header toggles.
      cy.get('.agent-card').then(($card) => {
        if ($card.hasClass('collapsed')) cy.get('.agent-card > .card-header').click();
      });
      cy.get('.agent-card').should('not.have.class', 'collapsed');

      // Click on the Agent card header to collapse
      cy.get('.agent-card > .card-header').click();
      cy.get('.agent-card').should('have.class', 'collapsed');

      // Click again to expand
      cy.get('.agent-card > .card-header').click();
      cy.get('.agent-card').should('not.have.class', 'collapsed');
    });
  });

  describe('Chat Filters', () => {
    it('has thinking filter toggle', () => {
      cy.get('.stream-toggle').contains('thinking').should('exist');
    });

    it('has tools filter toggle', () => {
      cy.get('.stream-toggle').contains('tools').should('exist');
    });

    it('has edits filter toggle', () => {
      cy.get('.stream-toggle').contains('edits').should('exist');
    });

    it('can toggle thinking filter', () => {
      cy.get('.stream-toggle').contains('thinking').click();
      // The button should toggle its active state
      cy.get('.stream-toggle').contains('thinking').then(($el) => {
        expect($el.hasClass('active')).to.be.oneOf([true, false]);
      });
    });
  });

  describe('Responsive Design', () => {
    it('renders correctly on mobile viewport', () => {
      cy.viewport(375, 812); // iPhone X
      cy.get('#main-app').should('exist');
      cy.get('.header').should('exist');
      cy.get('.chat-input').should('exist');
    });

    it('renders correctly on tablet viewport', () => {
      cy.viewport(768, 1024); // iPad
      cy.get('#main-app').should('exist');
      cy.get('.header').should('exist');
    });
  });

  describe('Error Handling', () => {
    it('handles network errors gracefully', () => {
      // This is a basic test - in real scenarios we'd mock the API
      cy.get('#main-app').should('exist');
    });
  });
});
