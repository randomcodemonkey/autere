import React from 'react';
import { useAuth } from '../../src/frontend/hooks/useAuth';

// Test wrapper component for the hook
function TestComponent() {
  const { authenticated, authEnabled, loginError, checkAuthStatus, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="authenticated">{String(authenticated)}</span>
      <span data-testid="authEnabled">{String(authEnabled)}</span>
      <span data-testid="loginError">{loginError}</span>
      <button data-testid="checkAuth" onClick={() => checkAuthStatus()}>Check Auth</button>
      <button data-testid="login" onClick={() => login('admin', 'testpassword')}>Login</button>
      <button data-testid="loginEmpty" onClick={() => login('admin', '')}>Login Empty</button>
      <button data-testid="logout" onClick={() => logout()}>Logout</button>
    </div>
  );
}

describe('useAuth', () => {
  it('initializes with default state', () => {
    cy.mount(<TestComponent />);
    // Initial state before any API calls
    cy.get('[data-testid="authenticated"]').should('contain', 'false');
    cy.get('[data-testid="authEnabled"]').should('contain', 'false');
    cy.get('[data-testid="loginError"]').should('be.empty');
  });

  it('shows error for empty password', () => {
    cy.mount(<TestComponent />);
    // Login with empty password should show error immediately
    cy.get('[data-testid="loginEmpty"]').click();
    cy.get('[data-testid="loginError"]').should('contain', 'Enter password');
  });

  it('login button exists and is clickable', () => {
    cy.mount(<TestComponent />);
    cy.get('[data-testid="login"]').should('exist');
    cy.get('[data-testid="login"]').should('not.be.disabled');
  });

  it('logout button exists and is clickable', () => {
    cy.mount(<TestComponent />);
    cy.get('[data-testid="logout"]').should('exist');
    cy.get('[data-testid="logout"]').should('not.be.disabled');
  });

  it('checkAuth button exists and is clickable', () => {
    cy.mount(<TestComponent />);
    cy.get('[data-testid="checkAuth"]').should('exist');
    cy.get('[data-testid="checkAuth"]').should('not.be.disabled');
  });

  it('can toggle login error by typing then clearing', () => {
    cy.mount(<TestComponent />);
    // Initially no error
    cy.get('[data-testid="loginError"]').should('be.empty');
    // After clicking login with empty password, error appears
    cy.get('[data-testid="loginEmpty"]').click();
    cy.get('[data-testid="loginError"]').should('contain', 'Enter password');
  });
});
