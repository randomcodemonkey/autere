/**
 * E2E tests for the Repositories feature (Edits view).
 *
 * Real git on the host: the spec seeds an actual repository (commits,
 * uncommitted change, remote) plus a plain non-repo folder under the
 * scratch dir, configures them via the settings API, and drives the
 * Repositories tab end to end — tree, repo detail (status/remotes/log),
 * git init on a non-repo folder, and per-file Editor/Commits tabs.
 */

describe('Git repositories feature', () => {
  let sessionId: string;
  let scratch: string;
  let settingsSnapshot: any;
  let settingsConfigured = false;
  let settingsConfiguredGit: string[] = [];

  const repo = () => `${scratch}/seedrepo`;
  const plain = () => `${scratch}/plain`;

  before(() => {
    cy.visit('/');
    cy.location('pathname', { timeout: 15000 }).should('match', /\/session\//);
    cy.location('pathname').then((p) => { sessionId = p.split('/')[2]; });
  });

  after(() => {
    // Net-zero: restore whatever settings the file held before the run
    cy.task<string>('makeScratchDir');
    if (settingsSnapshot) {
      cy.request('PUT', '/api/v1/settings', settingsSnapshot);
    } else {
      cy.request('GET', '/api/v1/settings').then((r) => cy.request('PUT', '/api/v1/settings', r.body.data));
    }
    cy.request('PUT', '/api/v1/users/admin', { allowedDirs: [] });
    cy.task('cleanScratchDir');
  });

  /** Navigate to the Repositories view. The view can bounce back to chat
   *  (alias-resolution replace navigation, settings-save pi restart), so
   *  keep pressing Files → Repositories until the root rows actually render. */
  const gotoEdits = (tab: string) => {
    cy.visit('/');
    cy.location('pathname', { timeout: 15000 }).should('match', /\/session\//);
    cy.get('.status-badge', { timeout: 30000 }).should('exist');
    cy.location('pathname').then((p) => {
      sessionId = p.split('/')[2];
      const switchView = (attempt = 0): void => {
        cy.get('body').then(($b) => {
          // 2 repo roots visible = the Repositories view stuck after any bounce
          if ($b.find('.files-row.files-root').length >= 2) return;
          if (attempt > 15) throw new Error('repositories root rows never rendered');
          if (!$b.find('.edits-tabs').length) {
            cy.get('.view-menu .view-btn-edits', { timeout: 15000 }).click({ timeout: 15000 });
          }
          cy.get('body', { timeout: 15000 }).then(($b2) => {
            if (!$b2.find('.edits-tabs').length) {
              // Bounced back — click again instead of asserting and failing
              cy.get('.view-menu .view-btn-edits').click();
            }
          });
          cy.get('.edits-tabs', { timeout: 15000 }).should('be.visible')
            .find('button:contains(Repositories)').click();
          cy.wait(1000);
          switchView(attempt + 1);
        });
      };
      switchView();
    });
  };

  /** Create the git repo + plain folder, grant access, configure gitRepos */
  const setup = () => {
    cy.task<string>('makeScratchDir').then((s: string) => {
      scratch = s;
      // A real repo: 2 commits, a remote, one uncommitted file; then a plain folder
      cy.exec(
        `cd ${scratch} && mkdir seedrepo plain && cd seedrepo && git init -q -b main . && ` +
        'git config user.name tester && git config user.email t@e2e.invalid && ' +
        'echo one > seed.txt && git add -A && git commit -qm "first commit c1" && ' +
        'echo two >> seed.txt && git commit -qam "second commit c2" && ' +
        'git remote add origin http://git:3000/e2e/seedrepo.git && ' +
        'echo pending > pending.txt',
        { timeout: 30000 },
      ).then((r: any) => {
        if (r.code !== 0) if (r.exitCode !== 0) throw new Error(`git setup failed: ${r.stderr || r.stdout}`);
      });

        cy.request('GET', '/api/v1/settings').then((r) => {
          settingsSnapshot = r.body.data;
          cy.request('PUT', '/api/v1/users/admin', { allowedDirs: [{ path: scratch, access: 'rw' }] });
          // Restarting pi (settings save) breaks later navigation — configure
          // the repos ONCE and reuse across tests.
          if (settingsConfigured) return;
          settingsConfigured = true;
          cy.request('PUT', '/api/v1/settings', { ...settingsSnapshot, gitRepos: [scratch + '/seedrepo', scratch + '/plain'] });
        });
    });
  };

  it('shows configured repos, and the root click opens folder + repo detail', { retries: 3 }, () => {
    setup();
    gotoEdits('Repositories');

    // Both configured folders as root rows (no auto-expansion in repos mode)
    cy.get('.files-row.files-root', { timeout: 15000 }).should('have.length', 2);
    cy.get('.files-row').should('contain', 'seedrepo');
    cy.get('.files-row').should('contain', 'plain');

    // Root click → detail pane (whole content area, no file placeholder)
    // Root click = plain expand/collapse; detail pane opens via the Status button
    cy.get('.files-row').contains('seedrepo').click();
    cy.get('.files-row', { timeout: 15000 }).should('contain', 'seed.txt');
    cy.get('.files-row').contains('seedrepo').parent().find('.repo-row-btn').contains('info').click();
    cy.get('.repo-detail', { timeout: 15000 }).should('contain', '⎇ main');
    cy.get('.repo-detail').should('not.contain', 'Select a file to view or edit');
    // Section headers present
    cy.get('.repo-section-title').should('have.length', 3);
    cy.get('.repo-section-title:contains(Status)').next('.repo-status-list').should('contain', 'pending.txt');
    cy.get('.repo-detail').should('contain', 'origin').should('contain', 'http://git:3000/e2e/seedrepo.git');
    cy.get('.repo-log').should('contain', 'first commit c1').should('contain', 'second commit c2');
    // Only 2 commits — no Load more button
    cy.get('.repo-load-more').should('not.exist');

    // Folder also expanded → seed.txt visible in the tree
    cy.get('.files-row', { timeout: 10000 }).should('contain', 'seed.txt').should('contain', 'pending.txt');
  });

  it('offers git init for a non-repo folder and reloads detail after the action', { retries: 3 }, () => {
    setup();
    gotoEdits('Repositories');
    cy.get('.files-row.files-root', { timeout: 15000 }).should('have.length', 2);

    // Non-repo root: actions live under the row's status button
    cy.get('.files-row').contains('plain').click();
    cy.get('.files-row', { timeout: 15000 }).should('contain', 'plain');
    cy.get('.files-row').contains('plain').parent().find('.repo-row-btn').contains('info').click();
    cy.get('.repo-actions', { timeout: 15000 }).should('exist');

    // git init with a prompted remote → repo created, detail pane loads
    cy.window().then((w) => cy.stub(w, 'prompt').returns('http://git:3000/e2e/plain.git'));
    cy.get('.repo-actions').contains('git init').click();
    cy.get('.repo-detail', { timeout: 15000 }).should('contain', '⎇ main');
    cy.get('.repo-detail').should('contain', 'No commits yet');
    cy.get('.repo-detail').should('contain', 'http://git:3000/e2e/plain.git');

    // Confirmed on disk: a real .git with the origin remote
    cy.exec(`git -C ${plain()} remote get-url origin`, { timeout: 15000 })
      .its('stdout').should('contain', 'http://git:3000/e2e/plain.git');
  });

  it('file click shows Editor and Commits tabs with the file history', { retries: 3 }, () => {
    setup();
    gotoEdits('Repositories');
    cy.get('.files-row').contains('seedrepo', { timeout: 15000 }).click();
    // Folder opened by the root click → open the file straight away
    cy.get('.files-row').contains('seed.txt', { timeout: 10000 }).click();

    // Two tabs; Editor shows content
    cy.get('.files-detail-tabs', { timeout: 15000 }).should('exist');
    cy.get('.files-detail-tabs button:contains(Commits)').should('exist');
    cy.window({ timeout: 20000 }).then((w) => {
      const ed = (w as any).__autereEd;
      if (!ed) throw new Error('monaco editor not mounted');
      expect(ed.getValue()).to.contain('two');
    });

    // Commits tab → git log for the file
    cy.get('.files-detail-tabs').contains('Commits').click();
    cy.get('.repo-file-log', { timeout: 10000 }).should('contain', 'second commit c2').should('contain', 'first commit c1');
    // Repo detail pane is gone while a file is open
    cy.get('.repo-actions').should('not.exist');
  });
});
