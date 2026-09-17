import React from 'react';
import { SettingsCard } from '../../src/frontend/components/SettingsCard';

const schema = [
  {
    id: 'images',
    label: 'Images',
    fields: [
      { key: 'imageModel', label: 'Image Model', type: 'select' as const,
        options: [ { value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' } ],
        description: 'Pick the image generation model' },
    ],
  },
];

function stubFetch(settings: Record<string, any>) {
  // Component tests run in an already-loaded page — cy.intercept and
  // window:before:load don't apply, so stub window.fetch directly.
  cy.window({ log: false }).then((win) => {
    win.fetch = (input: any, _init: any) => {
      const u = String(input);
      let data: any = { success: true };
      if (u.includes('/api/settings/schema')) data = { success: true, data: schema };
      else if (u.includes('/api/settings')) data = { success: true, data: settings };
      else if (u.includes('/api/extensions/packages')) data = { success: true, data: { available: [] } };
      return Promise.resolve({ json: () => Promise.resolve(data) } as any);
    };
  });
}

describe('SettingsCard select fields', () => {
  it('renders a select with auto option and discovered models', () => {
    stubFetch({ imageModel: '' });
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('select.settings-input').should('exist');
    cy.get('select option').should('have.length', 3);
    cy.get('select option').first().should('contain', 'Auto (first available)');
    cy.get('select option').eq(1).should('contain', 'Model A');
  });

  it('shows the selected value', () => {
    stubFetch({ imageModel: 'model-b' });
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('select.settings-input').should('have.value', 'model-b');
  });
});

describe('SettingsCard number fields', () => {
  const numberSchema = [
    {
      id: 'chat',
      label: 'Chat',
      fields: [
        { key: 'reserveTokensPercent', label: 'Reserved context (%)', type: 'number' as const,
          description: 'Compaction reserve as % of context window (0-90)' },
      ],
    },
  ];

  function stubFetchWithSave(settings: Record<string, any>, schemaData: any) {
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/settings/schema')) data = { success: true, data: schemaData };
        else if (u.includes('/api/settings') && init?.method === 'POST') data = { success: true };
        else if (u.includes('/api/settings')) data = { success: true, data: settings };
        else if (u.includes('/api/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
  }

  it('renders a number input with the stored value', () => {
    stubFetchWithSave({ reserveTokensPercent: 25 }, numberSchema);
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('input[type="number"].settings-input').should('have.value', '25');
  });

  it('saves the edited percentage', () => {
    stubFetchWithSave({ reserveTokensPercent: 0 }, numberSchema);
    let savedBody: any = null;
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/settings/schema')) data = { success: true, data: numberSchema };
        else if (u.includes('/api/settings') && init?.method === 'POST') {
          savedBody = JSON.parse(init.body);
          data = { success: true };
        }
        else if (u.includes('/api/settings')) data = { success: true, data: { reserveTokensPercent: 0 } };
        else if (u.includes('/api/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('input[type="number"].settings-input').clear().type('30');
    cy.contains('button', 'Save').click();
    cy.wrap(null).should(() => {
      expect(savedBody).to.deep.equal({ reserveTokensPercent: '30' });
    });
  });
});
