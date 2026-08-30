import React from 'react';
import { Modal } from '../../src/frontend/components/Modal';

describe('Modal', () => {
  it('renders children when open', () => {
    cy.mount(
      <Modal open={true} onClose={cy.stub()}>
        <div data-testid="modal-content">Hello World</div>
      </Modal>
    );
    cy.get('[data-testid="modal-content"]').should('be.visible');
    cy.get('.modal-overlay').should('have.class', 'open');
  });

  it('does not render visible content when closed', () => {
    cy.mount(
      <Modal open={false} onClose={cy.stub()}>
        <div data-testid="modal-content">Hello World</div>
      </Modal>
    );
    cy.get('.modal-overlay').should('not.have.class', 'open');
  });

  it('calls onClose when overlay is clicked', () => {
    const onClose = cy.stub().as('onClose');
    cy.mount(
      <Modal open={true} onClose={onClose}>
        <div style={{ width: 100, height: 100, margin: '50px' }}>Content</div>
      </Modal>
    );
    // Click the overlay outside the modal content - use coordinates at the edge
    cy.get('.modal-overlay').click(0, 0, { force: true });
    cy.get('@onClose').should('have.been.calledOnce');
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = cy.stub().as('onClose');
    cy.mount(
      <Modal open={true} onClose={onClose}>
        <div>Content</div>
      </Modal>
    );
    cy.get('body').type('{esc}');
    cy.get('@onClose').should('have.been.calledOnce');
  });

  it('does not call onClose when clicking inside modal content', () => {
    const onClose = cy.stub().as('onClose');
    cy.mount(
      <Modal open={true} onClose={onClose}>
        <div className="modal-content-inner">Content</div>
      </Modal>
    );
    cy.get('.modal-content-inner').click();
    cy.get('@onClose').should('not.have.been.called');
  });

  it('applies custom className', () => {
    cy.mount(
      <Modal open={true} onClose={cy.stub()} className="modal-status">
        <div>Content</div>
      </Modal>
    );
    cy.get('.modal').should('have.class', 'modal-status');
  });
});
