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

import { getSessionStored, setSessionStored } from './storage';

const KEY = 'autere-client-id';

let cached: string | null = null;

export function getClientId(): string {
  if (cached) return cached;
  const existing = getSessionStored(KEY);
  if (existing) return (cached = existing);
  // sessionStorage unavailable (private mode?) — per-tab identity degrades to
  // per-page-load; routing still works within a page's lifetime.
  cached = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setSessionStored(KEY, cached);
  return cached;
}

/** Header value for fetch calls */
export const CLIENT_ID_HEADER = 'x-autere-client-id';