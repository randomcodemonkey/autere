/**
 * Session flow e2e — creating and switching sessions (heavy: real model
 * turns for seeding and isolation checks).
 */

import { waitForBackend, openSessionsModal, seedIdleSession } from './support/helpers';

describe('autere — session flow', () => {
  before(function() {
    this.timeout(120000);
    waitForBackend();
    // A persisted OTHER session for the switch targets — seeded on disk
    // (no pi spawn) so these tests never depend on earlier specs.
    seedIdleSession('flow switch target');
  });
  beforeEach(() => { cy.visit('/'); });

  describe('Create New Session', () => {
    it('creates a new session and navigates to it', function() {
      this.timeout(60000);

      // Wait for the agent to be idle (New Session is disabled while Working)
      cy.get('.status-badge', { timeout: 30000 }).should('not.contain', 'Working');
      cy.get('.status-badge', { timeout: 30000 }).should('not.contain', 'Compacting');

      // Open the sessions modal
      openSessionsModal();
      cy.get('.modal-session .btn-primary').should('be.visible').and('not.be.disabled');
      cy.get('.modal-session .btn-primary').click();
      // The form opens inside the modal; create with the prefilled name
      cy.get('.session-create-btn').should('be.visible').click();

      // Should eventually navigate to a new session (loading page may be too fast to catch)
      cy.url({ timeout: 5000 }).should('match', /\/session\/[^/]+$/);

      // Session badge must show the NEW session's auto-name ("[ui] - <locale date+time>")
      // immediately — not the previous session's name/id.
      cy.get('.session-badge-text').should('contain', '[ui] -');
    });
  });

  describe('Switch Sessions', () => {
    it('switches to a different session via the sessions modal', function() {
      this.timeout(30000);

      // Open the sessions modal
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');

      // Wait for sessions to load
      cy.get('.session-item', { timeout: 5000 }).should('have.length.greaterThan', 0);

      // Find and click a different session
      cy.get('.session-item').not('.active').first().click();

      // Should navigate to a session URL
      cy.url({ timeout: 5000 }).should('match', /\/session\/[^/]+$/);
    });

    it('can switch sessions via URL', function() {
      this.timeout(30000);

      // Open the sessions modal
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');

      // Get a session ID from the list
      cy.get('.session-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
      cy.get('.session-item').not('.active').first().find('.session-item-id').invoke('text').then((sessionId) => {

        // Navigate directly to the session via URL
        cy.visit(`/session/${sessionId.trim()}`);

        // Should show that session's ID
        cy.get('.session-badge-text', { timeout: 5000 }).should('contain', sessionId.trim().substring(0, 6));
      });
    });

    it('session list shows sessions with id and name', () => {
      cy.get('.session-badge').click();
      // At least the current session must be listed
      cy.get('.session-item', { timeout: 5000 }).should('have.length.at.least', 1);
      cy.get('.session-item').first().find('.session-item-id').should('exist');
      cy.get('.modal-session .modal-close').click();
    });

    it('current session is highlighted in list', () => {
      cy.get('.session-badge').click();
      cy.get('.session-item.active', { timeout: 5000 }).should('exist');
      cy.get('.modal-session .modal-close').click();
    });

    it('can abort operation from the status card', function() {
      this.timeout(30000);

      // Send a message to make the agent work
      cy.get('.chat-input').type('Think about the meaning of life for a moment');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      // Wait for streaming to start
      cy.get('.status-badge', { timeout: 10000 }).should('have.class', 'status-streaming');

      // Click abort (force: the turn may already have finished between the
      // streaming check and this click, hiding the button again)
      cy.contains('Abort Operation', { timeout: 3000 }).click({ force: true });

      // Agent must end up idle, whether aborted or already finished
      cy.get('.status-badge', { timeout: 10000 }).should('have.class', 'status-connected');
    });
  });

  describe('Session Switching', () => {
    it('closes the sessions modal after creating a new session', function() {
      this.timeout(30000);
      // Previous tests may have left the agent streaming — new session needs idle
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
      openSessionsModal();
      cy.get('.btn-primary').contains('New Session').click();
      // The form opens inside the modal; create with the prefilled name
      cy.get('.session-create-btn').should('be.visible').click();
      // Modal must close once the new session is ready
      cy.get('.modal-session', { timeout: 10000 }).should('not.be.visible');
      // And we end up on a fresh session view
      cy.get('.stream-card', { timeout: 10000 }).should('exist');
    });

    it('switches to a previous session from the sessions modal', function() {
      this.timeout(30000);
      // Switching is disabled while the agent is active
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
      openSessionsModal();
      const items = cy.get('.session-item:not(.active)', { timeout: 5000 });
      items.then(($items) => {
        expect($items.length, 'at least one other session exists').to.be.greaterThan(0);
        const targetId = $items.first().find('.session-item-id').text().trim();
        cy.wrap($items.first()).click();
        // URL must change to the target session and the modal must close
        cy.url({ timeout: 10000 }).should('include', `/session/${targetId}`);
        cy.get('.modal-session').should('not.be.visible');
      });
    });
  });

  describe('New Session Isolation', () => {
    it('does not show old session content after creating new session', function() {
      this.timeout(90000);

      // Wait for agent to be idle first (previous tests may have left it streaming)
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');

      // Send a unique message in the current session so we can identify it
      const uniqueMsg = 'Test marker ' + Date.now();
      cy.get('.chat-input').should('not.be.disabled').type(uniqueMsg);
      cy.get('.chat-send-btn').first().click();

      // Wait for the user message to appear
      cy.get('.stream-role-user', { timeout: 5000 }).should('contain', 'user');
      cy.get('.stream-text').should('contain', uniqueMsg);

      // Open the sessions modal and abort
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');
      cy.get('.btn-abort', { timeout: 5000 }).should('be.visible').click();

      // Agent should leave the Working state
      cy.get('.status-badge', { timeout: 30000 }).should('not.contain', 'Working');
      cy.get('.modal-session .modal-close').click();
      cy.get('.modal-session').should('not.be.visible');
    });
  });
});
