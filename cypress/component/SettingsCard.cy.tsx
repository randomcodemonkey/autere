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

describe('SettingsCard per-model fields', () => {
  const perModelSchema = [
    {
      id: 'models',
      label: 'Models',
      fields: [
        { key: 'enabledModels', label: 'Enabled Models', type: 'list' as const },
        { key: 'modelThinkingLevels', label: 'Thinking level per model', type: 'perModel' as const,
          perModel: { control: 'select' as const, options: [
            { value: '', label: 'pi default' }, { value: 'off', label: 'off' }, { value: 'high', label: 'high' },
          ] } },
        { key: 'reserveTokensPercentByModel', label: 'Reserved context per model (%)', type: 'perModel' as const,
          perModel: { control: 'number' as const, min: 0, max: 90 } },
      ],
    },
  ];

  it('renders one row per enabled model with the stored values', () => {
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, _init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/settings/schema')) data = { success: true, data: perModelSchema };
        else if (u.includes('/api/settings')) data = { success: true, data: {
          enabledModels: ['z-ai/glm-5.3-flash', 'anthropic/claude-x'],
          modelThinkingLevels: { 'z-ai/glm-5.3-flash': 'high' },
          reserveTokensPercentByModel: { 'anthropic/claude-x': '10' },
        } };
        else if (u.includes('/api/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('.settings-per-model-row').should('have.length', 4); // 2 models × 2 fields
    cy.get('.settings-per-model-name').first().should('contain', 'z-ai/glm-5.3-flash');
    cy.get('select.settings-input').first().should('have.value', 'high');
    cy.get('select.settings-input').eq(1).should('have.value', '');
    cy.get('input[type="number"].settings-input').eq(1).should('have.value', '10');
  });

  it('saves per-model levels and drops entries reset to the default', () => {
    let savedBody: any = null;
    const settings = {
      enabledModels: ['a/m1', 'a/m2'],
      modelThinkingLevels: { 'a/m1': 'off' },
      reserveTokensPercentByModel: {},
    };
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/settings/schema')) data = { success: true, data: perModelSchema };
        else if (u.includes('/api/settings') && init?.method === 'POST') { savedBody = JSON.parse(init.body); data = { success: true }; }
        else if (u.includes('/api/settings')) data = { success: true, data: settings };
        else if (u.includes('/api/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
    cy.mount(<SettingsCard sseConnected={true} />);
    // Row 1: clear the stored 'off' → entry removed. Row 2: set 'high'.
    cy.get('select.settings-input').first().select('');
    cy.get('select.settings-input').eq(1).select('high');
    cy.contains('button', 'Save').click();
    cy.wrap(null).should(() => {
      expect(savedBody.modelThinkingLevels).to.deep.equal({ 'a/m2': 'high' });
    });
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
