import React from 'react';
import { ExtensionUiModal } from '../../src/frontend/components/ExtensionUiModal';

describe('ExtensionUiModal', () => {
  it('renders nothing without a request', () => {
    cy.mount(<ExtensionUiModal request={null} onRespond={cy.stub().as('respond')} />);
    cy.get('.modal-extension-ui').should('not.exist');
  });

  it('answers a select with the clicked option', () => {
    cy.mount(
      <ExtensionUiModal
        request={{ id: 'r1', method: 'select', title: 'Allow dangerous command?', options: ['Allow', 'Block'] }}
        onRespond={cy.stub().as('respond')}
      />,
    );
    cy.contains('.modal-extension-ui h3', 'Allow dangerous command?').should('exist');
    cy.contains('.extension-ui-options button', 'Block').click();
    cy.get('@respond').should('have.been.calledWith', { value: 'Block' });
  });

  it('answers a confirm with yes/no', () => {
    cy.mount(
      <ExtensionUiModal
        request={{ id: 'r2', method: 'confirm', title: 'Clear session?', message: 'All messages will be lost.' }}
        onRespond={cy.stub().as('respond')}
      />,
    );
    cy.contains('.extension-ui-message', 'All messages will be lost.').should('exist');
    cy.contains('.modal-extension-ui button', 'No').click();
    cy.get('@respond').should('have.been.calledWith', { confirmed: false });
  });

  it('submits typed input', () => {
    cy.mount(
      <ExtensionUiModal
        request={{ id: 'r3', method: 'input', title: 'Base URL', placeholder: 'https://…' }}
        onRespond={cy.stub().as('respond')}
      />,
    );
    cy.get('.modal-extension-ui input').should('have.attr', 'placeholder', 'https://…').type('http://x{enter}');
    cy.get('@respond').should('have.been.calledWith', { value: 'http://x' });
  });

  it('prefills and submits the editor text', () => {
    cy.mount(
      <ExtensionUiModal
        request={{ id: 'r4', method: 'editor', title: 'Edit', prefill: 'line 1\nline 2' }}
        onRespond={cy.stub().as('respond')}
      />,
    );
    cy.get('.extension-ui-editor').should('contain.value', 'line 1').type('\nline 3');
    cy.contains('.modal-extension-ui button', 'Submit').click();
    cy.get('@respond').should('have.been.calledWith', { value: 'line 1\nline 2\nline 3' });
  });

  it('cancels on close and shows the pi timeout', () => {
    cy.mount(
      <ExtensionUiModal
        request={{ id: 'r5', method: 'select', title: 'Pick', options: ['a'], timeout: 10000 }}
        onRespond={cy.stub().as('respond')}
      />,
    );
    cy.contains('.modal-extension-ui .settings-description', 'after 10s').should('exist');
    cy.get('.modal-extension-ui .modal-close').click();
    cy.get('@respond').should('have.been.calledWith', { cancelled: true });
  });
});
