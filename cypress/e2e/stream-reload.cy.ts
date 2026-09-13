/**
 * Reload mid-stream: the in-flight assistant message must survive.
 *
 * Regression test for: bootstrap served file-based history while streaming.
 * File entries never carry streaming:true (or the live entry ids), so after
 * a reload the client had no streaming entry — every stream_delta was
 * dropped and the streaming message vanished from view.
 */
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
  it('assistant message stays visible and keeps growing across cy.reload()', function () {
    this.timeout(300000);
    cy.visit('/');
    cy.get('.chat-input', { timeout: 15000 }).should('exist');

    // Long turn so it is still streaming through the reload + poll window.
    cy.get('.chat-input').type(
      'Write an essay of at least 2000 words about pine trees: botany, species, ecology, forestry, and human uses. Do not stop early.'
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

    // Turn ends and the final message is intact.
    cy.get('.status-badge', { timeout: 240000 }).should('not.have.class', 'status-streaming');
    cy.get('.stream-msg:has(.stream-role-assistant)').should('have.length.greaterThan', 0);
  });
});
