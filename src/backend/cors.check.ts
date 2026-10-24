// Self-check for the CORS allowlist (AUTERE_CORS_ORIGINS).
// Run: npx tsx src/backend/cors.check.ts
import assert from 'node:assert';
import { corsAllowOrigin } from './cors.js';

const HOST = 'localhost:3456';

delete process.env.AUTERE_CORS_ORIGINS;
assert.equal(corsAllowOrigin(undefined, HOST), null);
assert.deepEqual(corsAllowOrigin('http://localhost:3456', HOST), { origin: 'http://localhost:3456', vary: true });
assert.equal(corsAllowOrigin('http://localhost:5173', HOST), null, 'other origin denied by default');

process.env.AUTERE_CORS_ORIGINS = ' https://chat.example.com/ , http://localhost:5173,notaurl';
assert.deepEqual(corsAllowOrigin('https://chat.example.com', HOST), { origin: 'https://chat.example.com', vary: true });
assert.ok(corsAllowOrigin('HTTPS://CHAT.EXAMPLE.COM', HOST), 'case-insensitive match');
assert.ok(corsAllowOrigin('http://localhost:5173', HOST), 'second entry');
assert.equal(corsAllowOrigin('http://chat.example.com', HOST), null, 'scheme must match');
assert.equal(corsAllowOrigin('https://chat.example.com:8443', HOST), null, 'port must match');
assert.equal(corsAllowOrigin('http://evil.example', HOST), null, 'invalid entry ignored');
assert.deepEqual(corsAllowOrigin('http://localhost:3456', HOST), { origin: 'http://localhost:3456', vary: true }, 'same host still echoed');

process.env.AUTERE_CORS_ORIGINS = '*';
assert.deepEqual(corsAllowOrigin('http://anything.example', HOST), { origin: '*', vary: false });
assert.deepEqual(corsAllowOrigin('http://localhost:3456', HOST), { origin: 'http://localhost:3456', vary: true }, 'same host keeps echo');

assert.equal(corsAllowOrigin('null', HOST), null, 'opaque origin');
delete process.env.AUTERE_CORS_ORIGINS;

console.log('cors.check: OK');
