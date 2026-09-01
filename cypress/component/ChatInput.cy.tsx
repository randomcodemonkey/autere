import React from 'react';
import { ChatInput } from '../../src/frontend/components/ChatInput';

describe('ChatInput slash commands', () => {
  it('/new triggers onNewSession when idle', () => {
    const onNewSession = cy.stub().as('onNewSession');
    cy.mount(<ChatInput onNewSession={onNewSession} />);
    cy.get('.chat-input').type('/new{enter}');
    cy.get('@onNewSession').should('have.been.calledOnce');
  });

  it('/clear is an alias for /new', () => {
    const onNewSession = cy.stub().as('onNewSession');
    cy.mount(<ChatInput onNewSession={onNewSession} />);
    cy.get('.chat-input').type('/clear{enter}');
    cy.get('@onNewSession').should('have.been.calledOnce');
  });

  it('/new shows an error when active (Working state)', () => {
    const onNewSession = cy.stub().as('onNewSession');
    const onError = cy.stub().as('onError');
    cy.mount(<ChatInput onNewSession={onNewSession} onError={onError} isActive={true} />);
    cy.get('.chat-input').type('/new{enter}');
    cy.get('@onNewSession').should('not.have.been.called');
    cy.get('@onError').should('have.been.calledOnce');
    cy.get('@onError').its('firstCall.args.0').should('contain', 'only be used when idle');
  });

  it('/compact triggers onCompact when idle', () => {
    const onCompact = cy.stub().as('onCompact');
    cy.mount(<ChatInput onNewSession={() => {}} onCompact={onCompact} />);
    cy.get('.chat-input').type('/compact{enter}');
    cy.get('@onCompact').should('have.been.calledOnce');
  });

  it('/compact shows an error when active (Working state)', () => {
    const onCompact = cy.stub().as('onCompact');
    const onError = cy.stub().as('onError');
    cy.mount(<ChatInput onNewSession={() => {}} onCompact={onCompact} onError={onError} isActive={true} />);
    cy.get('.chat-input').type('/compact{enter}');
    cy.get('@onCompact').should('not.have.been.called');
    cy.get('@onError').should('have.been.calledOnce');
  });

  it('/help shows the available commands without contacting the backend', () => {
    cy.intercept('POST', '**/api/send', { statusCode: 500, body: { success: false } }).as('send');
    cy.mount(<ChatInput onNewSession={() => {}} />);
    cy.get('.chat-input').type('/help{enter}');
    cy.get('.chat-help-box').should('be.visible');
    cy.get('.chat-help-cmd').should('contain', '/new');
    cy.get('.chat-help-cmd').should('contain', '/compact');
    cy.get('.chat-help-cmd').should('contain', '/help');
    // Close it
    cy.get('.chat-help-close').click();
    cy.get('.chat-help-box').should('not.exist');
    cy.get('@send.all').should('have.length', 0);
  });

  it('unknown slash command shows an error', () => {
    const onError = cy.stub().as('onError');
    cy.mount(<ChatInput onNewSession={() => {}} onError={onError} />);
    cy.get('.chat-input').type('/frobnicate{enter}');
    cy.get('@onError').should('have.been.calledWith', 'Unknown command: /frobnicate — type /help to see available commands.');
  });

  it('regular messages do not trigger commands and go to the backend', () => {
    cy.intercept('POST', '**/api/send', { success: true }).as('send');
    cy.mount(<ChatInput onNewSession={() => {}} />);
    cy.get('.chat-input').type('hello world{enter}');
    cy.wait('@send');
    cy.get('.chat-help-box').should('not.exist');
  });
});
