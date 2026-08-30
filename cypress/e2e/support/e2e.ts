/**
 * E2E test support file.
 *
 * The backend lifecycle is managed by run-e2e.ts (Node.js), NOT here.
 * This file only sets up Cypress custom commands for browser-side use.
 */

// Custom commands
declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Wait for SSE connection to be established
       */
      waitForSSEConnection(): Chainable<void>;

      /**
       * Wait for the agent to become idle (not streaming)
       */
      waitForIdle(timeout?: number): Chainable<void>;

      /**
       * Send a message and wait for response
       */
      sendMessage(message: string): Chainable<void>;
    }
  }
}

Cypress.Commands.add('waitForSSEConnection', () => {
  cy.get('.status-badge', { timeout: 15000 }).should('exist');
  cy.get('.status-badge').should('not.contain', 'Disconnected');
});

Cypress.Commands.add('waitForIdle', (timeout = 60000) => {
  cy.get('.status-badge', { timeout }).should('contain', 'Idle');
});

Cypress.Commands.add('sendMessage', (message: string) => {
  cy.get('.chat-input').clear().type(message);
  cy.get('.chat-send-btn').click();
});

export {};
