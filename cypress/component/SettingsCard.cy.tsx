import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsCard } from '../../src/frontend/components/SettingsCard';
import type { SettingSection } from '../../src/frontend/types';

const schema: SettingSection[] = [
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


// Backend appends personas/apiTokens sections to the schema (backend-driven
// sections since f10778a) — mirror that contract in every stub.
const backendSections = [
  { id: 'apiTokens', label: 'API Tokens', fields: [] },
  { id: 'personas', label: 'Personas', fields: [] },
];

function stubFetch(settings: Record<string, any>) {
  // Component tests run in an already-loaded page — cy.intercept and
  // window:before:load don't apply, so stub window.fetch directly.
  cy.window({ log: false }).then((win) => {
    win.fetch = (input: any, _init: any) => {
      const u = String(input);
      let data: any = { success: true };
      if (u.includes('/api/v1/settings/schema')) data = { success: true, data: [...schema, ...backendSections] };
      else if (u.includes('/api/v1/settings')) data = { success: true, data: settings };
      else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
      return Promise.resolve({ json: () => Promise.resolve(data) } as any);
    };
  });
}

describe('SettingsCard select fields', () => {
  it('renders a select with auto option and discovered models', () => {
    stubFetch({ imageModel: '' });
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('select.settings-input').should('exist');
    cy.get('select.settings-input option').should('have.length', 3);
    cy.get('select.settings-input option').first().should('contain', 'Auto (first available)');
    cy.get('select.settings-input option').eq(1).should('contain', 'Model A');
  });

  it('shows the selected value', () => {
    stubFetch({ imageModel: 'model-b' });
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
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
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: [...schemaData, ...backendSections] };
        else if (u.includes('/api/v1/settings') && init?.method === 'PUT') data = { success: true };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: settings };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
  }

  it('renders a number input with the stored value', () => {
    stubFetchWithSave({ reserveTokensPercent: 25 }, numberSchema);
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('input[type="number"].settings-input').should('have.value', '25');
  });

  it('saves the edited percentage', () => {
    stubFetchWithSave({ reserveTokensPercent: 0 }, numberSchema);
    let savedBody: any = null;
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: [...numberSchema, ...backendSections] };
        else if (u.includes('/api/v1/settings') && init?.method === 'PUT') {
          savedBody = JSON.parse(init.body);
          data = { success: true };
        }
        else if (u.includes('/api/v1/settings')) data = { success: true, data: { reserveTokensPercent: 0 } };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
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
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: [...twoSectionSchema, ...backendSections] };
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
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
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
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
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
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('.sortable-list-item').should('have.length', 2);
    cy.get('.sortable-list-item').first().find('input[type=text]').should('have.value', '/tmp');
    cy.get('.sortable-list-item').first().find('input[type=checkbox]').first().should('be.checked');
    cy.get('.sortable-list-item').first().find('input[type=checkbox]').eq(1).should('not.be.checked');
  });

  it('unchecking the last flag removes the row and adding appends', () => {
    stubFetch({ folderIgnores: [{ path: '.git', edits: true, files: true }] });
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
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
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: [...schema, ...backendSections] };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: {} };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        else if (u.endsWith('/api/v1/tokens')) data = { success: true, data: [] };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
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
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: [...ordered, ...backendSections].sort((a, b) => a.label.localeCompare(b.label)) };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: {} };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('.settings-menu-btn').then(($btns) => {
      const labels = [...$btns].map((b) => b.textContent);
      expect(labels).to.deep.eq(['Alpha', 'API Tokens', 'Personas', 'Zulu']);
    });
  });
});

