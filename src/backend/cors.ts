/**
 * Browser CORS policy.
 *
 * Default: only an Origin whose host matches the request Host is echoed (the
 * dashboard is same-origin; reverse proxies keep the public Host header).
 *
 * AUTERE_CORS_ORIGINS adds explicit cross-origin browser clients:
 *   AUTERE_CORS_ORIGINS=https://chat.example.com,http://localhost:5173
 *   AUTERE_CORS_ORIGINS=*     (any origin)
 *
 * Allowed origins still authenticate with a bearer token (OIDC JWT or an
 * autere API token). The response never sets Access-Control-Allow-Credentials,
 * so the login cookie is not usable cross-origin.
 */

export interface CorsAllow {
  /** Value for Access-Control-Allow-Origin */
  origin: string;
  /** The answer depends on the request Origin, so add `Vary: Origin` */
  vary: boolean;
}

function normalizeOrigin(value: string): string {
  try { return new URL(value.trim()).origin.toLowerCase(); } catch { return ''; }
}

/** Null = do not send CORS headers (browser blocks the response). */
export function corsAllowOrigin(origin: string | undefined, host: string | undefined): CorsAllow | null {
  if (!origin) return null;

  let originHost: string;
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return null; }
  if (host && originHost === host.toLowerCase()) return { origin, vary: true };

  const configured = (process.env.AUTERE_CORS_ORIGINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.includes('*')) return { origin: '*', vary: false };
  const normalized = normalizeOrigin(origin);
  if (normalized && configured.map(normalizeOrigin).includes(normalized)) return { origin, vary: true };
  return null;
}
