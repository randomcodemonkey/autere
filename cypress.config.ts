import { defineConfig } from 'cypress';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const configDir = dirname(fileURLToPath(import.meta.url));

// Locate the isolated pi env for this e2e run (set by run-e2e.ts). Returns
// the session FILE for the given session id (matches by filename, tolerating
// id drift) or the newest session when no id is given — mirrors the
// backend's findSession fallback logic.
function findSessionFile(sessionId?: string): string | null {
  const envsDir = process.env.AUTERE_E2E_ENVS_DIR;
  if (!envsDir) return null;
  const root = join(envsDir, 'admin', 'sessions');
  if (!existsSync(root)) return null;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root);
  if (sessionId) return files.find((f) => f.includes(sessionId)) || null;
  return files.sort((a, b) => {
    // Newest first; readdirSync doesn't give mtimes — sort by name is a
    // stable fallback (pi session files start with a timestamp prefix).
    return b.split('/').pop()!.localeCompare(a.split('/').pop()!);
  })[0] || null;
}

// Scratch dir the agent writes test files into (under the pi cwd, so the
// extension's relative-path rendering applies); cleaned up after the run.
const scratchDir = join(configDir, 'cypress', 'e2e', 'tmp-edits');

export default defineConfig({
  component: {
    devServer: {
      framework: 'react',
      bundler: 'vite',
      viteConfig: './src/frontend/vite.config.ts',
    },
    specPattern: 'cypress/component/**/*.cy.{ts,tsx}',
    indexHtmlFile: 'cypress/component/support/index.html',
    supportFile: 'cypress/component/support/component.ts',
    viewportWidth: 1280,
    viewportHeight: 800,
  },
  e2e: {
    baseUrl: 'http://localhost:3457', // overridden at runtime by run-e2e.ts
    specPattern: 'cypress/e2e/**/*.cy.{ts,tsx}',
    supportFile: 'cypress/e2e/support/e2e.ts',
    // Exclude support scripts from webpack bundling
    excludeSpecPattern: ['**/support/*.ts'],
    viewportWidth: 1280,
    viewportHeight: 800,
    defaultCommandTimeout: 3000,
    requestTimeout: 15000,
    responseTimeout: 15000,
    pageLoadTimeout: 30000,
    video: false,
    screenshotOnRunFailure: true,
    setupNodeEvents(on) {
      on('task', {
        /** Session id for the current (or given) session — null if none */
        findSessionId(sessionId?: string): string | null {
          const f = findSessionFile(sessionId);
          return f ? f.split('/').pop()!.replace(/\.jsonl$/, '') : null;
        },

        /** Write the per-session file-changes JSONL (null entries = delete) */
        seedFileChanges({ sessionId, entries }: { sessionId?: string; entries: unknown[] | null }): boolean {
          const sessionFile = findSessionFile(sessionId);
          if (!sessionFile) return false;
          // <env>/admin/sessions/<...>/<base>.jsonl → <env>/admin/file-changes/<base>.jsonl
          const envDir = sessionFile.slice(0, sessionFile.indexOf(join('admin', 'sessions')) + 'admin'.length);
          const baseName = sessionFile.split('/').pop()!.replace(/\.jsonl$/, '');
          const dir = join(envDir, 'file-changes');
          const target = join(dir, `${baseName}.jsonl`);
          if (entries === null) {
            rmSync(target, { force: true });
            return true;
          }
          mkdirSync(dir, { recursive: true });
          writeFileSync(target, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
          return true;
        },

        /** Create the agent scratch dir; returns its absolute path */
        makeScratchDir(): string {
          rmSync(scratchDir, { recursive: true, force: true });
          mkdirSync(scratchDir, { recursive: true });
          return scratchDir;
        },

        /** Remove the agent scratch dir */
        cleanScratchDir(): boolean {
          rmSync(scratchDir, { recursive: true, force: true });
          return true;
        },
      });
    },
  },
});
