describe('Status Card collapse', () => {
  before(() => {
    cy.request({ url: '/api/state', retryOnStatusCodeFailure: true, timeout: 30000 })
      .its('status').should('eq', 200);
  });

  beforeEach(() => {
    cy.visit('/');
    cy.get('#main-app', { timeout: 20000 }).should('exist');
  });

  it('session card collapses and expands via header click', () => {
    cy.get('.status-card-session', { timeout: 15000 }).should('exist');

    // Collapse: body hidden
    cy.get('.status-card-session .card-header').click();
    cy.get('.status-card-session').should('have.class', 'collapsed');
    cy.get('.status-card-session .status-card-body').should('not.be.visible');

    // Expand: body visible again
    cy.get('.status-card-session .card-header').click();
    cy.get('.status-card-session').should('not.have.class', 'collapsed');
    cy.get('.status-card-session .status-card-body').should('be.visible');

    // Persisted: reload keeps the collapsed preference
    cy.get('.status-card-session .card-header').click();
    cy.get('.status-card-session').should('have.class', 'collapsed');
    cy.reload();
    cy.get('.status-card-session', { timeout: 15000 }).should('have.class', 'collapsed');
    // restore for other tests
    cy.get('.status-card-session .card-header').click();
    cy.get('.status-card-session').should('not.have.class', 'collapsed');
  });
});
