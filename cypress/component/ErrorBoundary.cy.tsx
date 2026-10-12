// ErrorBoundary: render errors → styled fallback; stale chunk → reload hint.
// The crashing child renders on a rerender (initial-mount throws bubble as
// window errors in the cypress harness instead of being boundary-caught).
import React from 'react';
import ErrorBoundary from '../../src/frontend/components/ErrorBoundary';

/** Crash AFTER mount when the switch button is pressed — the boundary then
 *  catches the rerender error the way production errors usually occur. */
function Crasher({ mode, onCrash }: { mode: 'plain' | 'chunk'; onCrash: () => void }): JSX.Element {
  const [crash, setCrash] = React.useState(false);
  if (crash) {
    if (mode === 'chunk') throw new Error('Unable to preload CSS for /assets/EditsPage-Cuo9tjen.css');
    throw new Error('kaboom');
  }
  return <button onClick={() => { onCrash(); setCrash(true); }}>break</button>;
}

function Healthy(): JSX.Element {
  const [broken, setBroken] = React.useState(false);
  if (broken) throw new Error('one-off');
  return <button onClick={() => setBroken(true)}>break</button>;
}

describe('ErrorBoundary', () => {
  // React's DEV build rethrows handled boundary errors as window error events
  // (so devtools show them) — production browsers don't do this. Suppress
  // ONLY our test-speculate error payloads; anything else stays a failure.
  const DEV_RETHROWS = ['kaboom', 'Unable to preload CSS', 'one-off'];
  beforeEach(() => {
    Cypress.on('uncaught:exception', (err) => !DEV_RETHROWS.some((m) => err.message?.includes(m)));
  });

  it('render crash shows the fallback card with a try-again recovery', () => {
    cy.mount(
      <ErrorBoundary name="Files">
        <Crasher mode="plain" onCrash={() => {}} />
      </ErrorBoundary>,
    );
    cy.contains('button', 'break').click();
    cy.get('.error-boundary-card').should('exist');
    cy.contains('.card-title', 'Files failed to render');
    cy.contains('.error-boundary-message', 'kaboom');
    cy.contains('button', 'Try again').should('be.visible');
  });

  it('stale chunk error tells the user a page reload is required', () => {
    cy.mount(
      <ErrorBoundary name="Files">
        <Crasher mode="chunk" onCrash={() => {}} />
      </ErrorBoundary>,
    );
    cy.contains('button', 'break').click();
    cy.get('.error-boundary-card').should('exist');
    cy.contains('.error-boundary-message', 'Unable to preload CSS');
    cy.contains('button', 'Reload page').should('be.visible');
  });

  it('Try again recovers and renders the child again', () => {
    cy.mount(
      <ErrorBoundary name="S">
        <Healthy />
      </ErrorBoundary>,
    );
    cy.contains('button', 'break').click();
    cy.get('.error-boundary-card').should('exist');
    cy.contains('button', 'Try again').click();
    cy.contains('button', 'break').should('be.visible'); // reset state → child renders again
  });
});
