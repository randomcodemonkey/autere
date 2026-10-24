/**
 * Browser CORS policy, configured by env:
 *
 *   AUTERE_CORS_ORIGINS     exact origins allowed cross-origin (`*` = any)
 *   AUTERE_CORS_CREDENTIALS `true` lets allowlisted origins send cookies
 *                           (Access-Control-Allow-Credentials: true);
 *                           never combined with `*`
 *   AUTERE_CORS_METHODS     Access-Control-Allow-Methods (default below)
 *   AUTERE_CORS_HEADERS     Access-Control-Allow-Headers (default below)
 *
 * Same-host origins are always echoed (the dashboard is same-origin; reverse
 * proxies keep the public Host header). Responses for unlisted origins get no
 * CORS headers, so the browser blocks them.
 */

const DEFAULT_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const DEFAULT_HEADERS = 'Content-Type, Accept, Authorization, X-Autere-Client-Id';

export interface CorsAllow {
  /** Value for Access-Control-Allow-Origin */
  origin: string;
  /** The answer depends on the request Origin, so add `Vary: Origin` */
  vary: boolean;
  /** Send Access-Control-Allow-Credentials: true (allowlisted origin only) */
  credentials: boolean;
}

function envList(name: string, fallback: string): string[] {
  const raw = (process.env[name] || '').trim();
  return (raw || fallback).split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function corsMethods(): string[] {
  return envList('AUTERE_CORS_METHODS', DEFAULT_METHODS);
}

export function corsHeaders(): string[] {
  return envList('AUTERE_CORS_HEADERS', DEFAULT_HEADERS);
}

function normalizeOrigin(value: string): string {
  try { return new URL(value.trim()).origin.toLowerCase(); } catch { return ''; }
}

/** Null = do not send CORS headers (browser blocks the response). */
export function corsAllowOrigin(origin: string | undefined, host: string | undefined): CorsAllow | null {
  if (!origin) return null;

  let originHost: string;
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return null; }
  if (host && originHost === host.toLowerCase()) return { origin, vary: true, credentials: false };

  const configured = (process.env.AUTERE_CORS_ORIGINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.includes('*')) return { origin: '*', vary: false, credentials: false };

  const normalized = normalizeOrigin(origin);
  if (!normalized || !configured.map(normalizeOrigin).includes(normalized)) return null;
  // Credentials only for an explicitly listed origin: `*` cannot carry them,
  // and the operator has made a per-origin trust decision here.
  return { origin, vary: true, credentials: process.env.AUTERE_CORS_CREDENTIALS === 'true' };
}
