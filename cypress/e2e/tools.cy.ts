/**
 * Tool-call rendering e2e — one model turn that triggers a bash tool call,
 * rendered inline in the chat stream.
 */

import { waitForBackend } from './support/helpers';

describe('autere — tools', () => {
  before(() => { waitForBackend(); });
  beforeEach(() => { cy.visit('/'); });

  it('renders tool calls inline in the chat stream', function() {
    this.timeout(120000);

    // Tool calls are rendered as messages in the stream (toolCall role),
    // not as a separate card — send something that triggers a tool.
    cy.get('.chat-input').clear().type('Run the command: echo hello');
    cy.get('.chat-send-btn').first().click();

    cy.get('.tool-call-header', { timeout: 90000 }).should('exist');
    cy.get('.tool-call-name').should('contain', '⚙');
  });
});
