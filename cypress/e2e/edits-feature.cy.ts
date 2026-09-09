/**
 * E2E tests for the Edits feature (per-session file-change tracking).
 *
 * Two layers are covered:
 * 1. Seeded JSONL → backend route → frontend rendering (deterministic):
 *    2 files seeded with create/modify history incl. a duplicate "created"
 *    entry that the UI must dedupe away.
 * 2. Real agent flow: a prompt drives pi's write/edit tools to create two
 *    files and modify one; the Edits tab must show what the agent did.
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
    });
    // pi writes the session FILE lazily on the first appended entry — if it
    // doesn't exist yet, send one minimal message to materialize it (model
    // round-trip; skipped in the normal pipeline where earlier specs already
    // messaged the session). The file appears asynchronously after the send
    // is accepted, so poll for it.
    const waitForSessionFile = (attempt = 0): void => {
      cy.task('findSessionId').then((id) => {
        if (!id && attempt < 30) {
          cy.wait(500);
          waitForSessionFile(attempt + 1);
        } else {
          expect(id, 'session file materialized').to.not.eq(null);
        }
      });
    };
    cy.task('findSessionId').then((id) => {
      if (!id) {
        cy.request('POST', '/api/send', { message: 'Reply with just: ok', type: 'prompt' });
        waitForSessionFile();
      }
    });
  });

  afterEach(() => {
    // Reset seeded data so tests stay independent of each other
    cy.task('seedFileChanges', { sessionId, entries: null });
  });

  after(() => {
    cy.task('cleanScratchDir');
  });

  it('renders seeded file changes with dedup, auto-expand and search', () => {
    cy.task('seedFileChanges', { sessionId, entries: seedEntries(Date.now()) }).should('eq', true);
    cy.visit(`/session/${sessionId}/edits`);

    // File browser shows 2 files (duplicate created entry deduped away)
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

    // The duplicate created entry is NOT shown: e2e-a shows exactly one
    // created and one modified
    cy.get('.changes-mod').should('have.length', 2);
    cy.get('.changes-mod .changes-badge-created').should('have.length', 1);
    cy.get('.changes-mod .changes-badge-modified').should('have.length', 1);

    // Selecting the other file shows its (auto-expanded) modification
    cy.contains('.changes-file', 'e2e-b.txt').click();
    cy.get('.changes-mod').should('have.length', 1);
    cy.get('.changes-mod.expanded', { timeout: 10000 }).should('contain', 'hello b');
    cy.get('.changes-mod.expanded .changes-badge-created').should('have.text', 'created');

    // Search narrows the file list
    cy.get('.changes-search').type('e2e-a');
    cy.get('.changes-files-list .changes-file').should('have.length', 1);
    cy.get('.changes-files-list').should('contain', 'e2e-a.txt');
  });

  it('tracks agent-created file changes end to end', function () {
    this.timeout(300000);

    // Clean slate: remove seeded data before the agent run
    cy.task('seedFileChanges', { sessionId, entries: null });
    cy.task('makeScratchDir').then((scratch: string) => {
      // Single line — typing a literal newline would submit mid-prompt
      const prompt =
        `Do exactly these 3 steps with tools, nothing else: (1) use the write tool to create ${scratch}/e2e-agent-a.txt with exactly this content: alpha ` +
        `(2) use the write tool to create ${scratch}/e2e-agent-b.txt with exactly this content: beta ` +
        `(3) use the edit tool to replace alpha with gamma in ${scratch}/e2e-agent-a.txt. ` +
        `Do not use bash. Do not read the files back. Reply with just: done`;

      // Ensure the agent is idle before prompting (previous spec may have
      // left it streaming) — visit first, Cypress 15 resets the page
      // between tests
      cy.visit(`/session/${sessionId}`);
      cy.get('.status-badge', { timeout: 60000 }).should('not.have.class', 'status-streaming');
      cy.get('.chat-input', { timeout: 15000 }).type(prompt);
      cy.get('.chat-send-btn:not(.chat-steer-btn):not(.chat-followup-btn)').click({ force: true });

      // Wait for the agent to finish (tool-call sprees can take a while)
      cy.get('.status-badge', { timeout: 240000 }).should('not.have.class', 'status-streaming');

      // Inspect the Edits tab. The exact create/modify split depends on how
      // the model complies (it may merge steps into one write), so assert
      // what the feature guarantees: both files tracked, diffs reflect the
      // agent's content, latest file pre-selected and auto-expanded.
      cy.visit(`/session/${sessionId}/edits`);
      cy.get('.changes-files-list .changes-file', { timeout: 10000 }).should('have.length', 2);
      cy.get('.changes-files-list').should('contain', 'e2e-agent-a.txt');
      cy.get('.changes-files-list').should('contain', 'e2e-agent-b.txt');

      // agent-a (modified last) pre-selected, latest diff expanded with the
      // final content
      cy.get('.changes-file.selected').should('contain', 'e2e-agent-a.txt');
      cy.get('.changes-mod.expanded', { timeout: 10000 }).should('contain', 'gamma');

      // agent-b: its recorded change carries the created content
      cy.contains('.changes-file', 'e2e-agent-b.txt').click();
      cy.get('.changes-mod.expanded', { timeout: 10000 }).should('contain', 'beta');
    });
  });
});
