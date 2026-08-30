/**
 * Runtime base path for autere.
 *
 * When running behind a reverse proxy with a non-root base URL
 * (e.g. /monitor/), the backend injects __PI_MONITOR_BASE__ into
 * the HTML.  This module reads it and provides helpers so that all
 * fetch() / EventSource calls use the correct prefix.
 */

declare const __PI_MONITOR_BASE__: string | undefined;

const base: string = (typeof __PI_MONITOR_BASE__ !== 'undefined' ? __PI_MONITOR_BASE__ : '') || '';

/** Return the base path (always starts with "/" and ends with "/"). */
export function basePath(): string {
  return base;
}

/** Prefix a path with the base path. */
export function url(path: string): string {
  // Avoid double-slash when base = "/" and path starts with "/"
  if (base.endsWith('/') && path.startsWith('/')) {
    return base + path.slice(1);
  }
  return base + path;
}
