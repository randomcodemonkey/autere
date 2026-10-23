/**
 * JSON API client for the dashboard.
 *
 * Every autere endpoint answers `{ success, data }` or `{ success: false, error }`
 * (see sendJSON in the backend) — one place to unwrap that, instead of a
 * fetch→json→success check at each of the ~70 call sites.
 */

import { url } from './base-path';

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** GET (or any custom init) returning `data`; throws Error(error message). */
export async function apiJSON<T = any>(path: string, init?: RequestInit): Promise<T> {
  return (await apiBody<T>(path, init)).data as T;
}

/** Whole body, for endpoints that carry top-level fields beside `data`
 *  (`deferred`, `navigateUrl`, `mustChangePassword`, ...). */
export async function apiBody<T = any>(path: string, init?: RequestInit): Promise<{ success: true; data?: T } & Record<string, any>> {
  const res = await fetch(url(path), init);
  const body = await res.json().catch(() => null);
  const d = body as ({ success?: boolean; error?: string } & Record<string, any>) | null;
  if (!d || !d.success) throw new Error(d?.error || `HTTP ${res.status}`);
  return d as { success: true; data?: T } & Record<string, any>;
}

/** POST/PUT/DELETE with an optional JSON body. */
export function apiSend<T = any>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  return apiJSON<T>(path, {
    method,
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
