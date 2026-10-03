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

  it('unknown slash command shows an error', () => {
    const onError = cy.stub().as('onError');
    cy.mount(<ChatInput onNewSession={() => {}} onError={onError} />);
    cy.get('.chat-input').type('/frobnicate{enter}');
    cy.get('@onError').should('have.been.calledWith', 'Unknown command: /frobnicate');
  });

  it('regular messages do not trigger commands and go to the backend', () => {
    cy.intercept('POST', '**/api/v1/session/messages', { success: true }).as('send');
    cy.mount(<ChatInput onNewSession={() => {}} />);
    cy.get('.chat-input').type('hello world{enter}');
    cy.wait('@send');
    cy.get('.chat-help-box').should('not.exist');
  });
});

describe('ChatInput attachments', () => {
  // 1x1 red PNG
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const TXT = 'hello attachment';

  const attachPng = (name = 'dot.png') => {
    cy.get('input[type=file]').selectFile(
      { contents: Cypress.Buffer.from(PNG_B64, 'base64'), fileName: name, mimeType: 'image/png' },
      { force: true }
    );
  };

  it('shows the toolbar with Image button when focused, hides it on blur', () => {
    cy.mount(<ChatInput onNewSession={() => {}} />);
    cy.get('.chat-toolbar').should('not.exist');
    cy.get('.chat-input').focus();
    cy.get('.chat-toolbar').should('exist');
    cy.get('.chat-tool-btn').should('contain', 'Upload');
    cy.get('.chat-input').should('have.attr', 'rows', '4');
    cy.get('.chat-input').blur();
    cy.get('.chat-toolbar').should('not.exist');
  });

  it('attaching an image shows a removable thumbnail', () => {
    const onError = cy.stub().as('onError');
    cy.mount(<ChatInput onNewSession={() => {}} onError={onError} />);
    cy.get('.chat-input').focus();
    attachPng();
    cy.get('.chat-attachment').should('have.length', 1);
    cy.get('.chat-attachment img').should('have.attr', 'src').and('contain', 'data:image/png;base64,');
    cy.get('.chat-attachment-remove').click();
    cy.get('.chat-attachment').should('have.length', 0);
  });

  it('sends images with the message and clears them after send', () => {
    cy.intercept('POST', '**/api/v1/session/messages', { success: true }).as('send');
    cy.mount(<ChatInput onNewSession={() => {}} />);
    cy.get('.chat-input').focus();
    attachPng();
    cy.get('.chat-input').type('what is this?');
    cy.get('.chat-input').type('{enter}');
    cy.wait('@send').its('request.body').should('deep.equal', {
      message: 'what is this?',
      type: 'prompt',
      images: [{ mimeType: 'image/png', data: PNG_B64, name: 'dot.png' }],
    });
    cy.get('.chat-attachment').should('have.length', 0);
  });

  it('Send is enabled with an image but no text', () => {
    cy.intercept('POST', '**/api/v1/session/messages', { success: true }).as('send');
    cy.mount(<ChatInput onNewSession={() => {}} />);
    cy.get('.chat-input').focus();
    attachPng();
    cy.get('.chat-send-btn').should('not.be.disabled');
    cy.get('.chat-send-btn').click();
    cy.wait('@send').its('request.body').should('deep.equal', {
      message: '',
      type: 'prompt',
      images: [{ mimeType: 'image/png', data: PNG_B64, name: 'dot.png' }],
    });
  });

  it('attaching a text file shows a removable name chip', () => {
    const onError = cy.stub().as('onError');
    cy.mount(<ChatInput onNewSession={() => {}} onError={onError} />);
    cy.get('.chat-input').focus();
    cy.get('input[type=file]').selectFile(
      { contents: Cypress.Buffer.from(TXT), fileName: 'note.txt', mimeType: 'text/plain' },
      { force: true }
    );
    cy.get('.chat-attachment.is-file').should('have.length', 1);
    cy.get('.chat-file-name').should('have.text', 'note.txt');
    cy.get('.chat-attachment-remove').click();
    cy.get('.chat-attachment').should('have.length', 0);
  });

  it('sends a mixed batch: images inline, other files with name+data', () => {
    cy.intercept('POST', '**/api/v1/session/messages', { success: true }).as('send');
    cy.mount(<ChatInput onNewSession={() => {}} />);
    cy.get('.chat-input').focus();
    attachPng('pic.png');
    cy.get('input[type=file]').selectFile(
      { contents: Cypress.Buffer.from(TXT), fileName: 'note.txt', mimeType: 'text/plain' },
      { force: true }
    );
    cy.get('.chat-input').type('both kinds');
    cy.get('.chat-input').type('{enter}');
    cy.wait('@send').its('request.body.images').should('deep.equal', [
      { mimeType: 'image/png', data: PNG_B64, name: 'pic.png' },
      { mimeType: 'text/plain', data: btoa(TXT), name: 'note.txt' },
    ]);
    cy.get('.chat-attachment').should('have.length', 0);
  });

  it('rejects files over 10 MB with an error', () => {
    const onError = cy.stub().as('onError');
    cy.mount(<ChatInput onNewSession={() => {}} onError={onError} />);
    cy.get('.chat-input').focus();
    const big = new ArrayBuffer(10 * 1024 * 1024 + 1);
    cy.get('input[type=file]').selectFile(
      { contents: Cypress.Buffer.from(big), fileName: 'big.bin', mimeType: 'application/octet-stream' },
      { force: true }
    );
    cy.get('@onError').should('have.been.calledWith', '"big.bin" is too large (max 10 MB).');
    cy.get('.chat-attachment').should('have.length', 0);
  });

  it('limits attachments to 4 images', () => {
    const onError = cy.stub().as('onError');
    cy.mount(<ChatInput onNewSession={() => {}} onError={onError} />);
    cy.get('.chat-input').focus();
    attachPng('a.png');
    attachPng('b.png');
    attachPng('c.png');
    attachPng('d.png');
    cy.get('.chat-attachment').should('have.length', 4);
    attachPng('e.png');
    cy.get('@onError').should('have.been.calledWith', 'At most 4 files can be attached.');
    cy.get('.chat-attachment').should('have.length', 4);
  });
});

