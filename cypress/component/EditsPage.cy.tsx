import React from 'react';
import { EditsPage } from '../../src/frontend/components/EditsPage';
// Global styles — Monaco needs a laid-out parent (flex heights live here)
import '../../src/frontend/styles.scss';

const ROOT = { path: '/home/test', access: 'rw' };
const ROOT_ENTRIES: any[] = [
  { name: 'src', type: 'dir', size: 0, mtime: 1 },
  { name: 'hello.txt', type: 'file', size: 22, mtime: 2 },
];
const SRC_ENTRIES: any[] = [{ name: 'index.ts', type: 'file', size: 10, mtime: 3 }];

interface Call { url: string; opts?: any }

/**
 * window.fetch stub for /api/browse/*. /list under .../src returns
 * SRC_ENTRIES, other dirs ROOT_ENTRIES. File read returns "hello world".
 * Every call is recorded for assertions.
 */
function stubFetch(): { calls: Call[]; fetch: any } {
  const calls: Call[] = [];
  const fetch = (u: any, opts?: any) => {
    calls.push({ url: String(u), opts });
    const s = String(u);
    if (s.includes('/api/browse/roots')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [ROOT] }) });
    }
    if (s.includes('/api/browse/list')) {
      const list = decodeURIComponent(s.split('path=')[1] || '').endsWith('/src') ? SRC_ENTRIES : ROOT_ENTRIES;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: list }) });
    }
    if (s.includes('/api/browse/read')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { content: 'hello world', binary: false, truncated: false, size: 11 } }) });
    }
    if (s.includes('/api/browse/write') || s.includes('/api/browse/delete')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { ok: true } }) });
    }
    // Anything else (e.g. the Changes tab's file-changes fetch) → empty data
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) });
  };
  return { calls, fetch: fetch as any };
}

const mountWith = (userRole: string) => {
  const s = stubFetch();
  cy.stub(window, 'fetch').callsFake(s.fetch);
  // Fixed-size wrapper — the real app provides a laid-out parent via
  // .edits-card's flex column; Monaco's frame layout can lag in the test
  // iframe, so content assertions go through the editor handle instead.
  cy.mount(<div style={{ height: 700, width: 1200, display: 'flex', flexDirection: 'column' }}><EditsPage sessionId="s1" userRole={userRole} /></div>);
  return s;
};

/** Wait until a Monaco editor instance is mounted, then read its model */
// NOTE: no cy assertions directly on the editor object — Cypress's error
// formatter deep-walks it into monaco's config and explodes.
const editorValue = () => cy.window({ timeout: 20000 }).then((w) => {
  const ed = (w as any).__autereEd;
  if (!ed) throw new Error('monaco editor not mounted');
  return ed.getValue();
});

// The sole root auto-expands → 3 rows immediately (root + src + hello.txt)
describe('EditsPage — Files tab', () => {
  it('renders roots, expands directories and opens files (read-only for chat role)', () => {
    mountWith('chat');
    cy.get('.files-row', { timeout: 15000 }).should('have.length', 3);
    cy.get('.files-row').should('contain', '/home/test');
    cy.get('.files-access-rw').should('exist');

    // Expand the nested dir → lazy listing adds its child
    cy.get('.files-row').contains('src').click();
    cy.get('.files-row', { timeout: 10000 }).should('have.length', 4);
    cy.get('.files-row').should('contain', 'index.ts');

    // Open a file → content in the editor model; no write buttons
    cy.get('.files-row').contains('hello.txt').click();
    editorValue().then((v) => expect(v).to.eq('hello world'));
    cy.get('.files-save').should('not.exist');
    cy.get('.files-delete').should('not.exist');
    cy.get('.files-ro').should('exist');
  });

  it('saves edited content and deletes files for control role (with confirm)', () => {
    const { calls } = mountWith('control');
    cy.stub(window, 'confirm').returns(true);

    cy.get('.files-row', { timeout: 15000 }).should('have.length', 3);
    cy.get('.files-row').contains('hello.txt').click();
    editorValue().then((v) => expect(v).to.eq('hello world'));

    // Save button appears for control role, disabled until dirty
    cy.get('.files-save').should('exist').and('be.disabled');
    cy.get('.files-delete').should('exist');

    // Edit via the model → onChange fires → dirty → save posts the content
    cy.window().then((w) => {
      (w as any).__autereEd.setValue('hello world\nappended line');
    });
    cy.get('.files-save').should('not.be.disabled').click();
    cy.then(() => {
      const write = calls.find((c) => c.opts?.method === 'POST' && c.url.includes('/api/browse/write'));
      expect(write, 'write POST happened').to.be.ok;
      const body = JSON.parse(write!.opts.body);
      expect(body.path).to.eq('/home/test/hello.txt');
      expect(body.content).to.contain('appended line');
    });

    // Delete confirms and posts
    cy.get('.files-delete').click();
    cy.then(() => {
      const del = calls.find((c) => c.opts?.method === 'POST' && c.url.includes('/api/browse/delete'));
      expect(del, 'delete POST happened').to.be.ok;
      expect(JSON.parse(del!.opts.body).path).to.eq('/home/test/hello.txt');
    });
  });

  it('shows the Changes tab with the per-session history', () => {
    mountWith('admin');
    cy.get('.edits-tabs').contains('Changes').click();
    cy.get('.changes-page').should('exist');
  });
});
