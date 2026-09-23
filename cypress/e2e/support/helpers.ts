/**
 * Shared helpers for the e2e specs. Each spec file is an independent group —
 * the helpers keep page-interaction boilerplate out of the specs.
 */

/** Wait for the backend (started by run-e2e.ts on a random port) to be up. */
export function waitForBackend(): void {
  cy.request({ url: '/api/state', retryOnStatusCodeFailure: true, timeout: 5000 })
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

/** Scope to the Models section — the settings page has TWO sortable lists. */
export function modelsSection(): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.get('.settings-section:has(.settings-section-title:contains("Models"))');
}

/** Open the sessions modal, retrying when a freshly-opened modal closes
 *  itself (rare headless-browser race). Fails for real if it never opens. */
export function openSessionsModal(): void {
  cy.get('body').then(($body) => {
    const modalVisible = $body.find('.modal-session.open, .modal-overlay.open .modal-session').length > 0
      && $body.find('.modal-session').is(':visible');
    if (!modalVisible) {
      cy.get('.session-badge').click();
    }
  });
  cy.get('.modal-session', { timeout: 5000 }).should('be.visible');
}

/** Write a minimal idle session jsonl into the e2e env (no pi spawn). */
export function seedIdleSession(name: string): Cypress.Chainable<string> {
  const id = `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return cy.task('seedSession', { id, name }).should('eq', true).then(() => id);
}
