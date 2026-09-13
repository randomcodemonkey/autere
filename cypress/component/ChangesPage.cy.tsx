import React from 'react';
import { ChangesPage } from '../../src/frontend/components/ChangesPage';

const longDiff = Array.from({ length: 80 }, (_, i) => `line ${i} of the diff body text`).join('\n');

const changes = [
  { ts: 1, path: 'src/long.ts', tool: 'edit', change: 'modified', diff: longDiff },
  { ts: 2, path: 'src/short.ts', tool: 'edit', change: 'modified', diff: 'one short line' },
];

const mountPage = () => {
  cy.intercept('GET', '**/file-changes', { success: true, data: changes });
  // Height-constrained wrapper: gives .changes-mods a real overflow context.
  cy.mount(
    <div style={{ height: '400px', display: 'flex' }}>
      <ChangesPage sessionId="s1" />
    </div>
  );
};

describe('ChangesPage file selection', () => {
  it('scrolls the diff back to top when switching files', () => {
    mountPage();
    // The component-mount harness lacks the app's height-constrained
    // ancestor chain, so the mods pane never actually overflows here —
    // assert the reset mechanism (scrollTo(0,0) on selection change).
    cy.get('.changes-mods').then(($el) => {
      cy.spy($el[0], 'scrollTo').as('scrollTo');
    });
    cy.get('.changes-file').contains('src/long.ts').click();
    cy.get('@scrollTo').should('have.been.calledWith', 0, 0);
    cy.get('.changes-file').contains('src/short.ts').click();
    cy.get('@scrollTo').should('have.been.calledWith', 0, 0);
  });

  it('deselects on second click — diff hidden, list takes full height', () => {
    mountPage();
    cy.get('.changes-file').contains('src/long.ts').click();
    cy.get('.changes-mods').should('exist');

    // Click the already-selected file: diff hides, list expands.
    cy.get('.changes-file').contains('src/long.ts').click();
    cy.get('.changes-mods').should('not.exist');
    cy.get('.changes-page').should('have.class', 'no-selection');

    // Selecting again restores the diff pane.
    cy.get('.changes-file').contains('src/long.ts').click();
    cy.get('.changes-mods').should('exist');
    cy.get('.changes-page').should('not.have.class', 'no-selection');
  });
});
