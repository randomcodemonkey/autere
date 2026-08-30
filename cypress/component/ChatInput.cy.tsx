import React from 'react';
import { ChatInput } from '../../src/frontend/components/ChatInput';

describe('ChatInput', () => {
  beforeEach(() => {
    // Intercept the fetch call to /api/send
    cy.intercept('POST', '/api/send', { success: true }).as('sendMessage');
  });

  it('renders with send button when idle', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.get('.chat-input').should('exist');
    cy.get('.chat-send-btn').should('contain', 'Send');
    cy.get('.chat-input').should('have.attr', 'placeholder', 'Type a message...');
  });

  it('renders with steer/followup buttons when streaming', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={true} />);
    cy.get('.chat-steer-btn').should('contain', 'Steer');
    cy.get('.chat-followup-btn').should('contain', 'Followup');
    cy.get('.chat-input').should('have.attr', 'placeholder', 'Steer the agent...');
  });

  it('disables input when disabled prop is true', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} disabled={true} />);
    cy.get('.chat-input').should('be.disabled');
    cy.get('.chat-send-btn').should('be.disabled');
  });

  it('disables send button when input is empty', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.get('.chat-send-btn').should('be.disabled');
  });

  it('enables send button when input has text', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.get('.chat-input').type('Hello');
    cy.get('.chat-send-btn').should('not.be.disabled');
  });

  it('sends prompt when Send button is clicked', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.get('.chat-input').type('Hello world');
    cy.get('.chat-send-btn').click();
    cy.wait('@sendMessage').its('request.body').should('deep.equal', {
      message: 'Hello world',
      type: 'prompt',
    });
  });

  it('sends steer when Steer button is clicked', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={true} />);
    cy.get('.chat-input').type('Change direction');
    cy.get('.chat-steer-btn').click();
    cy.wait('@sendMessage').its('request.body').should('deep.equal', {
      message: 'Change direction',
      type: 'steer',
    });
  });

  it('sends followUp when Followup button is clicked', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={true} />);
    cy.get('.chat-input').type('Continue please');
    cy.get('.chat-followup-btn').click();
    cy.wait('@sendMessage').its('request.body').should('deep.equal', {
      message: 'Continue please',
      type: 'followUp',
    });
  });

  it('clears input after successful send', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.get('.chat-input').type('Hello world');
    cy.get('.chat-send-btn').click();
    cy.wait('@sendMessage');
    cy.get('.chat-input').should('have.value', '');
  });

  it('calls onNewSession when /new is typed', () => {
    const onNewSession = cy.stub().as('onNewSession');
    cy.mount(<ChatInput onNewSession={onNewSession} isStreaming={false} />);
    cy.get('.chat-input').type('/new');
    cy.get('.chat-send-btn').click();
    cy.get('@onNewSession').should('have.been.calledOnce');
  });

  it('calls onNewSession when /clear is typed', () => {
    const onNewSession = cy.stub().as('onNewSession');
    cy.mount(<ChatInput onNewSession={onNewSession} isStreaming={false} />);
    cy.get('.chat-input').type('/clear');
    cy.get('.chat-send-btn').click();
    cy.get('@onNewSession').should('have.been.calledOnce');
  });

  it('does not call onNewSession when /new is typed while active', () => {
    const onNewSession = cy.stub().as('onNewSession');
    cy.mount(<ChatInput onNewSession={onNewSession} isStreaming={true} isActive={true} />);
    cy.get('.chat-input').type('/new');
    // When streaming, there are two buttons - click the first one (Steer)
    cy.get('.chat-steer-btn').click();
    // /new should not trigger onNewSession when isActive is true
    cy.get('@onNewSession').should('not.have.been.called');
  });

  it('sends steer on Enter when streaming', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={true} />);
    cy.get('.chat-input').type('Hello world{enter}');
    cy.wait('@sendMessage').its('request.body').should('deep.equal', {
      message: 'Hello world',
      type: 'steer',
    });
  });

  it('sends prompt on Enter when idle', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.get('.chat-input').type('Hello world{enter}');
    cy.wait('@sendMessage').its('request.body').should('deep.equal', {
      message: 'Hello world',
      type: 'prompt',
    });
  });

  it('allows Shift+Enter for newlines without sending', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.get('.chat-input').type('Line 1{shift+enter}Line 2');
    cy.get('.chat-input').should('have.value', 'Line 1\nLine 2');
    cy.get('@sendMessage').should('not.exist');
  });
});
