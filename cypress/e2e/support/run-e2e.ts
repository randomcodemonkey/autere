/**
 * Run e2e tests: start backend, run cypress, stop backend.
 */
import { startBackend, stopBackend, TEST_PORT, getTestEnvsDir } from './start-backend';
import { execSync } from 'child_process';

async function main() {
  // Ensure the backend (and its pi children) die even if the runner is
  // interrupted — no matter if tests fail or succeed.
  const cleanup = () => {
    stopBackend().then(() => process.exit(1));
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    console.log(`[run-e2e] Starting backend on port ${TEST_PORT}...`);
    await startBackend();
    console.log(`[run-e2e] Running cypress e2e tests against port ${TEST_PORT}...`);
    const envsDir = getTestEnvsDir();
    execSync(`npx cypress run --e2e --config baseUrl=http://localhost:${TEST_PORT} ${process.env.SPEC ? `--spec ${process.env.SPEC}` : `""`}`, {
      cwd: process.cwd(),
      stdio: 'inherit',
      // Tests read this to locate the isolated pi env (seed/reset data files)
      env: { ...process.env, AUTERE_E2E_ENVS_DIR: envsDir },
    });
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
