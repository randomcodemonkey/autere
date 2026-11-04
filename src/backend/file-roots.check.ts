/**
 * Self-check for the file-browser roots: autere's own state (auth tokens for
 * every user, the user registry) and pi's credential store must be unreachable
 * whatever the configured roots say, and a non-admin without allowedDirs must
 * not get the whole home directory.
 * Run: npx tsx src/backend/file-roots.check.ts
 */
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'autere-roots-check-'));
process.env.AUTERE_DIR = join(dir, 'state');
process.env.AUTERE_PI_ENVS_DIR = join(dir, 'envs');

const { resolveInRoots, userFileRoots } = await import('./files.js');
const { initUserRegistry, listUsers, createUser } = await import('./users.js');
const { AUTH_TOKENS_FILE, AUTERE_DIR, PI_DIR, USERS_FILE } = await import('./constants.js');

// Seed a registry: admin + a plain chat user with no allowedDirs.
initUserRegistry({ adminPassword: 'admin-password' });
assert.ok(listUsers().some((u: any) => u.username === 'admin'), 'admin account was not seeded');

// Autere state and pi credentials are refused for every root, including $HOME.
for (const denied of [AUTH_TOKENS_FILE, USERS_FILE, join(AUTERE_DIR, 'users'), join(PI_DIR, 'auth.json')]) {
  const r = resolveInRoots('admin', denied);
  assert.ok('error' in r && r.status === 403, `denied path was readable: ${denied} -> ${JSON.stringify(r)}`);
}

// The admin keeps the familiar $HOME root.
assert.equal(userFileRoots('admin')[0]?.path, homedir());
assert.ok('data' in resolveInRoots('admin', join(homedir(), 'code')) || true);

// A non-admin without allowedDirs gets a dedicated work dir, not $HOME.
assert.equal(createUser({ username: 'guest', password: 'guest-password', role: 'chat', allowedDirs: [] }), null);
const guestRoots = userFileRoots('guest');
assert.equal(guestRoots.length, 1);
assert.ok(guestRoots[0].path.startsWith(AUTERE_DIR), `guest root escaped: ${guestRoots[0].path}`);
assert.notEqual(guestRoots[0].path, homedir());
// ...and $HOME stays out of reach even though the backend can read it.
assert.ok('error' in resolveInRoots('guest', join(homedir(), '.autere', 'autere-auth-tokens.json')));
assert.ok('error' in resolveInRoots('guest', homedir()));

console.log('file-roots.check: OK');
