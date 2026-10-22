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

  it('places New Session at the end of the Sessions header', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.sessions-page > .card-header .sessions-new-btn').should('contain', 'New Session').click();
    cy.get('.modal-header h3').should('contain', 'New session');
  });

  it('uses an info Add workdir button and only shows Save for unsaved changes', () => {
    const current = { ...SESSIONS[0], workdirs: ['/home/autere/code'] };
    cy.intercept('GET', '**/api/v1/sessions', { success: true, data: [current, ...SESSIONS.slice(1)] }).as('sessionsWithWorkdirs');
    cy.intercept('GET', '**/api/v1/browse/roots', { success: true, data: [{ path: '/home/autere', access: 'rw' }] });
    cy.intercept('GET', '**/api/v1/browse/list*', {
      success: true,
      data: [{ name: 'code', type: 'dir' }, { name: 'tmp', type: 'dir' }],
    });
    mountModal({ canSetWorkdir: true });
    cy.wait('@sessionsWithWorkdirs');
    cy.get('.session-workdirs-save').should('not.exist');
    cy.get('.session-workdirs-edit .sortable-list-add-btn')
      .should('have.class', 'btn-info')
      .and('not.have.class', 'btn-primary');
    cy.get('.session-workdirs-edit').first().within(() => {
      cy.get('.sortable-list-item .sortable-list-input').first().clear().type('/home/autere/tmp');
      cy.get('.session-workdirs-save').should('exist');
      cy.get('.sortable-list-item .sortable-list-input').first().clear().type('/home/autere/code');
      cy.get('.session-workdirs-save').should('not.exist');
    });
  });

  it('pins old sessions from the full session list without switching', () => {
    const onTogglePinnedSession = cy.stub().as('togglePin');
    mountModal({ onTogglePinnedSession, pinnedSessionFiles: ['/s/aaaa.jsonl'] });
    cy.wait('@sessions');
    cy.get('.session-item.active .session-pin-toggle').should('contain', 'Unpin').click();
    cy.get('@togglePin').should('have.been.calledWithMatch', { sessionFile: '/s/aaaa.jsonl' });
    cy.get('.session-item').contains('Idle one').parents('.session-item').find('.session-pin-toggle').should('contain', 'Pin').click();
    cy.get('@togglePin').should('have.been.calledWithMatch', { sessionFile: '/s/cccc.jsonl' });
    cy.get('@onSwitchSession').should('not.have.been.called');
  });

  it('action buttons wrap to their own row in mobile card mode', () => {
    cy.viewport(375, 700);
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').not('.active').first().within(() => {
      cy.get('.session-item-content').then(($content) => {
        cy.get('.session-delete-btn').then(($btn) => {
          expect($btn[0].offsetTop, 'buttons wrapped below the content')
            .to.be.greaterThan($content[0].offsetTop);
        });
      });
    });
  });

  it('workdir validation: bogus path shows error and blocks create', () => {
    cy.intercept('GET', '**/api/v1/browse/roots', { success: true, data: [{ path: '/home/autere', access: 'rw' }] }).as('roots');
    cy.intercept('GET', '**/api/v1/browse/list*', { success: true, data: [{ name: 'code', type: 'dir', size: 1, mtime: 1 }] }).as('list');
    mountModal({ canSetWorkdir: true });
    cy.contains('button', 'New Session').click();
    // force: the no-CSS harness overlays the modal header over the body;
    // real browsers scroll it clear (users type here fine). Scope to the
    // modal — the current-session WorkdirEditor also has an add-input.
    cy.get('.modal-session .sortable-list-add .sortable-list-input').first().type('/home/autere/nope{enter}', { force: true });
    cy.wait('@roots');
    cy.wait('@list');
    cy.contains('does not exist on the server').should('be.visible');
    cy.get('.session-create-btn').should(($b) => {
      expect($b.prop('disabled'), 'create button disabled').to.equal(true);
    });
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

  it('delete button shows a text label, no armed/❗ state (confirm() is used instead)', () => {
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').not('.active').find('.session-delete-btn')
      .should('contain', 'delete').and('not.contain', '❗');
  });

  it('clear button: only on the current session, gated behind confirm()', () => {
    let accept = false;
    cy.window({ log: false }).then((win) => { (win as any).confirm = () => accept; });
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item.active .session-clear-btn').should('exist');
    cy.get('.session-item').not('.active').find('.session-clear-btn').should('not.exist');
    // Dismissing the confirm dialog must NOT create a new session
    cy.get('.session-item.active .session-clear-btn').click();
    cy.get('@onNewSession').should('not.have.been.called');
    // Accepting creates a fresh session with the same name/workdirs and
    // passes the old session id so it gets deleted after the switch.
    cy.wrap(null).then(() => { accept = true; });
    cy.get('.session-item.active .session-clear-btn').click();
    cy.get('@onNewSession').should('have.been.calledWith', null, 'First', undefined, undefined, 'aaaa1111-0000');
  });

  it('clone button: modal prefilled with the source name and workdirs', () => {
    const withWd = [{ ...SESSIONS[2], workdirs: ['/home/autere/code'] }];
    cy.intercept('GET', '**/api/v1/sessions', { success: true, data: withWd }).as('sessionsWd');
    mountModal({ canSetWorkdir: true });
    cy.wait('@sessionsWd');
    cy.get('.session-item:contains("Idle one")').find('.session-clone-btn').click();
    cy.get('.modal:visible .modal-header h3').should('contain', 'Clone session');
    cy.get('#session-clone-name').should('have.value', 'Idle one');
    cy.get('.modal-session .sortable-list .sortable-list-input').first().should('have.value', '/home/autere/code');
  });

  it('clone button: confirm issues the clone request with edited name/workdirs', () => {
    const withWd = [{ ...SESSIONS[0], workdirs: ['/home/autere/code'] }];
    cy.intercept('GET', '**/api/v1/sessions', { success: true, data: withWd }).as('sessionsWd');
    cy.intercept('POST', '**/api/v1/sessions/*/clone', { success: true, data: { id: 'clone-id' } }).as('clone');
    mountModal({ canSetWorkdir: true });
    cy.wait('@sessionsWd');
    cy.get('.session-item:contains("First")').find('.session-clone-btn').click();
    cy.get('#session-clone-name').clear().type('Cloned name');
    cy.get('.session-clone-confirm').click();
    cy.wait('@clone').its('request.body').should('deep.include', {
      sessionName: 'Cloned name',
      workdirs: ['/home/autere/code'],
    });
    // The modal closes once the clone succeeds
    cy.get('.session-clone-confirm').should('not.exist');
  });

  it('clone button: a failed clone keeps the modal open with the error', () => {
    cy.intercept('POST', '**/api/v1/sessions/*/clone', { success: false, error: 'Session has no history to clone yet' }).as('cloneFail');
    mountModal();
    cy.wait('@sessions');
    cy.get('.session-item').first().find('.session-clone-btn').click();
    cy.get('.session-clone-confirm').click();
    cy.wait('@cloneFail');
    cy.get('.modal:visible').should('contain', 'Session has no history to clone yet');
  });
});
