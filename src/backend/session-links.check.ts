/** Session messaging graph: symmetric, depth 1, no dangling links. */
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'autere-links-'));
process.env.AUTERE_DIR = join(root, 'autere');
process.env.AUTERE_PI_ENVS_DIR = join(root, 'pi-envs');

const { linkParent, setPeers, relationship, canTalk, linksOf, forgetSession } = await import('./session-links.js');

const USER = 'alice';
const [P, C, G, X, Y] = ['parent', 'child', 'grandchild', 'other', 'third'];

// ── nothing by default ──
assert.strictEqual(relationship(USER, X, Y), null, 'unrelated sessions must not match');
assert.strictEqual(canTalk(USER, X, Y), false);
assert.strictEqual(canTalk(USER, X, X), true, 'a session may always address itself');

// ── a task run is a child of its creator ──
linkParent(USER, C, P);
assert.strictEqual(relationship(USER, P, C), 'child', "the creator sees the run as its child");
assert.strictEqual(relationship(USER, C, P), 'parent', 'the run sees the creator as its parent');
assert.strictEqual(canTalk(USER, P, C), true);
assert.strictEqual(relationship(USER, P, X), null, 'child link does not open other sessions');
assert.deepStrictEqual(linksOf(USER, P), { parent: null, children: [C], peers: [] });

// ── depth 1: no transitivity through a grandchild ──
linkParent(USER, G, C);
assert.strictEqual(canTalk(USER, C, G), true);
assert.strictEqual(canTalk(USER, P, G), false, 'grandchildren are not reachable');

// ── guards: self links and empty ids are ignored ──
linkParent(USER, P, P);
linkParent(USER, '', P);
assert.strictEqual(linksOf(USER, P).parent, null);

// ── user grants are symmetric ──
setPeers(USER, X, [Y]);
assert.strictEqual(relationship(USER, X, Y), 'peer');
assert.strictEqual(relationship(USER, Y, X), 'peer', 'the grant mirrors to the other side');
assert.strictEqual(canTalk(USER, P, X), false, 'a grant is not transitive either');

// replacing the grant drops the old mirror
setPeers(USER, X, []);
assert.strictEqual(relationship(USER, Y, X), null, 'removed peer lost the mirror');
assert.deepStrictEqual(linksOf(USER, X), { parent: null, children: [], peers: [] });

// ── deleting a session cleans both sides ──
setPeers(USER, X, [Y]);
forgetSession(USER, X);
assert.deepStrictEqual(linksOf(USER, Y), { parent: null, children: [], peers: [] }, 'peer reference lingered');
forgetSession(USER, P);
assert.strictEqual(linksOf(USER, C).parent, null, "a deleted parent's child kept a dangling link");
assert.strictEqual(canTalk(USER, C, G), true, 'unrelated links were dropped by the cleanup');

// ── stored per user ──
linkParent(USER, C, P);
assert.strictEqual(canTalk('bob', C, P), false, 'links must not leak across users');

rmSync(root, { recursive: true, force: true });
console.log('session-links.check: OK');
