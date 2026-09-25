/**
 * Git support for the Repositories view.
 *
 * Every path passes through resolveInRoots() first (files.ts) — the same
 * allowedDirs enforcement as the rest of the file browser; never call the
 * helpers below directly from routes with an unvalidated path.
 */

import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import type { DirEntry } from './files.js';
import { resolveInRoots, type FileRoot, type BrowseResult } from './files.js';
import { log } from './logger.js';
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

/** `.git` may be a dir (repo), a file (worktree/submodule) — both count */
export function isGitRepo(p: string): boolean {
  return existsSync(resolve(p, '.git'));
}

/** Unified worktree diff for one file (staged + unstaged; untracked → /dev/null diff) */
export function fileDiff(user: string, path: string): BrowseResult<{ diff: string }> {
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  const root = repoRootFor(t.abs);
  if (!root) return { error: 'Not inside a git repository', status: 400 };
  try {
    let out: string;
    try {
      out = sync(root, ['diff', 'HEAD', '--', t.abs]);
    } catch (e: any) {
      if (!String(e.stderr || e.message).includes("bad revision 'HEAD'")) throw e;
      out = ''; // empty repo — no commits yet, fall through to the untracked path
    }
    if (!out.trim() && !sync(root, ['ls-tree', 'HEAD', '--', t.abs]).trim()) {
      // Untracked (bad-revision repo paths above also land here) → render as
      // an all-add patch. --no-index implies --exit-code (exit 1 = "has
      // differences", still output)
      try {
        out = sync(root, ['diff', '--no-index', '--', '/dev/null', t.abs]);
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

const async = (p: string, args: string[]) =>
  new Promise<string>((res, rej) => execFile('git', ['-C', p, ...args], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) rej(new Error((stderr || err.message).trim()));
    else res(stdout);
  }));

const sync = (p: string, args: string[]) =>
  execFileSync('git', ['-C', p, ...args], { maxBuffer: 8 * 1024 * 1024 }).toString();

// ',' never appears inside git pretty fields we request (hash/author/date
// are comma-free; %s subjects could theoretically contain one, but only the
// subject (position 5+) carries that risk and we only split the first 4).
const SEP = '   |   ';

/** Configured repo folders for the Repositories view — as-is, no searching/filtering */
export function listRepos(user: string): BrowseResult<RepoEntry[]> {
  return { data: resolvedGitRepos(user).map((path) => ({ path, isRepo: isGitRepo(path), access: 'rw' })) };
}

/**
 * Resolve within the user's file roots OR within one of their configured
 * repository folders (a configured repo is the user's explicit grant — it
 * does not have to be inside allowedDirs as well).
 */
export function resolveInRepos(user: string, path: string): { abs: string; access: 'read' | 'rw' } | { error: string; status: number } {
  const t = resolveInRoots(user, path);
  if (!('error' in t)) return t;
  const abs = resolve(path);
  for (const repo of resolvedGitRepos(user)) {
    if (abs === repo || abs.startsWith(repo.endsWith('/') ? repo : repo + '/')) return { abs, access: 'rw' };
  }
  return t;
}

function parseLog(out: string): Commit[] {
  return out.split('\n').filter(Boolean).map((l) => {
    const i1 = l.indexOf(SEP), i2 = l.indexOf(SEP, i1 + SEP.length), i3 = l.indexOf(SEP, i2 + SEP.length), i4 = l.indexOf(SEP, i3 + SEP.length);
    return { hash: l.slice(0, i1), short: l.slice(i1 + SEP.length, i2), author: l.slice(i2 + SEP.length, i3), date: Number(l.slice(i3 + SEP.length, i4)) * 1000, subject: l.slice(i4 + SEP.length) };
  });
}

/** Full repository detail: status, remotes, last N commits. */
export function repoDetail(user: string, path: string, commitCount: number): BrowseResult<RepoDetail> {
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  const p = t.abs;
  if (!isDir(p)) return { error: 'Not a directory', status: 400 };
  if (!isGitRepo(p)) return { error: 'Not a git repository', status: 400 };
  const detail: RepoDetail = { root: p, isRepo: true, branch: '', changed: [], remotes: [], commits: [], hasMore: false };
  try {
    const status = sync(p, ['status', '--porcelain=v1', '-b']);
    const lines = status.split('\n').filter(Boolean);
    // "## main...origin/main [ahead 1]" / "## No commits yet on main" (unborn branch — use its name, not "unknown")
    const head = (lines.find((l) => l.startsWith('## ')) || '').slice(3);
    detail.branch = /No commits yet on (.+)/.exec(head)?.[1] || head.split('...')[0].split(' ')[0];
    if (!detail.branch) detail.branch = 'unknown';
    for (const l of lines.filter((l) => !l.startsWith('## ') && l.length > 3)) {
      detail.changed.push({ x: l[0], y: l[1], path: l.slice(3).replace(/^"|"$/g, '') });
    }
    const remotes = sync(p, ['remote', '-v']).split('\n').filter((l) => l.endsWith('(fetch)'));
    for (const l of remotes) {
      const parts = l.split(/\s+/);
      detail.remotes.push({ name: parts[0], url: parts[1] });
    }
    const log = sync(p, ['log', `--pretty=format:%H${SEP}%h${SEP}%aN${SEP}%at${SEP}%s`, '-n', String(commitCount + 1)]);
    const commits = parseLog(log);
    detail.hasMore = commits.length > commitCount;
    detail.commits = commits.slice(0, commitCount);
  } catch (err: any) {
    // Empty repo (no commits yet): status/remote still worked above the throw
    if (!String(err.message).includes('does not have any commits yet') && !String(err.message).includes('unborn')) {
      return { error: `git failed: ${err.message}`, status: 500 };
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
export function fileLog(user: string, path: string): BrowseResult<Commit[]> {
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  const root = repoRootFor(t.abs);
  if (!root) return { error: 'Not inside a git repository', status: 400 };
  try {
    const out = sync(root, ['log', '--follow', '-n', '100', LOG_FMT, '--', t.abs]);
    return { data: parseLog(out) };
  } catch (err: any) {
    if (/does not have any commits|unknown revision|unmerged/.test(err.message)) return { data: [] };
    return { error: `git log failed: ${err.message}`, status: 500 };
  }
}

export function initRepo(user: string, path: string, remote: unknown): BrowseResult<{ initialized: true }> {
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  if (t.access !== 'rw') return { error: 'Directory is read-only', status: 403 };
  if (isGitRepo(t.abs)) return { error: 'Already a git repository', status: 409 };
  try {
    mkdirSync(t.abs, { recursive: true }); // also covers a configured but not-yet-existing folder
    sync(t.abs, ['init', '-b', 'main']);
    if (typeof remote === 'string' && remote.trim()) sync(t.abs, ['remote', 'add', 'origin', remote.trim()]);
    return { data: { initialized: true } };
  } catch (err: any) {
    return { error: `git init failed: ${err.message}`, status: 500 };
  }
}

export function gitList(user: string, path: string): BrowseResult<DirEntry[]> {
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  const abs = t.abs;
  try {
    if (!isDir(abs)) return { error: 'Not a directory', status: 400 };
    const st = (p: string) => { try { return statSync(p); } catch { return null; } };
    const out: DirEntry[] = [];
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (out.length >= 500) break;
      const s2 = st(abs + '/' + e.name);
      if (!s2) continue;
      out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: s2.size, mtime: s2.mtimeMs });
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { data: out };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { error: 'Not found', status: 404 };
    return { error: `Listing failed: ${err.message}`, status: 500 };
  }
}

export function cloneRepo(user: string, path: string, remote: unknown): BrowseResult<{ cloned: true }> {
  if (typeof remote !== 'string' || !remote.trim()) return { error: 'Remote URL is required', status: 400 };
  const url = remote.trim();
  // Trust-boundary validation: shell-safe charset, no option injection
  if (!/^[a-zA-Z0-9~._\/:@+-]+$/.test(url) || url.startsWith('-')) return { error: 'Invalid remote URL', status: 400 };
  const t = resolveInRepos(user, path);
  if ('error' in t) return t;
  if (t.access !== 'rw') return { error: 'Directory is read-only', status: 403 };
  if (isGitRepo(t.abs)) return { error: 'Already a git repository', status: 409 };
  try {
    if (readdirSync(t.abs).length > 0) return { error: 'Target folder is not empty', status: 400 };
  } catch { /* clones into a fresh dir */ }
  try {
    const parent = t.abs.slice(0, t.abs.lastIndexOf('/')) || '/';
    sync(parent, ['clone', url, t.abs]);
    return { data: { cloned: true } };
  } catch (err: any) {
    return { error: `git clone failed: ${err.message}`, status: 500 };
  }
}
