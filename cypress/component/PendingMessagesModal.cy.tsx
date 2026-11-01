import React from 'react';
import { PendingMessagesModal } from '../../src/frontend/components/PendingMessagesModal';

describe('PendingMessagesModal', () => {
  it('lists steer and follow-up messages with their queue type', () => {
    cy.mount(
      <PendingMessagesModal steer={['first']} followUp={['second']} onClose={cy.stub()} onCancel={cy.stub()} onSave={cy.stub()} />,
    );
    cy.get('.pending-message').should('have.length', 2);
    cy.get('.pending-message').eq(0).find('.badge').should('have.text', 'Steer');
    cy.get('.pending-message').eq(1).find('.badge').should('have.text', 'Follow-up');
    cy.get('.pending-message-text').eq(1).should('have.value', 'second');
  });

  it('says so when nothing is queued', () => {
    cy.mount(<PendingMessagesModal steer={[]} followUp={[]} onClose={cy.stub()} onCancel={cy.stub()} onSave={cy.stub()} />);
    cy.contains('.settings-empty', 'Nothing is queued').should('exist');
  });

  it('cancels a queued message by its original text', () => {
    const onCancel = cy.stub().resolves(true).as('cancel');
    cy.mount(<PendingMessagesModal steer={['drop me']} followUp={[]} onClose={cy.stub()} onCancel={onCancel} onSave={cy.stub()} />);
    cy.contains('.pending-message button', 'Cancel').click();
    cy.get('@cancel').should('have.been.calledWith', 'drop me');
  });

  it('saves an edited message with the queue type', () => {
    const onSave = cy.stub().resolves(true).as('save');
    cy.mount(<PendingMessagesModal steer={['old']} followUp={[]} onClose={cy.stub()} onCancel={cy.stub()} onSave={onSave} />);
    cy.get('.pending-message-text').clear().type('new');
    cy.contains('.pending-message button', 'Save').click();
    cy.get('@save').should('have.been.calledWith', 'old', 'new', 'steer');
  });

  it('keeps the Save button disabled until the text changes', () => {
    cy.mount(<PendingMessagesModal steer={['same']} followUp={[]} onClose={cy.stub()} onCancel={cy.stub()} onSave={cy.stub()} />);
    cy.contains('.pending-message button', 'Save').should('be.disabled');
    cy.get('.pending-message-text').type(' more');
    cy.contains('.pending-message button', 'Save').should('not.be.disabled');
  });

  it('reports an ignored edit when pi already consumed the message', () => {
    cy.mount(
      <PendingMessagesModal
        steer={['gone']}
        followUp={[]}
        onClose={cy.stub()}
        onCancel={cy.stub().resolves(false)}
        onSave={cy.stub().resolves(true)}
      />,
    );
    cy.contains('.pending-message button', 'Cancel').click();
    cy.contains('.settings-error', 'already processed').should('exist');
  });
});
