import React from 'react';
import { SessionView, formatSessionTime } from '../../src/frontend/components/SessionModal';
import type { SessionSearchResult } from '../../src/frontend/types';
import '../../src/frontend/styles.scss';

const SESSIONS: SessionSearchResult[] = [
  { id: 'aaaa1111-0000', sessionFile: '/s/aaaa.jsonl', sessionName: 'First', parentSession: null, createdAt: 1, lastActivity: Date.now(), cwd: null, active: true, streaming: true },
  { id: 'bbbb2222-0000', sessionFile: '/s/bbbb.jsonl', sessionName: null, parentSession: null, createdAt: 1, lastActivity: Date.now() - 60000, cwd: null, active: true },
  { id: 'cccc3333-0000', sessionFile: '/s/cccc.jsonl', sessionName: 'Idle one', parentSession: null, createdAt: 1, lastActivity: Date.now() - 120000, cwd: null, active: false },
];

function mountModal(props: Partial<Parameters<typeof SessionView>[0]> = {}) {
  cy.mount(
    <SessionView
      statusType="connected"
      sessionId="aaaa1111-0000"
      sessionName="First"
      compacting={false}
      isStreaming={false}
      onNewSession={cy.stub().as('onNewSession')}
      onSwitchSession={cy.stub().as('onSwitchSession')}
      {...props}
    />
  );
}

