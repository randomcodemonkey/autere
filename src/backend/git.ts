/**
 * Git support for the Repositories view.
 *
 * Every path passes through resolveInRoots() first (files.ts) — the same
 * allowedDirs enforcement as the rest of the file browser; never call the
 * helpers below directly from routes with an unvalidated path.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { resolveInRoots, listDirectoryEntries, type FileRoot, type DirEntry, type BrowseResult } from './files.js';
import { getGitRepos } from './user-settings.js';

export interface RepoEntry extends FileRoot { isRepo: boolean }
export interface Commit { hash: string; short: string; author: string; date: number; subject: string }
export interface RepoDetail {
  root: string;
  isRepo: boolean;
  branch: string;
  changed: { x: string; y: string; path: string }[];
  remotes: { name: string; url: string }[];
  commits: Commit[];
  hasMore: boolean;
}

/** Configured repo folders, resolved (relative → $HOME), exactly as configured */
export function resolvedGitRepos(user: string): string[] {
  return getGitRepos(user).map((raw) => (raw.startsWith('/') ? raw : `${homedir()}/${raw}`)).map((p) => resolve(p));
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const execFileAsync = promisify(execFile);

function validateRepoRoot(user: string, path: string): BrowseResult<{ root: string; access: 'read' | 'rw' }> {
  const target = resolveInRoots(user, path);
  if ('error' in target) return target;
  const root = repoRootFor(target.abs);
  if (!root) return { error: 'Not inside a configured repository', status: 400 };
  const allowed = resolveInRoots(user, root);
  if ('error' in allowed) return allowed;
  if (allowed.access !== target.access) return { error: 'Repository root has different file permissions', status: 403 };
  return { data: { root: allowed.abs, access: allowed.access } };
}

/** `.git` may be a dir (repo), a file (worktree/submodule) — both count */
export function isGitRepo(p: string): boolean {
  return existsSync(resolve(p, '.git'));
}

/** Unified worktree diff for one file (staged + unstaged; untracked → /dev/null diff) */
export async function fileDiff(user: string, path: string): Promise<BrowseResult<{ diff: string }>> {
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  const checked = validateRepoRoot(user, t.abs);
  if ('error' in checked) return checked;
  const root = checked.data.root;
  try {
    let out: string;
    try {
      out = await git(root, ['diff', 'HEAD', '--', t.abs]);
    } catch (e: any) {
      if (!String(e.stderr || e.message).includes("bad revision 'HEAD'")) throw e;
      out = ''; // empty repo — no commits yet, fall through to the untracked path
    }
    if (!out.trim() && !(await git(root, ['ls-tree', 'HEAD', '--', t.abs])).trim()) {
      // Untracked (bad-revision repo paths above also land here) → render as
      // an all-add patch. --no-index implies --exit-code (exit 1 = "has
      // differences", still output)
      try {
        out = await git(root, ['diff', '--no-index', '--', '/dev/null', t.abs]);
      } catch (e: any) {
        if (e.status === 1 || e.code === 1) out = e.stdout || '';
        else throw e;
      }
    }
    return { data: { diff: out } };
  } catch (err: any) {
    return { error: `git diff failed: ${err.message}`, status: 500 };
  }
}

/** Run git off the event loop; rejects with stdout/stderr/code on failure
 *  (callers inspect those, so no error wrapping here). */
const git = async (p: string, args: string[]) =>
  (await execFileAsync('git', ['-C', p, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout.toString();

// ',' never appears inside git pretty fields we request (hash/author/date
// are comma-free; %s subjects could theoretically contain one, but only the
// subject (position 5+) carries that risk and we only split the first 4).
const SEP = '   |   ';

/** Configured repo folders for the Repositories view — as-is, no searching/filtering */
export function listRepos(user: string): BrowseResult<RepoEntry[]> {
  return {
    data: resolvedGitRepos(user).flatMap((path) => {
      const root = resolveInRoots(user, path);
      return 'error' in root ? [] : [{ path: root.abs, isRepo: isGitRepo(root.abs), access: root.access }];
    }),
  };
}

/**
 * Resolve within the user's file roots. Configured repository folders do
 * not grant access beyond the user's allowed roots.
 */
export function resolveInRepos(user: string, path: string): { abs: string; access: 'read' | 'rw' } | { error: string; status: number } {
  return resolveInRoots(user, path);
}

function parseLog(out: string): Commit[] {
  return out.split('\n').filter(Boolean).map((l) => {
    const i1 = l.indexOf(SEP), i2 = l.indexOf(SEP, i1 + SEP.length), i3 = l.indexOf(SEP, i2 + SEP.length), i4 = l.indexOf(SEP, i3 + SEP.length);
    return { hash: l.slice(0, i1), short: l.slice(i1 + SEP.length, i2), author: l.slice(i2 + SEP.length, i3), date: Number(l.slice(i3 + SEP.length, i4)) * 1000, subject: l.slice(i4 + SEP.length) };
  });
}

/** Full repository detail: status, remotes, last N commits. */
export async function repoDetail(user: string, path: string, commitCount: number): Promise<BrowseResult<RepoDetail>> {
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  if (!isDir(t.abs)) return { error: 'Not a directory', status: 400 };
  const checked = validateRepoRoot(user, t.abs);
  if ('error' in checked) return checked;
  const p = checked.data.root;
  const detail: RepoDetail = { root: p, isRepo: true, branch: '', changed: [], remotes: [], commits: [], hasMore: false };
  try {
    const status = await git(p, ['status', '--porcelain=v1', '-b']);
    const lines = status.split('\n').filter(Boolean);
    // "## main...origin/main [ahead 1]" / "## No commits yet on main" (unborn branch — use its name, not "unknown")
    const head = (lines.find((l) => l.startsWith('## ')) || '').slice(3);
    detail.branch = /No commits yet on (.+)/.exec(head)?.[1] || head.split('...')[0].split(' ')[0];
    if (!detail.branch) detail.branch = 'unknown';
    for (const l of lines.filter((l) => !l.startsWith('## ') && l.length > 3)) {
      detail.changed.push({ x: l[0], y: l[1], path: l.slice(3).replace(/^"|"$/g, '') });
    }
    const remotes = (await git(p, ['remote', '-v'])).split('\n').filter((l) => l.endsWith('(fetch)'));
    for (const l of remotes) {
      const parts = l.split(/\s+/);
      detail.remotes.push({ name: parts[0], url: parts[1] });
    }
    const log = await git(p, ['log', `--pretty=format:%H${SEP}%h${SEP}%aN${SEP}%at${SEP}%s`, '-n', String(commitCount + 1)]);
    const commits = parseLog(log);
    detail.hasMore = commits.length > commitCount;
    detail.commits = commits.slice(0, commitCount);
  } catch (err: any) {
    // Empty repo (no commits yet): status/remote still worked above the throw
    if (!String(err.message).includes('does not have any commits yet') && !String(err.message).includes('unborn')) {
      // Prefer the stderr tail — that's where git writes actionable errors
      // (e.g. "detected dubious ownership in repository at …").
      const stderr = typeof err.stderr === 'string' && err.stderr.trim() ? err.stderr.trim() : String(err.message);
      return { error: `git failed: ${stderr}`, status: 500 };
    }
  }
  return { data: detail };
}

/** Nearest enclosing git root for a path (or null) */
function repoRootFor(p: string): string | null {
  let cur = isDir(p) ? p : p.slice(0, p.lastIndexOf('/')) || '/';
  while (cur !== '/' && cur !== '.') {
    if (isGitRepo(cur)) return cur;
    cur = cur.slice(0, cur.lastIndexOf('/')) || '/';
  }
  return null;
}

const LOG_FMT = `--pretty=format:%H${SEP}%h${SEP}%aN${SEP}%at${SEP}%s`;

/** Commit history for a single file (max ~100). */
export async function fileLog(user: string, path: string): Promise<BrowseResult<Commit[]>> {
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  const checked = validateRepoRoot(user, t.abs);
  if ('error' in checked) return checked;
  const root = checked.data.root;
  try {
    const out = await git(root, ['log', '--follow', '-n', '100', LOG_FMT, '--', t.abs]);
    return { data: parseLog(out) };
  } catch (err: any) {
    if (/does not have any commits|unknown revision|unmerged/.test(err.message)) return { data: [] };
    return { error: `git log failed: ${err.message}`, status: 500 };
  }
}

export async function initRepo(user: string, path: string, remote: unknown): Promise<BrowseResult<{ initialized: true }>> {
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  if (t.access !== 'rw') return { error: 'Directory is read-only', status: 403 };
  // Recheck after recursive mkdir, which may follow a changed symlink target.
  if (isGitRepo(t.abs)) return { error: 'Already a git repository', status: 409 };
  try {
    mkdirSync(t.abs, { recursive: true }); // also covers a configured but not-yet-existing folder
    const checked = resolveInRoots(user, t.abs);
    if ('error' in checked || checked.access !== 'rw' || checked.abs !== t.abs) return { error: 'Path changed or escaped its file root', status: 403 };
    await git(t.abs, ['init', '-b', 'main']);
    if (typeof remote === 'string' && remote.trim()) await git(t.abs, ['remote', 'add', 'origin', remote.trim()]);
    return { data: { initialized: true } };
  } catch (err: any) {
    return { error: `git init failed: ${err.message}`, status: 500 };
  }
}

export async function gitList(user: string, path: string): Promise<BrowseResult<DirEntry[]>> {
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  const checked = validateRepoRoot(user, t.abs);
  if ('error' in checked) return checked;
  const abs = t.abs;
  try {
    if (!isDir(abs)) return { error: 'Not a directory', status: 400 };
    return { data: await listDirectoryEntries(abs, 500) };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Listing failed: ${err.message}`, status: 500 };
  }
}

export async function cloneRepo(user: string, path: string, remote: unknown): Promise<BrowseResult<{ cloned: true }>> {
  if (typeof remote !== 'string' || !remote.trim()) return { error: 'Remote URL is required', status: 400 };
  const url = remote.trim();
  // Trust-boundary validation: shell-safe charset, no option injection
  if (!/^[a-zA-Z0-9~._/:@+-]+$/.test(url) || url.startsWith('-')) return { error: 'Invalid remote URL', status: 400 };
  const t = resolveInRoots(user, path);
  if ('error' in t) return t;
  if (t.access !== 'rw') return { error: 'Directory is read-only', status: 403 };
  if (isGitRepo(t.abs)) return { error: 'Already a git repository', status: 409 };
  try {
    if (readdirSync(t.abs).length > 0) return { error: 'Target folder is not empty', status: 400 };
  } catch { /* clones into a fresh dir */ }
  const targetCheck = resolveInRoots(user, t.abs);
  if ('error' in targetCheck || targetCheck.access !== 'rw' || targetCheck.abs !== t.abs) return { error: 'Clone target is outside your writable file roots', status: 403 };
  const parent = t.abs.slice(0, t.abs.lastIndexOf('/')) || '/';
  const checked = resolveInRoots(user, parent);
  if ('error' in checked || checked.access !== 'rw' || checked.abs !== parent) return { error: 'Clone parent is outside your writable file roots', status: 403 };
  try {
    await git(parent, ['clone', url, t.abs]);
    return { data: { cloned: true } };
  } catch (err: any) {
    return { error: `git clone failed: ${err.message}`, status: 500 };
  }
}
