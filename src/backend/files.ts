/**
 * File browser backend for the Edits view.
 *
 * Every path a user can see is restricted to their admin-managed
 * `allowedDirs` (see users.ts), falling back to $HOME when none are
 * configured. All handlers enforce this via resolveInRoots() — never call
 * the fs helpers directly from routes.
 */

import { constants as fsConstants, realpathSync } from 'fs';
import { open, readdir, lstat, stat, mkdir, unlink, writeFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
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

/** True if abs is root itself or somewhere under it (plain string prefix) */
export function under(root: string, abs: string): boolean {
  const r = resolve(root);
  return abs === r || abs.startsWith(r.endsWith('/') ? r : r + '/');
}

/** Resolve existing path components without following missing suffixes. */
function safeReal(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch {}
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(safeReal(parent), abs.slice(parent.length).replace(/^\/+/, ''));
}

function withinConfiguredRoot(root: string, abs: string): boolean {
  return under(safeReal(resolve(root)), abs);
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
  const abs = safeReal(path);
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

/** One directory listing: readdir + concurrent lstat (async — a 500-entry
 *  listing must not block the event loop). */
export async function listDirectoryEntries(path: string, limit = MAX_LIST_ENTRIES): Promise<DirEntry[]> {
  const dirents = (await readdir(path, { withFileTypes: true })).slice(0, limit);
  const entries = await Promise.all(dirents.map(async (e): Promise<DirEntry | null> => {
    try {
      const st = await lstat(join(path, e.name));
      return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
    } catch { return null; /* entry was removed or became inaccessible */ }
  }));
  return entries
    .filter((e): e is DirEntry => e !== null)
    .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
}

export async function browseList(user: string, path: string): Promise<BrowseResult<DirEntry[]>> {
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  try {
    if (!(await stat(t.abs)).isDirectory()) return { error: 'Not a directory', status: 400 };
    return { data: await listDirectoryEntries(t.abs) };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Listing failed: ${err.message}`, status: 500 };
  }
}

export async function browseRead(user: string, path: string): Promise<BrowseResult<ReadData>> {
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  try {
    const st = await stat(t.abs);
    if (!st.isFile()) return { error: 'Not a file', status: 400 };
    const size = st.size;
    const len = Math.min(size, MAX_FILE_BYTES);
    const buf = Buffer.alloc(len);
    const fh = await open(t.abs, 'r');
    try { await fh.read(buf, 0, len, 0); } finally { await fh.close(); }
    const binary = buf.subarray(0, Math.min(len, 8192)).includes(0);
    return { data: { content: binary ? '' : buf.toString('utf-8'), binary, truncated: size > MAX_FILE_BYTES, size } };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Read failed: ${err.message}`, status: 500 };
  }
}

export async function browseWrite(user: string, path: string, content: unknown): Promise<BrowseResult<{ saved: boolean }>> {
  if (typeof content !== 'string' || content.length > MAX_FILE_BYTES) {
    return { error: 'Invalid or oversized content', status: 400 };
  }
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  if (t.access !== 'rw') return { error: 'Directory is read-only', status: 403 };
  try {
    const parent = dirname(t.abs);
    await mkdir(parent, { recursive: true });
    // Re-resolve after directory creation to close symlink/missing-path escapes.
    const checked = resolveInRoots(user, t.abs);
    if ('error' in checked || checked.access !== 'rw' || checked.abs !== t.abs) {
      return { error: 'Path changed or escaped its file root', status: 403 };
    }
    await writeFile(t.abs, content, {
      flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      mode: 0o666,
    });
    log.http.info(`file write ${t.abs} (${content.length} bytes) by ${user}`);
    return { data: { saved: true } };
  } catch (err: any) {
    return { error: `Write failed: ${err.message}`, status: 500 };
  }
}

export async function browseDelete(user: string, path: string): Promise<BrowseResult<{ deleted: boolean }>> {
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  if (t.access !== 'rw') return { error: 'Directory is read-only', status: 403 };
  if (rootsFor(user).some((r) => withinConfiguredRoot(r.path, t.abs) && safeReal(resolve(r.path)) === t.abs)) {
    return { error: 'Cannot delete a file root', status: 403 };
  }
  try {
    if (!(await lstat(t.abs)).isFile()) return { error: 'Only files can be deleted', status: 400 };
    await unlink(t.abs);
    log.http.info(`file delete ${t.abs} by ${user}`);
    return { data: { deleted: true } };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Delete failed: ${err.message}`, status: 500 };
  }
}
