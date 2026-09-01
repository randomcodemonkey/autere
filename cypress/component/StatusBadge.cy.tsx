import React from 'react';
import { StatusBadge } from '../../src/frontend/components/StatusBadge';

describe('StatusBadge', () => {
  it('renders connected status with green dot', () => {
    cy.mount(<StatusBadge status="connected" text="Idle" />);
    cy.get('.status-badge').should('contain', 'Idle');
    cy.get('.dot-green').should('exist');
  });

  it('renders streaming status with yellow dot', () => {
    cy.mount(<StatusBadge status="streaming" text="Working" />);
    cy.get('.status-badge').should('contain', 'Working');
    cy.get('.dot-yellow').should('exist');
  });

  it('renders disconnected status with red dot', () => {
    cy.mount(<StatusBadge status="disconnected" text="Disconnected" />);
    cy.get('.status-badge').should('contain', 'Disconnected');
    cy.get('.dot-red').should('exist');
  });

  it('shows working-external indicator', () => {
    cy.mount(<StatusBadge status="connected" text="Idle" workingExternal={true} />);
    cy.get('.status-badge').should('contain', 'Working (external)');
    cy.get('.dot-pulse-amber').should('exist');
  });

  it('calls onClick when clicked', () => {
    const onClick = cy.stub().as('onClick');
    cy.mount(<StatusBadge status="connected" text="Idle" onClick={onClick} />);
    cy.get('.status-badge').click();
    cy.get('@onClick').should('have.been.calledOnce');
  });

  it('has correct CSS class for status', () => {
    cy.mount(<StatusBadge status="connected" text="Idle" />);
    cy.get('.status-badge').should('have.class', 'status-connected');
  });
});
