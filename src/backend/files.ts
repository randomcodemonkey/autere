/**
 * File browser backend for the Edits view.
 *
 * Every path a user can see is restricted to their admin-managed
 * `allowedDirs` (see users.ts), falling back to $HOME when none are
 * configured. All handlers enforce this via resolveInRoots() — never call
 * the fs helpers directly from routes.
 */

import { openSync, readSync, closeSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { realpathSync } from 'fs';
import { homedir } from 'os';
import { getUserAllowedDirs } from './users.js';
import { log } from './logger.js';

export interface FileRoot { path: string; access: 'read' | 'rw' }
export interface DirEntry { name: string; type: 'file' | 'dir'; size: number; mtime: number }
export interface ReadData { content: string; binary: boolean; truncated: boolean; size: number }

/** Union return for browse handlers: either data or an HTTP-mapped error */
export type BrowseResult<T = any> = { data: T } | { error: string; status: number };

const MAX_LIST_ENTRIES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function rootsFor(user: string): FileRoot[] {
  const dirs = getUserAllowedDirs(user);
  if (dirs.length > 0) return dirs;
  return [{ path: homedir(), access: 'rw' }];
}

/** True if abs is root itself or somewhere under it */
function under(root: string, abs: string): boolean {
  const r = resolve(root);
  return abs === r || abs.startsWith(r.endsWith('/') ? r : r + '/');
}

/** Realpath, falling back to the nearest existing ancestor (new files) */
function safeReal(p: string): string {
  try { return realpathSync(p); } catch {}
  try { return joinSafe(realpathSync(dirname(p)), basename(p)); } catch {}
  return p;
}

function joinSafe(a: string, b: string): string {
  return a.endsWith('/') ? a + b : a + '/' + b;
}

/**
 * Resolve an absolute user-supplied path against the user's roots.
 * Symlinks are resolved so a link inside a root cannot escape it. The most
 * specific (deepest) matching root wins, so a rw subdir can override a
 * read-only parent.
 */
export function resolveInRoots(user: string, path: string): { abs: string; access: 'read' | 'rw' } | { error: string; status: number } {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
    return { error: 'Invalid path', status: 400 };
  }
  const abs = safeReal(resolve(path));
  let best: { abs: string; access: 'read' | 'rw'; len: number } | null = null;
  for (const r of rootsFor(user)) {
    const root = safeReal(resolve(r.path));
    if (under(root, abs) && (!best || root.length > best.len)) {
      best = { abs, access: r.access, len: root.length };
    }
  }
  if (!best) return { error: 'Path is outside your file roots', status: 403 };
  return best;
}

export function userFileRoots(user: string): FileRoot[] {
  return rootsFor(user).map((r) => ({ ...r }));
}

export function browseList(user: string, path: string): BrowseResult<DirEntry[]> {
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  try {
    if (!statSync(t.abs).isDirectory()) return { error: 'Not a directory', status: 400 };
    const entries: DirEntry[] = [];
    for (const e of readdirSync(t.abs, { withFileTypes: true })) {
      if (entries.length >= MAX_LIST_ENTRIES) break;
      let st: ReturnType<typeof statSync> | null = null;
      try { st = statSync(t.abs + '/' + e.name); } catch { continue; }
      entries.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st!.size, mtime: st!.mtimeMs });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { data: entries };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Listing failed: ${err.message}`, status: 500 };
  }
}

export function browseRead(user: string, path: string): BrowseResult<ReadData> {
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  try {
    const st = statSync(t.abs);
    if (!st.isFile()) return { error: 'Not a file', status: 400 };
    const size = st.size;
    const len = Math.min(size, MAX_FILE_BYTES);
    const fd = openSync(t.abs, 'r');
    const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, 0); } finally { closeSync(fd); }
    const binary = buf.subarray(0, Math.min(len, 8192)).includes(0);
    return { data: { content: binary ? '' : buf.toString('utf-8'), binary, truncated: size > MAX_FILE_BYTES, size } };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Read failed: ${err.message}`, status: 500 };
  }
}

export function browseWrite(user: string, path: string, content: unknown): BrowseResult<{ saved: boolean }> {
  if (typeof content !== 'string' || content.length > MAX_FILE_BYTES) {
    return { error: 'Invalid or oversized content', status: 400 };
  }
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  if (t.access !== 'rw') return { error: 'Directory is read-only', status: 403 };
  try {
    mkdirSync(dirname(t.abs), { recursive: true });
    writeFileSync(t.abs, content);
    log.http.info(`file write ${t.abs} (${content.length} bytes) by ${user}`);
    return { data: { saved: true } };
  } catch (err: any) {
    return { error: `Write failed: ${err.message}`, status: 500 };
  }
}

export function browseDelete(user: string, path: string): BrowseResult<{ deleted: boolean }> {
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  if (t.access !== 'rw') return { error: 'Directory is read-only', status: 403 };
  if (rootsFor(user).some((r) => resolve(r.path) === t.abs)) {
    return { error: 'Cannot delete a file root', status: 403 };
  }
  try {
    if (!statSync(t.abs).isFile()) return { error: 'Only files can be deleted', status: 400 };
    unlinkSync(t.abs);
    log.http.info(`file delete ${t.abs} by ${user}`);
    return { data: { deleted: true } };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Delete failed: ${err.message}`, status: 500 };
  }
}
