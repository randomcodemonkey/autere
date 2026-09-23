/**
 * Sessions modal basics + lazy spawn e2e — viewing an idle (disk-only)
 * session must not spawn pi; sending must. One model turn.
 */

import { waitForBackend, seedIdleSession } from './support/helpers';

describe('autere — sessions modal', () => {
  before(() => { waitForBackend(); });
  beforeEach(() => { cy.visit('/'); });

  describe('Session Management', () => {
    it('views an idle session without spawning pi, and spawns on send', function() {
      this.timeout(120000);
      seedIdleSession('idle seeded session').then((seedId) => {
        // Viewing it (bootstrap binds) must NOT spawn its process
        cy.visit(`/session/${seedId}`);
        // The text lives in .stream-msg; .stream-role-* is just the role label.
        cy.get('.stream-msg:has(.stream-role-user)', { timeout: 15000 }).should('contain', 'seeded question');
        cy.get('.stream-msg:has(.stream-role-assistant)').should('contain', 'seeded answer');
        cy.request('/api/sessions').its('body.data').then((sessions: any[]) => {
          const seeded = sessions.find((x) => x.id === seedId);
          expect(seeded, 'seeded session listed').to.exist;
          expect(seeded.active, 'idle session has no pi process').to.eq(false);
        });
        // Sending a message spawns the process (async — poll until active)
        cy.get('.chat-input').should('not.be.disabled').type('Reply with just: woke ok');
        cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click();
        const waitForSpawn = (attempt = 0): void => {
          cy.request('/api/sessions').its('body.data').then((sessions: any[]) => {
            const seeded = sessions.find((x) => x.id === seedId);
            if (!seeded?.active && attempt < 20) {
              cy.wait(1000);
              waitForSpawn(attempt + 1);
            } else {
              expect(seeded.active, 'process spawned by send').to.eq(true);
            }
          });
        };
        waitForSpawn();
        cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
      });
    });

    it('opens the sessions modal from the status badge', () => {
      cy.get('.session-badge').click();
      cy.get('.modal-session').should('be.visible');
      cy.get('.session-search-input').should('exist');
    });

    it('shows current session ID in the modal', () => {
      cy.get('.session-badge').click();
      cy.get('.session-current-id', { timeout: 5000 }).should('exist');
      cy.get('.modal-session .modal-close').click();
      cy.get('.modal-session').should('not.be.visible');
    });

    it('lists available sessions in the modal', () => {
      cy.get('.session-badge').click();
      cy.get('.session-item', { timeout: 5000 }).should('have.length.greaterThan', 0);
      cy.get('.modal-session .modal-close').click();
      cy.get('.modal-session').should('not.be.visible');
    });
  });
});
