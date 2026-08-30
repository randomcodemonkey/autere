import React from 'react';
import { StreamCard } from '../../src/frontend/components/StreamCard';
import type { StreamMessage } from '../../src/frontend/types';

describe('StreamCard', () => {
  it('renders chat title', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.card-title').should('contain', 'Chat');
  });

  it('renders filter buttons and fullscreen toggle', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-toggle').should('have.length', 4);
    cy.get('.stream-toggle').eq(0).should('contain', 'full');
    cy.get('.stream-toggle').eq(1).should('contain', 'thinking');
    cy.get('.stream-toggle').eq(2).should('contain', 'tools');
    cy.get('.stream-toggle').eq(3).should('contain', 'edits');
  });

  it('renders user messages', () => {
    const messages: StreamMessage[] = [
      { role: 'user', text: 'Hello world', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-msg').should('have.length', 1);
    cy.get('.stream-role-user').should('contain', 'user');
    cy.get('.stream-text').should('contain', 'Hello world');
  });

  it('renders assistant messages', () => {
    const messages: StreamMessage[] = [
      { role: 'assistant', text: 'I can help with that.', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-role-assistant').should('contain', 'assistant');
  });

  it('renders streaming indicator for active messages', () => {
    const messages: StreamMessage[] = [
      { role: 'assistant', text: 'Still typing...', streaming: true },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={true} onNewSession={cy.stub()} />);
    cy.get('.stream-cursor').should('exist');
  });

  it('renders thinking messages', () => {
    const messages: StreamMessage[] = [
      { role: 'thinking', text: 'Let me think about this...', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-role-thinking').should('contain', 'thinking');
  });

  it('renders tool result messages', () => {
    const messages: StreamMessage[] = [
      { role: 'toolResult', text: '[bash] output here', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-tool-output').should('contain', '[bash] output here');
  });

  it('hides thinking messages when filter is off', () => {
    // Set localStorage to hide thinking
    localStorage.setItem('autere-filter-thinking', 'off');
    const messages: StreamMessage[] = [
      { role: 'thinking', text: 'Hidden thought', streaming: false },
      { role: 'assistant', text: 'Visible response', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-msg').should('have.length', 1);
    cy.get('.stream-text').should('contain', 'Visible response');
  });

  it('shows thinking messages when filter is on', () => {
    localStorage.setItem('autere-filter-thinking', 'on');
    const messages: StreamMessage[] = [
      { role: 'thinking', text: 'Visible thought', streaming: false },
      { role: 'assistant', text: 'Visible response', streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-msg').should('have.length', 2);
  });

  it('adds working class when streaming', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={true} onNewSession={cy.stub()} />);
    cy.get('.stream-card').should('have.class', 'working');
  });

  it('renders chat input', () => {
    cy.mount(<StreamCard messages={[]} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.chat-input').should('exist');
    cy.get('.chat-send-btn').should('contain', 'Send');
  });

  it('shows expand/collapse for long messages', () => {
    const longText = 'A'.repeat(3000);
    const messages: StreamMessage[] = [
      { role: 'assistant', text: longText, streaming: false },
    ];
    cy.mount(<StreamCard messages={messages} isStreaming={false} onNewSession={cy.stub()} />);
    cy.get('.stream-text-truncated').should('contain', 'more characters');
  });
});
