/**
 * Run ONE e2e spec against the harness backend:
 *   npx tsx cypress/e2e/support/run-one.ts cypress/e2e/stream-reload.cy.ts
 */
import { startBackend, stopBackend, TEST_PORT, getTestEnvsDir } from './start-backend';
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
