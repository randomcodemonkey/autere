import React from 'react';
import { ToolsCard } from '../../src/frontend/components/ToolsCard';
import type { ActiveTool, RecentTool } from '../../src/frontend/types';

describe('ToolsCard', () => {
  it('shows empty state when no tools', () => {
    cy.mount(<ToolsCard activeTools={[]} recentTools={[]} />);
    cy.get('.tool-empty').should('contain', 'No active tools');
  });

  it('renders active tools with spinner', () => {
    const activeTools: ActiveTool[] = [
      { id: '1', name: 'bash', cmd: 'ls -la', args: { command: 'ls -la' }, startTime: Date.now() },
      { id: '2', name: 'read', cmd: '/path/to/file', args: { path: '/path/to/file' }, startTime: Date.now() },
    ];
    cy.mount(<ToolsCard activeTools={activeTools} recentTools={[]} />);
    cy.get('.tool-chip').should('have.length', 2);
    cy.get('.tool-chip').eq(0).should('contain', 'bash');
    cy.get('.tool-chip').eq(0).find('.spinner').should('exist');
    cy.get('.tool-chip').eq(1).should('contain', 'read');
  });

  it('renders recent tools', () => {
    const recentTools: RecentTool[] = [
      { name: 'bash', isError: false, timestamp: Date.now(), args: { command: 'echo hello' } },
      { name: 'read', isError: true, timestamp: Date.now(), args: { path: '/missing/file' } },
    ];
    cy.mount(<ToolsCard activeTools={[]} recentTools={recentTools} />);
    cy.get('.recent-tool-item').should('have.length', 2);
    cy.get('.recent-tool-name').eq(0).should('contain', 'bash');
    cy.get('.recent-tool-name').eq(1).should('contain', 'read');
  });

  it('shows error indicator for failed tools', () => {
    const recentTools: RecentTool[] = [
      { name: 'bash', isError: true, timestamp: Date.now(), args: { command: 'exit 1' } },
    ];
    cy.mount(<ToolsCard activeTools={[]} recentTools={recentTools} />);
    cy.get('.recent-tool-err').should('exist');
  });

  it('shows success indicator for successful tools', () => {
    const recentTools: RecentTool[] = [
      { name: 'bash', isError: false, timestamp: Date.now(), args: { command: 'echo hello' } },
    ];
    cy.mount(<ToolsCard activeTools={[]} recentTools={recentTools} />);
    cy.get('.recent-tool-ok').should('exist');
  });

  it('toggles collapse state', () => {
    cy.mount(<ToolsCard activeTools={[]} recentTools={[]} />);
    cy.get('.card').should('not.have.class', 'collapsed');
    cy.get('.card-header').click();
    cy.get('.card').should('have.class', 'collapsed');
  });

  it('truncates long tool commands', () => {
    const longCommand = 'a'.repeat(100);
    const recentTools: RecentTool[] = [
      { name: 'bash', isError: false, timestamp: Date.now(), args: { command: longCommand } },
    ];
    cy.mount(<ToolsCard activeTools={[]} recentTools={recentTools} />);
    cy.get('.tool-cmd').should('have.class', 'tool-cmd-truncated');
  });
});
