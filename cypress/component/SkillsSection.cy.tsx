import React from 'react';
import '../../src/frontend/styles.scss';
import { SkillsSection } from '../../src/frontend/components/SkillsSection';

const skills = [
  { name: 'pdf-tools', description: 'Extract text from PDFs', shared: false, hasSkillMd: true, template: true },
  { name: 'autere', description: 'Dashboard knowledge', shared: true, hasSkillMd: true, template: false },
];

const tree = [
  { path: 'SKILL.md', type: 'file', size: 40 },
  { path: 'scripts', type: 'dir', size: 0 },
  { path: 'scripts/extract.sh', type: 'file', size: 12 },
];

const files: Record<string, string> = {
  'SKILL.md': '---\nname: pdf-tools\ndescription: Extract text from PDFs\n---\n# pdf-tools\n',
  'scripts/extract.sh': '#!/bin/sh\n',
};

function stubFetch() {
  const calls: Array<{ url: string; method?: string; body?: any }> = [];
  cy.window({ log: false }).then((win) => {
    win.fetch = (input: any, init: any) => {
      const u = String(input);
      const method = init?.method || 'GET';
      let body: any;
      try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      calls.push({ url: u, method, body });
      (win as any).__skillCalls = calls;

      let data: any = { success: true };
      if (u.endsWith('/api/v1/skills') && method === 'GET') data = { success: true, data: skills };
      else if (u.endsWith('/api/v1/skills') && method === 'POST') data = { success: true, data: skills[0] };
      else if (u.includes('/api/v1/skills/import')) data = { success: true, data: { files: 2 } };
      else if (u.includes('/tree')) data = { success: true, data: tree };
      else if (u.includes('/template')) {
        data = method === 'GET'
          ? { success: true, data: { content: '---\ndescription: Extract\n---\n' } }
          : { success: true };
      } else if (u.includes('/file')) {
        const path = decodeURIComponent(new URL(u, 'http://x').searchParams.get('path') || '');
        if (method === 'GET') data = { success: true, data: { content: files[path] ?? '', binary: false } };
        else data = { success: true };
      }
      return Promise.resolve({ json: () => Promise.resolve(data), ok: true } as any);
    };
  });
}

const callsOf = (win: any) => (win as any).__skillCalls as Array<{ url: string; method?: string; body?: any }>;

describe('SkillsSection', () => {
  it('lists skills as a table with edit and delete actions', () => {
    stubFetch();
    cy.mount(<SkillsSection />);
    cy.get('.data-table tbody tr').should('have.length', 2);
    cy.contains('.data-table tbody tr', 'pdf-tools').within(() => {
      cy.contains('Extract text from PDFs').should('exist');
      cy.contains('code', '/pdf-tools').should('exist');
      cy.contains('button', 'Edit').should('exist');
      cy.contains('button', 'Delete').should('exist');
    });
    cy.contains('.data-table tbody tr', 'autere').contains('.skills-badge', 'shared').should('exist');
  });

  it('creates a skill from the New skill modal', () => {
    stubFetch();
    cy.mount(<SkillsSection />);
    cy.contains('button', 'New skill').click();
    cy.get('.modal-skills-form').should('exist');
    cy.get('.modal-skills-form input[type="text"]').eq(0).type('pdf-tools');
    cy.get('.modal-skills-form input[type="text"]').eq(1).type('Extract text from PDFs');
    cy.get('.modal-skills-form').contains('button', 'Create skill').click();
    cy.window({ log: false }).then((win) => {
      const post = callsOf(win).find((c) => c.method === 'POST' && c.url.endsWith('/api/v1/skills'));
      expect(post, 'create called').to.exist;
      expect(post!.body).to.deep.equal({ name: 'pdf-tools', description: 'Extract text from PDFs' });
    });
    cy.get('.modal-skills-form').should('not.exist');
  });

  it('imports a zip package from the Import modal', () => {
    stubFetch();
    cy.mount(<SkillsSection />);
    cy.contains('button', 'Import').click();
    cy.get('.modal-skills-form').contains('button', 'Import package').should('be.disabled');
    cy.get('.modal-skills-form input[type="file"]')
      .selectFile({ contents: Cypress.Buffer.from('PK\u0003\u0004fake'), fileName: 'skill.zip' });
    cy.get('.modal-skills-form input[type="text"]').eq(0).type('pdf-tools');
    cy.get('.modal-skills-form').contains('button', 'Import package').should('not.be.disabled').click();
    cy.window({ log: false }).then((win) => {
      const post = callsOf(win).find((c) => c.url.includes('/skills/import'));
      expect(post, 'import called').to.exist;
      expect(post!.body.name).to.equal('pdf-tools');
      expect(post!.body.zip.length).to.be.greaterThan(0);
    });
    cy.get('.modal-skills-form').should('not.exist');
  });

  it('edits a skill in the Edit modal', () => {
    stubFetch();
    cy.mount(<SkillsSection />);
    cy.contains('.data-table tbody tr', 'pdf-tools').contains('button', 'Edit').click();
    cy.get('.modal-skills-edit').should('exist');
    cy.get('.modal-skills-edit textarea').should('contain.value', '# pdf-tools');
    cy.get('.modal-skills-edit').contains('.skills-tree-item', 'extract.sh').should('exist');
    cy.get('.modal-skills-edit textarea').type('\nmore');
    cy.get('.modal-skills-edit').contains('button', 'Save').click();
    cy.window({ log: false }).then((win) => {
      const put = callsOf(win).find((c) => c.method === 'PUT' && c.url.includes('/file'));
      expect(put, 'file PUT').to.exist;
      expect(put!.body.path).to.equal('SKILL.md');
      expect(put!.body.content).to.contain('more');
    });
  });

  it('creates a new file via the tree actions', () => {
    stubFetch();
    cy.window({ log: false }).then((win) => cy.stub(win, 'prompt').returns('references/formats.md'));
    cy.mount(<SkillsSection />);
    cy.contains('.data-table tbody tr', 'pdf-tools').contains('button', 'Edit').click();
    cy.get('.modal-skills-edit').contains('button', '+ File').click();
    cy.window({ log: false }).then((win) => {
      const put = callsOf(win).find((c) => c.method === 'PUT' && c.url.includes('/file'));
      expect(put, 'create file').to.exist;
      expect(put!.body).to.deep.equal({ path: 'references/formats.md', content: '' });
    });
  });

  it('edits the prompt template in the Edit modal', () => {
    stubFetch();
    cy.mount(<SkillsSection />);
    cy.contains('.data-table tbody tr', 'pdf-tools').contains('button', 'Edit').click();
    cy.get('.modal-skills-edit').contains('.skills-tab', 'Prompt template').click();
    cy.get('.modal-skills-edit textarea').should('contain.value', 'description: Extract');
    cy.get('.modal-skills-edit textarea').type(' Extra instructions');
    cy.get('.modal-skills-edit').contains('button', 'Save template').click();
    cy.window({ log: false }).then((win) => {
      const put = callsOf(win).find((c) => c.method === 'PUT' && c.url.includes('/template'));
      expect(put, 'template PUT').to.exist;
      expect(put!.body.content).to.contain('Extra instructions');
    });
  });

  it('renders a shared skill read-only', () => {
    stubFetch();
    cy.mount(<SkillsSection />);
    cy.contains('.data-table tbody tr', 'autere').contains('button', 'Edit').click();
    cy.get('.modal-skills-edit').contains('shared — read-only').should('exist');
    cy.get('.modal-skills-edit textarea').should('have.attr', 'readonly');
    cy.get('.modal-skills-edit').contains('button', 'Save').should('be.disabled');
  });
});
