import React from 'react';
import { useCardState } from '../../src/frontend/hooks/useCardState';

// Test wrapper component for the hook
function TestComponent({ cardId, defaultCollapsed }: { cardId: string; defaultCollapsed?: boolean }) {
  const { collapsed, toggle } = useCardState(cardId, defaultCollapsed);
  return (
    <div>
      <span data-testid="collapsed">{String(collapsed)}</span>
      <button data-testid="toggle" onClick={toggle}>Toggle</button>
    </div>
  );
}

describe('useCardState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to expanded on desktop', () => {
    cy.mount(<TestComponent cardId="test" />);
    cy.get('[data-testid="collapsed"]').should('contain', 'false');
  });

  it('toggles collapsed state', () => {
    cy.mount(<TestComponent cardId="test" />);
    cy.get('[data-testid="collapsed"]').should('contain', 'false');
    cy.get('[data-testid="toggle"]').click();
    cy.get('[data-testid="collapsed"]').should('contain', 'true');
    cy.get('[data-testid="toggle"]').click();
    cy.get('[data-testid="collapsed"]').should('contain', 'false');
  });

  it('persists state to localStorage', () => {
    cy.mount(<TestComponent cardId="test" />);
    cy.get('[data-testid="toggle"]').click();
    cy.get('[data-testid="collapsed"]').should('contain', 'true');
    // Check localStorage was updated
    cy.window().then((win) => {
      const stored = win.localStorage.getItem('autere-card-test-desktop');
      expect(stored).to.equal('1');
    });
  });

  it('uses different keys for mobile vs desktop', () => {
    // Set different values for mobile and desktop
    localStorage.setItem('autere-card-test-desktop', '1');
    localStorage.setItem('autere-card-test-mobile', '0');
    
    cy.mount(<TestComponent cardId="test" />);
    // Desktop should be collapsed (stored as '1')
    cy.get('[data-testid="collapsed"]').should('contain', 'true');
  });

  it('uses defaultCollapsed when no stored value (mobile only)', () => {
    // On desktop, cards always default to expanded regardless of defaultCollapsed
    // On mobile, defaultCollapsed is respected for non-chat cards
    cy.mount(<TestComponent cardId="test" defaultCollapsed={true} />);
    // Desktop viewport - should be expanded (false)
    cy.get('[data-testid="collapsed"]').should('contain', 'false');
  });

  it('each card has independent state', () => {
    function TestApp() {
      const card1 = useCardState('card1');
      const card2 = useCardState('card2');
      return (
        <div>
          <span data-testid="card1">{String(card1.collapsed)}</span>
          <span data-testid="card2">{String(card2.collapsed)}</span>
          <button data-testid="toggle1" onClick={card1.toggle}>Toggle 1</button>
          <button data-testid="toggle2" onClick={card2.toggle}>Toggle 2</button>
        </div>
      );
    }

    cy.mount(<TestApp />);
    cy.get('[data-testid="card1"]').should('contain', 'false');
    cy.get('[data-testid="card2"]').should('contain', 'false');
    cy.get('[data-testid="toggle1"]').click();
    cy.get('[data-testid="card1"]').should('contain', 'true');
    cy.get('[data-testid="card2"]').should('contain', 'false');
  });
});
