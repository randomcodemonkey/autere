/**
 * Run ONE e2e spec against the harness backend:
 *   npx tsx cypress/e2e/support/run-one.ts cypress/e2e/stream-reload.cy.ts
 */
import { startBackend, stopBackend, TEST_PORT, getTestEnvsDir, getTestModels } from './start-backend';
import { spawn } from 'child_process';

async function main() {
  const spec = process.argv[2];
  if (!spec) {
    console.error('usage: npx tsx run-one.ts <spec-path>');
    process.exit(1);
  }
  const cleanup = () => stopBackend().then(() => process.exit(1));
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  try {
    console.log(`[run-one] Starting backend on port ${TEST_PORT}...`);
    await startBackend();
    // Same documented model settings as run-e2e.ts: without them the user
    // settings fall back to the master pi settings' model, which the isolated
    // test env's router cannot serve (the New Session form would preselect it).
    const models = getTestModels();
    if (models.length > 0) {
      await fetch(`http://localhost:${TEST_PORT}/api/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModels: models }),
      });
    }
    // NOT execSync — it blocks this process's event loop, and the mock router
    // lives in this process: a blocked loop leaves the mock's sockets
    // accepted-but-unserviced (pi's model calls hang until the test times
    // out). Same reasoning as run-e2e.ts.
    const code = await new Promise<number>((resolve, reject) => {
      const cyp = spawn(
        'npx',
        ['cypress', 'run', '--e2e', '--config', `baseUrl=http://localhost:${TEST_PORT}`, '--spec', spec],
        { stdio: 'inherit', env: { ...process.env, AUTERE_E2E_ENVS_DIR: getTestEnvsDir() } },
      );
      cyp.on('exit', (c) => resolve(c ?? 1));
      cyp.on('error', reject);
    });
    if (code !== 0) process.exitCode = 1;
  } catch (err: any) {
    console.error('[run-one] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await stopBackend();
    process.exit();
  }
}
main();
