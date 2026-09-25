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
 * window.fetch stub for /api/v1/browse/*. /list under .../src returns
 * SRC_ENTRIES, other dirs ROOT_ENTRIES. File read returns "hello world".
 * Every call is recorded for assertions.
 */
function stubFetch(): { calls: Call[]; fetch: any } {
  const calls: Call[] = [];
  const fetch = (u: any, opts?: any) => {
    calls.push({ url: String(u), opts });
    const s = String(u);
    if (s.includes('/api/v1/browse/roots')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [ROOT] }) });
    }
    if (s.includes('/api/v1/browse/list')) {
      const list = decodeURIComponent(s.split('path=')[1] || '').endsWith('/src') ? SRC_ENTRIES : ROOT_ENTRIES;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: list }) });
    }
    if (s.includes('/api/v1/browse/read')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { content: 'hello world', binary: false, truncated: false, size: 11 } }) });
    }
    if (s.includes('/api/v1/browse/file')) {
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

/** editorValue, retrying until the freshly mounted editor carries the value */
const expectEditorValue = (expected: string, attempt = 0) => {
  editorValue().then((v) => {
    if (v === expected) expect(v).to.eq(expected);
    else if (attempt < 20) cy.wait(300).then(() => expectEditorValue(expected, attempt + 1));
    else expect(v, `editor value (after ${attempt} retries)`).to.eq(expected);
  });
};

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
    expectEditorValue('hello world');
    cy.get('.files-save').should('not.exist');
    cy.get('.files-delete').should('not.exist');
    cy.get('.files-ro').should('exist');
  });

  it('saves edited content and deletes files for control role (with confirm)', () => {
    const { calls } = mountWith('control');
    cy.stub(window, 'confirm').returns(true);

    cy.get('.files-row', { timeout: 15000 }).should('have.length', 3);
    cy.get('.files-row').contains('hello.txt').click();
    expectEditorValue('hello world');

    // Save button appears for control role, disabled until dirty
    cy.get('.files-save').should('exist').and('be.disabled');
    cy.get('.files-delete').should('exist');

    // Edit via the model → onChange fires → dirty → save posts the content
    cy.window().then((w) => {
      (w as any).__autereEd.setValue('hello world\nappended line');
    });
    cy.get('.files-save').should('not.be.disabled').click();
    cy.then(() => {
      const write = calls.find((c) => c.opts?.method === 'PUT' && c.url.includes('/api/v1/browse/file'));
      expect(write, 'write POST happened').to.be.ok;
      const body = JSON.parse(write!.opts.body);
      expect(body.path).to.eq('/home/test/hello.txt');
      expect(body.content).to.contain('appended line');
    });

    // Delete confirms and posts
    cy.get('.files-delete').click();
    cy.then(() => {
      const del = calls.find((c) => c.opts?.method === 'DELETE' && c.url.includes('/api/v1/browse/file'));
      expect(del, 'delete happened').to.be.ok;
      expect(del!.url).to.contain(encodeURIComponent('/home/test/hello.txt'));
    });
  });

  it('shows the Session Edits tab with the per-session history', () => {
    mountWith('admin');
    cy.get('.edits-tabs').contains('Session Edits').click();
    cy.get('.changes-files').should('exist');
  });

  it('search filters the tree to matches and their ancestor chain', () => {
    mountWith('chat');
    cy.get('.files-row', { timeout: 15000 }).should('have.length', 3);
    // Only src/index.ts matches — root + src ancestors shown, hello.txt hidden
    cy.get('.files-search').type('index');
    cy.get('.files-row', { timeout: 10000 }).should('have.length', 3);
    cy.get('.files-row').should('contain', 'index.ts');
    cy.get('.files-row.files-matched').should('contain', 'index.ts');
    cy.get('.files-row').should('not.contain', 'hello.txt');
    // Folder matches render as folders (they can be re-opened after clearing)
    cy.get('.files-search').clear().type('src');
    cy.get('.files-row', { timeout: 10000 }).should('contain', 'src');
    // Trailing-slash: everything under folders named 'src' — subtree shown
    cy.get('.files-search').clear().type('src/');
    cy.get('.files-row', { timeout: 10000 }).should('have.length', 3);
    cy.get('.files-row').should('contain', 'index.ts');
    // Clearing restores the full tree
    cy.get('.files-search').clear();
    cy.get('.files-row', { timeout: 10000 }).should('contain', 'hello.txt');
  });
});

// ── Repositories tab ──
const REPO = { path: '/home/test/proj', access: 'rw', isRepo: true };
const PLAIN = { path: '/home/test/plain', access: 'rw', isRepo: false };
const PROJ_ENTRIES: any[] = [{ name: 'app.ts', type: 'file', size: 3, mtime: 5 }];
const REPO_DETAIL = {
  root: '/home/test/proj',
  isRepo: true,
  branch: 'main',
  changed: [{ x: 'M', y: 'M', path: 'app.ts' }],
  remotes: [{ name: 'origin', url: 'http://git:3000/xenic/pi-monitor.git' }],
  commits: [{ hash: 'h1', short: 'a1b2c3d', author: 'Tester', date: 1700000000000, subject: 'first commit' }],
  hasMore: true,
};

