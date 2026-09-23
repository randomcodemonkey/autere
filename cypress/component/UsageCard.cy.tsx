import React from 'react';
import { UsageCard } from '../../src/frontend/components/UsageCard';
import type { SessionStats } from '../../src/frontend/types';

describe('UsageCard', () => {
  const defaultStats: SessionStats = {
    tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
    cost: 0.0234,
    contextUsage: { tokens: 15000, contextWindow: 200000, percent: 7.5 },
  };

  it('renders all stat values', () => {
    cy.mount(
      <UsageCard messageCount={42} requestCount={10} stats={defaultStats} />
    );
    cy.contains('Messages').parent().should('contain', '42');
    cy.contains('Requests').parent().should('contain', '10');
    cy.contains('Input Tokens').parent().should('contain', '1.0K');
    cy.contains('Output Tokens').parent().should('contain', '500');
    cy.contains('Cost').parent().should('contain', '$0.02'); // 2-decimal display
    cy.contains('Context').parent().should('contain', '15.0K / 200.0K');
  });

  it('formats large numbers with M suffix', () => {
    const stats: SessionStats = {
      tokens: { input: 1500000, output: 2000000, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsage: null,
    };
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={stats} />);
    cy.contains('Input Tokens').parent().should('contain', '1.5M');
    cy.contains('Output Tokens').parent().should('contain', '2.0M');
  });

  it('shows dash when no context usage', () => {
    const stats: SessionStats = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsage: null,
    };
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={stats} />);
    cy.contains('Context').parent().should('contain', '-');
  });

  it('renders progress bar with width based on context usage', () => {
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={defaultStats} />);
    cy.get('.progress-fill').should('have.css', 'width').and('not.equal', '0px');
  });

  it('shows context bar on header when collapsed, hidden when expanded', () => {
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={defaultStats} />);
    cy.get('.usage-header-bar').should('not.exist');
    cy.get('.card-header').click();
    cy.get('.card').should('have.class', 'collapsed');
    cy.get('.usage-header-bar').should('exist');
    cy.get('.usage-header-bar-fill').should('have.attr', 'style').and('contain', '7.5%');
    cy.get('.usage-header-bar').should('have.attr', 'title').and('contain', '8%');
  });

  it('header bar is vertically centered in the header', () => {
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={defaultStats} />);
    cy.get('.card-header').click();
    cy.get('.card-header').then(($h) => {
      const hTop = $h[0].getBoundingClientRect().top;
      const hMid = hTop + $h[0].getBoundingClientRect().height / 2;
      const bar = $h.find('.usage-header-bar')[0].getBoundingClientRect();
      const tgl = $h.find('.card-toggle')[0].getBoundingClientRect();
      cy.log('bar mid offset', (bar.top + bar.height / 2) - hMid);
      cy.log('toggle mid offset', (tgl.top + tgl.height / 2) - hMid);
      expect(Math.abs((bar.top + bar.height / 2) - hMid)).to.be.lessThan(2);
    });
  });

  it('shows no context bar on header when there is no context data', () => {
    const stats: SessionStats = { ...defaultStats, contextUsage: null };
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={stats} />);
    cy.get('.card-header').click();
    cy.get('.card').should('have.class', 'collapsed');
    cy.get('.usage-header-bar').should('not.exist');
  });

  it('toggles collapse state', () => {
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={defaultStats} />);
    cy.get('.card').should('not.have.class', 'collapsed');
    cy.get('.card-header').click();
    cy.get('.card').should('have.class', 'collapsed');
  });

  it('compact row: rendered only with onCompact, enabled by default, calls back', () => {
    const onCompact = cy.stub().as('compact');
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={defaultStats} onCompact={onCompact} />);
    cy.get('.usage-compact-row .btn').should('contain', 'Compact Context').and('not.be.disabled');
    cy.get('.usage-compact-row .btn').click();
    cy.get('@compact').should('have.been.calledOnce');
    // Without onCompact no row renders
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={defaultStats} />);
    cy.get('.usage-compact-row').should('not.exist');
  });

  it('compact row: disabled while compacting, shows progress label', () => {
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={defaultStats} onCompact={cy.stub()} compactDisabled compacting />);
    cy.get('.usage-compact-row .btn').should('contain', 'Compacting').and('be.disabled');
  });
});

describe('UsageCard reserve-% effective window', () => {
  const stats: SessionStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    contextUsage: { tokens: 330000, contextWindow: 1000000, percent: 33, effectiveWindow: 200000 },
  };

  it('shows context as effective (total) and % against the effective window', () => {
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={stats} />);
    cy.contains('Context').parent().should('contain', '330.0K / 200.0K (1.0M)');
    // 330k of the 200k usable window = full bar (capped at 100%)
    cy.get('.progress-fill').then(($el) => {
      const w = parseFloat($el.css('width'));
      const max = $el.parent().width() || 1;
      expect(w / max).to.be.closeTo(1, 0.01);
    });
  });

  it('falls back to plain display without effectiveWindow', () => {
    const plain: SessionStats = {
      tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
      cost: 0.0234,
      contextUsage: { tokens: 15000, contextWindow: 200000, percent: 7.5 },
    };
    cy.mount(<UsageCard messageCount={0} requestCount={0} stats={plain} />);
    cy.contains('Context').parent().should('contain', '15.0K / 200.0K');
    cy.contains('Context').parent().should('not.contain', '(');
  });
});
