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
      isAssistant={role === 'assistant'}
      isToolResult={false}
      isLong={false}
      truncLen={5000}
    />,
  );
}

describe('ChatMessage — markdown rendering', () => {
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

  it('renders user messages as markdown', () => {
    mountMsg('user', '**bold** and `code`');
    cy.get('.stream-role-user > span').should('contain', 'user');
    cy.get('.md-rendered strong').should('contain', 'bold');
    cy.get('.md-rendered code').should('contain', 'code');
  });

  for (const role of ['user', 'assistant']) {
    it(`escapes raw HTML in ${role} messages while rendering Markdown`, () => {
      mountMsg(role, '<pre>not an element</pre>\n\n**still markdown**');
      cy.get('.md-rendered pre').should('not.exist');
      cy.get('.md-rendered').should('contain.text', '<pre>not an element</pre>');
      cy.get('.md-rendered strong').should('contain', 'still markdown');
    });
  }

  it('does not restyle user messages that merely mention the marker', () => {
    mountMsg('user', 'What does [autere task] in the docs mean?');
    cy.get('.stream-role-user > span').should('contain', 'user');
  });
});

describe('ChatMessage — ANSI tool output', () => {
  function mountTool(displayText: string) {
    cy.mount(
      <ChatMessage
        msg={base}
        role="toolResult"
        displayText={displayText}
        isAssistant={false}
        isToolResult={true}
        isLong={false}
        truncLen={5000}
      />,
    );
  }

  it('renders SGR colors and styles without showing escape codes', () => {
    mountTool('  \u001b[32m✓\u001b[0m \u001b[90mdim note\u001b[0m \u001b[1;31mbold red\u001b[0m');
    cy.get('.stream-tool-output').should('contain.text', '✓ dim note bold red');
    cy.get('.stream-tool-output').should('not.contain.text', '\u001b');
    cy.get('.stream-tool-output span').eq(0).should('have.attr', 'style').and('contain', '--ansi-2');
    cy.get('.stream-tool-output span').eq(1).should('have.attr', 'style').and('contain', '--ansi-8');
    cy.get('.stream-tool-output span').eq(2).should('have.class', 'ansi-bold').and('have.attr', 'style').and('contain', '--ansi-1');
  });

  it('drops unknown escape sequences instead of rendering them', () => {
    mountTool('a\u001b[2Kb\u001b]0;window title\u0007c\u001b(0d');
    cy.get('.stream-tool-output').should('have.text', 'abcd');
  });

  it('cannot inject markup through output text or color parameters', () => {
    mountTool(
      '\u001b[31m<script>window.__xss=1</script><img src=x onerror="window.__xss=2">'
      + '\u001b[38;2;0;0;0;background:url(https://evil)\u001b[0mok',
    );
    cy.get('.stream-tool-output script').should('not.exist');
    cy.get('.stream-tool-output img').should('not.exist');
    cy.get('.stream-tool-output').should('contain.text', '<script>window.__xss=1</script>');
    cy.window().its('__xss').should('be.undefined');
  });
});

describe('ChatMessage — streaming tool call', () => {
  it('shows the partial output tail and the timeout while the tool runs', () => {
    cy.mount(
      <ChatMessage
        msg={{ ...base, streaming: true, partial: '\u001b[32mcompiling\u001b[0m 3/4', toolCall: { name: 'bash', cmd: 'npm test', timeout: 300000 } } as any}
        role="toolCall"
        displayText="npm test"
        isAssistant={false}
        isToolResult={true}
        isLong={false}
        truncLen={5000}
      />,
    );
    cy.get('.tool-call-header').should('contain.text', 'bash').and('contain.text', 'npm test');
    cy.get('.tool-call-timeout').should('contain.text', '5m');
    cy.get('.stream-tool-output').should('contain.text', 'compiling 3/4').and('not.contain.text', '\u001b');
    cy.get('.stream-tool-output > span').first().should('have.attr', 'style').and('contain', '--ansi-2');
  });

  it('renders an empty thinking block while streaming', () => {
    cy.mount(
      <ChatMessage
        msg={{ ...base, streaming: true } as any}
        role="thinking"
        displayText=""
        isAssistant={false}
        isToolResult={false}
        isLong={false}
        truncLen={5000}
      />,
    );
    cy.contains('.stream-role', 'thinking').should('exist');
    cy.get('.stream-cursor').should('exist');
    cy.get('.stream-empty-marker').should('have.text', '…');
  });

  it('keeps an empty thinking block after it ends', () => {
    cy.mount(
      <ChatMessage
        msg={{ ...base, streaming: false } as any}
        role="thinking"
        displayText=""
        isAssistant={false}
        isToolResult={false}
        isLong={false}
        truncLen={5000}
      />,
    );
    cy.contains('.stream-role', 'thinking').should('exist');
    cy.get('.stream-empty-marker').should('exist');
    cy.get('.stream-cursor').should('not.exist');
  });

  it('shows the tool duration and indents nested calls', () => {
    cy.mount(
      <ChatMessage
        msg={{ ...base, streaming: false, toolCall: { name: 'bash', cmd: 'npm test', durationMs: 12345 } } as any}
        role="toolCall"
        displayText="npm test"
        isAssistant={false}
        isToolResult={true}
        isLong={false}
        truncLen={5000}
      />,
    );
    cy.get('.tool-call-duration').should('have.text', '12s');
    cy.get('.tool-call-header').should('not.have.class', 'tool-call-nested');
  });

  it('indents a nested tool call', () => {
    cy.mount(
      <ChatMessage
        msg={{ ...base, streaming: false, toolCall: { name: 'read', cmd: 'a.txt', parentToolCallId: 'call_parent' } } as any}
        role="toolCall"
        displayText="a.txt"
        isAssistant={false}
        isToolResult={true}
        isLong={false}
        truncLen={5000}
      />,
    );
    cy.get('.tool-call-header').should('have.class', 'tool-call-nested');
  });

  it('renders a call whose arguments are still streaming (no cmd yet)', () => {
    cy.mount(
      <ChatMessage
        msg={{ ...base, streaming: true, toolCall: { name: 'write' } } as any}
        role="toolCall"
        displayText=""
        isAssistant={false}
        isToolResult={true}
        isLong={false}
        truncLen={5000}
      />,
    );
    cy.get('.tool-call-header').should('contain.text', 'write');
    cy.get('.tool-call-cmd').should('not.exist');
    cy.get('.tool-call-header .stream-cursor').should('exist');
  });

  it('hides the timeout badge when the tool has none', () => {
    cy.mount(
      <ChatMessage
        msg={{ ...base, streaming: true, toolCall: { name: 'read', cmd: 'read /tmp/x' } } as any}
        role="toolCall"
        displayText="read /tmp/x"
        isAssistant={false}
        isToolResult={true}
        isLong={false}
        truncLen={5000}
      />,
    );
    cy.get('.tool-call-timeout').should('not.exist');
  });
});
