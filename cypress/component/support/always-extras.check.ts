/**
 * Assert the always-on bundled extension (pi-9router-ext) is installed and
 * never user-visible, and that provider/retired handling cleans up copies.
 * Run: npx tsx cypress/component/support/always-extras.check.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'always-extras-'));
const envDir = join(root, 'envs', 'admin');
const extrasDir = join(root, 'pi-ext-extra');

// A normal (user-toggleable) extra and the always-on one.
for (const name of ['pi-autere', 'pi-9router-ext']) {
  mkdirSync(join(extrasDir, name), { recursive: true });
  writeFileSync(join(extrasDir, name, 'index.ts'), 'export default function () {}\n');
}
mkdirSync(envDir, { recursive: true });
mkdirSync(join(root, '.pi', 'agent'), { recursive: true });
process.env.HOME = root;
process.env.AUTERE_DIR = join(root, '.autere');
process.env.AUTERE_PI_ENVS_DIR = join(root, 'envs');
process.env.AUTERE_PI_EXT_EXTRA = extrasDir;
delete process.env.AUTERE_PROVIDER;

const envExtensions = join(envDir, 'extensions');
const installed = (name: string) => existsSync(join(envExtensions, name, 'index.ts'));

try {
  const { ensurePiEnv } = await import('../../../src/backend/pi-env.js');
  const {
    getAvailableExtras, getAlwaysEnabledExtras, desiredExtras, getEnabledPackages,
  } = await import('../../../src/backend/user-settings.js');

  // Hidden from Settings → Extensions, but enabled anyway.
  assert.equal(getAvailableExtras().includes('local:pi-9router-ext'), false, 'always-on extra is not user-toggleable');
  assert.equal(getAvailableExtras().includes('local:pi-autere'), true, 'normal extras stay listed');
  assert.deepEqual(getAlwaysEnabledExtras(), ['pi-9router-ext'], 'always-on for the default (9router) provider');
  assert.equal(desiredExtras('admin').includes('local:pi-9router-ext'), true, 'always-on extra is wanted');
  assert.equal(getEnabledPackages('admin').includes('local:pi-9router-ext'), true, 'reaches pi packages');

  // Installed as a real per-user copy on spawn.
  ensurePiEnv('admin');
  assert.equal(installed('pi-9router-ext'), true, 'always-on extra is copied into the env');

  // Legacy npm package and retired extras are cleaned out of the env.
  writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-9router-ext', 'npm:pi-memory'] }));
  mkdirSync(join(envExtensions, 'pi-combo-reasoning'), { recursive: true });
  writeFileSync(join(envExtensions, 'pi-combo-reasoning', 'index.ts'), 'export default function () {}\n');
  ensurePiEnv('admin');
  assert.deepEqual(JSON.parse(readFileSync(join(envDir, 'settings.json'), 'utf8')).packages, ['npm:pi-memory'],
    'legacy npm pi-9router-ext is stripped');
  assert.equal(installed('pi-combo-reasoning'), false, 'retired extra copy is removed');

  // Non-9router provider: not installed at all, copy removed.
  process.env.AUTERE_PROVIDER = 'openai';
  assert.deepEqual(getAlwaysEnabledExtras(), [], 'no always-on extras for another provider');
  assert.equal(desiredExtras('admin').includes('local:pi-9router-ext'), false, 'not wanted for another provider');
  ensurePiEnv('admin');
  assert.equal(installed('pi-9router-ext'), false, 'copy removed when the provider changes');

  // Bundled source missing (deployment/image built without extras): nothing is
  // always-on, and the legacy npm package is left in place so the env still has
  // a 9router provider at all.
  delete process.env.AUTERE_PROVIDER;
  rmSync(extrasDir, { recursive: true, force: true });
  assert.deepEqual(getAlwaysEnabledExtras(), [], 'no always-on extras without the bundled source');
  writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-9router-ext'] }));
  ensurePiEnv('admin');
  assert.deepEqual(JSON.parse(readFileSync(join(envDir, 'settings.json'), 'utf8')).packages, ['npm:pi-9router-ext'],
    'legacy npm pi-9router-ext is kept when the bundled copy is missing');

  console.log('Always-on extension checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
