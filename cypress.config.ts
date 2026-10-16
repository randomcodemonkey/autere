import { defineConfig } from 'cypress';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
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
    env: {
      // Sandbox-enabled runs (tasks-sandbox spec) — empty = sandbox off.
      e2eSandboxImage: process.env.AUTERE_E2E_SANDBOX_IMAGE || '',
    },
    setupNodeEvents(on) {
      on('task', {
        /** Poll until the session file exists and its header cwd is inside
         *  the sandbox work area ($HOME/work/...) — pi flushes async. */
        async awaitSandboxHeaderCwd(sessionId: string): Promise<string | null> {
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            const f = findSessionFile(sessionId);
            if (f) {
              try {
                const cwd = (JSON.parse(readFileSync(f, 'utf-8').split('\n', 1)[0]) as { cwd?: string }).cwd;
                if (cwd && cwd.startsWith('/home/autere/work/')) return cwd;
              } catch { /* retry */ }
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          return null;
        },

        /** Sandbox containers started after the given ids (run probe):
         *  WorkingDir + work-area mounts of each new container. */
        sandboxProbe(beforeIds: string[]): { workdir: string; workMounts: string[] }[] {
          const image = process.env.AUTERE_E2E_SANDBOX_IMAGE || '';
          if (!image) return [];
          const run = (cmd: string) => execSync(cmd, { encoding: 'utf-8' }).trim();
          const ids = run(`docker ps -q --filter ancestor=${image}`).split('\n').filter(Boolean);
          const out: { workdir: string; workMounts: string[] }[] = [];
          for (const id of ids.filter((id) => !beforeIds.includes(id))) {
            const insp = run(`docker inspect ${id} --format '{{.Config.WorkingDir}}|{{json .Mounts}}'`);
            const [workdir, mj] = insp.split('|');
            const mounts = JSON.parse(mj) as { Destination: string }[];
            out.push({ workdir, workMounts: mounts.filter((m) => m.Destination.includes('/work')).map((m) => m.Destination) });
          }
          return out;
        },

        /** Header cwd of a session file (null when missing/unreadable) */
        sessionHeaderCwd(sessionId: string): string | null {
          const f = findSessionFile(sessionId);
          if (!f) return null;
          try {
            const first = readFileSync(f, 'utf-8').split('\n', 1)[0];
            return (JSON.parse(first) as { cwd?: string }).cwd || null;
          } catch {
            return null;
          }
        },

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

        /** Write a minimal seeded session jsonl (idle session with history) */
        seedSession({ id, name }: { id: string; name?: string }): boolean {
          const envsDir = process.env.AUTERE_E2E_ENVS_DIR;
          if (!envsDir) return false;
          const dir = join(envsDir, 'admin', 'sessions', '--tmp-e2e--');
          mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const now = new Date().toISOString();
          const file = join(dir, `${stamp}_${id}.jsonl`);
          const lines = [
            JSON.stringify({ type: 'session', version: 3, id, timestamp: now, cwd: envsDir }),
            JSON.stringify({ type: 'session_info', id: 'seedinfo1', parentId: null, timestamp: now, name: name || `seeded ${id.slice(0, 8)}` }),
            JSON.stringify({ type: 'message', id: 'seedu1', parentId: null, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'seeded question' }] } }),
            JSON.stringify({ type: 'message', id: 'seeda1', parentId: 'seedu1', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'seeded answer' }], model: '9router/seed-model' } }),
          ];
          writeFileSync(file, lines.join('\n') + '\n');
          return true;
        },

        /** Simulate a backend session clone (copies a seeded session file) */
        cloneSession({ sourceId, cloneId, name }: { sourceId: string; cloneId: string; name?: string }): boolean {
          const envsDir = process.env.AUTERE_E2E_ENVS_DIR;
          if (!envsDir) return false;
          const dir = join(envsDir, 'admin', 'sessions', '--tmp-e2e--');
          const src = join(dir, `${sourceId}.jsonl`);
          const dst = join(dir, `${cloneId}.jsonl`);
          if (!existsSync(src)) return false;
          const content = readFileSync(src, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const e = JSON.parse(l);
              if (e.type === 'session') e.id = cloneId;
              if (e.type === 'session_info' && name) e.name = name;
              return JSON.stringify(e);
            })
            .join('\n') + '\n';
          writeFileSync(dst, content);
          return true;
        },

        /** Create the agent scratch dir; returns its absolute path */
        makeScratchDir(): string {
          rmSync(scratchDir, { recursive: true, force: true });
          mkdirSync(scratchDir, { recursive: true });
          return scratchDir;
        },

        /** Does a file exist (post-delete assertions) */
        fileExists(path: string): boolean {
          return existsSync(path);
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
