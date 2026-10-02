/**
 * Reload mid-stream: the in-flight assistant message must survive.
 *
 * Regression test for: bootstrap served file-based history while streaming.
 * File entries never carry streaming:true (or the live entry ids), so after
 * a reload the client had no streaming entry — every stream_delta was
 * dropped and the streaming message vanished from view.
 */
import { openSessionsModal } from './support/helpers';

const totalLen = ($els: JQuery) => {
  // Entries render truncated (e.g. "▸ 1234 more characters - click to
  // expand") — sum rendered text + the hidden remainder for the real size.
  let max = 0;
  $els.each((_, el) => {
    const t = Cypress.$(el).text();
    const m = t.match(/([\d,]+)\s*more characters/);
    const len = t.length + (m ? parseInt(m[1].replace(/,/g, ''), 10) : 0);
    max = Math.max(max, len);
  });
  return max;
};

describe('mid-stream reload keeps the streaming message', () => {
  it('switching away and back mid-stream keeps the chat history', function () {
    this.timeout(300000);
    // The second session to switch to is seeded AFTER landing — RootRedirect
    // picks the most recently active session, so seeding first would make it
    // the landing (current) session and the "switch away" click a no-op.
    const seedId = `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let switchBackId = '';

    cy.intercept('POST', '**/api/v1/sessions/*/activate').as('switch');
    cy.visit('/');
    cy.get('.chat-input', { timeout: 15000 }).should('exist');

    // Turn 1: short, completes — the pre-turn history that must survive.
    cy.get('.chat-input').type('Reply with just: marker one');
    cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click();
    cy.get('.stream-msg:has(.stream-role-assistant)', { timeout: 60000 }).should('exist');
    cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
    // The send's HTTP response clears the input AFTER turn end (the response
    // races the badge update) — wait for it, or it wipes the next message
    // mid-typing and the second send fires into an empty input.
    cy.get('.chat-input').should('have.value', '');

    // Turn 2: long, streaming through the switches (the user's repro).
    cy.get('.chat-input').type('Write an essay of at least 600 words about oak trees. Do not stop early.');
    cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click();
    cy.get('.status-badge', { timeout: 60000 }).should('have.class', 'status-streaming');

    // Everything below depends on the CURRENT session id, which is only
    // known once the URL has settled — and Cypress command args (e.g.
    // cy.contains(x)) evaluate at QUEUE time, so these must run inside the
    // .then callback.
    cy.location('pathname').then((p) => {
      switchBackId = p.split('/')[2];

      // Idle second session to switch to (lazy: viewing it spawns nothing)
      cy.task('seedSession', { id: seedId, name: 'switch target' }).should('eq', true);

      // Away to the seeded idle session (sessions page click path)
      openSessionsModal();
      cy.get('.session-item').contains('switch target').click();
      cy.wait('@switch');
      cy.get('.sessions-page').should('not.exist');
      cy.get('.stream-msg:has(.stream-role-user)', { timeout: 15000 }).should('contain', 'seeded question');

      // Back — the pre-turn history (turn 1) must still be on screen. The
      // sessions view closes when the switch response lands (asserted, not
      // assumed — otherwise its late close races the reopen below).
      openSessionsModal();
      cy.get('.session-item .session-item-id').contains(switchBackId).click();
      cy.wait('@switch');
      cy.get('.sessions-page').should('not.exist');
      cy.get('.stream-msg:has(.stream-role-user)', { timeout: 15000 }).contains('marker one').should('exist');
      cy.get('.stream-msg:has(.stream-role-user)').contains('oak trees').should('exist');
      cy.get('.status-badge').should('have.class', 'status-streaming');

      // Cleanup: abort the essay turn so the run ends idle.
      cy.request('POST', `/api/v1/session/abort?sessionId=${switchBackId}`);
      cy.get('.status-badge', { timeout: 120000 }).should('not.have.class', 'status-streaming');
    });
  });

  it('assistant message stays visible and keeps growing across cy.reload()', function () {
    this.timeout(300000);
    cy.visit('/');
    cy.get('.chat-input', { timeout: 15000 }).should('exist');

    // Long turn so it is still streaming through the reload + poll window.
    cy.get('.chat-input').type(
      'Write an essay of at least 600 words about pine trees. Do not stop early.'
    );
    cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });
    cy.get('.status-badge', { timeout: 60000 }).should('have.class', 'status-streaming');

    // Reload as soon as real assistant text is on screen — mid-turn.
    // (.stream-role-* is the role-label chip; the body is a sibling —
    // select the whole .stream-msg entry.)
    cy.get('.stream-msg:has(.stream-role-assistant)', { timeout: 60000 }).should('exist');
    cy.get('body').should(($body) => {
      expect(totalLen($body.find('.stream-msg:has(.stream-role-assistant)')), 'assistant text before reload').to.be.greaterThan(50);
    });

    // ── the reload under test ──
    cy.reload();
    cy.get('.chat-input', { timeout: 20000 }).should('exist');
    cy.get('.stream-role-assistant', { timeout: 30000 }).should('exist');

    // Poll through the rest of the turn: the assistant entry must be present
    // at every check and its text must keep growing (deltas must flow).
    let lastLen = 0;
    let grew = false;
    for (let i = 0; i < 24; i++) {
      cy.wait(800);
      cy.get('body').then(($body) => {
        const $asst = $body.find('.stream-msg:has(.stream-role-assistant)');
        expect($asst.length, 'assistant message present').to.be.greaterThan(0);
        const len = totalLen($asst);
        if (len > lastLen + 100) grew = true;
        lastLen = Math.max(lastLen, len);
      });
    }
    cy.wrap(null).should(() => {
      expect(grew, `assistant text kept growing after reload (len=${lastLen})`).to.eq(true);
    });

    // Turn ends and the final message is intact (~600 words streams for
    // well under a minute even on slow router runs).
    cy.get('.status-badge', { timeout: 240000 }).should('not.have.class', 'status-streaming');
    cy.get('.stream-msg:has(.stream-role-assistant)').should('have.length.greaterThan', 0);
  });
});
