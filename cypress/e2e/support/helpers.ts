/**
 * Shared helpers for the e2e specs. Each spec file is an independent group —
 * the helpers keep page-interaction boilerplate out of the specs.
 */

/** Wait for the backend (started by run-e2e.ts on a random port) to be up. */
export function waitForBackend(): void {
  cy.request({ url: '/api/v1/session/state', retryOnStatusCodeFailure: true, timeout: 5000 })
    .its('status').should('eq', 200);
}

/** Warm up a COLD backend: the first visit triggers RootRedirect → new
 *  session → pi spawn. Call in a spec's before() so the first test's
 *  short-timeout assertions don't race the spawn. */
export function warmUpSession(): void {
  cy.visit('/');
  cy.get('.chat-input', { timeout: 30000 }).should('exist');
}

/** Open the settings view via the header view menu. */
export function openSettings(): void {
  cy.get('.view-btn-settings').click();
  cy.get('.settings-card').should('be.visible');
}

/** Open a specific settings section via the side menu (one section renders
 *  at a time). Desktop viewport assumed (menu buttons hidden on mobile). */
export function openSettingsSection(label: string): void {
  openSettings();
  cy.get('.settings-menu-btn', { timeout: 5000 }).contains(label).click();
}

/** Scope to the Models section — the settings page has TWO sortable lists. */
export function modelsSection(): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.get('.settings-section:has(.settings-section-title:contains("Models"))');
}

/** Open the Models settings section and return its scope. */
export function openModelsSection(): Cypress.Chainable<JQuery<HTMLElement>> {
  openSettingsSection('Models');
  return modelsSection().should('be.visible');
}

/** Open the sessions page via the header view menu. */
export function openSessionsModal(): void {
  cy.get('.view-btn-sessions', { timeout: 5000 }).click();
  cy.get('.sessions-page', { timeout: 5000 }).should('be.visible');
}

/** Write a minimal idle session jsonl into the e2e env (no pi spawn). */
export function seedIdleSession(name: string): Cypress.Chainable<string> {
  const id = `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return cy.task('seedSession', { id, name }).should('eq', true).then(() => id);
}