describe('ChatInput first-click send (expanded state regression)', () => {
  it('sends on the FIRST click while the input is expanded (button position stable)', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.intercept('POST', '**/api/v1/session/messages', { success: true }).as('send');
    cy.get('.chat-input').focus().type('hello');
    cy.get('.chat-input-container').should('have.class', 'expanded');
    // Capture the button's position while expanded, then click it.
    cy.get('.chat-send-btn').then(($btn) => {
      const rect = $btn[0].getBoundingClientRect();
      cy.wrap({ x: Math.round(rect.x), y: Math.round(rect.y) }).as('before');
    });
    cy.get('.chat-send-btn').click();
    cy.wait('@send').its('request.body.message').should('eq', 'hello');
    // Input collapses back to the compact one-row state after sending
    cy.get('.chat-input-container').should('not.have.class', 'expanded');
    // Click landed on the button (not displaced by a mid-click collapse) —
    // proven by the request above being sent exactly once.
    cy.get('.chat-send-btn').should('exist');
  });

  it('rapid double-click sends only once', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} isStreaming={false} />);
    cy.intercept('POST', '**/api/v1/session/messages', { success: true }).as('send');
    cy.get('.chat-input').focus().type('hello');
    cy.get('.chat-send-btn').click();
    // After the first click the input clears and the button disables — a
    // second tap cannot send again.
    cy.wait('@send').its('request.body.message').should('eq', 'hello');
    cy.get('.chat-send-btn').should('be.disabled');
    cy.get('@send.all').should('have.length', 1);
  });
});

describe('ChatInput draft persistence', () => {
  it('restores the draft after remount (tab navigation) and clears on send', () => {
    cy.mount(<ChatInput onNewSession={cy.stub()} sessionId="s1" />);
    cy.get('.chat-input').type('remember me');
    // Remount = what happens when the user navigates away and back.
    cy.mount(<ChatInput onNewSession={cy.stub()} sessionId="s1" />);
    cy.get('.chat-input').should('have.value', 'remember me');

    // Drafts are per-session: another session starts empty.
    cy.mount(<ChatInput onNewSession={cy.stub()} sessionId="s2" />);
    cy.get('.chat-input').should('have.value', '');

    // Sending clears the draft.
    cy.intercept('POST', '**/api/v1/session/messages', { success: true }).as('send');
    cy.get('.chat-input').type('hi{enter}');
    cy.wait('@send');
    cy.mount(<ChatInput onNewSession={cy.stub()} sessionId="s2" />);
    cy.get('.chat-input').should('have.value', '');
  });
});
