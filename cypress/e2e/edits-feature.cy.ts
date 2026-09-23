/**
 * E2E tests for the Edits feature.
 *
 * Files tab: backend-backed file tree + Monaco editor. The user's allowed
 * dirs are the browser roots (fallback: $HOME when none are configured).
 * Roles come from the registry — with auth disabled everyone is admin,
 * so write flows run as admin and role gating is covered by the component
 * specs instead.
 *
 * Changes tab: per-session file-change tracking (JSONL → route → UI) and a
 * real agent run (model-driven, slow).
 */

describe('Edits feature', () => {
  let sessionId: string;

  const seedEntries = (now: number) => [
    { ts: now + 1000, path: 'e2e-a.txt', tool: 'write', change: 'created', diff: 'Create e2e-a.txt\n\n@@ -0,0 +1 @@\n+hello a' },
    { ts: now + 2000, path: 'e2e-b.txt', tool: 'write', change: 'created', diff: 'Create e2e-b.txt\n\n@@ -0,0 +1 @@\n+hello b' },
    // Duplicate "created" for e2e-a — the UI must keep only the latest
    { ts: now + 3000, path: 'e2e-a.txt', tool: 'write', change: 'created', diff: 'Create e2e-a.txt\n\n@@ -0,0 +1 @@\n+hello a v2' },
    { ts: now + 4000, path: 'e2e-a.txt', tool: 'edit', change: 'modified', diff: 'Modified e2e-a.txt\n\n@@ -1 +1 @@\n-hello a\n+goodbye a' },
  ];

  before(() => {
    cy.visit('/');
    cy.location('pathname', { timeout: 15000 }).should('match', /\/session\//);
    cy.location('pathname').then((p) => {
      sessionId = p.split('/')[2];
      // pi writes the session FILE lazily on the first appended entry —
      // materialize it with a minimal message (the Changes tab reads the
      // per-session file-changes JSONL keyed by that file name). Poll for
      // the file; args to cy.task are evaluated at QUEUE time, so the
      // checks must run inside this .then where sessionId is set.
      const waitForSessionFile = (attempt = 0): void => {
        cy.task('findSessionId', sessionId).then((id) => {
          if (!id && attempt < 120) {
            cy.wait(500);
            waitForSessionFile(attempt + 1);
          } else {
            expect(id, 'session file materialized').to.not.eq(null);
          }
        });
      };
      cy.task('findSessionId', sessionId).then((id) => {
        if (!id) {
          cy.request('POST', '/api/send', { message: 'Reply with just: ok', type: 'prompt', sessionId });
          waitForSessionFile();
        }
      });
    });
  });

  after(() => {
    // Restore the default state: no allowedDirs (fallback $HOME roots) —
    // tests must stay net-zero for the rest of the suite.
    cy.request('POST', '/api/users/admin', { allowedDirs: [] });
    cy.task('cleanScratchDir');
  });

  it('shows the fallback $HOME root when no allowedDirs are configured', () => {
    cy.task('makeScratchDir');
    cy.visit(`/session/${sessionId}/edits`);
    // Root row = $HOME (admin has no allowedDirs configured) — auto-expanded
    cy.get('.files-row.files-root', { timeout: 30000 }).should('contain', '/');
  });

  it('creates, saves and deletes a file under a configured rw root', () => {
    cy.task<string>('makeScratchDir').then((scratch: string) => {
      cy.writeFile(`${scratch}/save-me.txt`, 'one\n');
      // Grant admin the scratch dir as a rw root (after() restores [])
      cy.request('POST', '/api/users/admin', { allowedDirs: [{ path: scratch, access: 'rw' }] });

      // The sole root auto-expands — its listing shows right away
      cy.visit(`/session/${sessionId}/edits`);
      cy.get('.files-row.files-root', { timeout: 30000 }).should('contain', scratch);
      cy.get('.files-row', { timeout: 10000 }).should('contain', 'save-me.txt');

      // Open → edit → save → the file on disk has the new content
      cy.get('.files-row').contains('save-me.txt').click();
      cy.window({ timeout: 20000 }).then((w) => {
        const ed = (w as any).__autereEd;
        if (!ed) throw new Error('monaco editor not mounted');
        expect(ed.getValue()).to.contain('one');
        ed.setValue('one\ntwo\n');
      });
      cy.get('.files-save', { timeout: 10000 }).should('not.be.disabled');
      cy.get('.files-save').click();
      cy.readFile(`${scratch}/save-me.txt`, { timeout: 15000 }).should('contain', 'two');

      // New… creates a file (prompt for the name); save then delete
      // New… prompts for a name and opens an empty buffer (row appears
      // only AFTER the first save refreshes the tree)
      cy.window().then((w) => cy.stub(w, 'prompt').returns('e2e-new.ts'));
      cy.get('.files-new').click();
      cy.window({ timeout: 20000 }).then((w) => {
        const ed = (w as any).__autereEd;
        if (!ed) throw new Error('monaco editor not mounted');
        expect(ed.getValue(), 'new empty buffer').to.eq('');
        ed.setValue('new file content');
      });
      cy.get('.files-save', { timeout: 10000 }).should('not.be.disabled').click();
      // Save creates the file and refreshes the tree
      cy.readFile(`${scratch}/e2e-new.ts`, { timeout: 15000 }).should('contain', 'new file content');
      cy.get('.files-row', { timeout: 10000 }).should('contain', 'e2e-new.ts');

      // Delete: confirm accepted → POST delete → row leaves the tree
      cy.window().then((w) => cy.stub(w, 'confirm').returns(true));
      cy.get('.files-delete').click();
      // Tree refreshes after the delete → the row disappears
      cy.get('.files-row', { timeout: 10000 }).should('not.contain', 'e2e-new.ts');

      // Disk state after delete
      cy.task<boolean>('fileExists', `${scratch}/e2e-new.ts`).then((exists) => {
        if (exists) throw new Error('file still exists after delete');
      });
    });
  });

  it('renders seeded file changes with dedup, auto-expand and search', () => {
    cy.task('seedFileChanges', { sessionId, entries: seedEntries(Date.now()) }).should('eq', true);
    cy.visit(`/session/${sessionId}/edits`);

    // The Files tab is the default view — switch to the Changes tab
    cy.get('.edits-tabs').contains('Changes').click();

    cy.get('.changes-files-list .changes-file', { timeout: 10000 }).should('have.length', 2);
    cy.get('.changes-files-list').should('contain', 'e2e-a.txt');
    cy.get('.changes-files-list').should('contain', 'e2e-b.txt');

    // e2e-a has 2 surviving changes (created + modified), e2e-b has 1
    cy.contains('.changes-file', 'e2e-a.txt').find('.changes-file-count').should('have.text', '2');
    cy.contains('.changes-file', 'e2e-b.txt').find('.changes-file-count').should('not.exist');

    // Latest file (e2e-a) is pre-selected and its latest change auto-expanded
    cy.get('.changes-file.selected').should('contain', 'e2e-a.txt');
    cy.get('.changes-mod.expanded', { timeout: 10000 }).should('have.length', 1);
    cy.get('.changes-mod.expanded').should('contain', 'goodbye a');
    cy.get('.changes-mod.expanded .changes-badge-modified').should('have.text', 'modified');

    cy.get('.changes-mod .changes-badge-created').should('have.length', 1);
    cy.get('.changes-mod .changes-badge-modified').should('have.length', 1);

    cy.contains('.changes-file', 'e2e-b.txt').click();
    cy.get('.changes-mod.expanded', { timeout: 10000 }).should('contain', 'hello b');

    cy.get('.changes-search').type('e2e-a');
    cy.get('.changes-files-list .changes-file').should('have.length', 1);
    cy.get('.changes-files-list').should('contain', 'e2e-a.txt');
  });

  it('tracks agent-created file changes end to end', function () {
    this.timeout(300000);

    cy.task('seedFileChanges', { sessionId, entries: null } as any);
    cy.task<string>('makeScratchDir').then((scratch: string) => {
      const prompt =
        `Do exactly these 3 steps with tools, nothing else: (1) use the write tool to create ${scratch}/e2e-agent-a.txt with exactly this content: alpha ` +
        `(2) use the write tool to create ${scratch}/e2e-agent-b.txt with exactly this content: beta ` +
        `(3) use the edit tool to replace alpha with gamma in ${scratch}/e2e-agent-a.txt. ` +
        `Do not use bash. Do not read the files back. Reply with just: done`;

      cy.visit(`/session/${sessionId}`);
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
      cy.get('.chat-input', { timeout: 15000 }).type(prompt);
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      cy.get('.status-badge', { timeout: 240000 }).should('not.have.class', 'status-streaming');

      cy.visit(`/session/${sessionId}/edits`);
      cy.get('.edits-tabs').contains('Changes').click();
      // Long retry window: provider hiccups make pi auto-retry the turn, and
      // the status badge briefly reads idle during retry gaps.
      cy.get('.changes-files-list .changes-file', { timeout: 120000 }).should('have.length', 2);
      cy.get('.changes-files-list').should('contain', 'e2e-agent-a.txt');
      cy.get('.changes-files-list').should('contain', 'e2e-agent-b.txt');

      cy.get('.changes-file.selected').should('contain', 'e2e-agent-a.txt');
      cy.get('.changes-mod.expanded', { timeout: 10000 }).should('contain', 'gamma');

      cy.contains('.changes-file', 'e2e-agent-b.txt').click();
      cy.get('.changes-mod.expanded', { timeout: 10000 }).should('contain', 'beta');
    });
  });
});
