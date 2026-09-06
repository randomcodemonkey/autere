import React from 'react';
import { SessionModal, formatSessionTime } from '../../src/frontend/components/SessionModal';
import type { SessionSearchResult } from '../../src/frontend/types';

const SESSIONS: SessionSearchResult[] = [
  { id: 'aaaa1111-0000', sessionFile: '/s/aaaa.jsonl', sessionName: 'First', parentSession: null, createdAt: 1, lastActivity: Date.now(), cwd: null },
  { id: 'bbbb2222-0000', sessionFile: '/s/bbbb.jsonl', sessionName: null, parentSession: null, createdAt: 1, lastActivity: Date.now() - 60000, cwd: null },
];

function mountModal(props: Partial<Parameters<typeof SessionModal>[0]> = {}) {
  cy.mount(
    <SessionModal
      open={true}
      onClose={cy.stub()}
      statusType="connected"
      sessionId="aaaa1111-0000"
      sessionName="First"
      compacting={false}
      isStreaming={false}
      isActive={false}
      onAbort={cy.stub()}
      onAbortCompaction={cy.stub()}
      onNewSession={cy.stub().as('onNewSession')}
      onCompact={cy.stub()}
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
    cy.intercept('GET', '**/api/sessions/search*', { success: true, data: [] }).as('search');
    cy.intercept('GET', '**/api/sessions', { success: true, data: SESSIONS }).as('sessions');
  });

  it('lists sessions with the current one highlighted', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').should('have.length', 2);
    cy.get('.session-item.active').should('contain', 'First');
    cy.get('.session-item.active .session-delete-btn').should('not.exist');
  });

  it('calls onSwitchSession when another session is clicked', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').not('.active').first().click();
    cy.get('@onSwitchSession').should('have.been.calledWith', 'bbbb2222-0000');
  });

  it('calls onNewSession from the New Session button', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.btn-primary').click();
    cy.get('@onNewSession').should('have.been.calledOnce');
  });

  it('searches by name/id via the search endpoint and keeps ranking', () => {
    mountModal();
    cy.wait('@sessions');
    cy.intercept('GET', '**/api/sessions/search?q=fir*', {
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
    cy.intercept('GET', '**/api/sessions/search?q=needle*', {
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
    cy.intercept('GET', '**/api/sessions/search?q=zzz*', { success: true, data: [] }).as('ranked');
    cy.get('.session-search-input').type('zzz');
    cy.wait('@ranked');
    cy.get('.session-empty').should('contain', 'No matching sessions');
  });

  it('deletes a session after confirm()', () => {
    cy.intercept('POST', '**/api/sessions/delete', { success: true }).as('delete');
    let accept = false;
    cy.window({ log: false }).then((win) => {
      (win as any).confirm = () => accept;
    });
    mountModal();
    cy.wait('@sessions');
    // Dismissing the confirm dialog must NOT send the delete request
    cy.get('.session-item').not('.active').find('.session-delete-btn').click();
    cy.get('@delete.all').should('have.length', 0);
    // Accepting the confirm dialog issues the delete
    cy.wrap(null).then(() => { accept = true; });
    cy.get('.session-item').not('.active').find('.session-delete-btn').click();
    cy.wait('@delete');
    // The deleted session disappears from the list
    cy.get('.session-item').not('.active').should('not.exist');
  });

  it('delete button shows no armed/❗ state (confirm() is used instead)', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').not('.active').find('.session-delete-btn')
      .should('contain', '✕').and('not.contain', '❗');
  });
});
