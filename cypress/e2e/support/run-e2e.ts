/**
 * Run e2e tests: mock router (when no live 9router), start backend, run
 * cypress, stop everything.
 */
import { startBackend, stopBackend, TEST_PORT, getTestEnvsDir, getTestModels } from './start-backend';
import { spawn } from 'child_process';

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

    // Documented user settings for the test user — the model dropdown reads
    // enabledModels from user settings (defaults would otherwise carry the
    // master pi settings' single possibly-unroutable model, skipping the
    // model-selection switch test).
    const models = getTestModels();
    if (models.length > 0) {
      await fetch(`http://localhost:${TEST_PORT}/api/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModels: models }),
      });
    }

    console.log(`[run-e2e] Running cypress e2e tests against port ${TEST_PORT}...`);
    const envsDir = getTestEnvsDir();
    // NOT execSync — it blocks this process's event loop, and the mock
    // router lives in this process: a blocked loop leaves the mock's
    // sockets accepted-but-unserviced (pi's model calls hang forever).
    const code = await new Promise<number>((resolve, reject) => {
      const cyp = spawn('npx', ['cypress', 'run', '--e2e', '--config', `baseUrl=http://localhost:${TEST_PORT}`, ...(process.env.SPEC ? ['--spec', process.env.SPEC] : [])], {
        cwd: process.cwd(),
        stdio: 'inherit',
        // Tests read this to locate the isolated pi env (seed/reset data files)
        env: { ...process.env, AUTERE_E2E_ENVS_DIR: envsDir },
      });
      cyp.on('exit', resolve);
      cyp.on('error', reject);
    });
    if (code !== 0) process.exitCode = 1;
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
