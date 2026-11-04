// Self-check: MCP servers are strictly per user. mcp.json must NOT be seeded
// from the master pi env (a shared entry carries env/headers secrets into
// every user's settings page), and writing one must create the env dir.
// Run: npx tsx src/backend/mcp-config.check.ts
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'autere-mcp-check-'));
process.env.AUTERE_DIR = join(dir, 'state');
process.env.AUTERE_PI_ENVS_DIR = join(dir, 'envs');

const { ensurePiEnv, getPiEnvDir } = await import('./pi-env.js');
const { setMcpServer, getMcpServers, deleteMcpServer } = await import('./mcp-config.js');

const envDir = ensurePiEnv('tester');
assert.ok(existsSync(envDir), 'ensurePiEnv did not create the env dir');
assert.ok(!existsSync(join(envDir, 'mcp.json')), 'mcp.json was seeded from the master env');

// A user who never ran pi has no env dir yet.
const fresh = getPiEnvDir('fresh');
assert.ok(!existsSync(fresh), 'env dir unexpectedly exists');
setMcpServer('fresh', 'github', { command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'x' } });
assert.deepEqual(Object.keys(getMcpServers('fresh')), ['github']);
assert.equal(JSON.parse(readFileSync(join(fresh, 'mcp.json'), 'utf-8')).mcpServers.github.command, 'npx');
assert.equal(deleteMcpServer('fresh', 'github'), true);
assert.deepEqual(getMcpServers('fresh'), {});

console.log('mcp-config.check: OK');
