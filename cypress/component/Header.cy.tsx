import React from 'react';
import { Header } from '../../src/frontend/components/Header';

describe('Header', () => {
  it('renders with session name when provided', () => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        onStatusClick={cy.stub()}
        sessionId="abc123"
        sessionName="My Session"
        onSessionClick={cy.stub()}
      />
    );
    cy.get('.session-badge-text').should('contain', 'My Session');
  });

  it('renders truncated session name when too long', () => {
    const longName = 'A'.repeat(100);
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        onStatusClick={cy.stub()}
        sessionId="abc123"
        sessionName={longName}
        onSessionClick={cy.stub()}
      />
    );
    cy.get('.session-badge-text').should('contain', '…');
  });

  it('renders truncated session ID when no name', () => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        onStatusClick={cy.stub()}
        sessionId="abc123-def456"
        sessionName={null}
        onSessionClick={cy.stub()}
      />
    );
    cy.get('.session-badge-text').should('contain', 'abc123…');
  });

  it('renders "session" when no ID or name', () => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        onStatusClick={cy.stub()}
        sessionId={null}
        sessionName={null}
        onSessionClick={cy.stub()}
      />
    );
    cy.get('.session-badge-text').should('contain', 'session');
  });

  it('calls onStatusClick when status badge is clicked', () => {
    const onStatusClick = cy.stub().as('onStatusClick');
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        onStatusClick={onStatusClick}
        sessionId="abc123"
        sessionName="Test"
        onSessionClick={cy.stub()}
      />
    );
    cy.get('.status-badge').click({ force: true });
    cy.get('@onStatusClick').should('have.been.calledOnce');
  });

  it('calls onSessionClick when session badge is clicked', () => {
    const onSessionClick = cy.stub().as('onSessionClick');
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        onStatusClick={cy.stub()}
        sessionId="abc123"
        sessionName="Test"
        onSessionClick={onSessionClick}
      />
    );
    cy.get('.session-badge').click();
    cy.get('@onSessionClick').should('have.been.calledOnce');
  });

  it('session badge is clickable when isActive', () => {
    const onSessionClick = cy.stub().as('onSessionClick');
    cy.mount(
      <Header
        statusType="streaming"
        statusText="Working"
        onStatusClick={cy.stub()}
        sessionId="abc123"
        sessionName="Test"
        onSessionClick={onSessionClick}
        isActive={true}
      />
    );
    cy.get('.session-badge').should('not.have.class', 'disabled');
    cy.get('.session-badge').click();
    cy.get('@onSessionClick').should('have.been.calledOnce');
  });

  it('shows disconnected header styling', () => {
    cy.mount(
      <Header
        statusType="disconnected"
        statusText="Disconnected"
        onStatusClick={cy.stub()}
        sessionId="abc123"
        sessionName="Test"
        onSessionClick={cy.stub()}
      />
    );
    cy.get('.header').should('have.class', 'header-disconnected');
  });

  it('shows external activity styling', () => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        onStatusClick={cy.stub()}
        sessionId="abc123"
        sessionName="Test"
        onSessionClick={cy.stub()}
        externalActivity={true}
      />
    );
    cy.get('.header').should('have.class', 'header-external');
  });
});
