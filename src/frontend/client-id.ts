/**
 * Per-tab dashboard client identity.
 *
 * Each browser TAB gets a stable client id (sessionStorage) and sends it on
 * every API call (x-autere-client-id header) and the SSE connection
 * (?clientId=) — the backend routes events and API calls to whichever pi
 * session that tab is viewing. Cookie-based ids were racy: the id was minted
 * by the SSE response's Set-Cookie, so early API calls raced it and tabs
 * clobbered each other's cookie.
 */

const KEY = 'autere-client-id';

let cached: string | null = null;

export function getClientId(): string {
  if (cached) return cached;
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(KEY, id);
    }
    cached = id;
    return id;
  } catch {
    // sessionStorage unavailable (private mode?) — per-tab identity degrades
    // to per-page-load; routing still works within a page's lifetime.
    return (cached = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }
}

/** Header value for fetch calls */
export const CLIENT_ID_HEADER = 'x-autere-client-id';