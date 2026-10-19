/**
 * Assert bundled extras refresh as real per-user directory copies.
 * Run: npx tsx cypress/component/support/extra-copies.check.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'extra-copies-'));
const envDir = join(root, 'envs', 'admin');
const extensionsDir = join(envDir, 'extensions');
const sourceDir = join(root, 'pi-ext-extra', 'pi-autere');
const staleDir = join(extensionsDir, 'pi-autere');
mkdirSync(join(sourceDir), { recursive: true });
mkdirSync(join(staleDir), { recursive: true });
writeFileSync(join(sourceDir, 'index.ts'), 'export const version = "current";\n');
writeFileSync(join(staleDir, 'index.ts'), 'export const version = "stale";\n');
writeFileSync(join(envDir, 'autere-extensions.json'), JSON.stringify({ enabled: ['pi-autere'] }));
mkdirSync(join(root, '.pi', 'agent'), { recursive: true });
process.env.HOME = root;
process.env.AUTERE_DIR = join(root, '.autere');
process.env.AUTERE_PI_ENVS_DIR = join(root, 'envs');
process.env.AUTERE_PI_EXT_EXTRA = join(root, 'pi-ext-extra');

try {
  const { ensurePiEnv, prepareSandboxEnvDir } = await import('../../../src/backend/pi-env.js');
  const { setExtraEnabled } = await import('../../../src/backend/user-settings.js');
  ensurePiEnv('admin');
  prepareSandboxEnvDir(envDir);
  assert.equal(lstatSync(staleDir).isDirectory(), true, 'enabled extra remains a real directory');
  assert.equal(lstatSync(staleDir).isSymbolicLink(), false, 'sandbox path is not a symlink');
  assert.equal(readFileSync(join(staleDir, 'index.ts'), 'utf8'), 'export const version = "current";\n');

  writeFileSync(join(sourceDir, 'index.ts'), 'export const version = "updated";\n');
  ensurePiEnv('admin');
  prepareSandboxEnvDir(envDir);
  assert.equal(readFileSync(join(staleDir, 'index.ts'), 'utf8'), 'export const version = "updated";\n', 'refreshes an enabled copy on each session spawn');

  setExtraEnabled('admin', 'pi-autere', false);
  assert.throws(() => lstatSync(staleDir), { code: 'ENOENT' }, 'removes a disabled extension');
  console.log('Bundled extension copy checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
