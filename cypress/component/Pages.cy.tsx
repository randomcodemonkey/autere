import React from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { NotFound } from '../../src/frontend/pages/NotFound';
import { RootRedirect } from '../../src/frontend/pages/RootRedirect';

// MemoryRouter doesn't touch the browser address bar — render the current
// path into the DOM so tests can assert navigation.
const LocationProbe = () => <div data-cy="location">{useLocation().pathname}</div>;

function renderAt(path: string, children: React.ReactNode) {
  cy.mount(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<>{children}<LocationProbe /></>} />
        <Route path="/session/:sessionId" element={<><div data-cy="session-page">session page</div><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('NotFound', () => {
  it('shows the 404 message', () => {
    renderAt('/whatever', <NotFound />);
    cy.get('.card-title').should('contain', '404 — Not Found');
    cy.get('#main-app').should('exist');
  });

  it('navigates home via the Go Home button', () => {
    renderAt('/whatever', <NotFound />);
    cy.contains('button', 'Go Home').click();
    cy.get('[data-cy="location"]').should('have.text', '/');
  });
});

describe('RootRedirect', () => {
  it('shows a loading indicator while resolving sessions', () => {
    cy.intercept('GET', '**/api/v1/sessions', () => new Promise(() => {})).as('sessions'); // never resolves
    renderAt('/', <RootRedirect />);
    cy.contains('Loading…').should('exist');
  });

  it('redirects to the most recent session', () => {
    cy.intercept('GET', '**/api/v1/sessions', {
      success: true,
      data: [{ id: 'session-abc' }, { id: 'session-def' }],
    }).as('sessions');
    renderAt('/', <RootRedirect />);
    cy.get('[data-cy="session-page"]').should('exist');
    cy.get('[data-cy="location"]').should('have.text', '/session/session-abc');
  });

  it('navigates to the newly created session when no sessions exist', () => {
    cy.intercept('GET', '**/api/v1/sessions', { success: true, data: [] }).as('sessions');
    cy.intercept('POST', '**/api/v1/sessions', {
      success: true,
      navigateUrl: '/session/new-session-1',
    }).as('newSession');
    renderAt('/', <RootRedirect />);
    cy.wait('@sessions');
    cy.wait('@newSession');
    cy.get('[data-cy="location"]').should('have.text', '/session/new-session-1');
  });

  it('lands on the synthetic no-session view when session creation fails', () => {
    cy.intercept('GET', '**/api/v1/sessions', { success: true, data: [] }).as('sessions');
    cy.intercept('POST', '**/api/v1/sessions', {
      statusCode: 503,
      body: { success: false, error: 'Failed to create session: docker socket not available' },
    }).as('newSession');
    renderAt('/', <RootRedirect />);
    cy.wait('@sessions');
    cy.wait('@newSession');
    // App must stay usable: land on the synthetic '-' route (error surfaces
    // via AppPage's modal in the real app), not a dead-end error page.
    cy.get('[data-cy="session-page"]').should('exist');
    cy.get('[data-cy="location"]').should('have.text', '/session/-');
  });

  it('lands on the synthetic no-session view when the sessions fetch fails', () => {
    cy.intercept('GET', '**/api/v1/sessions', { statusCode: 500, body: 'error' }).as('sessions');
    renderAt('/', <RootRedirect />);
    cy.wait('@sessions');
    cy.get('[data-cy="session-page"]').should('exist');
    cy.get('[data-cy="location"]').should('have.text', '/session/-');
  });
});
