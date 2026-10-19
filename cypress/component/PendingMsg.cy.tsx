import React, { useState } from 'react';
import { StreamCard } from '../../src/frontend/components/StreamCard';
import type { StreamMessage } from '../../src/frontend/types';

// Harness mimicking DashboardPage's optimistic flow: onSent adds a pending
// message; calling the exposed "retire" window function simulates the
// backend broadcast arriving with the same text.
function Harness() {
  const [history, setHistory] = useState<StreamMessage[]>([]);
  const [pending, setPending] = useState<StreamMessage[]>([]);
  const [sessionId, setSessionId] = useState('session-a');
  (window as any).__retire = (text: string) => {
    setHistory((prev) => [...prev, { role: 'user', text, streaming: false }]);
    setPending((prev) => prev.filter((p) => p.text !== text));
  };
  return (
    <>
      <button data-cy="switch-session" onClick={() => setSessionId('session-b')}>Switch session</button>
      <button data-cy="switch-back" onClick={() => setSessionId('session-a')}>Switch back</button>
      <div data-cy="active-session">{sessionId}</div>
      <StreamCard
        messages={[...history, ...pending.filter((p) => p.pendingSessionId === sessionId)]}
        isStreaming={false}
        onNewSession={cy.stub()}
        onSent={(text, _type, pendingSessionId) => setPending((prev) => [...prev, { role: 'user', text, streaming: false, pending: true, pendingSessionId }])}
        sessionId={sessionId}
      />
    </>
  );
}

describe('Optimistic pending user message', () => {
  it('appears immediately with a pending indicator, then is replaced by the broadcast copy', () => {
    cy.mount(<Harness />);
    cy.intercept('POST', '**/api/v1/session/messages', { success: true }).as('send');
    cy.get('.chat-input').focus().type('hello world');
    cy.get('.chat-send-btn').click();
    cy.wait('@send');
    // Optimistic copy appears right away with the pending indicator
    cy.get('.stream-msg-pending').should('contain.text', 'hello world');
    cy.get('.stream-pending-indicator').should('exist');
    cy.get('.stream-msg').should('have.length', 1);
    // Backend broadcast arrives → pending copy retired, real one stays
    cy.window().then((w) => (w as any).__retire('hello world'));
    cy.get('.stream-msg-pending').should('not.exist');
    cy.get('.stream-pending-indicator').should('not.exist');
    cy.get('.stream-msg').should('have.length', 1);
    cy.get('.stream-msg').should('contain.text', 'hello world');
  });

  it('keeps a delayed optimistic message scoped to the session that sent it', () => {
    cy.mount(<Harness />);
    cy.intercept('POST', '**/api/v1/session/messages', { delay: 500, body: { success: true } }).as('send');
    cy.get('.chat-input').focus().type('session a message');
    cy.get('.chat-send-btn').click();
    cy.get('[data-cy="switch-session"]').click();
    cy.wait('@send').its('request.body.sessionId').should('eq', 'session-a');
    cy.get('[data-cy="active-session"]').should('have.text', 'session-b');
    cy.get('.stream-msg-pending').should('not.exist');
    cy.get('[data-cy="switch-back"]').click();
    cy.get('.stream-msg-pending').should('contain.text', 'session a message');
  });
});
