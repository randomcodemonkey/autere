// Self-check for OIDC JWT bearer validation against a local fake provider.
// Run: npx tsx src/backend/oidc.check.ts
import assert from 'node:assert';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { authenticateOidc, checkAuth, getTokenFromRequest, getUser } from './auth.js';
import { isJwtShaped, oidcUsername, resolveOidcUser } from './oidc.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64url = (value: any) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signJwt(header: any, claims: any, privateKey = rsa.privateKey): string {
  const input = `${b64url(header)}.${b64url(claims)}`;
  const signature = sign('sha256', Buffer.from(input), privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

const jwk = (key: any, kid: string, alg: string) => ({
  ...key.export({ format: 'jwk' }),
  kid,
  use: 'sig',
  alg,
});

async function main() {
  const issuerPath = '/tenant';
  const jwks = { keys: [jwk(rsa.publicKey, 'rsa1', 'RS256'), jwk(ec.publicKey, 'ec1', 'ES256')] };
  const server = createServer((req, res) => {
    const send = (body: any) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/tenant/.well-known/openid-configuration') {
      return send({ issuer: base + issuerPath, jwks_uri: `${base}/tenant/jwks` });
    }
    if (req.url === '/tenant/jwks') return send(jwks);
    // RFC 8414 path-aware variant
    if (req.url === '/.well-known/oauth-authorization-server/tenant') {
      return send({ issuer: base + issuerPath, jwks_uri: `${base}/tenant/jwks` });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const now = () => Math.floor(Date.now() / 1000);
  const claims = (over: any = {}) => ({
    iss: `${base}${issuerPath}`,
    sub: 'user-1',
    preferred_username: 'alice',
    aud: 'autere',
    iat: now(),
    exp: now() + 300,
    ...over,
  });
  const valid = () => signJwt({ alg: 'RS256', typ: 'at+jwt', kid: 'rsa1' }, claims());

  delete process.env.AUTERE_OIDC_AUDIENCE;
  delete process.env.AUTERE_OIDC_USER_CLAIM;

  try {
    // ── Shape ──
    assert.equal(isJwtShaped(valid()), true);
    assert.equal(isJwtShaped('deadbeef'), false);
    assert.equal(isJwtShaped('a.b'), false);

    // OIDC disabled -> no validation attempted
    assert.equal(await resolveOidcUser(valid()), null);

    process.env.AUTERE_OAUTH2_SERVER = `${base}${issuerPath}`; // requested env name
    const resolved = await resolveOidcUser(valid());
    assert.equal(resolved?.user, 'alice');
    assert.equal(resolved?.claims.sub, 'user-1');

    // ── Signature / header ──
    assert.equal(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims(), rogue.privateKey)), null, 'wrong key');
    assert.equal(await resolveOidcUser(signJwt({ alg: 'none' }, claims())), null, 'alg none');
    assert.equal(await resolveOidcUser(signJwt({ alg: 'RS384', kid: 'rsa1' }, claims())), null, 'alg/key mismatch');
    assert.equal(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'nope' }, claims())), null, 'unknown kid');
    assert.equal(await resolveOidcUser('header.payload'), null);

    // ES256 with its own key and alg
    const esInput = `${b64url({ alg: 'ES256', kid: 'ec1' })}.${b64url(claims())}`;
    const esSig = sign('sha256', Buffer.from(esInput), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' });
    assert.equal((await resolveOidcUser(`${esInput}.${esSig.toString('base64url')}`))?.user, 'alice');

    // ── Claims ──
    assert.equal(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ exp: now() - 300 }))), null, 'expired');
    assert.equal(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ exp: undefined }))), null, 'no exp');
    assert.equal(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ nbf: now() + 300 }))), null, 'nbf future');
    assert.equal(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ iss: 'https://evil.example' }))), null, 'issuer mismatch');
    // 60 s clock leeway keeps a just-expired token valid
    assert.ok(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ exp: now() - 10 }))));

    // Audience: only enforced when configured
    process.env.AUTERE_OIDC_AUDIENCE = 'autere';
    assert.ok(await resolveOidcUser(valid()));
    assert.equal(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ aud: 'other' }))), null, 'aud mismatch');
    assert.ok(await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ aud: ['other', 'autere'] }))), 'aud array');
    delete process.env.AUTERE_OIDC_AUDIENCE;

    // Identity claim chain and override
    assert.equal(oidcUsername({ email: 'alice@example.com' }), 'alice_example.com');
    assert.equal(oidcUsername({ sub: 'abc-123' }), 'abc-123');
    assert.equal(oidcUsername({}), null);
    process.env.AUTERE_OIDC_USER_CLAIM = 'kasutaja';
    assert.equal((await resolveOidcUser(signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ kasutaja: 'bob' }))))?.user, 'bob');
    delete process.env.AUTERE_OIDC_USER_CLAIM;

    // Explicit discovery URL also works
    process.env.AUTERE_OIDC_ISSUER = `${base}${issuerPath}/.well-known/openid-configuration`;
    assert.equal((await resolveOidcUser(valid()))?.user, 'alice');
    delete process.env.AUTERE_OIDC_ISSUER;
    process.env.AUTERE_OAUTH2_SERVER = `${base}${issuerPath}`;

    // ── Request glue: one validation per request, then sync auth helpers ──
    const token = valid();
    // Unknown IdP users are rejected unless auto-provisioning is enabled.
    const unknownReq: any = { headers: { authorization: `Bearer ${token}` } };
    await authenticateOidc(unknownReq);
    assert.equal(getUser(unknownReq), null, 'unregistered user rejected by default');

    process.env.AUTERE_OIDC_AUTO_PROVISION = 'true';
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    assert.equal(checkAuth(req), false);
    await authenticateOidc(req);
    assert.equal(checkAuth(req), true);
    assert.equal(getUser(req), 'alice');
    assert.equal(getTokenFromRequest(req), 'oidc:alice');

    const badReq: any = { headers: { authorization: `Bearer ${signJwt({ alg: 'RS256', kid: 'rsa1' }, claims(), rogue.privateKey)}` } };
    await authenticateOidc(badReq);
    assert.equal(getUser(badReq), null);
    assert.equal(checkAuth(badReq), false);

    // Opaque autere tokens are not touched by the OIDC path
    const opaqueReq: any = { headers: { authorization: 'Bearer deadbeef' } };
    await authenticateOidc(opaqueReq);
    assert.equal(getUser(opaqueReq), null);

    // ── Discovery URL order and authoritative documents ──
    const startProvider = async (opts: { docIssuer?: string; serveOidc?: boolean }) => {
      const seen: string[] = [];
      let origin = '';
      const srv = createServer((req, res) => {
        seen.push(req.url || '');
        const send = (body: any) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        const doc = { issuer: opts.docIssuer ?? `${origin}/tenant`, jwks_uri: `${origin}/tenant/jwks` };
        if (req.url === '/tenant/jwks') return send(jwks);
        if (req.url === '/tenant/.well-known/openid-configuration' && opts.serveOidc !== false) return send(doc);
        if (req.url === '/.well-known/oauth-authorization-server/tenant') return send(doc);
        res.writeHead(404); res.end();
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      return { origin, seen, close: () => srv.close() };
    };

    // Split horizon: the document answers but names another issuer -> reject,
    // and do not waste a request on the RFC 8414 URL.
    const split = await startProvider({ docIssuer: 'https://auth.example.com/tenant' });
    process.env.AUTERE_OIDC_ISSUER = `${split.origin}/tenant`;
    assert.equal(await resolveOidcUser(valid()), null, 'document issuer must match the configured issuer');
    assert.equal(split.seen.join(','), '/tenant/.well-known/openid-configuration', `split.seen=${JSON.stringify(split.seen)}`);
    split.close();

    // RFC 8414 metadata is still the fallback when the OIDC document is missing.
    const rfc = await startProvider({ serveOidc: false });
    process.env.AUTERE_OIDC_ISSUER = `${rfc.origin}/tenant`;
    const rfcToken = signJwt({ alg: 'RS256', kid: 'rsa1' }, claims({ iss: `${rfc.origin}/tenant` }));
    assert.equal((await resolveOidcUser(rfcToken))?.user, 'alice', 'RFC 8414 fallback');
    assert.equal(rfc.seen.join(','), '/tenant/.well-known/openid-configuration,/.well-known/oauth-authorization-server/tenant,/tenant/jwks', `rfc.seen=${JSON.stringify(rfc.seen)}`);
    rfc.close();

    console.log('oidc.check: OK');
  } finally {
    server.close();
    delete process.env.AUTERE_OAUTH2_SERVER;
    delete process.env.AUTERE_OIDC_ISSUER;
    delete process.env.AUTERE_OIDC_AUDIENCE;
    delete process.env.AUTERE_OIDC_USER_CLAIM;
    delete process.env.AUTERE_OIDC_AUTO_PROVISION;
  }
}

main().then(() => process.exit(0), (err) => { console.error('oidc.check FAILED:', err); process.exit(1); });
