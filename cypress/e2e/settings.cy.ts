/**
 * Settings page e2e — no model turns. Mutates the enabled-models list
 * (add/remove); the mutations net out like they did in the monolith.
 */

import { waitForBackend, warmUpSession, openSettings, modelsSection } from './support/helpers';

describe('autere — settings', () => {
  before(function() { this.timeout(60000); waitForBackend(); warmUpSession(); });
  beforeEach(() => { cy.visit('/'); });

  it('navigates to settings view from the menu', () => {
    openSettings();
    cy.get('#main-app').should('have.class', 'view-settings');
  });

  it('shows settings card with title', () => {
    openSettings();
    cy.get('.settings-card').should('exist');
    cy.get('.settings-card .card-title').should('contain', 'Settings');
  });

  it('shows Models section with sortable list', () => {
    openSettings();
    cy.get('.settings-section-title').contains('Models').should('exist');
    modelsSection().find('.sortable-list').should('exist');
  });

  it('shows 9Router section if extension is enabled', () => {
    openSettings();
    cy.get('.settings-section-title', { timeout: 5000 }).contains('9Router').should('exist');
  });

  it('shows enabled models in sortable list', () => {
    openSettings();
    modelsSection().find('.sortable-list-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
  });

  it('add model input is visible on its own row', () => {
    openSettings();
    modelsSection().find('.sortable-list-add').should('exist');
    modelsSection().find('.sortable-list-add .sortable-list-input').should('be.visible');
    modelsSection().find('.sortable-list-add-btn').should('contain', 'Add Model');
  });

  it('add model button is disabled when input is empty', () => {
    openSettings();
    modelsSection().find('.sortable-list-add .sortable-list-input').should('have.value', '');
    modelsSection().find('.sortable-list-add-btn').should('be.disabled');
  });

  it('add model button enables when input has text', () => {
    openSettings();
    modelsSection().find('.sortable-list-add .sortable-list-input').type('test/model-v1');
    modelsSection().find('.sortable-list-add-btn').should('not.be.disabled');
  });

  it('can add a model to the list', () => {
    openSettings();

    // Get initial count
    modelsSection().find('.sortable-list-item').then(($items) => {
      const initialCount = $items.length;

      // Type a new model name
      modelsSection().find('.sortable-list-add .sortable-list-input').type('test/newly-added-model');
      modelsSection().find('.sortable-list-add-btn').click();

      // Should have one more item
      modelsSection().find('.sortable-list-item').should('have.length', initialCount + 1);

      // New item's input should contain the model name
      modelsSection().find('.sortable-list-item').last().find('.sortable-list-input').should('have.value', 'test/newly-added-model');

      // Input should be cleared
      modelsSection().find('.sortable-list-add .sortable-list-input').should('have.value', '');
    });
  });

  it('can add multiple models sequentially', () => {
    openSettings();

    modelsSection().find('.sortable-list-item').then(($items) => {
      const initialCount = $items.length;

      // Add first model
      modelsSection().find('.sortable-list-add .sortable-list-input').type('test/first-model');
      modelsSection().find('.sortable-list-add-btn').click();
      modelsSection().find('.sortable-list-item').should('have.length', initialCount + 1);

      // Add second model
      modelsSection().find('.sortable-list-add .sortable-list-input').type('test/second-model');
      modelsSection().find('.sortable-list-add-btn').click();
      modelsSection().find('.sortable-list-item').should('have.length', initialCount + 2);

      // Both should be present as input values
      modelsSection().find('.sortable-list-item').eq(initialCount).find('.sortable-list-input').should('have.value', 'test/first-model');
      modelsSection().find('.sortable-list-item').eq(initialCount + 1).find('.sortable-list-input').should('have.value', 'test/second-model');
    });
  });

  it('can remove a model from the list', () => {
    openSettings();

    // Net-zero mutation: add a fixture model, then remove exactly that one —
    // the shared env's enabled-models list must be unchanged by this spec.
    modelsSection().find('.sortable-list-item', { timeout: 5000 }).then(($items) => {
      const initialCount = $items.length;
      modelsSection().find('.sortable-list-add .sortable-list-input').type('test/removable-model');
      modelsSection().find('.sortable-list-add-btn').click();
      modelsSection().find('.sortable-list-item').should('have.length', initialCount + 1);

      // The new item is appended last (its name lives in the input's value,
      // not text — so locate by position, not by content)
      modelsSection().find('.sortable-list-item').last()
        .find('.sortable-list-input').should('have.value', 'test/removable-model');
      modelsSection().find('.sortable-list-item').last().find('.sortable-list-remove').click();
      modelsSection().find('.sortable-list-item').should('have.length', initialCount);
    });
  });

  it('can focus and interact with model entry inputs', () => {
    openSettings();

    cy.get('.sortable-list-item', { timeout: 5000 }).should('have.length.greaterThan', 0);

    // Model entry inputs should be focusable and editable
    cy.get('.sortable-list-item').first().find('.sortable-list-input').should('not.be.disabled');
    cy.get('.sortable-list-item').first().find('.sortable-list-input').focus();
    cy.get('.sortable-list-item').first().find('.sortable-list-input').should('have.focus');
  });

  it('prevents adding duplicate models', () => {
    openSettings();

    modelsSection().find('.sortable-list-item', { timeout: 5000 }).should('have.length.greaterThan', 0);

    // Get the first model name and initial count, then try adding duplicate
    modelsSection().find('.sortable-list-item').first().find('.sortable-list-input').invoke('val').then((existingName) => {
      modelsSection().find('.sortable-list-item').its('length').then((initialCount) => {
        // Try to add the same name (wait for the button to enable — a
        // transient SSE-driven remount can clear the input mid-type)
        modelsSection().find('.sortable-list-add .sortable-list-input').type(String(existingName));
        modelsSection().find('.sortable-list-add-btn').should('not.be.disabled');
        modelsSection().find('.sortable-list-add-btn').click();

        // Should NOT add a duplicate — count stays the same
        modelsSection().find('.sortable-list-item').should('have.length', initialCount);
      });
    });
  });

  it('toggle fields work correctly', () => {
    openSettings();

    cy.get('.settings-toggle', { timeout: 5000 }).should('exist');

    // Find the first toggle and verify it toggles
    cy.get('.settings-toggle input[type="checkbox"]').first().check({ force: true }).should('be.checked');
    cy.get('.settings-toggle input[type="checkbox"]').first().uncheck({ force: true }).should('not.be.checked');
  });

  it('save button is visible', () => {
    openSettings();
    // Floating save action only appears while there are unsaved changes
    cy.get('input.settings-input').first().click().type('x');
    cy.get('.settings-save-float .btn-primary').should('contain', 'Save Settings');
  });

  it('Sessions view button opens the sessions page', () => {
    cy.get('.view-btn-sessions').click();
    cy.get('.sessions-page').should('be.visible');
  });

  it('settings view replaces the chat card', () => {
    openSettings();
    cy.get('.settings-card').should('exist');
    cy.get('.stream-card').should('not.exist');
  });
});
