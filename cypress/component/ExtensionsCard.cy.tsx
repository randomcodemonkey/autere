import React from 'react';
import { ExtensionsCard } from '../../src/frontend/components/ExtensionsCard';
import type { ExtensionInfo } from '../../src/frontend/types';

const ext = (over: Partial<ExtensionInfo>): ExtensionInfo => ({
  name: 'pi-janitor', displayName: 'Janitor', configPath: '', hasConfig: false,
  status: 'ok', statusText: 'Active', details: {},
  sections: [{ header: 'Cleanups', items: [{ 'Sweeps': 0 }] }],
  ...over,
});

describe('ExtensionsCard', () => {
  it('shows empty state when no extensions', () => {
    cy.mount(<ExtensionsCard extensions={[]} />);
    cy.get('.ext-empty').should('contain', 'No extensions loaded');
  });

  it('renders extensions with status dots', () => {
    const extensions: ExtensionInfo[] = [
      {
        name: 'whatsapp-pi',
        displayName: 'WhatsApp',
        configPath: '/path/to/config',
        hasConfig: true,
        status: 'ok',
    statusText: 'Available',
        details: {},
      },
      {
        name: 'pi-9router-ext',
        displayName: '9Router',
        configPath: '/path/to/config',
        hasConfig: true,
        status: 'configured',
        details: {},
      },
    ];
    cy.mount(<ExtensionsCard extensions={extensions} />);
    cy.get('.ext-item').should('have.length', 2);
    cy.get('.ext-name').eq(0).should('contain', 'WhatsApp');
    cy.get('.ext-name').eq(1).should('contain', '9Router');
    cy.get('.dot-green').should('exist');
  });

  it('shows error status for failed extensions', () => {
    const extensions: ExtensionInfo[] = [
      {
        name: 'whatsapp-pi',
        displayName: 'WhatsApp',
        configPath: '/path/to/config',
        hasConfig: true,
        status: 'error',
        statusText: 'Error',
        details: {},
      },
    ];
    cy.mount(<ExtensionsCard extensions={extensions} />);
    cy.get('.dot-red').should('exist');
    cy.get('.badge.danger').should('exist');
  });

  it('shows available status styling', () => {
    const extensions: ExtensionInfo[] = [
      {
        name: 'whatsapp-pi',
        displayName: 'WhatsApp',
        configPath: '/path/to/config',
        hasConfig: true,
        status: 'ok',
    statusText: 'Available',
        details: {},
      },
    ];
    cy.mount(<ExtensionsCard extensions={extensions} />);
    cy.get('.badge.success').should('exist');
  });

  it('toggles collapse state', () => {
    cy.mount(<ExtensionsCard extensions={[]} />);
    cy.get('.card').should('not.have.class', 'collapsed');
    cy.get('.card-header').click();
    cy.get('.card').should('have.class', 'collapsed');
  });

  it('polls /api/extensions while the detail modal is open, not when closed', () => {
    cy.clock();
    const stub = cy.stub(window, 'fetch').callsFake(() =>
      Promise.resolve({ json: () => Promise.resolve({ success: true, data: [ext({})] }) } as any));
    cy.mount(<ExtensionsCard extensions={[ext({ status: 'neutral', statusText: '' })]} />);
    cy.get('.ext-header').click();
    cy.tick(7000); // initial fetch + ≥2 polls
    cy.wrap(stub).its('callCount').should('be.gte', 3);
    let afterClose = 0;
    cy.get('.modal-close').click().then(() => { afterClose = stub.callCount; });
    cy.tick(9000);
    cy.wrap(null).should(() => expect(stub.callCount).to.eq(afterClose));
  });

  it('shows per-user stats from /api/extensions instead of the zero placeholders', () => {
    const props: ExtensionInfo[] = [{
      name: 'pi-janitor', displayName: 'Janitor', configPath: '', hasConfig: false,
      status: 'neutral', statusText: '', details: {},
      sections: [{ header: 'Cleanups', items: [{ 'Sweeps': 0 }] }],
    }];
    const api: ExtensionInfo[] = [{
      ...props[0], status: 'ok', statusText: 'Active',
      sections: [
        { header: 'Cache observations', items: [{ 'Requests observed': 42, 'Cache misses': 3, 'Missed tokens': 51000, 'Post-sweep requests': 2, 'Observed cache TTL (s)': 640, 'Sweep threshold (s)': 1280 }] },
        { header: 'Cleanups', items: [{ 'Sweeps': 2, 'Tool results stubbed': 7, 'Images stubbed': 1, 'Approx tokens saved': 3100 }] },
      ],
    }];
    cy.stub(window, 'fetch').resolves({ json: () => Promise.resolve({ success: true, data: api }) } as any);
    cy.mount(<ExtensionsCard extensions={props} />);
    cy.get('.badge').should('contain', 'Active');
    cy.get('.ext-header').click();
    cy.get('.ext-section').eq(0).should('contain', '42').should('contain', '1280');
    cy.get('.ext-section').eq(1).should('contain', 'Tool results stubbed').should('contain', '7');
  });

  it('shows janitor cache + cleanup stats in the detail modal', () => {
    const extensions: ExtensionInfo[] = [{
      name: 'pi-janitor',
      displayName: 'Janitor',
      configPath: '',
      hasConfig: false,
      status: 'ok',
      statusText: 'Active',
      details: {},
      sections: [
        {
          header: 'Cache observations',
          items: [
            { 'Requests observed': 42, 'Cache misses': 3, 'Missed tokens': 51000, 'Post-sweep requests': 2, 'Observed cache TTL (s)': 640, 'Sweep threshold (s)': 1280 },
            { 'Session': 'Fix janitor sorting', 'Requests': 42, 'Misses': 3, 'Missed tokens': 51000, 'Cache TTL (s)': 640, 'Threshold (s)': 1280, 'Last active': 1758350000000 },
          ],
        },
        {
          header: 'Cleanups',
          items: [
            { 'Sweeps': 2, 'Tool results stubbed': 7, 'Images stubbed': 1, 'Approx tokens saved': 3100 },
            { 'Session': 'Fix janitor sorting', 'Sweeps': 2, 'Tool results': 7, 'Images': 1, 'Tokens saved': 3100, 'Last sweep': '2026-09-20T07:00:00.000Z', 'Last active': 1758350000000 },
          ],
        },
      ],
    }];
    cy.mount(<ExtensionsCard extensions={extensions} />);
    cy.get('.ext-header').click();
    cy.get('.modal-header h3').should('contain', 'Janitor');
    cy.get('.ext-section-header').eq(0).should('contain', 'Cache observations');
    cy.get('.ext-section-header').eq(1).should('contain', 'Cleanups');
    cy.get('.ext-section').eq(0).should('contain', '42').should('contain', '1280');
    cy.get('.ext-section').eq(1).should('contain', 'Tool results stubbed').should('contain', 'Fix janitor sorting').should('not.contain', '1758350');
  });
});
