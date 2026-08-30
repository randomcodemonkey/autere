/**
 * Run e2e tests: start backend, run cypress, stop backend.
 */
import { startBackend, stopBackend, TEST_PORT } from './start-backend';
import { execSync } from 'child_process';

async function main() {
  try {
    console.log(`[run-e2e] Starting backend on port ${TEST_PORT}...`);
    await startBackend();
    console.log(`[run-e2e] Running cypress e2e tests against port ${TEST_PORT}...`);
    execSync(`npx cypress run --e2e --config baseUrl=http://localhost:${TEST_PORT}`, { cwd: process.cwd(), stdio: 'inherit' });
    console.log('[run-e2e] Tests complete.');
  } catch (err: any) {
    console.error('[run-e2e] Error:', err.message);
    process.exitCode = 1;
  } finally {
    console.log('[run-e2e] Stopping backend...');
    await stopBackend();
    process.exit();
  }
}

main();
