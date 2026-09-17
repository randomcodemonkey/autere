import React from 'react';
import { PersonaSection, PersonasSettingsSection } from '../../src/frontend/components/Personas';

const personas = [
  { id: 'p1', name: 'Code Reviewer', description: 'Reviews code changes', prompt: 'You are a meticulous code reviewer.' },
  { id: 'p2', name: 'Pirate', description: '', prompt: 'Arr, talk like a pirate.' },
];

function stubFetch(overrides: Record<string, any> = {}) {
  const calls: Array<{ url: string; method?: string; body?: any }> = [];
  cy.window({ log: false }).then((win) => {
    win.fetch = (input: any, init: any) => {
      const u = String(input);
      const method = init?.method || 'GET';
      let body: any;
      try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      calls.push({ url: u, method, body });
      let data: any = { success: true };
      if (u.includes('/api/personas') && method === 'GET') data = { success: true, data: overrides.list ?? personas };
      if (u.includes('/api/personas/generate')) data = overrides.generate ?? { success: true, data: { prompt: 'Generated prompt.' } };
      if (u.includes('/api/personas') && method === 'POST' && !u.includes('generate')) data = overrides.save ?? { success: true };
      if (u.includes('/api/personas/delete')) data = { success: true };
      if (u.includes('/api/set-persona')) data = { success: true };
      (win as any).__personaCalls = calls;
      return Promise.resolve({ json: () => Promise.resolve(data), ok: true } as any);
    };
  });
}

describe('PersonaSection (Agent card)', () => {
  it('renders the persona select with none active', () => {
    stubFetch();
    cy.mount(<PersonaSection persona={null} />);
    cy.get('select.settings-input').should('have.value', '');
    cy.get('select option').should('have.length', 3);
    cy.get('select option').eq(1).should('contain', 'Code Reviewer');
    cy.contains('Active: none').should('exist');
  });

  it('shows the active persona', () => {
    stubFetch();
    cy.mount(<PersonaSection persona={{ id: 'p1', name: 'Code Reviewer' }} />);
    cy.get('select.settings-input').should('have.value', 'p1');
    cy.contains('Active: Code Reviewer').should('exist');
  });

  it('POSTs /api/set-persona when changed', () => {
    stubFetch();
    cy.mount(<PersonaSection persona={null} />);
    cy.get('select.settings-input').select('p2');
    cy.window({ log: false }).then((win) => {
      const calls = (win as any).__personaCalls as Array<any>;
      const set = calls.find((c) => c.url.includes('/api/set-persona'));
      expect(set, 'set-persona called').to.exist;
      expect(set.body).to.deep.equal({ personaId: 'p2' });
    });
  });
});

describe('PersonasSettingsSection', () => {
  it('lists personas with name and description', () => {
    stubFetch();
    cy.mount(<PersonasSettingsSection />);
    cy.contains('.persona-name', 'Code Reviewer').should('exist');
    cy.contains('.persona-description', 'Reviews code changes').should('exist');
    cy.contains('.persona-name', 'Pirate').should('exist');
  });

  it('shows an empty-state hint when no personas exist', () => {
    stubFetch({ list: [] });
    cy.mount(<PersonasSettingsSection />);
    cy.contains('No personas yet').should('exist');
    cy.contains('button', '+ New Persona').should('exist');
  });

  it('details button opens a modal with an editable prompt, regenerates and saves', () => {
    stubFetch();
    cy.mount(<PersonasSettingsSection />);
    cy.contains('.persona-item', 'Code Reviewer').contains('button', 'Details').click();
    cy.get('.modal').should('be.visible');
    cy.get('.persona-details-prompt').should('have.value', 'You are a meticulous code reviewer.');
    // Regenerate replaces the textarea content via the generate endpoint
    cy.contains('button', 'Regenerate prompt').click();
    cy.get('.persona-details-prompt').should('have.value', 'Generated prompt.');
    // Save posts the full persona (id included) with the edited prompt
    cy.get('.persona-details-prompt').type(' (edited)');
    cy.contains('button', 'Save Changes').click();
    cy.window({ log: false }).then((win) => {
      const calls = (win as any).__personaCalls as Array<any>;
      const save = calls.find((c) => c.url.endsWith('/api/personas') && c.method === 'POST');
      expect(save.body.id).to.equal('p1');
      expect(save.body.prompt).to.equal('Generated prompt. (edited)');
    });
  });

  it('create modal: generate button appears only after prompt text is entered, and calls the generate endpoint', () => {
    stubFetch();
    cy.mount(<PersonasSettingsSection />);
    cy.contains('button', '+ New Persona').click();
    cy.get('.modal').should('be.visible');
    cy.contains('button', 'Generate prompt').should('not.exist');
    cy.get('.modal textarea.settings-input').type('A terse assistant');
    cy.contains('button', 'Generate prompt').should('exist');
    cy.contains('uses the given text and generates a prompt from it', { matchCase: false }).should('exist');
    cy.contains('button', 'Generate prompt').click();
    cy.window({ log: false }).then((win) => {
      const calls = (win as any).__personaCalls as Array<any>;
      const gen = calls.find((c) => c.url.includes('/api/personas/generate'));
      expect(gen, 'generate called').to.exist;
      expect(gen.body).to.deep.equal({ text: 'A terse assistant' });
    });
    cy.get('.modal textarea.settings-input').should('have.value', 'Generated prompt.');
  });

  it('create modal: saves a new persona', () => {
    stubFetch();
    cy.mount(<PersonasSettingsSection />);
    cy.contains('button', '+ New Persona').click();
    cy.get('.modal input.settings-input').eq(0).type('Tester');
    cy.get('.modal textarea.settings-input').type('You test things.');
    cy.contains('button', 'Create Persona').click();
    cy.window({ log: false }).then((win) => {
      const calls = (win as any).__personaCalls as Array<any>;
      const save = calls.find((c) => c.url.endsWith('/api/personas') && c.method === 'POST');
      expect(save, 'save called').to.exist;
      expect(save.body.name).to.equal('Tester');
      expect(save.body.prompt).to.equal('You test things.');
    });
  });
});
