import React from 'react';
import { SortableList } from '../../src/frontend/components/SortableList';

describe('SortableList', () => {
  it('renders existing items with edit inputs', () => {
    cy.mount(<SortableList items={['alpha', 'beta']} onChange={() => {}} />);
    cy.get('.sortable-list-item').should('have.length', 2);
    cy.get('.sortable-list-item input').first().should('have.value', 'alpha');
    cy.get('.sortable-list-item input').eq(1).should('have.value', 'beta');
  });

  it('adds a new item via the Add button', () => {
    const onChange = cy.stub().as('onChange');
    cy.mount(<SortableList items={['alpha']} onChange={onChange} />);
    cy.get('.sortable-list-add input').type('gamma');
    cy.get('.sortable-list-add-btn').click();
    cy.get('@onChange').should('have.been.calledOnceWithExactly', ['alpha', 'gamma']);
    // input cleared
    cy.get('.sortable-list-add input').should('have.value', '');
  });

  it('adds a new item via Enter key', () => {
    const onChange = cy.stub().as('onChange');
    cy.mount(<SortableList items={[]} onChange={onChange} />);
    cy.get('.sortable-list-add input').type('solo{enter}');
    cy.get('@onChange').should('have.been.calledOnceWithExactly', ['solo']);
  });

  it('does not add empty or whitespace-only items', () => {
    const onChange = cy.stub().as('onChange');
    cy.mount(<SortableList items={[]} onChange={onChange} />);
    cy.get('.sortable-list-add input').type('   {enter}');
    cy.get('@onChange').should('not.have.been.called');
  });

  it('does not add duplicate items', () => {
    const onChange = cy.stub().as('onChange');
    cy.mount(<SortableList items={['alpha']} onChange={onChange} />);
    cy.get('.sortable-list-add input').type('alpha{enter}');
    cy.get('@onChange').should('not.have.been.called');
  });

  it('removes an item', () => {
    const onChange = cy.stub().as('onChange');
    cy.mount(<SortableList items={['alpha', 'beta']} onChange={onChange} />);
    cy.get('.sortable-list-item .sortable-list-remove').first().click();
    cy.get('@onChange').should('have.been.calledOnceWithExactly', ['beta']);
  });

  it('edits an item inline', () => {
    // The component is controlled: typing calls onChange per keystroke, so
    // mount a stateful wrapper that applies the updates (as real usage does).
    const Wrapper = () => {
      const [items, setItems] = React.useState(['alpha']);
      return <SortableList items={items} onChange={setItems} />;
    };
    cy.mount(<Wrapper />);
    // Set the value with the native setter + input event (standard trick for
    // React controlled inputs that re-render mid-command).
    cy.get('.sortable-list-item input').first().then(($el) => {
      const el = $el[0] as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, 'delta');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    cy.get('.sortable-list-item input').first().should('have.value', 'delta');
  });

  it('disables all controls when disabled', () => {
    const onChange = cy.stub().as('onChange');
    cy.mount(<SortableList items={['alpha']} onChange={onChange} disabled={true} />);
    cy.get('.sortable-list-item input').should('be.disabled');
    cy.get('.sortable-list-item .sortable-list-remove').should('be.disabled');
    cy.get('.sortable-list-add input').should('be.disabled');
    cy.get('.sortable-list-add-btn').should('be.disabled');
  });

  it('uses custom placeholder and add label', () => {
    cy.mount(
      <SortableList items={[]} onChange={() => {}} placeholder="Custom…" addLabel="Add item" />
    );
    cy.get('.sortable-list-add input').should('have.attr', 'placeholder', 'Custom…');
    cy.get('.sortable-list-add-btn').should('contain', 'Add item');
  });
});
