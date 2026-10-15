import React from 'react';
import { ChatMessage } from '../../src/frontend/components/ChatMessage';

// Minimal message fixture; ChatMessage only reads text/streaming/timestamp
// (plus optional images/file/isError) for a non-streaming text entry.
const base = { text: 'hello', streaming: false, timestamp: 1700000000000 } as any;

function mountMsg(role: string, displayText: string) {
  cy.mount(
    <ChatMessage
      msg={base}
      role={role}
      displayText={displayText}
      isAssistant={false}
      isToolResult={false}
      isLong={false}
      truncLen={5000}
    />,
  );
}

describe('ChatMessage — scheduled-task deliveries', () => {
  it('renders task deliveries with a distinct task sender and a markdown body', () => {
    mountMsg(
      'taskReport',
      '[autere task] Scheduled task "Alpha" reported:\n\n**Done**, all green.',
    );
    cy.get('.stream-role-taskReport > span').should('contain', 'task');
    cy.get('.md-rendered strong').should('contain', 'Done');
    // Not styled as a system-ish bracketed text
    cy.get('.stream-text').should('not.have.class', 'stream-non-text');
  });

  it('keeps ordinary user messages plain', () => {
    mountMsg('user', 'hello there');
    cy.get('.stream-role-user > span').should('contain', 'user');
    cy.get('.md-rendered').should('not.exist');
    cy.get('.stream-text').should('not.have.class', 'md-rendered');
  });

  it('does not restyle user messages that merely mention the marker', () => {
    mountMsg('user', 'What does [autere task] in the docs mean?');
    cy.get('.stream-role-user > span').should('contain', 'user');
  });
});
