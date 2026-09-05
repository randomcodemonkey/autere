import React, { useState } from 'react';
import { StreamCard } from '../../src/frontend/components/StreamCard';
import type { StreamMessage } from '../../src/frontend/types';

// Harness mimicking DashboardPage's optimistic flow: onSent adds a pending
// message; calling the exposed "retire" window function simulates the
// backend broadcast arriving with the same text.
function Harness() {
  const [history, setHistory] = useState<StreamMessage[]>([]);
  const [pending, setPending] = useState<StreamMessage[]>([]);
  (window as any).__retire = (text: string) => {
    setHistory((prev) => [...prev, { role: 'user', text, streaming: false }]);
    setPending((prev) => prev.filter((p) => p.text !== text));
  };
  return (
    <StreamCard
      messages={[...history, ...pending]}
      isStreaming={false}
      onNewSession={cy.stub()}
      onSent={(text) => setPending((prev) => [...prev, { role: 'user', text, streaming: false, pending: true }])}
    />
  );
}

describe('Optimistic pending user message', () => {
  it('appears immediately with a pending indicator, then is replaced by the broadcast copy', () => {
    cy.mount(<Harness />);
    cy.intercept('POST', '**/api/send', { success: true }).as('send');
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
});
