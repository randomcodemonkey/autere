import React, { useState } from 'react';
import { MarkdownEditor } from '../../src/frontend/components/MarkdownEditor';

describe('MarkdownEditor (CodeMirror chat input)', () => {
  // Enter sends; Shift+Enter inserts a newline (textarea parity).
  it('sends on Enter, newlines on Shift+Enter', () => {
    const onSend = cy.stub().as('onSend');
    const onChange = cy.stub().as('onChange');
    cy.mount(<MarkdownEditor value="" onChange={onChange} onSend={onSend} />);
    cy.get('.cm-content').invoke('focus');
    cy.get('.cm-content').type('Line 1{shift+enter}Line 2');
    cy.get('@onSend').should('not.have.been.called');
    cy.get('@onChange').should('have.been.calledWith', 'Line 1');
    cy.get('.cm-line').first().should('have.text', 'Line 1');
    cy.get('.cm-line').eq(1).should('have.text', 'Line 2');
    cy.get('.cm-content').type('{enter}');
    cy.get('@onSend').should('have.been.calledOnce');
  });

  it('applies markdown highlight classes while typing', () => {
    cy.mount(<MarkdownEditor value="" onChange={cy.stub()} onSend={cy.stub()} />);
    cy.get('.cm-content').invoke('focus');
    cy.get('.cm-content').type('# Title');
    cy.get('.md-heading').should('have.text', '# Title');
    cy.get('.cm-content').type('{enter}**bold** and `code`');
    cy.get('.md-strong').should('exist');
    cy.get('.md-code').should('have.text', 'code');
  });

  it('stays in sync with a controlled value prop', () => {
    function Controlled() {
      const [v, setV] = useState('');
      return (
        <div>
          <button onClick={() => setV('from-parent')}>set</button>
          <MarkdownEditor value={v} onChange={setV} onSend={() => {}} />
        </div>
      );
    }
    cy.mount(<Controlled />);
    cy.get('button').click();
    cy.get('.cm-content').should('have.text', 'from-parent');
    // Typing still flows back up
    cy.get('.cm-content').invoke('focus');
    cy.get('.cm-content').type(' tail');
    cy.get('.cm-content').should('have.text', 'from-parent tail');
  });

  // Send clears the input while the scroller is scrolled down (multiline
  // draft): the empty editor must be back at the top or the placeholder
  // renders half cut off.
  it('resets scroll to top when cleared externally', () => {
    function Controlled() {
      const [v, setV] = useState('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl');
      return (
        <div>
          <button onClick={() => setV('')}>clear</button>
          <MarkdownEditor value={v} onChange={setV} onSend={() => {}} style={{ height: '6rem' }} />
        </div>
      );
    }
    cy.mount(<Controlled />);
    cy.get('.cm-content').invoke('focus');
    cy.get('.cm-content').type('{end}{ctrl+end}');
    cy.get('.cm-scroller').should(($el) => expect($el[0].scrollTop).to.be.greaterThan(0));
    cy.get('button').click();
    cy.get('.cm-scroller').should(($el) => expect($el[0].scrollTop).to.equal(0));
  });

  it('is read-only when disabled', () => {
    cy.mount(<MarkdownEditor value="" onChange={cy.stub()} onSend={cy.stub()} disabled={true} />);
    cy.get('.cm-content').should('have.attr', 'contenteditable', 'false');
  });

  it('shows the placeholder', () => {
    cy.mount(<MarkdownEditor value="" onChange={cy.stub()} onSend={cy.stub()} placeholder="Steer the agent..." />);
    cy.get('.cm-placeholder').should('have.text', 'Steer the agent...');
  });
});
