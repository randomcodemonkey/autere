import React from 'react';
import { Header } from '../../src/frontend/components/Header';

describe('Header', () => {
  const mountHeader = (props: Partial<Parameters<typeof Header>[0]> = {}) => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        sessionId="abc123"
        sessionName={null}
        activeView="chat"
        onViewChange={cy.stub()}
        {...props}
      />
    );
  };

  it('renders with session name when provided', () => {
    mountHeader({ sessionName: 'My Session' });
    cy.get('.session-badge-text').should('contain', 'My Session');
  });

  it('renders truncated session name when too long', () => {
    mountHeader({ sessionName: 'A'.repeat(100) });
    cy.get('.session-badge-text').should('contain', '…');
  });

  it('renders truncated session ID when no name', () => {
    mountHeader({ sessionId: 'abc123-def456', sessionName: null });
    cy.get('.session-badge-text').should('contain', 'abc123…');
  });

  it('renders "session" when no ID or name', () => {
    mountHeader({ sessionId: null, sessionName: null });
    cy.get('.session-badge-text').should('contain', 'session');
  });

  it('renders the view menu with all three views', () => {
    mountHeader();
    cy.get('.view-menu').should('exist');
    cy.get('.view-btn-status').should('contain', 'Status');
    cy.get('.view-btn-chat').should('contain', 'Chat');
    cy.get('.view-btn-settings').should('contain', 'Settings');
  });

  it('highlights the active view', () => {
    mountHeader({ activeView: 'settings' });
    cy.get('.view-btn-settings').should('have.class', 'active');
    cy.get('.view-btn-chat').should('not.have.class', 'active');
  });

  it('calls onViewChange when a view button is clicked', () => {
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader({ onViewChange });
    cy.get('.view-btn-settings').click();
    cy.get('@onViewChange').should('have.been.calledWith', 'settings');
  });

  it('hamburger dropdown shows the active view as its label', () => {
    mountHeader({ activeView: 'settings' });
    cy.get('.view-menu-label').should('contain', 'Settings');
    mountHeader({ activeView: 'chat' });
    cy.get('.view-menu-label').should('contain', 'Chat');
  });

  it('hamburger dropdown opens and selects a view', () => {
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader({ onViewChange });
    cy.get('.view-menu-dropdown').should('not.exist');
    cy.get('.view-menu-toggle').click({ force: true });
    cy.get('.view-menu-dropdown').should('exist');
    cy.get('.view-menu-item').should('have.length', 3);
    cy.get('.view-menu-item.active').should('contain', 'Chat');
    cy.get('.view-menu-item').contains('Status').click({ force: true });
    cy.get('@onViewChange').should('have.been.calledWith', 'status');
    cy.get('.view-menu-dropdown').should('not.exist');
  });

  it('calls onViewChange("status") when the combined badge is clicked', () => {
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader({ onViewChange });
    cy.get('.session-badge.status-connected').click({ force: true });
    cy.get('@onViewChange').should('have.been.calledWith', 'status');
  });

  it('combined badge carries the status colour class', () => {
    mountHeader({ statusType: 'streaming', statusText: 'Working' });
    cy.get('.session-badge.status-streaming').should('exist');
    cy.get('.session-badge .connection-dot.dot-yellow').should('exist');
    mountHeader({ workingExternal: true });
    cy.get('.session-badge.status-external .dot-pulse-amber').should('exist');
  });

  it('calls onViewChange("status") when session badge is clicked', () => {
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader({ onViewChange });
    cy.get('.session-badge').click();
    cy.get('@onViewChange').should('have.been.calledWith', 'status');
  });

  it('session badge is clickable when isActive', () => {
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader({ onViewChange, isActive: true });
    cy.get('.session-badge').should('not.have.class', 'disabled');
    cy.get('.session-badge').click();
    cy.get('@onViewChange').should('have.been.calledWith', 'status');
  });

  it('shows disconnected header styling', () => {
    mountHeader({ statusType: 'disconnected', statusText: 'Disconnected' });
    cy.get('.header').should('have.class', 'header-disconnected');
  });

  it('shows external activity styling', () => {
    mountHeader({ workingExternal: true });
    cy.get('.header').should('have.class', 'header-external');
  });
});
