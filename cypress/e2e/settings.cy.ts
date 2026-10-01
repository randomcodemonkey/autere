/**
 * Settings page e2e — no model turns. Mutates the enabled-models list
 * (add/remove); the mutations net out like they did in the monolith.
 */

import { waitForBackend, warmUpSession, openSettings, openSettingsSection, openModelsSection, modelsSection } from './support/helpers';

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

  it('shows Models section with the catalog table', () => {
    openModelsSection();
    cy.get('.settings-section-title').contains('Models').should('exist');
    modelsSection().find('.models-table', { timeout: 60000 }).should('exist');
    modelsSection().find('.models-table tbody tr', { timeout: 60000 }).should('have.length.greaterThan', 0);
  });

  it('models table: Update re-reads the full pi model catalog', () => {
    openModelsSection();
    // Auto-loaded on open (from pi via the backend); Update re-reads it
    modelsSection().find('.models-table tbody tr', { timeout: 60000 }).should('have.length.greaterThan', 0);
    modelsSection().contains('button', 'Update', { timeout: 5000 }).click();
    modelsSection().find('.models-table tbody tr', { timeout: 60000 }).should('have.length.greaterThan', 0);
    // Columns match the requested per-model controls
    modelsSection().find('.models-table thead th').eq(1).should('contain', 'Enabled');
    modelsSection().find('.models-table thead th').eq(2).should('contain', 'Thinking level');
    modelsSection().find('.models-table thead th').eq(3).should('contain', 'Reserved context');
    modelsSection().find('.models-table thead th').eq(4).should('contain', 'Image mode');
  });

  it('shows 9Router section if extension is enabled', () => {
    openSettings();
    cy.get('.settings-section-title', { timeout: 5000 }).contains('9Router').should('exist');
  });

  it('toggle fields work correctly', () => {
    // Toggles live in the Chat section; the default section (Sandbox) has
    // only a text field, and Images only exists when pi-images is installed.
    openSettingsSection('Chat');

    cy.get('.settings-toggle', { timeout: 5000 }).should('exist');

    // Find the first toggle and verify it toggles
    cy.get('.settings-toggle input[type="checkbox"]').first().check({ force: true }).should('be.checked');
    cy.get('.settings-toggle input[type="checkbox"]').first().uncheck({ force: true }).should('not.be.checked');
  });

  it('save button is visible', () => {
    openSettingsSection('9Router');
    // Save action only appears while there are unsaved changes
    cy.get('input.settings-input').first().click().type('x');
    cy.get('.settings-save-btn', { timeout: 5000 }).should('contain', 'Save Settings');
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
