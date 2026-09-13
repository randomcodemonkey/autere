import React, { useState } from 'react';
import { SortableList } from '../../src/frontend/components/SortableList';
import { SettingsCard } from '../../src/frontend/components/SettingsCard';

describe('SortableList focus retention', () => {
  // Stateful parent: controlled inputs update for real while we watch focus.
  const Stateful: React.FC<{ initial: string[] }> = ({ initial }) => {
    const [items, setItems] = useState(initial);
    return <SortableList items={items} onChange={setItems} />;
  };

  it('keeps focus while typing in an existing item input', () => {
    cy.mount(<Stateful initial={['alpha', 'beta']} />);
    cy.get('.sortable-list-item input').first().click();
    cy.focused().should('have.class', 'sortable-list-input');
    // Typing must not remount the input (old code keyed rows by content,
    // so the first keystroke dropped focus).
    cy.get('.sortable-list-item input').first().type('x');
    cy.focused().should('have.class', 'sortable-list-input');
    cy.get('.sortable-list-item input').first().should('have.value', 'alphax');
  });

  it('add input keeps focus while typing', () => {
    cy.mount(<Stateful initial={[]} />);
    cy.get('.sortable-list-add input').click().type('new-dir');
    cy.focused().should('have.class', 'sortable-list-input');
    cy.get('.sortable-list-add input').should('have.value', 'new-dir');
  });
});

describe('SettingsCard focus retention', () => {
  const schema = [
    {
      id: 's1',
      label: 'Section',
      fields: [
        { key: 'name', label: 'Name', type: 'text' as const },
        { key: 'dirs', label: 'Ignored folders', type: 'list' as const },
      ],
    },
  ];

  // Parent harness that re-renders SettingsCard on click (any SSE-driven
  // parent update has the same effect).
  const Harness: React.FC = () => {
    const [tick, setTick] = useState(0);
    return (
      <>
        <button onClick={() => setTick(tick + 1)}>rerender</button>
        <SettingsCard sseConnected={tick === 0} />
      </>
    );
  };

  beforeEach(() => {
    cy.intercept('GET', '**/api/settings/schema', { success: true, data: schema });
    cy.intercept('GET', '**/api/settings', { success: true, data: { name: '', dirs: ['one'] } });
    cy.intercept('GET', '**/api/extensions/packages', { success: true, data: { available: [] } });
  });

  it('does not remount field inputs across a re-render', () => {
    cy.mount(<Harness />);
    cy.get('.settings-input').first().should('exist').click();
    cy.focused().type('hello');
    cy.get('.settings-input').first().should('have.value', 'hello');
    // Mark the DOM node, re-render, and require the SAME node to still be
    // there. Old code remounted FieldShell (defined inside the component) on
    // every re-render — fresh node, focus gone.
    cy.get('.settings-input').first().then(($el) => {
      ($el[0] as any).__marker = 1;
    });
    cy.get('button').contains('rerender').click();
    cy.get('.settings-input').first().should(($el) => {
      expect(($el[0] as any).__marker, 'input DOM node survived the re-render').to.eq(1);
    });
    cy.get('.settings-input').first().should('have.value', 'hello');
  });

  it('keeps list item focus while typing', () => {
    cy.mount(<Harness />);
    cy.get('.sortable-list-item input').first().should('exist').click();
    cy.focused().type('x');
    cy.focused().should('have.class', 'sortable-list-input');
    cy.get('.sortable-list-item input').first().should('have.value', 'onex');
  });
});
