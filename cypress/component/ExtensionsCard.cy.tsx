import React from 'react';
import { ExtensionsCard } from '../../src/frontend/components/ExtensionsCard';
import type { ExtensionInfo } from '../../src/frontend/types';

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
        status: 'connected',
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
        details: { status: 'disconnected' },
      },
    ];
    cy.mount(<ExtensionsCard extensions={extensions} />);
    cy.get('.dot-red').should('exist');
    cy.get('.badge.danger').should('exist');
  });

  it('shows connected status styling', () => {
    const extensions: ExtensionInfo[] = [
      {
        name: 'whatsapp-pi',
        displayName: 'WhatsApp',
        configPath: '/path/to/config',
        hasConfig: true,
        status: 'connected',
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
});
