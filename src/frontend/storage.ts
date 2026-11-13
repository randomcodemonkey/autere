import { basePath } from './base-path';

/**
 * Client-only settings are stored per backend, not per browser.
 *
 * Two autere instances can share one browser origin (a proxy serving them at
 * different base paths), and localStorage/sessionStorage are per origin — so
 * a device-global key would leak card states, filters, drafts and pins from
 * one instance into the other. Every key goes through here, prefixed with the
 * instance's origin + base path.
 */
export function storageScope(): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `autere@${origin}${basePath()}`;
}

export function storageKey(key: string): string {
  return `${storageScope()}:${key}`;
}

export function getStored(key: string): string | null {
  try {
    return localStorage.getItem(storageKey(key));
  } catch {
    return null;
  }
}

export function setStored(key: string, value: string): void {
  try {
    localStorage.setItem(storageKey(key), value);
  } catch {
    /* quota exceeded or storage blocked: keep the in-memory state */
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

/** sessionStorage twin (per-tab identity, still scoped per backend). */
export function getSessionStored(key: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(key));
  } catch {
    return null;
  }
}

export function setSessionStored(key: string, value: string): void {
  try {
    sessionStorage.setItem(storageKey(key), value);
  } catch {
    /* ignore */
  }
}
