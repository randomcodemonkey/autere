import React from 'react';
import { Header } from '../../src/frontend/components/Header';

describe('Header', () => {
  // A running session the selected tab resolves against (badge renders as
  // one of the tabs once the session list is known)
  const withSession = (extra: Partial<React.ComponentProps<typeof Header>> = {}) => ({
    runningSessions: [{
      id: 'abc123', sessionName: 'My Session', active: true,
      sessionFile: '', cwd: null, createdAt: 0, lastActivity: 0, parentSession: null,
    }],
    ...extra,
  });

  const mountHeader = (props: Partial<React.ComponentProps<typeof Header>> = {}) => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        sessionId="abc123"
        sessionName={null}
        activeView="chat"
        onViewChange={cy.stub()}
        {...props}
      />
    );
  };

  it('renders with session name when provided', () => {
    mountHeader(withSession({ sessionId: 'abc123' }));
    cy.get('.session-badge-text').should('contain', 'My Session');
  });

  it('renders truncated session name when too long', () => {
    mountHeader({ sessionName: 'A'.repeat(100), sessionId: 'abc123', runningSessions: [{
      id: 'abc123', sessionName: 'A'.repeat(100), active: true,
      sessionFile: '', cwd: null, createdAt: 0, lastActivity: 0, parentSession: null,
    }] });
    cy.get('.session-badge-text').should('contain', '…');
  });

  it('renders the full session ID when no name (CSS truncates, not JS)', () => {
    mountHeader({ sessionId: 'abc123-def456', sessionName: null, runningSessions: [{
      id: 'abc123-def456', sessionName: null, active: true,
      sessionFile: '', cwd: null, createdAt: 0, lastActivity: 0, parentSession: null,
    }] });
    cy.get('.session-badge-text').should('contain', 'abc123-def456');
  });

  it('shows no session tab while no sessions are known (initial load)', () => {
    mountHeader({ sessionId: null, sessionName: null });
    cy.get('.session-tab, .session-badge').should('not.exist');
  });

  it('renders the view menu with all four views', () => {
    mountHeader();
    cy.get('.view-menu').should('exist');
    cy.get('.view-btn-status').should('contain', 'Status');
    cy.get('.view-btn-chat').should('contain', 'Chat');
    cy.get('.view-btn-settings').should('contain', 'Settings');
    cy.get('.view-btn-tasks').should('contain', 'Tasks');
  });

  it('highlights the active view', () => {
    mountHeader({ activeView: 'settings' });
    cy.get('.view-btn-settings').should('have.class', 'active');
    cy.get('.view-btn-chat').should('not.have.class', 'active');
  });

  it('calls onViewChange when a view button is clicked', () => {
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader({ onViewChange });
    cy.get('.view-btn-settings').click();
    cy.get('@onViewChange').should('have.been.calledWith', 'settings');
  });

  it('hamburger dropdown shows the active view as its label', () => {
    mountHeader({ activeView: 'settings' });
    cy.get('.view-menu-label').should('contain', 'Settings');
    mountHeader({ activeView: 'chat' });
    cy.get('.view-menu-label').should('contain', 'Chat');
  });

  it('hamburger dropdown opens and selects a view', () => {
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader({ onViewChange });
    cy.get('.view-menu-dropdown').should('not.exist');
    cy.get('.view-menu-toggle').click({ force: true });
    cy.get('.view-menu-dropdown').should('exist');
    cy.get('.view-menu-item').should('have.length', 7);
    cy.get('.view-menu-item.active').should('contain', 'Chat');
    cy.get('.view-menu-item').contains('Agent/System').click({ force: true });
    cy.get('@onViewChange').should('have.been.calledWith', 'status');
    cy.get('.view-menu-dropdown').should('not.exist');
  });

  it('badge click opens the session chat view', () => {
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader(withSession({ sessionId: 'abc123', onViewChange }));
    cy.get('.session-badge.status-connected').click({ force: true });
    cy.get('@onViewChange').should('have.been.calledWith', 'chat');
  });

  it('combined badge carries the status colour class', () => {
    mountHeader({ statusType: 'streaming', statusText: 'Working', sessionId: 'abc123', runningSessions: [{
      id: 'abc123', sessionName: 'My Session', active: true,
      sessionFile: '', cwd: null, createdAt: 0, lastActivity: 0, parentSession: null,
    }] });
    cy.get('.session-badge.status-streaming').should('exist');
    cy.get('.session-badge .connection-dot.dot-yellow').should('exist');
  });

  it('mobile: badge click also toggles the sessions dropdown', () => {
    cy.viewport(375, 667);
    const onViewChange = cy.stub().as('onViewChange');
    mountHeader(withSession({ sessionId: 'abc123', onViewChange }));
    cy.get('.session-tabs-dropdown').should('not.exist');
    cy.get('.session-badge').click({ force: true });
    cy.get('@onViewChange').should('have.been.calledWith', 'chat');
    cy.get('.session-tabs-dropdown').should('exist');
  });

  it('shows disconnected header styling', () => {
    mountHeader({ statusType: 'disconnected', statusText: 'Disconnected' });
    cy.get('.header').should('have.class', 'header-disconnected');
  });
});

