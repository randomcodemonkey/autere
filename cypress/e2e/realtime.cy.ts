/**
 * Real-time SSE update e2e — status flips during a turn and message-count
 * growth (2 model turns).
 */

import { waitForBackend } from './support/helpers';

describe('autere — realtime', () => {
  before(() => { waitForBackend(); });
  beforeEach(() => { cy.visit('/'); });

  describe('Real-time Updates', () => {
    it('updates status in real-time via SSE', function() {
      this.timeout(60000);

      // Send a message to trigger status change
      cy.get('.chat-input').type('Hello');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      // Status should change to Working
      cy.get('.status-badge', { timeout: 15000 }).should('have.class', 'status-streaming');

      // Then back to Idle after response
      cy.get('.status-badge', { timeout: 60000 }).should('have.class', 'status-connected');
    });

    it('updates message count after sending message', function() {
      this.timeout(120000);

      // Get initial message count
      cy.contains('Messages').parent().find('.stat-value-compact').then(($el) => {
        const initialCount = parseInt($el.text()) || 0;

        // Send a message
        cy.get('.chat-input').type('Count test');
        cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

        // Wait for response
        cy.get('.stream-role-assistant', { timeout: 60000 }).should('exist');

        // Message count should increase
        cy.contains('Messages').parent().find('.stat-value-compact').should(($el) => {
          const newCount = parseInt($el.text()) || 0;
          expect(newCount).to.be.greaterThan(initialCount);
        });

        // Wait for the turn to fully complete — the following test depends on
        // the agent being idle, and the assistant message existing only means
        // streaming STARTED.
        cy.get('.status-badge', { timeout: 90000 }).should('not.have.class', 'status-streaming');
      });
    });
  });
});
