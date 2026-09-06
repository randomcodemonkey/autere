import React from 'react';
import { useSSE } from '../../src/frontend/hooks/useSSE';

// Test wrapper component for the hook
function TestComponent({ onMessage }: { onMessage?: (msg: any) => void }) {
  const { connected, connect, disconnect } = useSSE({
    onMessage,
    autoConnect: false,
  });
  return (
    <div>
      <span data-testid="connected">{String(connected)}</span>
      <button data-testid="connect" onClick={connect}>Connect</button>
      <button data-testid="disconnect" onClick={disconnect}>Disconnect</button>
    </div>
  );
}

describe('useSSE', () => {
  it('starts disconnected when autoConnect is false', () => {
    cy.mount(<TestComponent />);
    cy.get('[data-testid="connected"]').should('contain', 'false');
  });

  it('connects to SSE endpoint', () => {
    // Create a mock SSE server
    cy.intercept('GET', '/events', (req) => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Send a test event
          controller.enqueue(encoder.encode('data: {"type":"status","data":{"connected":true}}\n\n'));
          controller.close();
        },
      });
      req.reply({
        statusCode: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
        body: stream,
      });
    }).as('sseConnect');

    cy.mount(<TestComponent />);
    cy.get('[data-testid="connect"]').click();
    cy.wait('@sseConnect');
  });

  it('disconnects from SSE', () => {
    cy.intercept('GET', '/events', (req) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      req.reply({
        statusCode: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
        body: stream,
      });
    });

    cy.mount(<TestComponent />);
    cy.get('[data-testid="connect"]').click();
    cy.get('[data-testid="disconnect"]').click();
    cy.get('[data-testid="connected"]').should('contain', 'false');
  });
});
