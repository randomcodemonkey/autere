import React from 'react';
import { StatusModal } from '../../src/frontend/components/StatusModal';

describe('StatusModal', () => {
  it('renders when open', () => {
    cy.mount(
      <StatusModal
        open={true}
        statusType="connected"
        text="Idle"
        onClose={cy.stub()}
        onRestart={cy.stub()}
        onLogout={cy.stub()}
      />
    );
    cy.get('.modal-overlay').should('have.class', 'open');
    cy.get('.modal-header h3').should('contain', 'Status');
  });

  it('shows connection status', () => {
    cy.mount(
      <StatusModal
        open={true}
        statusType="connected"
        statusText="Idle"
        onClose={cy.stub()}
        onRestart={cy.stub()}
        onLogout={cy.stub()}
      />
    );
    cy.get('.modal-status-text').should('contain', 'Idle');
    cy.get('.dot-green').should('exist');
  });

  it('shows red dot for disconnected', () => {
    cy.mount(
      <StatusModal
        open={true}
        statusType="disconnected"
        statusText="Disconnected"
        onClose={cy.stub()}
        onRestart={cy.stub()}
        onLogout={cy.stub()}
      />
    );
    cy.get('.dot-red').should('exist');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = cy.stub().as('onClose');
    cy.mount(
      <StatusModal
        open={true}
        statusType="connected"
        statusText="Idle"
        onClose={onClose}
        onRestart={cy.stub()}
        onLogout={cy.stub()}
      />
    );
    cy.get('.modal-close').click();
    cy.get('@onClose').should('have.been.calledOnce');
  });

  it('calls onRestart when restart button is clicked', () => {
    const onRestart = cy.stub().as('onRestart');
    cy.mount(
      <StatusModal
        open={true}
        statusType="connected"
        statusText="Idle"
        onClose={cy.stub()}
        onRestart={onRestart}
        onLogout={cy.stub()}
      />
    );
    cy.get('.btn-danger').click();
    cy.get('@onRestart').should('have.been.calledOnce');
  });

  it('calls onLogout when logout button is clicked', () => {
    const onLogout = cy.stub().as('onLogout');
    cy.mount(
      <StatusModal
        open={true}
        statusType="connected"
        statusText="Idle"
        onClose={cy.stub()}
        onRestart={cy.stub()}
        onLogout={onLogout}
      />
    );
    cy.get('.btn-default').click();
    cy.get('@onLogout').should('have.been.calledOnce');
  });

  it('shows restarting state on restart button', () => {
    cy.mount(
      <StatusModal
        open={true}
        statusType="connected"
        statusText="Idle"
        onClose={cy.stub()}
        onRestart={cy.stub()}
        onLogout={cy.stub()}
        restarting={true}
      />
    );
    cy.get('.btn-danger').should('contain', 'Restarting…');
    cy.get('.btn-danger').should('be.disabled');
  });
});