describe('SessionModal', () => {
  describe('formatSessionTime age boundaries', () => {
    const NOW = new Date('2026-09-03T12:00:00Z').getTime();
    beforeEach(() => cy.clock(NOW));
    it('formats minutes and hours (locale: en)', () => {
      expect(formatSessionTime(NOW - 30_000, 'en')).to.equal('now');
      expect(formatSessionTime(NOW - 5 * 60_000, 'en')).to.equal('5m ago');
      expect(formatSessionTime(NOW - 23 * 3_600_000, 'en')).to.equal('23h ago');
    });
    it('formats days without the 0d bug (locale: en)', () => {
      expect(formatSessionTime(NOW - 25 * 3_600_000, 'en')).to.equal('yesterday');
      expect(formatSessionTime(NOW - 47 * 3_600_000, 'en')).to.equal('yesterday');
      expect(formatSessionTime(NOW - 3 * 24 * 3_600_000, 'en')).to.equal('3d ago');
    });
    it('uses the given locale', () => {
      expect(formatSessionTime(NOW - 5 * 60_000, 'fi')).to.equal('5 min sitten');
    });
  });

  beforeEach(() => {
    cy.intercept('GET', '**/api/v1/sessions/search*', { success: true, data: [] }).as('search');
    cy.intercept('GET', '**/api/v1/sessions', { success: true, data: SESSIONS }).as('sessions');
  });

  it('lists sessions with the current one highlighted', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').should('have.length', 3);
    cy.get('.session-item.active').should('contain', 'First');
    cy.get('.session-item.active .session-delete-btn').should('not.exist');
  });

  it('active-only toggle filters out inactive sessions', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').should('have.length', 3);
    cy.get('.session-active-toggle input[type=checkbox]').check();
    cy.get('.session-item').should('have.length', 2);
    cy.get('.session-item').should('not.contain', 'Idle one');
    cy.get('.session-active-toggle input[type=checkbox]').uncheck();
    cy.get('.session-item').should('have.length', 3);
  });

  it('active-only toggle shows a distinct empty state when nothing is active', () => {
    cy.intercept('GET', '**/api/v1/sessions', { success: true, data: [SESSIONS[2]] }).as('sessionsIdle');
    mountModal();
    cy.wait('@sessionsIdle');
    cy.get('.session-active-toggle input[type=checkbox]').check();
    cy.get('.session-empty').should('contain', 'No active sessions');
  });

  it('calls onSwitchSession when another session is clicked', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').not('.active').first().click();
    cy.get('@onSwitchSession').should('have.been.calledWith', 'bbbb2222-0000');
  });

  it('new session form: prefill, persona select and create callback', () => {
    cy.intercept('GET', '**/api/v1/personas', { success: true, data: [{ id: 'p1', name: 'Pirate', description: '', prompt: '' }] }).as('personas');
    mountModal();
    cy.wait('@sessions');
    cy.get('.btn-primary').contains('New Session').click();
    // The form opens inside an inner modal; the listing stays on the page
    cy.get('.session-item').should('have.length', 3);
    cy.get('.modal:visible .modal-header h3').should('contain', 'New session');
    // Prefilled (auto-name pattern), editable
    cy.get('#session-new-name').invoke('val').should('match', /^\[ui\] - /);
    cy.get('#session-new-name').clear().type('My custom name');
    cy.wait('@personas');
    cy.get('#session-persona-select').select('Pirate');
    cy.get('.session-create-btn').click();
    cy.get('@onNewSession').should('have.been.calledWith', 'p1', 'My custom name');
  });

  it('closing the new-session modal returns to the listing', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.btn-primary').contains('New Session').click();
    cy.get('.modal-close:visible').click();
    cy.get('.session-item').should('have.length', 3);
    cy.get('@onNewSession').should('not.have.been.called');
  });

  it('searches by name/id via the search endpoint and keeps ranking', () => {
    mountModal();
    cy.wait('@sessions');
    cy.intercept('GET', '**/api/v1/sessions/search?q=fir*', {
      success: true,
      data: [{ ...SESSIONS[0], match: 'name' }],
    }).as('ranked');
    cy.get('.session-search-input').type('fir');
    cy.wait('@ranked');
    cy.get('.session-item').should('have.length', 1);
    cy.get('.session-item').should('contain', 'First');
    cy.get('.session-match-tag').should('not.exist');
  });

  it('tags content matches with a content-match badge', () => {
    mountModal();
    cy.wait('@sessions');
    cy.intercept('GET', '**/api/v1/sessions/search?q=needle*', {
      success: true,
      data: [{ ...SESSIONS[1], match: 'content' }],
    }).as('ranked');
    cy.get('.session-search-input').type('needle');
    cy.wait('@ranked');
    cy.get('.session-match-tag').should('contain', 'content match');
  });

  it('shows an empty state when nothing matches', () => {
    mountModal();
    cy.wait('@sessions');
    cy.intercept('GET', '**/api/v1/sessions/search?q=zzz*', { success: true, data: [] }).as('ranked');
    cy.get('.session-search-input').type('zzz');
    cy.wait('@ranked');
    cy.get('.session-empty').should('contain', 'No matching sessions');
  });

  it('deletes a session after confirm()', () => {
    cy.intercept('DELETE', '**/api/v1/sessions/*', { success: true }).as('delete');
    let accept = false;
    cy.window({ log: false }).then((win) => {
      (win as any).confirm = () => accept;
    });
    mountModal();
    cy.wait('@sessions');
    // Dismissing the confirm dialog must NOT send the delete request
    cy.get('.session-item').not('.active').find('.session-delete-btn').first().click();
    cy.get('@delete.all').should('have.length', 0);
    // Accepting the confirm dialog issues the delete
    cy.wrap(null).then(() => { accept = true; });
    cy.get('.session-item').not('.active').find('.session-delete-btn').first().click();
    cy.wait('@delete');
    // The deleted session disappears from the list
    cy.get('.session-item').contains('bbbb2222-0000').should('not.exist');
  });


  it('persona select: disabled "Loading personas" until personas arrive', () => {
    cy.intercept('GET', '**/api/v1/personas', {
      delay: 800,
      body: { success: true, data: [{ id: 'p1', name: 'Pirate', description: '', prompt: '' }] },
    }).as('personas');
    mountModal();
    cy.get('.btn-primary').contains('New Session').click();
    cy.get('#session-persona-select').should('be.disabled').and('contain', 'Loading personas');
    cy.wait('@personas');
    cy.get('#session-persona-select').should('not.be.disabled').and('contain', 'Pirate');
    cy.get('#session-persona-select option').should('have.length', 2); // No persona + Pirate
  });

  it('persona select: "No personas available" and stays disabled when none exist', () => {
    cy.intercept('GET', '**/api/v1/personas', { success: true, data: [] }).as('personas');
    mountModal();
    cy.get('.btn-primary').contains('New Session').click();
    cy.wait('@personas');
    cy.get('#session-persona-select').should('be.disabled').and('contain', 'No personas available');
  });

  it('persona select: surfaces a failed load instead of swallowing it', () => {
    cy.intercept('GET', '**/api/v1/personas', { statusCode: 500, body: 'boom' }).as('personas');
    mountModal();
    cy.get('.btn-primary').contains('New Session').click();
    cy.wait('@personas');
    cy.get('#session-persona-select').should('be.disabled').and('contain', 'Failed to load personas');
  });

  it('delete button shows no armed/❗ state (confirm() is used instead)', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').not('.active').find('.session-delete-btn')
      .should('contain', '✕').and('not.contain', '❗');
  });
});
