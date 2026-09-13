/**
 * Run ONE e2e spec against the harness backend:
 *   npx tsx cypress/e2e/support/run-one.ts cypress/e2e/stream-reload.cy.ts
 */
import { startBackend, stopBackend, TEST_PORT, getTestEnvsDir } from './start-backend';
import { execSync } from 'child_process';

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
    execSync(
      `npx cypress run --e2e --config baseUrl=http://localhost:${TEST_PORT} --spec "${spec}"`,
      { stdio: 'inherit', env: { ...process.env, AUTERE_E2E_ENVS_DIR: getTestEnvsDir() } },
    );
  } catch (err: any) {
    console.error('[run-one] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await stopBackend();
    process.exit();
  }
}
main();
