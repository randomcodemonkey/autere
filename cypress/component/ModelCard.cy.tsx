import React from 'react';
import { ModelCard } from '../../src/frontend/components/ModelCard';

describe('ModelCard', () => {
  beforeEach(() => {
    // Intercept API calls
    cy.intercept('GET', '/api/models', { success: true, data: [] }).as('getModels');
    cy.intercept('POST', '/api/set-model', { success: true }).as('setModel');
  });

  it('renders with models', () => {
    const models = [
      { provider: 'anthropic', id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet' },
      { provider: 'openai', id: 'gpt-4', name: 'GPT-4' },
    ];
    cy.mount(<ModelCard models={models} activeModelId="claude-sonnet-4-20250514" />);
    cy.get('.model-item').should('have.length', 2);
    cy.get('.model-name').eq(0).should('contain', 'Claude Sonnet');
    cy.get('.model-name').eq(1).should('contain', 'GPT-4');
  });

  it('highlights active model', () => {
    const models = [
      { provider: 'anthropic', id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet' },
      { provider: 'openai', id: 'gpt-4', name: 'GPT-4' },
    ];
    cy.mount(<ModelCard models={models} activeModelId="claude-sonnet-4-20250514" />);
    cy.get('.model-item').eq(0).should('have.class', 'active');
    cy.get('.model-item').eq(1).should('not.have.class', 'active');
  });

  it('shows empty state when no models', () => {
    cy.mount(<ModelCard models={[]} activeModelId={null} />);
    cy.get('.model-empty').should('contain', 'No scoped models configured');
  });

  it('calls set-model API when model is clicked', () => {
    const models = [
      { provider: 'anthropic', id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet' },
      { provider: 'openai', id: 'gpt-4', name: 'GPT-4' },
    ];
    cy.mount(<ModelCard models={models} activeModelId="claude-sonnet-4-20250514" />);
    cy.get('.model-item').eq(1).click();
    cy.wait('@setModel').its('request.body').should('deep.equal', {
      provider: 'openai',
      modelId: 'gpt-4',
    });
  });

  it('toggles collapse state', () => {
    const models = [
      { provider: 'anthropic', id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet' },
    ];
    cy.mount(<ModelCard models={models} activeModelId="claude-sonnet-4-20250514" />);
    cy.get('.card').should('not.have.class', 'collapsed');
    cy.get('.card-header').click();
    cy.get('.card').should('have.class', 'collapsed');
    cy.get('.card-header').click();
    cy.get('.card').should('not.have.class', 'collapsed');
  });

  it('shows provider name', () => {
    const models = [
      { provider: 'anthropic', id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet' },
    ];
    cy.mount(<ModelCard models={models} activeModelId="claude-sonnet-4-20250514" />);
    cy.get('.model-provider').should('contain', 'anthropic');
  });
});
