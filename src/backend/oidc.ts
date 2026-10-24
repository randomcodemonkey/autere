/**
 * OIDC bearer-token validation.
 *
 * When `AUTERE_OIDC_ISSUER` (alias: `AUTERE_OAUTH2_SERVER`) is set, an
 * `Authorization: Bearer <jwt>` is validated against that OpenID Provider:
 * discovery via `<issuer>/.well-known/openid-configuration` (RFC 8414
 * `/.well-known/oauth-authorization-server` as a fallback), JWKS signature
 * verification, then issuer/audience/expiry claim checks.
 *
 * Opaque autere tokens (cookies, login tokens, API tokens) are untouched and
 * keep working — this path only fires for JWT-shaped bearer values.
 *
 * The user identity comes from a claim (`AUTERE_OIDC_USER_CLAIM`, default
 * chain `preferred_username` -> `email` -> `sub`) and is sanitized the same
 * way usernames are for pi env dirs. Roles stay autere's own: a token user
 * that exists in the users registry gets that account's role, an unknown
 * one gets the registry default (`chat`) — create the user in Users to grant
 * more.
 */

import { constants as cryptoConstants, createPublicKey, verify as cryptoVerify } from 'crypto';
import type { JsonWebKey, KeyObject } from 'crypto';
import { sanitizeUserName } from '../shared/format.js';
import { log } from './logger.js';

export interface OidcConfig {
  /** Issuer URL, or a full `/.well-known/...` discovery URL */
  issuer: string;
  /** Required `aud` value; empty = any audience accepted */
  audience: string;
  /** Preferred identity claim; empty = preferred_username/email/sub chain */
  userClaim: string;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFRESH_FLOOR_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const CLOCK_LEEWAY_SEC = 60;
const MAX_TOKEN_LENGTH = 16 * 1024;

export function getOidcConfig(): OidcConfig | null {
  const issuer = (process.env.AUTERE_OIDC_ISSUER || process.env.AUTERE_OAUTH2_SERVER || '').trim();
  if (!issuer) return null;
  return {
    issuer: issuer.replace(/\/+$/, ''),
    audience: (process.env.AUTERE_OIDC_AUDIENCE || '').trim(),
    userClaim: (process.env.AUTERE_OIDC_USER_CLAIM || '').trim(),
  };
}

/** Three non-empty base64url segments: an opaque autere token never matches. */
export function isJwtShaped(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part));
}

// ── Discovery + JWKS caches (per issuer / JWKS URL) ──

interface Discovery {
  /** Normalized issuer this document describes (what `iss` must equal) */
  issuer: string;
  jwksUri: string;
}

interface JwksCache {
  fetchedAt: number;
  lastRefreshAt: number;
  keys: JsonWebKey[];
}

const discoveryCache = new Map<string, { fetchedAt: number; value: Discovery }>();
const jwksCache = new Map<string, JwksCache>();

function normalizeIssuer(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : '';
}

async function fetchJson(url: string): Promise<any> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`not an http(s) URL: ${url}`);
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function discover(config: OidcConfig): Promise<Discovery> {
  const cached = discoveryCache.get(config.issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.value;

  const candidates: string[] = [];
  if (config.issuer.includes('/.well-known/')) {
    // Operators may point the env var straight at the document.
    candidates.push(config.issuer);
  } else {
    candidates.push(`${config.issuer}/.well-known/openid-configuration`);
    try {
      const url = new URL(config.issuer);
      if (url.pathname && url.pathname !== '/' && url.pathname !== '') {
        // RFC 8414 puts the well-known prefix before the issuer path.
        candidates.push(`${url.origin}/.well-known/oauth-authorization-server${url.pathname.replace(/\/+$/, '')}`);
      }
    } catch { /* issuer validation happens on fetch */ }
  }

  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const doc = await fetchJson(url);
      const issuer = normalizeIssuer(doc?.issuer) || config.issuer;
      if (typeof doc?.jwks_uri !== 'string' || !doc.jwks_uri) throw new Error('document has no jwks_uri');
      if (!config.issuer.includes('/.well-known/') && issuer !== config.issuer) {
        throw new Error(`document issuer ${issuer} does not match ${config.issuer}`);
      }
      const value: Discovery = { issuer, jwksUri: doc.jwks_uri };
      discoveryCache.set(config.issuer, { fetchedAt: Date.now(), value });
      return value;
    } catch (err: any) {
      errors.push(`${url}: ${err?.message || err}`);
    }
  }

  // Provider blip: keep authenticating with the last good document.
  if (cached) {
    log.auth.warn(`OIDC discovery refresh failed, using cached document (${errors.join('; ')})`);
    return cached.value;
  }
  throw new Error(`OIDC discovery failed (${errors.join('; ')})`);
}

