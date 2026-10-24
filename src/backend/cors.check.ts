// Self-check for the CORS allowlist (AUTERE_CORS_ORIGINS).
// Run: npx tsx src/backend/cors.check.ts
import assert from 'node:assert';
import { corsAllowOrigin, corsHeaders, corsMethods } from './cors.js';

const HOST = 'localhost:3456';

delete process.env.AUTERE_CORS_ORIGINS;
assert.equal(corsAllowOrigin(undefined, HOST), null);
assert.deepEqual(corsAllowOrigin('http://localhost:3456', HOST), { origin: 'http://localhost:3456', vary: true, credentials: false });
assert.equal(corsAllowOrigin('http://localhost:5173', HOST), null, 'other origin denied by default');

process.env.AUTERE_CORS_ORIGINS = ' https://chat.example.com/ , http://localhost:5173,notaurl';
assert.deepEqual(corsAllowOrigin('https://chat.example.com', HOST), { origin: 'https://chat.example.com', vary: true, credentials: false });
assert.ok(corsAllowOrigin('HTTPS://CHAT.EXAMPLE.COM', HOST), 'case-insensitive match');
assert.ok(corsAllowOrigin('http://localhost:5173', HOST), 'second entry');
assert.equal(corsAllowOrigin('http://chat.example.com', HOST), null, 'scheme must match');
assert.equal(corsAllowOrigin('https://chat.example.com:8443', HOST), null, 'port must match');
assert.equal(corsAllowOrigin('http://evil.example', HOST), null, 'invalid entry ignored');
assert.deepEqual(corsAllowOrigin('http://localhost:3456', HOST), { origin: 'http://localhost:3456', vary: true, credentials: false }, 'same host still echoed');

process.env.AUTERE_CORS_ORIGINS = '*';
assert.deepEqual(corsAllowOrigin('http://anything.example', HOST), { origin: '*', vary: false, credentials: false });
assert.deepEqual(corsAllowOrigin('http://localhost:3456', HOST), { origin: 'http://localhost:3456', vary: true, credentials: false }, 'same host keeps echo');

assert.equal(corsAllowOrigin('null', HOST), null, 'opaque origin');
delete process.env.AUTERE_CORS_ORIGINS;

// ── credentials / methods / headers ──
delete process.env.AUTERE_CORS_CREDENTIALS;
process.env.AUTERE_CORS_ORIGINS = 'http://localhost:21080';
assert.deepEqual(corsAllowOrigin('http://localhost:21080', HOST),
  { origin: 'http://localhost:21080', vary: true, credentials: false }, 'credentials off by default');

process.env.AUTERE_CORS_CREDENTIALS = 'true';
assert.deepEqual(corsAllowOrigin('http://localhost:21080', HOST),
  { origin: 'http://localhost:21080', vary: true, credentials: true }, 'allowlisted origin may use cookies');
process.env.AUTERE_CORS_ORIGINS = '*';
assert.equal(corsAllowOrigin('http://localhost:21080', HOST)?.credentials, false, 'wildcard never carries credentials');
assert.equal(corsAllowOrigin('http://localhost:3456', HOST)?.credentials, false, 'same host needs no credentials');

assert.deepEqual(corsMethods(), ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
assert.deepEqual(corsHeaders(), ['Content-Type', 'Accept', 'Authorization', 'X-Autere-Client-Id']);
process.env.AUTERE_CORS_METHODS = 'POST, OPTIONS';
process.env.AUTERE_CORS_HEADERS = 'content-type, accept';
assert.deepEqual(corsMethods(), ['POST', 'OPTIONS']);
assert.deepEqual(corsHeaders(), ['content-type', 'accept']);
process.env.AUTERE_CORS_METHODS = ' ';
assert.deepEqual(corsMethods(), ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], 'empty env keeps defaults');
delete process.env.AUTERE_CORS_METHODS;
delete process.env.AUTERE_CORS_HEADERS;
delete process.env.AUTERE_CORS_CREDENTIALS;
delete process.env.AUTERE_CORS_ORIGINS;

console.log('cors.check: OK');
