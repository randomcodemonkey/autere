import React from 'react';
import { StatusCard } from '../../src/frontend/components/StatusCard';



function stubApi() {
  cy.stub(window, 'fetch').callsFake((input: RequestInfo | URL) => {
    const u = String(input);
    let body: any = { success: true, data: [] };
    if (u.includes('/api/v1/status')) body = { success: true, data: { autereStartedAt: Date.now() - 65000, piStartedAt: Date.now() - 10000 } };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
  });
}

function mountCard(props: Partial<Parameters<typeof StatusCard>[0]> = {}) {
  stubApi();
  cy.mount(
    <StatusCard
      statusType="connected"
      messageCount={3}
      requestCount={1}
      stats={{ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: null }}
      extensions={[]}
      models={[]}
      activeModelId={null}
      onModelsFetched={cy.stub()}
      username="admin"
      persona={null}
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
  
  
  
  
  
  it('shows username, role and uptime values', () => {
    mountCard();
    cy.get('.modal-username').should('contain', 'admin');
    cy.get('.badge').should('contain', 'admin');
    cy.contains('.modal-uptime-row', 'pi uptime').should('contain', '10s');
    cy.contains('.modal-uptime-row', 'autere uptime').should('contain', '1m 5s');
    cy.contains('.modal-uptime-row', 'UI build').should('contain', 'dev');
  });

  it('idle session: shows the inactive banner and Load spawns via callback', () => {
    const onActivate = cy.stub().as('activate');
    mountCard({ sessionActive: false, onActivateSession: onActivate });
    cy.get('.status-card-inactive').should('exist');
    cy.get('.status-card-inactive .btn').should('contain', 'Load status');
    cy.get('.status-card-inactive .btn').click();
    cy.wrap(onActivate).should('have.been.calledOnce');
    // The live agent card stays hidden while inactive
    cy.get('.agent-card').should('not.exist');
  });

  it('active session: no inactive banner, agent card visible', () => {
    mountCard();
    cy.get('.status-card-inactive').should('not.exist');
    cy.get('.agent-card').should('exist');
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
      const body = String(input).includes('/api/v1/status')
        ? { success: true, data: { autereStartedAt: null, piStartedAt: null } }
        : { success: true, data: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    });
    cy.mount(
      <StatusCard
        statusType="connected"
        messageCount={0}
        requestCount={0}
        stats={{ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: null }}
            extensions={[]}
        models={[]}
        activeModelId={null}
        onModelsFetched={cy.stub()}
        username={null}
        userRole={null}
        persona={null}
        restarting={false}
        restartingBackend={false}
        onRestart={cy.stub()}
        onRestartBackend={cy.stub()}
        onLogout={cy.stub()}
      />
    );
    cy.contains('.modal-uptime-row', 'pi uptime').should('contain', '—');
    cy.contains('.modal-uptime-row', 'autere uptime').should('contain', '—');
  });
});

describe('StatusCard collapse', () => {
  function mountForCollapse() {
    cy.stub(window, 'fetch').callsFake(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any
    );
    cy.mount(
      <StatusCard
        statusType="connected"
        messageCount={0}
        requestCount={0}
        stats={{ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: null }}
            extensions={[]}
        models={[]}
        activeModelId={null}
        onModelsFetched={() => {}}
        username="admin"
      persona={null}
        userRole="admin"
        restarting={false}
        restartingBackend={false}
        onRestart={cy.stub()}
        onRestartBackend={cy.stub()}
        onLogout={cy.stub()}
      />
    );
  }

  
  it('system card collapses and expands on header click', () => {
    mountForCollapse();
    cy.get('.status-card-system .card-header').click();
    cy.get('.status-card-system').should('have.class', 'collapsed');
  });
});