async function getJwks(discovery: Discovery, forceRefresh = false): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(discovery.jwksUri);
  const now = Date.now();
  const fresh = cached && now - cached.fetchedAt < JWKS_TTL_MS;
  if (!forceRefresh && fresh) return cached.keys;

  try {
    const doc = await fetchJson(discovery.jwksUri);
    const keys = Array.isArray(doc?.keys) ? doc.keys.filter((k: any) => k && typeof k === 'object') : [];
    jwksCache.set(discovery.jwksUri, { fetchedAt: now, lastRefreshAt: now, keys });
    return keys;
  } catch (err: any) {
    if (cached) {
      log.auth.warn(`OIDC JWKS refresh failed, using cached keys (${err?.message || err})`);
      return cached.keys;
    }
    throw err;
  }
}

/** Unwrap signatures/RSA key material into a KeyObject for the JWT alg. */
function publicKeyFor(jwk: JsonWebKey, alg: string): KeyObject {
  const kty = jwk.kty;
  const family = alg.startsWith('RS') || alg.startsWith('PS') ? 'RSA' : alg.startsWith('ES') ? 'EC' : alg === 'EdDSA' ? 'OKP' : '';
  if (!family || kty !== family) throw new Error(`key type ${kty} does not match alg ${alg}`);
  if (jwk.alg && jwk.alg !== alg) throw new Error(`key alg ${jwk.alg} does not match token alg ${alg}`);
  if (jwk.use && jwk.use !== 'sig') throw new Error('key is not a signing key');
  if (alg === 'ES256' && jwk.crv !== 'P-256') throw new Error('ES256 requires a P-256 key');
  if (alg === 'ES384' && jwk.crv !== 'P-384') throw new Error('ES384 requires a P-384 key');
  if (alg === 'ES512' && jwk.crv !== 'P-521') throw new Error('ES512 requires a P-521 key');
  if (alg === 'EdDSA' && jwk.crv !== 'Ed25519') throw new Error('EdDSA requires an Ed25519 key');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

const ALGS: Record<string, { hash: string | null; options?: Record<string, any> }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', options: { padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST } },
  PS384: { hash: 'sha384', options: { padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST } },
  PS512: { hash: 'sha512', options: { padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST } },
  ES256: { hash: 'sha256', options: { dsaEncoding: 'ieee-p1363' } },
  ES384: { hash: 'sha384', options: { dsaEncoding: 'ieee-p1363' } },
  ES512: { hash: 'sha512', options: { dsaEncoding: 'ieee-p1363' } },
  EdDSA: { hash: null },
};

function decodeJsonSegment(segment: string, what: string): any {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`invalid ${what} segment`);
  }
}

function sameAudience(claim: unknown, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  if (Array.isArray(claim)) return claim.includes(expected);
  return false;
}

/** Identity claim -> safe autere username. Exported for the self-check. */
export function oidcUsername(claims: any, preferredClaim?: string): string | null {
  const names = [preferredClaim, 'preferred_username', 'email', 'sub']
    .filter((name): name is string => !!name);
  for (const name of names) {
    const value = claims?.[name];
    if (typeof value !== 'string' || !value.trim()) continue;
    const user = sanitizeUserName(value.trim()).slice(0, 128);
    if (user && user !== '.' && user !== '..') return user;
  }
  return null;
}