describe('SettingsCard section deep links', () => {
  const twoSections = [
    { id: 'general', label: 'General', fields: [{ key: 'a', label: 'A', type: 'text' as const }] },
    { id: 'models', label: 'Models', fields: [{ key: 'b', label: 'B', type: 'text' as const }] },
  ];
  function stubTwo() {
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: twoSections };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: { a: 'x', b: 'y' } };
        else if (u.includes('/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
  }

  it('opens the section named in ?section= on mount', () => {
    stubTwo();
    cy.mount(<MemoryRouter initialEntries={['/session/s1/settings?section=models']}><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('.settings-section-title', { timeout: 10000 }).should('contain', 'Models');
  });

  it('switches section on menu click (param written → back/forward restorable)', () => {
    stubTwo();
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('.settings-menu-btn.active', { timeout: 10000 }).should('contain', 'General');
    cy.get('.settings-menu-btn').contains('Models').click();
    cy.get('.settings-section-title').should('contain', 'Models');
    cy.get('.settings-menu-btn').contains('General').click();
    cy.get('.settings-section-title').should('contain', 'General');
  });

  it('unknown ?section= falls back to the first section', () => {
    stubTwo();
    cy.mount(<MemoryRouter initialEntries={['/session/s1/settings?section=nope']}><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('.settings-section-title', { timeout: 10000 }).should('contain', 'General');
  });
});

describe('SettingsCard models catalog table', () => {
  const modelsSchema: SettingSection[] = [
    {
      id: 'models',
      label: 'Models',
      fields: [
        { key: 'enabledModels', label: 'Enabled Models', type: 'list' },
        { key: 'modelThinkingLevels', label: 'Thinking level per model', type: 'perModel',
          perModel: { control: 'select', options: [ { value: '', label: 'pi default' }, { value: 'low', label: 'low' } ] } },
        { key: 'reserveTokensPercentByModel', label: 'Reserved context per model (%)', type: 'perModel', perModel: { control: 'number', min: 0, max: 90 } },
        { key: 'visionByModel', label: 'Image input per model', type: 'perModel',
          perModel: { control: 'select', options: [ { value: '', label: 'metadata' }, { value: 'on', label: 'image' } ] } },
      ],
    },
    { id: 'general', label: 'General', fields: [{ key: 'a', label: 'A', type: 'text' as const }] },
  ];
  const cat = [
    { provider: 'p1', id: 'm1', name: 'Model One' },
    { provider: 'p2', id: 'm2', name: 'Model Two' },
  ];

  function stubWithCatalog(settings: Record<string, any>) {
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: modelsSchema };
        else if (u.includes('/api/v1/models/available')) data = { success: true, data: cat };
        else if (u.includes('/api/v1/settings')) data = { success: true, data: settings };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
  }

  it('auto-loads the pi catalog; rows render stored per-model values', () => {
    stubWithCatalog({ enabledModels: ['p1/m1'], modelThinkingLevels: { 'p1/m1': 'low' }, reserveTokensPercentByModel: { 'p2/m2': '10' } });
    cy.mount(<MemoryRouter initialEntries={['/session/s1/settings?section=models']}><SettingsCard sseConnected={true} /></MemoryRouter>);
    // Catalog auto-loads when the section opens; Update re-reads it
    cy.get('.models-table tbody tr', { timeout: 10000 }).should('have.length', 2);
    cy.get('.models-table tbody tr').first().should('contain', 'Model One');
    // Enabled first (settings order), then the rest alphabetically
    cy.get('.models-table tbody tr').eq(0).find('input[type=checkbox]').should('be.checked');
    cy.get('.models-table tbody tr').eq(1).find('input[type=checkbox]').should('not.be.checked');
    // Stored per-model values show up in the row controls
    cy.contains('.models-table tbody tr', 'Model One').find('select').first().should('have.value', 'low');
    cy.contains('.models-table tbody tr', 'Model Two').find('input[type=number]').should('have.value', '10');
    cy.contains('button', 'Update available models').click();
    cy.get('.models-table tbody tr', { timeout: 10000 }).should('have.length', 2);
  });

  it('table controls write the same draft keys (enabled toggle appends)', () => {
    stubWithCatalog({ enabledModels: ['p1/m1'] });
    cy.mount(<MemoryRouter initialEntries={['/session/s1/settings?section=models']}><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('.models-table tbody tr', { timeout: 10000 }).should('have.length', 2); // auto-loaded
    // Enable Model Two → appended to the enabledModels draft
    cy.contains('.models-table tbody tr', 'Model Two').find('input[type=checkbox]').check();
    // Thinking level select writes modelThinkingLevels
    cy.contains('.models-table tbody tr', 'Model Two').find('select').first().select('low');
    cy.contains('.models-table tbody tr', 'Model Two').find('select').first().should('have.value', 'low');
    // Edits route into the same draft keys → Save posts them all
    let savedBody: any = null;
    cy.window({ log: false }).then((win) => {
      const real = win.fetch;
      win.fetch = (input: any, init?: any) => {
        if (String(input).includes('/api/v1/settings') && init?.method === 'PUT') {
          savedBody = JSON.parse(init.body);
        }
        return real(input, init);
      };
    });
    cy.contains('button', 'Save Settings').click();
    cy.wrap(null).should(() => {
      expect(savedBody.enabledModels).to.deep.eq(['p1/m1', 'p2/m2']);
      expect(savedBody.modelThinkingLevels).to.deep.eq({ 'p2/m2': 'low' });
    });
  });
});

describe('SettingsCard codemode/mcp (pi 1.0)', () => {
  const toolSchema = [
    { id: 'chat', label: 'Chat', fields: [
      { key: 'codemode', label: 'Codemode scripting', type: 'toggle' as const, description: 'Enable pi codemode' },
      { key: 'mcpServers', label: 'MCP servers', type: 'mcpServers' as const, description: 'MCP servers' },
    ]},
  ];
  const savedBodyHolder: { body: any } = { body: null };

  function stub(settings: Record<string, any>, capture: boolean) {
    cy.window({ log: false }).then((win) => {
      win.fetch = (input: any, init: any) => {
        const u = String(input);
        let data: any = { success: true };
        if (u.includes('/api/v1/settings/schema')) data = { success: true, data: [...toolSchema, ...backendSections] };
        else if (u.includes('/api/v1/settings') && init?.method === 'PUT') {
          if (capture) savedBodyHolder.body = JSON.parse(init.body);
          data = { success: true };
        }
        else if (u.includes('/api/v1/settings')) data = { success: true, data: settings };
        else if (u.includes('/api/v1/extensions/packages')) data = { success: true, data: { available: [] } };
        return Promise.resolve({ json: () => Promise.resolve(data) } as any);
      };
    });
  }

  it('renders the codemode toggle and MCP rows; save posts the mcpServers object', () => {
    stub({ codemode: true, mcpServers: { fs: { command: 'npx', args: ['-y', 'pkg'], exposure: 'codemode' } } }, true);
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.get('.mcp-server-row').should('have.length', 1);
    cy.get('.mcp-name').should('have.value', 'fs');
    cy.get('.mcp-command').should('have.value', 'npx');
    cy.get('.mcp-args').should('have.value', '-y, pkg');
    // Make a change first — the save button only renders when dirty
    cy.get('.mcp-exposure').select('deferred');
    cy.contains('button', 'Save Settings').click();
    cy.wrap(null).should(() => {
      expect(savedBodyHolder.body.codemode).to.eq(true);
      expect(savedBodyHolder.body.mcpServers.fs).to.deep.eq({ command: 'npx', args: ['-y', 'pkg'], exposure: 'deferred' });
    });
  });

  it('add/remove rows and exposure select edit the mcp draft', () => {
    stub({ codemode: false, mcpServers: {} }, false);
    cy.mount(<MemoryRouter><SettingsCard sseConnected={true} /></MemoryRouter>);
    cy.contains('button', '+ Add MCP Server').click();
    cy.get('.mcp-server-row').should('have.length', 1);
    cy.get('.mcp-exposure').select('direct');
    cy.get('.mcp-exposure').should('have.value', 'direct');
    cy.get('.sortable-list-remove').click();
    cy.get('.mcp-server-row').should('have.length', 0);
  });
});
