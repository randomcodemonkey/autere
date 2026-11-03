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

  it('expands a streaming tool call to the whole output, not just its tail', function() {
    this.timeout(150000);

    cy.get('.chat-input').clear().type('Run a command with long output');
    cy.get('.chat-send-btn').first().click();

    // The card is still streaming when the collapsed toggle shows up, so this
    // is the live view and not the finalized result (which is complete anyway).
    cy.get('.tool-call-header', { timeout: 90000 }).should('exist');
    cy.get('.stream-text-truncated', { timeout: 60000 }).first().click();
    // The body starts at the first line — a tail preview could never contain
    // line 1, let alone the beginning of the run.
    cy.get('.stream-tool-output.expanded', { timeout: 30000 })
      .invoke('text')
      .should('contain', 'line 1\nline 2\nline 3')
      .and('not.match', /\.\.\.line 1/);
  });
});
