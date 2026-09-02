import React from 'react';
import { StatusCard } from '../../src/frontend/components/StatusCard';
import type { SessionInfo } from '../../src/frontend/types';

const SESSIONS: SessionInfo[] = [
  { id: 'aaaa1111-0000', sessionFile: '/s/aaaa.jsonl', sessionName: 'First', parentSession: null, createdAt: 1, lastActivity: Date.now(), cwd: null },
  { id: 'bbbb2222-0000', sessionFile: '/s/bbbb.jsonl', sessionName: null, parentSession: null, createdAt: 1, lastActivity: Date.now() - 60000, cwd: null },
];

function stubApi() {
  cy.stub(window, 'fetch').callsFake((input: RequestInfo | URL) => {
    const u = String(input);
    let body: any = { success: true, data: [] };
    if (u.includes('/api/sessions')) body = { success: true, data: SESSIONS };
    else if (u.includes('/api/status')) body = { success: true, data: { autereStartedAt: Date.now() - 65000, piStartedAt: Date.now() - 10000 } };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
  });
}

function mountCard(props: Partial<Parameters<typeof StatusCard>[0]> = {}) {
  stubApi();
  cy.mount(
    <StatusCard
      sessionId="aaaa1111-0000"
      sessionName="First"
      compacting={false}
      statusType="connected"
      availableSessions={SESSIONS}
      onNewSession={cy.stub()}
      onAbort={cy.stub()}
      onCompact={cy.stub()}
      onSwitchSession={cy.stub()}
      onSessionNameSet={cy.stub()}
      messageCount={3}
      requestCount={1}
      stats={{ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: null }}
      activeTools={[]}
      recentTools={[]}
      extensions={[]}
      models={[]}
      activeModelId={null}
      onModelsFetched={cy.stub()}
      username="admin"
      userRole="admin"
      restarting={false}
      restartingBackend={false}
      onRestart={cy.stub()}
      onRestartBackend={cy.stub()}
      onLogout={cy.stub()}
      {...props}
    />
  );
}

describe('StatusCard', () => {
  it('renders session, usage, tools, extensions and system sections', () => {
    mountCard();
    cy.get('.status-card-session').should('exist');
    cy.get('.card-title').contains('Usage').should('exist');
    cy.get('.card-title').contains('Tools').should('exist');
    cy.get('.card-title').contains('Extensions').should('exist');
    cy.get('.status-card-system').should('exist');
  });

  it('shows the current session id and name in the rename input', () => {
    mountCard();
    cy.get('.session-current-id').should('contain', 'aaaa1111-0000');
    cy.get('.session-name-input').should('have.value', 'First');
  });

  it('lists sessions with the current one highlighted', () => {
    mountCard();
    cy.get('.session-item').should('have.length', 2);
    cy.get('.session-item.active').should('contain', 'First');
  });

  it('calls onSwitchSession when another session is clicked', () => {
    const onSwitchSession = cy.stub().as('onSwitchSession');
    mountCard({ onSwitchSession });
    cy.get('.session-item').not('.active').first().click();
    cy.get('@onSwitchSession').should('have.been.calledWith', 'bbbb2222-0000');
  });

  it('calls onNewSession from the New Session button', () => {
    const onNewSession = cy.stub().as('onNewSession');
    mountCard({ onNewSession });
    cy.get('.status-card-session .btn-primary').click();
    cy.get('@onNewSession').should('have.been.calledOnce');
  });

  it('shows username, role and uptime values', () => {
    mountCard();
    cy.get('.modal-username').should('contain', 'admin');
    cy.get('.modal-role').should('contain', 'admin');
    cy.get('.modal-uptime-row').first().should('contain', '10s');
    cy.get('.modal-uptime-row').last().should('contain', '1m 5s');
  });

  it('shows both restart buttons for admins and logout', () => {
    mountCard();
    cy.contains('Restart PI').should('exist');
    cy.contains('Restart Autere').should('exist');
    cy.contains('Logout').should('exist');
  });

  it('hides the autere restart button for non-admins', () => {
    mountCard({ userRole: 'user' });
    cy.contains('Restart PI').should('exist');
    cy.contains('Restart Autere').should('not.exist');
  });

  it('shows em dashes for uptime when processes are not running', () => {
    cy.stub(window, 'fetch').callsFake((input: RequestInfo | URL) => {
      const body = String(input).includes('/api/status')
        ? { success: true, data: { autereStartedAt: null, piStartedAt: null } }
        : { success: true, data: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    });
    cy.mount(
      <StatusCard
        sessionId={null}
        sessionName={null}
        compacting={false}
        statusType="connected"
        availableSessions={[]}
        onNewSession={cy.stub()}
        onAbort={cy.stub()}
        onCompact={cy.stub()}
        onSwitchSession={cy.stub()}
        onSessionNameSet={cy.stub()}
        messageCount={0}
        requestCount={0}
        stats={{ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: null }}
        activeTools={[]}
        recentTools={[]}
        extensions={[]}
        models={[]}
        activeModelId={null}
        onModelsFetched={cy.stub()}
        username={null}
        userRole={null}
        restarting={false}
        restartingBackend={false}
        onRestart={cy.stub()}
        onRestartBackend={cy.stub()}
        onLogout={cy.stub()}
      />
    );
    cy.get('.modal-uptime-row').first().should('contain', '—');
    cy.get('.modal-uptime-row').last().should('contain', '—');
  });
});

describe('StatusCard collapse', () => {
  function mountForCollapse() {
    cy.stub(window, 'fetch').callsFake(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any
    );
    cy.mount(
      <StatusCard
        sessionId="aaaa1111-0000"
        sessionName="First"
        compacting={false}
        statusType="connected"
        availableSessions={[]}
        onNewSession={cy.stub()}
        onAbort={cy.stub()}
        onCompact={cy.stub()}
        onSwitchSession={cy.stub()}
        onSessionNameSet={cy.stub()}
        messageCount={0}
        requestCount={0}
        stats={{ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: null }}
        activeTools={[]}
        recentTools={[]}
        extensions={[]}
        models={[]}
        activeModelId={null}
        onModelsFetched={() => {}}
        username="admin"
        userRole="admin"
        restarting={false}
        restartingBackend={false}
        onRestart={cy.stub()}
        onRestartBackend={cy.stub()}
        onLogout={cy.stub()}
      />
    );
  }

  it('session card collapses and expands on header click', () => {
    mountForCollapse();
    cy.get('.status-card-session').should('not.have.class', 'collapsed');
    cy.get('.status-card-session .card-header').click();
    cy.get('.status-card-session').should('have.class', 'collapsed');
    // (body visibility itself is asserted in the e2e suite — component
    // tests run without the stylesheet)
    cy.get('.status-card-session .card-header').click();
    cy.get('.status-card-session').should('not.have.class', 'collapsed');
  });

  it('system card collapses and expands on header click', () => {
    mountForCollapse();
    cy.get('.status-card-system .card-header').click();
    cy.get('.status-card-system').should('have.class', 'collapsed');
  });
});