/**
 * Validate a JWT against the configured OIDC provider. Returns the mapped
 * user, or null when the token is invalid/unusable (callers answer 401).
 */
export async function resolveOidcUser(token: string): Promise<{ user: string; claims: Record<string, any> } | null> {
  const config = getOidcConfig();
  if (!config) return null;
  try {
    if (token.length > MAX_TOKEN_LENGTH) throw new Error('token too large');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('not a JWT');

    const header = decodeJsonSegment(parts[0], 'header');
    const claims = decodeJsonSegment(parts[1], 'payload');
    const spec = typeof header.alg === 'string' ? ALGS[header.alg] : undefined;
    if (!spec) throw new Error(`unsupported alg ${String(header.alg)}`);

    const discovery = await discover(config);
    const keys = await getJwks(discovery);
    const kid = typeof header.kid === 'string' ? header.kid : '';
    let candidates = keys.filter((k) => (!kid || k.kid === kid) && (!k.use || k.use === 'sig'));
    // Key rotation: one refetch when the kid is unknown (rate-limited).
    if (candidates.length === 0) {
      const cached = jwksCache.get(discovery.jwksUri);
      const lastRefresh = cached?.lastRefreshAt ?? 0;
      if (Date.now() - lastRefresh > JWKS_REFRESH_FLOOR_MS) {
        const refreshed = await getJwks(discovery, true);
        candidates = refreshed.filter((k) => (!kid || k.kid === kid) && (!k.use || k.use === 'sig'));
      }
    }
    if (candidates.length === 0) throw new Error(kid ? `unknown key id ${kid}` : 'no signing keys');

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    let verified = false;
    let lastError: Error | null = null;
    for (const jwk of candidates) {
      try {
        const key = publicKeyFor(jwk, header.alg);
        verified = spec.hash === null
          ? cryptoVerify(null, signingInput, key, signature)
          : cryptoVerify(spec.hash, signingInput, { key, ...spec.options }, signature);
        if (verified) break;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!verified) throw lastError || new Error('signature verification failed');

    // ── Claims ──
    const now = Math.floor(Date.now() / 1000);
    if (normalizeIssuer(claims.iss) !== discovery.issuer) {
      throw new Error(`issuer ${String(claims.iss)} does not match ${discovery.issuer}`);
    }
    if (typeof claims.exp !== 'number') throw new Error('token has no exp');
    if (now > claims.exp + CLOCK_LEEWAY_SEC) throw new Error('token expired');
    if (typeof claims.nbf === 'number' && now + CLOCK_LEEWAY_SEC < claims.nbf) throw new Error('token not yet valid');
    if (typeof claims.iat === 'number' && claims.iat > now + CLOCK_LEEWAY_SEC) throw new Error('token issued in the future');
    if (config.audience && !sameAudience(claims.aud, config.audience)) {
      throw new Error('token audience does not include the configured audience');
    }
    const user = oidcUsername(claims, config.userClaim);
    if (!user) throw new Error('token has no usable identity claim');

    return { user, claims };
  } catch (err: any) {
    log.auth.debug(`OIDC bearer rejected: ${err?.message || err}`);
    return null;
  }
}

/** Warm discovery + JWKS at startup so the first request is not slowed down.
 *  Failures are logged, never fatal: the provider may come up later. */
export async function warmOidc(): Promise<void> {
  const config = getOidcConfig();
  if (!config) return;
  try {
    const discovery = await discover(config);
    await getJwks(discovery);
    log.auth.info(`OIDC bearer validation enabled (issuer: ${discovery.issuer})`);
  } catch (err: any) {
    log.auth.warn(`OIDC provider not reachable yet (${err?.message || err}); will retry on request`);
  }
}
