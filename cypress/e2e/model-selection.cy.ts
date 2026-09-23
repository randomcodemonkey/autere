/**
 * Model dropdown e2e — no model turns. Model selection lives in the
 * chat-header dropdown since the Model card was replaced by the inline
 * selector.
 */

import { waitForBackend, warmUpSession } from './support/helpers';

describe('autere — model selection', () => {
  before(function() { this.timeout(60000); waitForBackend(); warmUpSession(); });
  beforeEach(() => { cy.visit('/'); });

  it('opens the model dropdown listing available models', () => {
    cy.get('.chat-model-name').click();
    cy.get('.chat-model-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
    cy.get('body').type('{esc}');
  });

  it('highlights the active model', () => {
    cy.get('.chat-model-name').click();
    cy.get('.chat-model-item.active', { timeout: 5000 }).should('exist');
    cy.get('body').type('{esc}');
  });

  it('can select a different model', function() {
    this.timeout(30000);

    cy.get('.chat-model-name').click();
    cy.get('.chat-model-item.active .model-name', { timeout: 5000 }).invoke('text').then((activeName) => {
      // Pick a model that is NOT the active one and select it
      cy.get('.chat-model-item').then(($items) => {
        const target = $items.toArray().find((el) => !el.classList.contains('active'));
        expect(target, 'a non-active model exists').to.exist;
        cy.wrap(target).click();
      });

      // Selecting closes the dropdown (async /api/set-model round-trip)
      cy.get('.chat-model-dropdown', { timeout: 5000 }).should('not.exist');

      // Reopen: the selection is now the active model — then restore
      cy.get('.chat-model-name').click();
      cy.get('.chat-model-item.active .model-name', { timeout: 5000 }).invoke('text')
        .should('not.equal', activeName);
      cy.get('.chat-model-item').contains(activeName).click();
      cy.get('.chat-model-dropdown', { timeout: 5000 }).should('not.exist');
    });
  });
});
