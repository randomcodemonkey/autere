import React from 'react';
import { LoginScreen } from '../../src/frontend/components/LoginScreen';

describe('LoginScreen', () => {
  it('renders login form when open', () => {
    cy.mount(<LoginScreen open={true} error="" onLogin={cy.stub().resolves(true)} />);
    cy.get('.login-screen').should('have.class', 'open');
    cy.get('.login-title').should('contain', 'autere');
    cy.get('.login-input').should('have.length', 2);
    cy.get('.login-btn').should('contain', 'Login');
  });

  it('is hidden when not open', () => {
    cy.mount(<LoginScreen open={false} error="" onLogin={cy.stub().resolves(true)} />);
    cy.get('.login-screen').should('not.have.class', 'open');
  });

  it('calls onLogin with user and password when form is submitted', () => {
    const onLogin = cy.stub().resolves(true);
    cy.wrap(onLogin).as('onLogin');
    cy.mount(<LoginScreen open={true} error="" onLogin={onLogin} />);
    cy.get('.login-input').eq(0).clear().type('admin');
    cy.get('.login-input').eq(1).type('testpassword');
    cy.get('.login-btn').click();
    cy.get('@onLogin').should('have.been.calledOnce');
    cy.get('@onLogin').should('be.calledWith', 'admin', 'testpassword');
  });

  it('shows error message when provided', () => {
    cy.mount(<LoginScreen open={true} error="Invalid password" onLogin={cy.stub().resolves(false)} />);
    cy.get('.login-error').should('contain', 'Invalid password');
    cy.get('.login-error').should('have.class', 'visible');
  });

  it('clears password input after successful login', () => {
    cy.mount(<LoginScreen open={true} error="" onLogin={cy.stub().resolves(true)} />);
    cy.get('.login-input').eq(1).type('testpassword');
    cy.get('.login-btn').click();
    cy.get('.login-input').eq(1).should('have.value', '');
  });

  it('does not clear password input after failed login', () => {
    cy.mount(<LoginScreen open={true} error="" onLogin={cy.stub().resolves(false)} />);
    cy.get('.login-input').eq(1).type('wrongpassword');
    cy.get('.login-btn').click();
    cy.get('.login-input').eq(1).should('have.value', 'wrongpassword');
  });

  it('focuses username input on mount', () => {
    cy.mount(<LoginScreen open={true} error="" onLogin={cy.stub().resolves(true)} />);
    cy.get('.login-input').eq(0).should('be.focused');
  });

  it('submits form on Enter key', () => {
    const onLogin = cy.stub().resolves(true);
    cy.wrap(onLogin).as('onLogin');
    cy.mount(<LoginScreen open={true} error="" onLogin={onLogin} />);
    cy.get('.login-input').eq(1).type('testpassword{enter}');
    cy.get('@onLogin').should('have.been.calledOnce');
  });
});
