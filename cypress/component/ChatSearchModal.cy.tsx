import React from 'react';
import '../../src/frontend/styles.scss';
import { ChatSearchModal } from '../../src/frontend/components/ChatSearchModal';
import { storageKey } from '../../src/frontend/storage';

const HITS = [
  {
    role: 'assistant',
    timestamp: 1700000000000,
    snippet: 'Fixed the Kymi threshold clamp in the script.',
    text: 'Fixed the Kymi threshold clamp in the script.\n\nDetails: the state file now stores the rounded value and the notification only fires on a fresh crossing.',
  },
  { role: 'toolResult', timestamp: 1700000005000, snippet: '…line 2 with kymi inside…', text: 'line 1\nline 2 with kymi inside\nline 3', truncated: true },
];

function mountSearch(props: Partial<React.ComponentProps<typeof ChatSearchModal>> = {}) {
  cy.mount(
    <ChatSearchModal open onClose={cy.stub().as('onClose')} sessionId="s1" {...props} />,
  );
}

describe('ChatSearchModal', () => {
  beforeEach(() => {
    cy.clearLocalStorage();
    cy.intercept('GET', '**/api/v1/session/search*', { success: true, data: { hits: HITS, total: 2, truncated: false } })
      .as('search');
  });

  it('prompts before searching and sends the selected kinds', () => {
    mountSearch();
    cy.get('.chat-search-status').should('contain', 'Type at least 2 characters');
    cy.get('.chat-search-input').type('kymi');
    cy.wait('@search').its('request.url').should((url: string) => {
      expect(url).to.include('q=kymi');
      expect(url).to.include('limit=200');
      expect(url).to.include('sessionId=s1');
      // only assistant and tools are preselected
      expect(decodeURIComponent(url)).to.include('roles=assistant,toolCall,toolResult');
    });
    cy.get('.chat-search-status').should('contain', '2 of 2 matches');
    cy.get('.chat-search-hit').should('have.length', 2);
    cy.get('.chat-search-hit').first().find('mark').should('have.text', 'Kymi');
    cy.get('.chat-search-hit').eq(1).find('.chat-search-role').should('contain', 'toolResult');
    cy.get('.chat-search-time').first().should('not.be.empty');
    cy.get('.chat-search-kind.active').should('have.length', 2);
    cy.get('.chat-search-kind.active').eq(0).should('contain', 'assistant');
    cy.get('.chat-search-kind.active').eq(1).should('contain', 'tools');
  });

  it('expands a hit to the whole message and back', () => {
    mountSearch();
    cy.get('.chat-search-input').type('kymi');
    cy.wait('@search');
    cy.get('.chat-search-hit').first().find('.chat-search-snippet').should('not.contain', 'Details:');
    cy.get('.chat-search-hit').first().find('.chat-search-expand').click();
    cy.get('.chat-search-hit').first().find('.chat-search-snippet')
      .should('contain', 'Details: the state file now stores the rounded value');
    cy.get('.chat-search-hit').first().find('mark').should('have.length', 1).and('have.text', 'Kymi');
    // a cut message says so
    cy.get('.chat-search-hit').eq(1).find('.chat-search-expand').click();
    cy.get('.chat-search-hit').eq(1).should('contain', 'Message cut at 20000 characters');
    cy.get('.chat-search-hit').first().find('.chat-search-expand').should('contain', 'show less').click();
    cy.get('.chat-search-hit').first().find('.chat-search-snippet').should('not.contain', 'Details:');
  });

  it('remembers the chosen kinds', () => {
    mountSearch();
    cy.get('.chat-search-kind').contains('thinking').click();
    cy.window().then((win) => {
      const saved = JSON.parse(win.localStorage.getItem(storageKey('autere.chatSearchKinds')) || '{}');
      expect(saved).to.deep.equal({ assistant: true, user: false, thinking: true, tools: true, edits: false, system: false });
    });
    cy.mount(<ChatSearchModal open onClose={cy.stub()} sessionId="s1" />);
    cy.get('.chat-search-kind.active').should('have.length', 3);
    cy.get('.chat-search-kind').contains('thinking').should('have.class', 'active');
    cy.get('.chat-search-input').type('kymi');
    cy.wait('@search').its('request.url').should((url: string) => expect(decodeURIComponent(url)).to.include('thinking'));
  });

  it('narrows the request when a kind is turned off', () => {
    mountSearch();
    cy.get('.chat-search-kind').contains('tools').click();
    cy.get('.chat-search-input').type('kymi');
    cy.wait('@search').its('request.url').should((url: string) => {
      const roles = decodeURIComponent(url).split('roles=')[1].split('&')[0].split(',');
      expect(roles).to.not.include('toolResult');
      expect(roles).to.include('assistant');
    });
  });

  it('reports the 200 result cap and very long sessions', () => {
    const capped = Array.from({ length: 200 }, (_, i) => ({ role: 'assistant', timestamp: 1700000000000 + i, snippet: `hit ${i} kymi` }));
    cy.intercept('GET', '**/api/v1/session/search*', {
      success: true,
      data: { hits: capped, total: 250, truncated: true },
    }).as('search');
    mountSearch();
    cy.get('.chat-search-input').type('kymi');
    cy.wait('@search');
    cy.get('.chat-search-status').should('contain', '200 of 250 matches').and('contain', 'showing the first 200');
    cy.get('.chat-search-hit').should('have.length', 200);
    cy.get('.chat-search-body').should('contain', 'only the most recent part was searched');
  });

  it('says when nothing matched', () => {
    cy.intercept('GET', '**/api/v1/session/search*', { success: true, data: { hits: [], total: 0, truncated: false } }).as('search');
    mountSearch();
    cy.get('.chat-search-input').type('zzz');
    cy.wait('@search');
    cy.get('.chat-search-status').should('contain', 'No matches');
    cy.get('.chat-search-hit').should('not.exist');
  });

  it('surfaces backend errors', () => {
    cy.intercept('GET', '**/api/v1/session/search*', { statusCode: 500, body: { success: false, error: 'Session not found' } }).as('search');
    mountSearch();
    cy.get('.chat-search-input').type('kymi');
    cy.wait('@search');
    cy.get('.chat-search-body').should('contain', 'Session not found');
  });
});