/** Fetch stub covering git endpoints + the browse endpoints reposMode uses */
function stubGitFetch(repoDetail = REPO_DETAIL): { calls: Call[]; fetch: any } {
  const s = stubFetch();
  const fetch = (u: any, opts?: any) => {
    const str = String(u);
    if (str.includes('/api/v1/git/')) s.calls.push({ url: str, opts });
    if (str.includes('/api/v1/git/repos')) {
      if (opts?.method === 'POST') {
        s.calls.push({ url: str, opts });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { initialized: true } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [REPO, PLAIN] }) });
    }
    if (str.includes('/api/v1/git/repo?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: repoDetail }) });
    if (str.includes('/api/v1/git/commits')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [{ hash: 'h1', short: 'a1b2c3d', author: 'Tester', date: 1700000000000, subject: 'app commit' }] }) });
    if (str.includes('/api/v1/git/diff')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { diff: '--- a/app.ts\n+++ b/app.ts\n+hline' } }) });
    if (str.includes('/api/v1/git/list')) {
      (window as any).__gl = decodeURIComponent(str.split('path=')[1] || '');
      const dir = (window as any).__gl;
      const list = dir.endsWith('/proj') ? PROJ_ENTRIES : [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: list }) });
    }
    return s.fetch(u, opts);
  };
  return { ...s, fetch: fetch as any };
}

describe('EditsPage — Repositories tab', () => {
  it('shows configured repos as a tree, root click opens details + folder, files get Editor/Commits tabs', () => {
    const s = stubGitFetch();
    cy.stub(window, 'fetch').callsFake(s.fetch);
    cy.mount(<div style={{ height: 700, width: 1200, display: 'flex', flexDirection: 'column' }}><EditsPage sessionId="s1" userRole="control" /></div>);
    cy.get('.edits-tabs').contains('Repositories').click();

    // Two configured roots visible; the repo one was NOT auto-expanded (len 2)
    cy.get('.files-row', { timeout: 15000 }).should('have.length', 2);
    cy.get('.files-row').should('contain', 'proj');

    // Root click = plain expand/collapse; detail pane opens via the Status button
    cy.get('.files-row').contains('proj').click();
    cy.get('.files-row').contains('app.ts', { timeout: 10000 }).should('exist');
    cy.get('.files-row').contains('proj').parent().find('.repo-row-btn').contains('status').click();
    cy.get('.repo-detail', { timeout: 10000 }).should('contain', '⎇ main');
    cy.get('.repo-detail').should('contain', 'origin');
    cy.get('.repo-detail').should('contain', 'first commit');
    cy.get('.repo-detail').should('contain', 'app.ts');
    // Load-more button since hasMore
    cy.get('.repo-load-more').should('exist');

    // Folder expanded its listing

    // File click → open in repo scope: Diff default (app.ts is in git status)
    cy.get('.files-row').contains('app.ts').click();
    cy.get('.files-detail-tabs', { timeout: 10000 }).should('exist');
    cy.get('.files-detail-tabs button.active').should('contain', 'Diff');
    // Diff pane renders the diff text
    cy.get('.files-diff-editor').should('exist');

    // Editor tab shows the file content; Commits tab lists file history.
    // Editor swaps (diff → plain) dispose the old monaco model, so the
    // __autereEd debug handle goes stale here — assert via the DOM instead.
    cy.get('.files-detail-tabs').contains('Editor').click();
    cy.get('.files-diff-editor').should('not.exist');
    cy.get('.view-lines', { timeout: 10000 }).first().invoke('text').then((t) => {
      expect(t.slice(0, 80), 'editor content').to.include('hello');
    });
    cy.get('.files-detail-tabs').contains('Commits').click();
    cy.get('.repo-file-log', { timeout: 10000 }).should('contain', 'app commit');

    // Pagination "Load more" re-requests with a higher count
    // (root click now collapses — reopen details via Status)
    cy.get('.files-row').contains('proj').parent().find('.repo-row-btn').contains('status').click();
    cy.get('.repo-load-more', { timeout: 10000 }).click();
    cy.then(() => {
      const detailCalls = s.calls.filter((c) => c.url.includes('/api/v1/git/repo?'));
      const counts = detailCalls.map((c) => Number(new URLSearchParams(c.url.split('?')[1]).get('count')));
      expect(counts.some((n) => n > 10), 'a load-more call with count>10').to.be.true;
    });
  });

  it('highlights changed files on open — before any Status click', () => {
    const s = stubGitFetch();
    cy.stub(window, 'fetch').callsFake(s.fetch);
    cy.mount(<div style={{ height: 700, width: 1200, display: 'flex', flexDirection: 'column' }}><EditsPage sessionId="s1" userRole="control" /></div>);
    cy.get('.edits-tabs').contains('Repositories').click();
    cy.get('.files-row').contains('proj').click();
    // Tree markers come from the background status fetch on view load —
    // no clicking the Status button first.
    cy.get('.files-row').contains('app.ts', { timeout: 10000 })
      .parent().find('.files-name')
      .should('have.class', 'files-git-modified');
  });

  it('offers clone/init actions for configured folders that are not git repos', () => {
    const s = stubGitFetch();
    cy.stub(window, 'fetch').callsFake(s.fetch);
    cy.stub(window, 'prompt').returns('http://git:3000/xenic/newrepo.git');
    cy.mount(<div style={{ height: 700, width: 1200, display: 'flex', flexDirection: 'column' }}><EditsPage sessionId="s1" userRole="control" /></div>);
    cy.get('.edits-tabs').contains('Repositories').click();
    // Non-repo root: actions open via the row Status button (click = expand)
    cy.get('.files-row').contains('plain', { timeout: 15000 }).click();
    cy.get('.files-row').contains('plain').parent().find('.repo-row-btn').contains('status').click();
    cy.get('.repo-actions', { timeout: 10000 }).should('exist');
    cy.get('.repo-actions').contains('git init').click();
    cy.then(() => {
      const post = s.calls.find((c) => c.opts?.method === 'POST' && c.url.includes('/git/repos/init'));
      expect(post, 'init POST happened').to.be.ok;
      expect(JSON.parse(post!.opts.body)).to.deep.eq({ path: '/home/test/plain', remote: 'http://git:3000/xenic/newrepo.git' });
    });
  });
});
