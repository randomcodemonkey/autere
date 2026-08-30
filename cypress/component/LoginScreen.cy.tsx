import React from 'react';
import { LoginScreen } from '../../src/frontend/components/LoginScreen';

describe('LoginScreen', () => {
  it('renders login form when open', () => {
    cy.mount(<LoginScreen open={true} error="" onLogin={cy.stub().resolves(true)} />);
    cy.get('.login-screen').should('have.class', 'open');
    cy.get('.login-title').should('contain', 'autere');
    cy.get('.login-input').should('exist');
    cy.get('.login-btn').should('contain', 'Login');
  });

  it('is hidden when not open', () => {
    cy.mount(<LoginScreen open={false} error="" onLogin={cy.stub().resolves(true)} />);
    cy.get('.login-screen').should('not.have.class', 'open');
  });

  it('calls onLogin with password when form is submitted', () => {
    const onLogin = cy.stub().resolves(true).as('onLogin');
    cy.mount(<LoginScreen open={true} error="" onLogin={onLogin} />);
    cy.get('.login-input').type('testpassword');
    cy.get('.login-btn').click();
    cy.get('@onLogin').should('have.been.calledOnce');
    cy.get('@onLogin').should('be.calledWith', 'testpassword');
  });

  it('shows error message when provided', () => {
    cy.mount(<LoginScreen open={true} error="Invalid password" onLogin={cy.stub().resolves(false)} />);
    cy.get('.login-error').should('contain', 'Invalid password');
    cy.get('.login-error').should('have.class', 'visible');
  });

  it('clears password input after successful login', () => {
    cy.mount(<LoginScreen open={true} error="" onLogin={cy.stub().resolves(true)} />);
    cy.get('.login-input').type('testpassword');
    cy.get('.login-btn').click();
    cy.get('.login-input').should('have.value', '');
  });

  it('does not clear password input after failed login', () => {
    cy.mount(<LoginScreen open={true} error="" onLogin={cy.stub().resolves(false)} />);
    cy.get('.login-input').type('wrongpassword');
    cy.get('.login-btn').click();
    cy.get('.login-input').should('have.value', 'wrongpassword');
  });

  it('focuses password input on mount', () => {
    cy.mount(<LoginScreen open={true} error="" onLogin={cy.stub().resolves(true)} />);
    cy.get('.login-input').should('be.focused');
  });

  it('submits form on Enter key', () => {
    const onLogin = cy.stub().resolves(true).as('onLogin');
    cy.mount(<LoginScreen open={true} error="" onLogin={onLogin} />);
    cy.get('.login-input').type('testpassword{enter}');
    cy.get('@onLogin').should('have.been.calledOnce');
  });
});
