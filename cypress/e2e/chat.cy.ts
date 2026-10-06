/**
 * Chat + keyboard e2e — real model turns (send, streaming, Enter-to-send).
 * Runs FIRST (alphabetical spec order): on a fresh env RootRedirect creates
 * the initial session, matching the monolith's historical first-spec role.
 */

import { waitForBackend, warmUpSession } from './support/helpers';

describe('autere — chat', () => {
  before(function() {
    this.timeout(60000);
    waitForBackend();
    // Cold-backend warm-up — the first visit spawns the session.
    warmUpSession();
  });
  beforeEach(() => { cy.visit('/'); });

  describe('Chat Functionality', () => {
    it('renders chat input', () => {
      cy.get('.chat-input').should('exist');
      cy.get('.chat-send-btn').should('contain', 'Send');
    });

    it('can type in chat input', () => {
      cy.get('.chat-input').type('Hello, this is a test message');
      cy.get('.chat-input').should('have.value', 'Hello, this is a test message');
    });

    it('enables send button when input has text', () => {
      cy.get('.chat-input').type('Test message');
      cy.get('.chat-send-btn').should('not.be.disabled');
    });

    it('can send a message and receive response', function() {
      this.timeout(120000); // Longer timeout for AI response

      // Type a simple question
      cy.get('.chat-input').type('What is 2 + 2? Answer with just the number.');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });
      cy.get('.stream-role-user', { timeout: 5000 }).should('contain', 'user');

      // Wait for the agent to start working
      cy.get('.status-badge', { timeout: 30000 }).should('have.class', 'status-streaming');

      // Wait for the agent to finish and show response
      cy.get('.stream-role-assistant', { timeout: 60000 }).should('exist');

      // Verify the response contains the answer
      cy.get('.stream-text').contains('4').should('exist');
    });

    it('shows streaming indicator while agent is working', function() {
      this.timeout(60000);

      // Wait for agent to be idle
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');

      // Clear any leftover value, type message, and force-click send
      // (button may be disabled from prior test's sending/compacting state)
      cy.get('.chat-input').clear().type('Write an essay of at least 600 words about oak trees. Do not stop early.');
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      // Check for working status
      cy.get('.status-badge', { timeout: 15000 }).should('have.class', 'status-streaming');

      // The stream card should have the working class
      cy.get('.stream-card').should('have.class', 'working');
    });
  });

  describe('Keyboard Navigation', () => {
    it('can send message with Enter key', function() {
      this.timeout(60000);

      cy.get('.chat-input').type('Say yes{enter}');
      // Message should be sent
      cy.get('.stream-role-user', { timeout: 5000 }).should('contain', 'user');
    });

    it('allows Shift+Enter for newlines', () => {
      cy.get('.chat-input').type('Line 1{shift+enter}Line 2');
      cy.get('.chat-input').should('have.value', 'Line 1\nLine 2');
    });
  });
});
