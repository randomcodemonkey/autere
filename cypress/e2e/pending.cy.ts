/**
 * Queued (steer) message e2e — a message sent while a slow tool call runs is
 * queued by pi; cancelling it must remove it from chat entirely, not leave a
 * copy that looks like it was sent.
 */

import { waitForBackend } from './support/helpers';

describe('autere — pending messages', () => {
  before(() => { waitForBackend(); });
  beforeEach(() => { cy.visit('/'); });

  it('removes a cancelled queued message from the chat', function() {
    this.timeout(180000);

    cy.get('.chat-input').clear().type('Run a command with long output');
    cy.get('.chat-send-btn').first().click();

    // While the tool call streams, send another message: pi queues it as a steer.
    cy.get('.tool-call-header', { timeout: 90000 }).should('exist');
    cy.get('.chat-input').clear().type('cancel this one');
    cy.get('.chat-input').should('have.value', 'cancel this one');
    cy.get('.chat-send-btn').first().click();
    cy.contains('.stream-msg-pending', 'cancel this one').should('exist');

    cy.contains('.stream-msg-pending', 'cancel this one').find('.pending-cancel').first().click();

    // Gone, not retired into a normal-looking user message.
    cy.get('.stream-msg-pending').should('not.exist');
    cy.wait(1000); // give a stray upsert the chance to fail the assertion below
    cy.contains('.stream-msg', 'cancel this one').should('not.exist');
  });
});
