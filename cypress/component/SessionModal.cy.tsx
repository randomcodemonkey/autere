import React from 'react';
import { SessionModal } from '../../src/frontend/components/SessionModal';
import type { SessionInfo } from '../../src/frontend/types';

describe('SessionModal', () => {
  const mockSessions: SessionInfo[] = [
    {
      id: 'session-123',
      sessionFile: '/path/to/session.jsonl',
      sessionName: 'Test Session',
      parentSession: null,
      createdAt: Date.now() - 3600000,
      lastActivity: Date.now() - 60000,
      cwd: null,
    },
    {
      id: 'session-456',
      sessionFile: '/path/to/other.jsonl',
      sessionName: null,
      parentSession: 'session-123',
      createdAt: Date.now() - 7200000,
      lastActivity: Date.now() - 3600000,
      cwd: null,
    },
  ];

  beforeEach(() => {
    cy.intercept('GET', '/api/sessions', { success: true, data: mockSessions }).as('getSessions');
    cy.intercept('POST', '/api/session-name', { success: true }).as('setSessionName');
    cy.intercept('POST', '/api/compact', { success: true }).as('compact');
    cy.intercept('POST', '/api/abort', { success: true }).as('abort');
  });

  it('renders when open', () => {
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.get('.modal-overlay').should('have.class', 'open');
    cy.get('.modal-header h3').should('contain', 'Session');
  });

  it('shows current session info', () => {
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.get('.session-current-id').should('contain', 'session-123');
    cy.get('.session-name-input').should('have.value', 'Test Session');
  });

  it('lists available sessions', () => {
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.get('.session-item').should('have.length', 2);
    cy.get('.session-item-name').eq(0).should('contain', 'Test Session');
    cy.get('.session-item-name').eq(1).should('contain', 'session-456');
  });

  it('highlights current session', () => {
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.get('.session-item').eq(0).should('have.class', 'active');
  });

  it('calls onSwitchSession when different session is clicked', () => {
    const onSwitchSession = cy.stub().as('onSwitchSession');
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={onSwitchSession}
      />
    );
    cy.wait('@getSessions');
    cy.get('.session-item').eq(1).click();
    cy.get('@onSwitchSession').should('have.been.calledOnce');
    cy.get('@onSwitchSession').should('be.calledWith', 'session-456');
  });

  it('does not call onSwitchSession when current session is clicked', () => {
    const onSwitchSession = cy.stub().as('onSwitchSession');
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={onSwitchSession}
      />
    );
    cy.wait('@getSessions');
    cy.get('.session-item').eq(0).click();
    cy.get('@onSwitchSession').should('not.have.been.called');
  });

  it('calls onNewSession when new session button is clicked', () => {
    const onNewSession = cy.stub().as('onNewSession');
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={onNewSession}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.contains('New Session').click();
    cy.get('@onNewSession').should('have.been.calledOnce');
  });

  it('calls onAbort when abort button is clicked', () => {
    const onAbort = cy.stub().as('onAbort');
    cy.mount(
      <SessionModal
        open={true}
        statusType="streaming"
        text="Working"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={onAbort}
        onNewSession={cy.stub()}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.contains('Abort Operation').click();
    cy.get('@onAbort').should('have.been.calledOnce');
  });

  it('shows abort button only when streaming', () => {
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.contains('Abort Operation').should('not.be.visible');
  });

  it('calls set-session-name API when name is saved', () => {
    cy.mount(
      <SessionModal
        open={true}
        statusType="connected"
        text="Idle"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.get('.session-name-input').clear().type('New Name');
    cy.get('.session-name-save').click();
    cy.wait('@setSessionName').its('request.body').should('deep.equal', {
      name: 'New Name',
    });
  });

  it('disables session switching when active', () => {
    cy.mount(
      <SessionModal
        open={true}
        statusType="streaming"
        text="Working"
        currentSessionId="session-123"
        currentSessionName="Test Session"
        isActive={true}
        onClose={cy.stub()}
        onAbort={cy.stub()}
        onNewSession={cy.stub()}
        onSwitchSession={cy.stub()}
      />
    );
    cy.wait('@getSessions');
    cy.get('.session-item').eq(1).should('have.class', 'disabled');
  });
});
