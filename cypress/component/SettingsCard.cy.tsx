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
      if (u.includes('/api/v1/settings/schema')) data = { success: true, data: schema };
      else if (u.includes('/api/v1/settings')) data = { success: true, data: settings };
      else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
      return Promise.resolve({ json: () => Promise.resolve(data) } as any);
    };
  });
}

describe('SettingsCard select fields', () => {
  it('renders a select with auto option and discovered models', () => {
    stubFetch({ imageModel: '' });
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('select.settings-input').should('exist');
    cy.get('select.settings-input option').should('have.length', 3);
    cy.get('select.settings-input option').first().should('contain', 'Auto (first available)');
    cy.get('select.settings-input option').eq(1).should('contain', 'Model A');
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
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: perModelSchema };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: {
          enabledModels: ['z-ai/glm-5.3-flash', 'anthropic/claude-x'],
          modelThinkingLevels: { 'z-ai/glm-5.3-flash': 'high' },
          reserveTokensPercentByModel: { 'anthropic/claude-x': '10' },
        } };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
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
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: perModelSchema };
        else if (u.includes('/api/v1/settings') && init?.method === 'PUT') { savedBody = JSON.parse(init.body); data = { success: true }; }
        else if (u.includes('/api/v1/settings')) data = { success: true, data: settings };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
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
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: schemaData };
        else if (u.includes('/api/v1/settings') && init?.method === 'PUT') data = { success: true };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: settings };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
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
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: numberSchema };
        else if (u.includes('/api/v1/settings') && init?.method === 'PUT') {
          savedBody = JSON.parse(init.body);
          data = { success: true };
        }
        else if (u.includes('/api/v1/settings')) data = { success: true, data: { reserveTokensPercent: 0 } };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
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

describe('SettingsCard side menu', () => {
  const twoSectionSchema = [
    { id: 'images', label: 'Images', fields: [ { key: 'imageModel', label: 'Image Model', type: 'select' as const, options: [] } ] },
    { id: 'sandbox', label: 'Sandbox', fields: [ { key: 'piSandboxImage', label: 'Sandbox Image', type: 'text' as const } ] },
  ];

  function stubTwo(putSpy?: (args: any) => void) {
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: twoSectionSchema };
        else if (u.includes('/api/v1/settings')) {
          if (init?.method === 'POST') { putSpy?.(init); return Promise.resolve({ json: () => Promise.resolve({ success: true, data }) } as any); }
          data = { success: true, data: { imageModel: '' } };
        } else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
  }

  it('renders category side menu and shows only the active section', () => {
    stubTwo();
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('.settings-menu-btn').should('have.length', 4); // 2 sections + Personas + API Tokens
    cy.get('.settings-menu-btn').first().should('have.class', 'active');
    cy.get('.settings-content select.settings-input').should('exist');
    cy.get('.settings-menu-btn').eq(1).click(); // backend order: Images, Sandbox (+Personas, +API Tokens)
    cy.get('.settings-content input.settings-input').should('exist');
    cy.contains('.settings-content', 'Sandbox Image').should('exist');
    cy.contains('.settings-content', 'Image Model').should('not.exist');
  });

  it('shows the save button under the categories only when dirty; saves', () => {
    const post = (args: any) => (window as any).__post = args;
    stubTwo(post);
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('.settings-save-btn').should('not.exist');
    cy.get('.settings-menu-btn').eq(1).click();
    cy.get('.settings-content input.settings-input').type('img-x');
    cy.get('.settings-save-btn').should('exist');
    cy.get('.settings-save-btn').click();
    cy.get('.settings-save-btn').should('not.exist');
    cy.contains('.settings-saved', 'Restarting').should('exist');
  });
});

describe('SettingsCard folderIgnores fields', () => {
  const _folderSchema = [
    {
      id: 'files',
      label: 'Files',
      fields: [
        { key: 'folderIgnores', label: 'Ignored folders', type: 'folderIgnores' as const },
      ],
    },
  ];

  // The folderIgnores schema lives inside the shared stub schema — patch it.
  beforeEach(() => { (schema as any).length = 0; schema.push({ id: 'files', label: 'Files', fields: [ { key: 'folderIgnores', label: 'Ignored folders', type: 'folderIgnores' as const } ] }); });

  it('renders rows with edits/files toggles', () => {
    stubFetch({ folderIgnores: [
      { path: '/tmp', edits: true, files: false },
      { path: 'node_modules', edits: true, files: true },
    ] });
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('.sortable-list-item').should('have.length', 2);
    cy.get('.sortable-list-item').first().find('input[type=text]').should('have.value', '/tmp');
    cy.get('.sortable-list-item').first().find('input[type=checkbox]').first().should('be.checked');
    cy.get('.sortable-list-item').first().find('input[type=checkbox]').eq(1).should('not.be.checked');
  });

  it('unchecking the last flag removes the row and adding appends', () => {
    stubFetch({ folderIgnores: [{ path: '.git', edits: true, files: true }] });
    cy.mount(<SettingsCard sseConnected={true} />);
    // uncheck both flags on the row → row is dropped
    cy.get('.sortable-list-item input[type=checkbox]').first().uncheck();
    cy.get('.sortable-list-item input[type=checkbox]').last().uncheck();
    cy.get('.sortable-list-item').should('not.exist');
    // Add: type a path then submit — a new row with both flags on appears
    cy.get('.sortable-list-add .sortable-list-input').type('node_modules');
    cy.contains('Add folder').click();
    cy.get('.sortable-list-item').should('have.length', 1);
    cy.get('.sortable-list-item input[type=checkbox]').should('be.checked').and('have.length', 2);
    cy.get('.sortable-list-add .sortable-list-input').should('have.value', '');
  });
});

describe('SettingsCard API tokens section', () => {
  it('stays on API Tokens after clicking it (no reset to first schema section)', () => {
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, _init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: schema };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: {} };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        else if (u.endsWith('/api/v1/tokens')) data = { success: true, data: [] };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.contains('.settings-menu-btn', 'API Tokens').click();
    // the validity-reset effect used to snap selection back to the first
    // schema section (e.g. 9router/Images) here
    cy.contains('.settings-menu-btn', 'API Tokens').should('have.class', 'active');
    cy.contains('.settings-section-title', 'API Tokens').should('exist');
    cy.contains('Create token').should('exist');
  });

  it('renders schema sections in backend order (no client-side sort)', () => {
    const ordered = [
      { id: 'zeta', label: 'Zulu', fields: [{ key: 'a', label: 'A', type: 'text' as const }] },
      { id: 'alpha', label: 'Alpha', fields: [{ key: 'b', label: 'B', type: 'text' as const }] },
    ];
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, _init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: ordered };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: {} };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
    cy.mount(<SettingsCard sseConnected={true} />);
    cy.get('.settings-menu-btn').then(($btns) => {
      const labels = [...$btns].map((b) => b.textContent);
      expect(labels).to.deep.eq(['Zulu', 'Alpha', 'Personas', 'API Tokens']);
    });
  });
});
