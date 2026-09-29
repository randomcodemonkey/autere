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
    <div style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
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

  it('shows every incremental edit to one file, not just the last one', () => {
    // Regression: the old per-path+change dedupe collapsed repeated
    // 'modified' rows into one entry, losing all but the newest diff.
    cy.intercept('GET', '**/file-changes', {
      success: true,
      data: [
        { ts: 1, path: 'src/x.ts', tool: 'edit', change: 'modified', diff: 'first edit' },
        { ts: 2, path: 'src/x.ts', tool: 'edit', change: 'modified', diff: 'second edit' },
        { ts: 3, path: 'src/x.ts', tool: 'edit', change: 'modified', diff: 'third edit' },
      ],
    });
    cy.mount(
      <div style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
        <ChangesPage sessionId="s1" />
      </div>
    );
    // src/x.ts is the newest change's file → auto-selected without a click
    cy.get('.changes-mod').should('have.length', 3);
    cy.get('.changes-mod-diff').last().should('contain', 'third edit');
  });

  it('deselects on second click — empty state in the detail pane', () => {
    mountPage();
    cy.get('.changes-file').contains('src/long.ts').click();
    cy.get('.changes-mods .changes-mod').should('exist');

    // Click the already-selected file: detail pane shows the empty state.
    cy.get('.changes-file').contains('src/long.ts').click();
    cy.get('.changes-mods').should('contain', 'Select a file to view its changes');

    // Selecting again restores the diff pane.
    cy.get('.changes-file').contains('src/long.ts').click();
    cy.get('.changes-mods .changes-mod').should('exist');
  });
});
