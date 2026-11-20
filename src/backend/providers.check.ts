/**
 * Provider allowlist (AUTERE_PROVIDER) + model scoping checks.
 * Run: npx tsx src/backend/providers.check.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'autere-providers-'));
process.env.AUTERE_DIR = join(root, 'autere');
const userDir = join(process.env.AUTERE_DIR, 'users', 'admin');
mkdirSync(userDir, { recursive: true });
writeFileSync(join(userDir, 'settings.json'), JSON.stringify({
  enabledModels: ['openai/gpt-5', '9router/auto', 'anthropic/claude'],
}));

try {
  const { parseProviderList } = await import('../shared/format.js');
  assert.deepEqual(parseProviderList(undefined), ['9router'], 'unset defaults to 9router');
  assert.deepEqual(parseProviderList(''), ['9router'], 'empty defaults to 9router');
  assert.deepEqual(parseProviderList(' Anthropic, 9Router , anthropic'), ['anthropic', '9router'],
    'trimmed, lower-cased, de-duplicated');

  const { getAllowedProviders, getDefaultProvider, getPiDefaultModel } = await import('./user-settings.js');

  delete process.env.AUTERE_PROVIDER;
  assert.deepEqual(getAllowedProviders(), ['9router']);
  assert.equal(getDefaultProvider(), '9router');
  assert.deepEqual(getPiDefaultModel('admin'), { provider: '9router', id: 'auto' },
    'default provider beats enabledModels order');

  process.env.AUTERE_PROVIDER = 'anthropic,9router';
  assert.deepEqual(getAllowedProviders(), ['anthropic', '9router']);
  assert.equal(getDefaultProvider(), 'anthropic');
  assert.deepEqual(getPiDefaultModel('admin'), { provider: 'anthropic', id: 'claude' });

  // Default provider has no enabled model: first enabled entry wins.
  process.env.AUTERE_PROVIDER = '9router,anthropic';
  assert.deepEqual(getPiDefaultModel('admin'), { provider: '9router', id: 'auto' });

  const { filterScopedModels, markDefaultModel, getEnabledModelEntries } = await import('./utils.js');
  const catalog = [
    { provider: '9router', id: 'auto', name: 'auto' },
    { provider: 'anthropic', id: 'claude', name: 'claude' },
    { provider: 'openai', id: 'gpt-5', name: 'gpt-5' },
  ];
  assert.deepEqual(
    filterScopedModels(catalog, 'admin').map((m: any) => `${m.provider}/${m.id}`),
    ['9router/auto', 'anthropic/claude'],
    'catalog hides providers outside AUTERE_PROVIDER',
  );
  assert.deepEqual(
    markDefaultModel(catalog, 'admin').filter((m: any) => m.isDefault).map((m: any) => m.id),
    ['auto'],
    'default marker follows the default provider',
  );
  assert.deepEqual(
    getEnabledModelEntries('admin').map((m: any) => `${m.provider}/${m.id}`),
    ['9router/auto', 'anthropic/claude'],
    'idle-session list applies the allowlist',
  );

  console.log('Provider allowlist checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