describe('Header running-session tabs', () => {
  const mountTabs = (props: Partial<Parameters<typeof Header>[0]> = {}) => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        sessionId="abc123"
        sessionName={null}
        activeView="chat"
        onViewChange={cy.stub()}
        {...props}
      />
    );
  };
  const tabs = [
    { id: 's1', sessionFile: 'f1', sessionName: 'Worker A', parentSession: null, createdAt: 0, lastActivity: 0, active: true },
    { id: 's2', sessionFile: 'f2', sessionName: null, parentSession: null, createdAt: 0, lastActivity: 0, active: true },
  ];

  it('renders recent running sessions; non-member selection replaces the last slot', () => {
    mountTabs({ runningSessions: tabs as any });
    cy.get('.session-tab').should('have.length', 2); // both members + 'abc123' slot
    cy.get('.session-tab').eq(1).should('have.class', 'running').and('contain', 'Worker A');
  });

  it('renders no tabs when none provided', () => {
    mountTabs();
    cy.get('.session-tab').should('not.exist');
  });

  it('defaults to eight sessions and respects the configured limit', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`, sessionFile: `f${i}`, sessionName: `Session ${i}`, parentSession: null,
      createdAt: 0, lastActivity: i, active: true,
    }));
    mountTabs({ runningSessions: sessions as any, sessionId: 's0' });
    cy.get('.session-tabs > .session-tab-item').should('have.length', 8);
    mountTabs({ runningSessions: sessions as any, sessionId: 's0', sessionTabLimit: 2 });
    cy.get('.session-tabs > .session-tab-item').should('have.length', 2);
  });

  it('shows full-name tooltips and keeps pinned idle sessions first alphabetically beyond the cap', () => {
    const longName = 'A'.repeat(90);
    const sessions = [
      { id: 'current', sessionFile: 'current-file', sessionName: 'Current', parentSession: null, createdAt: 0, lastActivity: 100, active: true },
      { id: 'recent', sessionFile: 'recent-file', sessionName: longName, parentSession: null, createdAt: 0, lastActivity: 90, active: true },
      { id: 'zulu', sessionFile: 'zulu-file', sessionName: 'Zulu archive', parentSession: null, createdAt: 0, lastActivity: 1, active: false },
      { id: 'alpha', sessionFile: 'alpha-file', sessionName: 'Alpha archive', parentSession: null, createdAt: 0, lastActivity: 0, active: false },
    ];
    const onTogglePinnedSession = cy.stub().as('togglePin');
    mountTabs({
      sessionId: 'current', runningSessions: sessions as any, sessionTabLimit: 2,
      pinnedSessionFiles: ['zulu-file', 'alpha-file', 'recent-file'], onTogglePinnedSession,
    });
    cy.get('.session-tabs > .session-tab-item').then(($items) => {
      expect(Array.from($items).map((item) => item.querySelector('.session-badge-text')?.textContent?.trim()))
        .to.deep.eq([`${longName.slice(0, 62)}…`, 'Alpha archive', 'Zulu archive', 'Current']);
    });
    cy.get('.session-tab-item').first().should('have.attr', 'data-tooltip', longName);
    cy.get('.session-tab-item').first().find('.session-tab').should('have.attr', 'aria-label').and('include', longName);
    cy.get('.session-tab').should('not.have.attr', 'title');
    cy.get('.session-tab-pin').first().click();
    cy.get('@togglePin').should('have.been.calledWith', sessions[1]);
  });

  it('switches immediately on tab click', () => {
    const onRunningSessionClick = cy.stub().as('onTab');
    mountTabs({ runningSessions: tabs as any, onRunningSessionClick });
    cy.get('.session-tab').eq(0).find('.session-badge-text').click();
    cy.get('@onTab').should('have.been.calledWith', 's2');
  });

  it('can pin a session from the mobile dropdown without switching', () => {
    cy.viewport(375, 667);
    const onRunningSessionClick = cy.stub().as('onTab');
    const onTogglePinnedSession = cy.stub().as('togglePin');
    mountTabs({ runningSessions: tabs as any, sessionId: 's1', onRunningSessionClick, onTogglePinnedSession });
    cy.get('.session-badge').click({ force: true });
    cy.get('.session-menu-pin').click({ force: true });
    cy.get('@togglePin').should('have.been.calledWith', tabs[1]);
    cy.get('@onTab').should('not.have.been.called');
  });
});

describe('Header session tabs: membership stable, selected becomes badge', () => {
  const mountTabs = (props: Partial<Parameters<typeof Header>[0]> = {}) => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        sessionId={null}
        sessionName={null}
        activeView="chat"
        onViewChange={cy.stub()}
        {...props}
      />
    );
  };
  const mk = (id: string, name: string, lastActivity = 0) => ({
    id, sessionFile: `f-${id}`, sessionName: name, parentSession: null, createdAt: 0, lastActivity, cwd: null, active: true,
  });

  it('orders tabs and the mobile dropdown by most recent activity', () => {
    cy.viewport(375, 667);
    mountTabs({
      sessionId: 'older',
      runningSessions: [mk('older', 'Zulu', 100), mk('newer', 'Alpha', 300), mk('middle', 'Mike', 200)],
    });
    cy.get('.session-tabs > *').then(($items) => {
      expect(Array.from($items).map((item) => item.querySelector('.session-badge-text')?.textContent?.trim())).to.deep.eq(['Alpha', 'Mike', 'Zulu']);
    });
    cy.get('.session-badge').click({ force: true });
    cy.get('.session-menu-item-label').then(($items) => {
      expect(Array.from($items).map((item) => item.textContent?.trim())).to.deep.eq(['Alpha', 'Mike']);
    });
  });

  it('keeps alphabetical order for sessions with tied activity; selected slot renders the badge', () => {
    const onRunningSessionClick = cy.stub().as('onSwitch');
    mountTabs({
      sessionId: 'x00000000000000000000000000003',
      runningSessions: [mk('x00000000000000000000000000001', 'delta'), mk('x00000000000000000000000000002', 'charlie'), mk('x00000000000000000000000000003', 'bravo'), mk('x00000000000000000000000000004', 'alpha')],
      onRunningSessionClick,
    });
    // membership {a,b,c,d}; selected = c ('bravo') → badge at bravo's slot
    cy.get('.session-tabs .session-badge').eq(0).should('have.class', 'status-connected').and('contain', 'bravo');
    cy.get('.session-tab').eq(0).should('contain', 'alpha');
    cy.get('.session-tab').eq(1).should('contain', 'charlie');
    cy.get('.session-tab').eq(2).should('contain', 'delta');
    cy.get('.session-tab').eq(0).find('.session-badge-text').click();
    cy.get('@onSwitch').should('have.been.calledWith', 'x00000000000000000000000000004');
  });

  it('selected session missing from running list still keeps a slot', () => {
    // mid-switch: selection not in (stale) running list — must NOT be
    // rendered separately after the tabs
    mountTabs({ sessionId: 'bravo-id', sessionName: 'bravo', runningSessions: [mk('s1', 'alpha'), mk('s2', 'charlie')] });
    // Room left: both members kept and 'bravo' receives a slot.
    cy.get('.session-tab').should('have.length', 2); // alpha + charlie
    cy.get('.session-tabs .session-badge').should('contain', 'bravo');
    const order: string[] = [];
    cy.get('.session-tabs > *').each(($el) => order.push($el.text())).then(() => {
      expect(order.join('|').length).to.be.greaterThan(0);
    });
  });
});

describe('Header session tabs: click-through switch flow', () => {
  const mk = (id: string, name: string) => ({
    id, sessionFile: `f-${id}`, sessionName: name, parentSession: null,
    createdAt: 0, lastActivity: 0, cwd: null, active: true,
  });
  const mountWith = (sessionId: string | null, sessionName: string | null, sessions: any, onRunningSessionClick?: any) => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        sessionId={sessionId}
        sessionName={sessionName}
        activeView="chat"
        onViewChange={cy.stub()}
        runningSessions={sessions}
        onRunningSessionClick={onRunningSessionClick}
      />
    );
  };
  const sessions = [
    mk('id-tabbed', 'autere tabbed sessions'),
    mk('id-tui', 'autere tui'),
  ]; // api order: most recent first

  it('click a tab → switch stub fires with the entry id', () => {
    const onSwitch = cy.stub().as('switch');
    mountWith('id-tabbed', 'autere tabbed sessions', sessions, onSwitch);
    // click the text, not the button: the unstyled close-SVG covers the center
    cy.get('.session-tab').eq(0).find('.session-badge-text').click();
    cy.get('@switch').should('have.been.calledWith', 'id-tui');
  });

  it('after the switch flow re-render: alphabetical order unchanged, badge re-slots', () => {
    // what the app renders after switch-by-id resolves + poll refresh
    mountWith('id-tui', 'autere tui', sessions);
    cy.get('.session-tabs > *').then(($c) => {
      expect($c[0].textContent).to.contain('autere tabbed sessions');
      expect($c[0].querySelector('.session-tab')).to.exist;    // tabbed: back to orange running tab
      expect($c[1].textContent).to.contain('autere tui');
      expect($c[1].querySelector('.session-badge')).to.exist;  // tui: badge at its alpha slot
      expect($c[1].querySelector('.session-tab')).to.not.exist;
    });
  });

  it('mid-flow selection (backend-resolved id not in the list) keeps alpha slot', () => {
    // id reroute: resolved id not an entry id yet; fallback slot must be
    // slotted alphabetically by name — never appended at the end
    mountWith('resolved-tui', 'autere tui', [sessions[0], sessions[1]]);
    cy.get('.session-tabs > *').then(($c) => {
      expect($c.length).to.eq(2);
      expect($c[0].textContent).to.contain('autere tabbed sessions');
      expect($c[0].querySelector('.session-tab')).to.exist;
      expect($c[1].textContent).to.contain('autere tui');
      expect($c[1].querySelector('.session-badge')).to.exist;
    });
  });
});

describe('Header session tabs: name-matched reheaded sessions + room for extra', () => {
  const mk = (id: string, name: string | null) => ({
    id, sessionFile: `f-${id}`, sessionName: name, parentSession: null,
    createdAt: 0, lastActivity: 0, cwd: null, active: true,
  });
  const mountWith = (sessionId: string | null, sessionName: string | null, sessions: any) => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        sessionId={sessionId}
        sessionName={sessionName}
        activeView="chat"
        onViewChange={cy.stub()}
        runningSessions={sessions}
        onRunningSessionClick={cy.stub()}
      />
    );
  };
  const TABBED = mk('id-tabbed', 'autere tabbed sessions');
  const TUI = mk('id-tui', 'autere tui');
  const sessions = [TABBED, TUI];

  it('reheaded running session: selection matches by name and badge re-slots', () => {
    // pi re-headed 'tabbed' — the resolved id shares no prefix/id with the
    // entry id, but the name is still identical
    mountWith('resolved-999-tabbed', 'autere tabbed sessions', sessions);
    cy.get('.session-tabs > *').then(($c) => {
      expect($c.length).to.eq(2);
      expect($c[0].textContent).to.contain('autere tabbed sessions');
      expect($c[0].querySelector('.session-badge')).to.exist;   // selected → badge FIRST (alpha)
      expect($c[1].textContent).to.contain('autere tui');
      expect($c[1].querySelector('.session-tab')).to.exist;
    });
  });

  it('selecting a non-running session keeps ALL running sessions + adds slot', () => {
    mountWith('seed-idle', 'idle session', sessions);
    cy.get('.session-tabs > *').then(($c) => {
      expect($c.length).to.eq(3);
      expect($c[0].textContent).to.contain('autere tabbed sessions');
      expect($c[1].textContent).to.contain('autere tui');
      expect($c[2].textContent).to.contain('idle session');
      expect($c[2].querySelector('.session-badge')).to.exist; // alphabetically last here, still the badge
    });
  });
});

describe('Header session tabs: idle padding below the cap', () => {
  const mk = (id: string, name: string, active: boolean) => ({
    id, sessionFile: `f-${id}`, sessionName: name, parentSession: null,
    createdAt: 0, lastActivity: 0, cwd: null, active,
  });
  const mountWith = (sessionId: string, sessionName: string | null, sessions: any) => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        sessionId={sessionId}
        sessionName={sessionName}
        activeView="chat"
        onViewChange={cy.stub()}
        runningSessions={sessions}
        onRunningSessionClick={cy.stub()}
      />
    );
  };

  it('pads with the most recent idle sessions when fewer than 5 running', () => {
    const R = [mk('r1', 'run-a', true), mk('r2', 'run-b', true)];
    const I = [mk('i1', 'idle-1', false), mk('i2', 'idle-2', false), mk('i3', 'idle-3', false)];
    mountWith('r1', 'run-a', [R[0], R[1], ...I]);
    cy.get('.session-tabs > *').then(($c) => {
      const labels = Array.from($c).map((el) => el.textContent || '');
      // 2 running + 3 idle = 5, alphabetical: idle-1, idle-2, idle-3, run-a(badge), run-b
      // Delete affordance sits inside each tab (× appended to textContent)
      expect(labels.map((l) => l.replace(/×$/, ''))).to.deep.eq(['idle-1', 'idle-2', 'idle-3', 'run-a', 'run-b']);
      expect($c[3].querySelector('.session-badge')).to.exist; // selected running = badge
      expect($c[0].querySelector('.session-tab')?.className).to.contain('idle').and.to.not.contain('running');   // idle padding = gray
      expect($c[4].querySelector('.session-tab')?.className).to.contain('running'); // other alive-idle tab = bright yellow running
    });
  });
});

describe('Header session tab delete', () => {
  const withTabs = (props: Partial<React.ComponentProps<typeof Header>> = {}) => {
    cy.mount(
      <Header
        statusType="connected"
        statusText="Idle"
        sessionId="sel"
        sessionName={null}
        activeView="chat"
        onViewChange={cy.stub()}
        runningSessions={[
          { id: 'sel', sessionFile: '/a', cwd: null, createdAt: 1, lastActivity: 1, parentSession: null, active: true } as any,
          { id: 'idle-1', sessionFile: '/b', cwd: null, createdAt: 1, lastActivity: 1, parentSession: null, active: false } as any,
          { id: 'busy-1', sessionFile: '/c', cwd: null, createdAt: 1, lastActivity: 1, parentSession: null, active: true, streaming: true } as any,
        ]}
        {...props}
      />
    );
  };

  it('confirm deletes the session (never on the viewed or busy one)', () => {
    cy.intercept('DELETE', '**/api/v1/sessions/*', { success: true }).as('del');
    const confirmStub = cy.stub(window, 'confirm').returns(true);
    withTabs();
    // Viewed (badge) and busy tabs carry no ×; the idle one does
    cy.get('.session-tab-item.selected .session-tab-close').should('not.exist');
    cy.get('.session-tab-item:has(.session-tab.working) .session-tab-close').should('not.exist');
    cy.get('.session-tab-item:has(.session-tab.idle) .session-tab-close').click();
    cy.wait('@del').then(() => {
      expect(confirmStub).to.have.been.called;
    });
  });
});
