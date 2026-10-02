import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Editor, { loader } from '@monaco-editor/react';
import { renderEditDiff } from './ChatMessage';
// Editor core + Monarch syntax highlighting for all bundled basic languages,
// WITHOUT the semantic language-service contribs (ts/json/css/html) — their
// workers crash in monaco 0.56 (unhandled rejections). Highlighting is
// Monarch-based and runs on the main thread; the base editor worker covers
// the remaining editor services.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { url } from '../base-path';
import { API, API_PREFIX } from '../api-paths';
import { ChangesPage } from './ChangesPage';

// Self-hosted monaco (no CDN). Language workers beyond the base editor
// worker (ts/json/css/html) crash in monaco 0.56's language services
// (unhandled rejections); tokenization/highlighting is Monarch-based and
// runs on the main thread, so editorWorker covers every language.
(self as any).MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};
loader.config({ monaco });

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', java: 'java', json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', hh: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', toml: 'ini', ini: 'ini', properties: 'ini',
};

function langFor(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? LANG_BY_EXT[name.slice(i + 1).toLowerCase()] || 'plaintext' : 'plaintext';
}

interface FileRoot { path: string; access: 'read' | 'rw' }
interface DirEntry { name: string; type: 'file' | 'dir'; size: number; mtime: number }
interface RepoEntry extends FileRoot { isRepo: boolean }
interface Commit { hash: string; short: string; author: string; date: number; subject: string }
interface RepoDetail { root: string; branch: string; changed: { x: string; y: string; path: string }[]; remotes: { name: string; url: string }[]; commits: Commit[]; hasMore: boolean }

interface TreeRow {
  path: string;
  name: string;
  type: 'root' | 'dir' | 'file';
  depth: number;
  access: 'read' | 'rw';
  expanded: boolean;
}

async function api(rel: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(url(rel), opts);
  const d = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (!res.ok || !d.success) throw new Error(d.error || `HTTP ${res.status}`);
  return d.data;
}

const parentDir = (p: string) => p.slice(0, p.lastIndexOf('/')) || p;

// Repositories mode lists through the git scope (configured folders are
// reachable even outside the allowedDirs file roots), Files through browse.
// A plain function taking reposMode as an argument — passing it as a
// component callback would keep the Files-tab value through tab switches
// (FileBrowser is reconciled in place, deps-[] callbacks never re-capture).
const listUrl = (reposMode: boolean | undefined, dir: string) =>
  reposMode ? API.git.list(dir) : API.browse.list(dir);

// Repositories view (reposMode): roots come from the configured git
// folders and the detail pane shows repo status/remotes/log for the root,
// plus a Commits tab per file.
// Deep-link state arrives via props (EditsPage mirrors it to URL query
// params): initialSelected = linked file path, initialDetailRoot = linked
// repo whose detail pane should open. State changes call onParam() so the
// URL tracks navigation (browser back/forward restores it).
const FileBrowser: React.FC<{
  canWrite: boolean;
  changedPaths: string[];
  reposMode?: boolean;
  initialSelected?: string | null;
  initialDetailRoot?: string | null;
  onParam?: (patch: { file?: string | null; repo?: string | null }) => void;
}> = ({ canWrite, changedPaths, reposMode, initialSelected, initialDetailRoot, onParam }) => {
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const rootIsRepo = useMemo(
    () => new Map(reposMode ? (roots as RepoEntry[]).map((r) => [r.path, r.isRepo]) : []),
    [roots, reposMode],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState<string | null>(null); // null = no file open
  const [readInfo, setReadInfo] = useState<{ binary: boolean; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Repositories view: detail pane state. Root click → repo detail + folder
  // opens; file click → editor + Commits tabs.
  const [detailRoot, setDetailRoot] = useState<string | null>(null);
  const [repoDetail, setRepoDetail] = useState<RepoDetail | null>(null);
  // repo root → worktree changes (fetched on view load, refreshed when stale;
  // lastFetched ref guards the 30s cache without re-renders)
  const [rootStatus, setRootStatus] = useState<Map<string, RepoDetail['changed']>>(new Map());
  const statusFetchedAt = useRef<Map<string, number>>(new Map());
  const [repoError, setRepoError] = useState<string | null>(null);
  const [logCount, setLogCount] = useState(10);
  const [fileCommits, setFileCommits] = useState<Commit[] | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'editor' | 'commits' | 'diff'>('editor');

  const loadRepoDetail = useCallback(async (root: string, count: number) => {
    setDetailRoot(root);
    setLogCount(count);
    setRepoError(null);
    try {
      const d = await api(`${API.git.detail(root)}&count=${count}`);
      setRepoDetail(d);
      statusFetchedAt.current.set(root, Date.now());
      setRootStatus((prev) => new Map(prev).set(root, d.changed || []));
    } catch (e: any) {
      setRepoDetail(null);
      setRepoError(e.message);
    }
  }, []);

  // Non-repo root selected → offer clone/init actions (control users only)
  const runRepoAction = useCallback(async (root: string, action: 'clone' | 'init', remote: string) => {
    setRepoError(null);
    try {
      await api(`${API_PREFIX}/git/repos/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: root, remote: remote || undefined }),
      });
      setRoots((prev) => prev.map((r) => (r.path === root ? { ...r, isRepo: true } : r)));
      await loadRepoDetail(root, 10);
    } catch (e: any) {
      setRepoError(e.message);
    }
  }, [loadRepoDetail]);

  // Fetch worktree status for the given repo roots in the background; entries
  // newer than STATUS_TTL are skipped unless force. Trees show change markers
  // from the moment the Repositories view loads.
  const STATUS_TTL = 30_000;
  const refreshStatuses = useCallback((rootsToFetch: string[], force = false) => {
    const now = Date.now();
    for (const root of rootsToFetch) {
      if (!force && now - (statusFetchedAt.current.get(root) ?? 0) < STATUS_TTL) continue;
      statusFetchedAt.current.set(root, now);
      api(`${API.git.detail(root)}&count=1`)
        .then((d: RepoDetail) => setRootStatus((prev) => new Map(prev).set(root, d.changed || [])))
        .catch(() => {
          statusFetchedAt.current.delete(root);
          setRootStatus((prev) => { const n = new Map(prev); n.delete(root); return n; });
        });
    }
  }, []);

  useEffect(() => {
    const src = reposMode ? API.git.repos : API.browse.roots;
    api(src).then((r) => {
      setRoots(r);
      if (reposMode) refreshStatuses(r.filter((x: RepoEntry) => x.isRepo).map((x: RepoEntry) => x.path));
      // Auto-expand the sole fallback root ($HOME) so the tree isn't empty
      if (r.length === 1 && !initialSelected) toggleDir(r[0].path);
      // Deep link: expand the ancestors of the linked file/repo so the tree
      // is open at the linked spot, not the collapsed initial state.
      const target = initialSelected || initialDetailRoot || null;
      if (target) {
        const root = r.find((x: FileRoot) => target === x.path || target.startsWith(x.path + '/'));
        if (root) {
          const segs = target.slice(root.path.length).split('/').filter(Boolean);
          const expandedSet = new Set<string>([root.path]);
          const dirs = [root.path];
          for (let k = 1; k < segs.length; k++) {
            const p = `${root.path}/${segs.slice(0, k).join('/')}`;
            expandedSet.add(p);
            dirs.push(p);
          }
          setExpanded(expandedSet);
          dirs.forEach(loadDir);
        } else {
          // Linked path's root vanished — fall back to the default state
          onParam?.({ file: null, repo: null });
        }
      }
    }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reposMode]);

  // Deep-link restore: once roots are loaded, open the linked file / repo.
  // One-shot — later state changes are user navigation.
  const restoredRef = useRef(false);
  useEffect(() => {
    const pending = (initialSelected || initialDetailRoot) && roots.length > 0;
    if (!pending || restoredRef.current) return;
    restoredRef.current = true;
    if (reposMode && initialDetailRoot && rootIsRepo.get(initialDetailRoot)) {
      openRepoStatus(initialDetailRoot, true);
    }
    if (initialSelected) {
      (reposMode ? openFileInRepo : openFile)(initialSelected, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, reposMode]);

  const loadDir = useCallback(async (dir: string) => {
    try {
      const list = await api(listUrl(reposMode, dir));
      setChildren((prev) => new Map(prev).set(dir, list));
    } catch (e: any) {
      // Surface load failures on the directory row itself
      setChildren((prev) => new Map(prev).set(dir, [{ name: `⚠ ${e.message}`, type: 'file', size: 0, mtime: 0 }]));
    }
  }, [reposMode]); // reposMode flips without a remount (in-place reconcile) — must re-capture

  const toggleDir = useCallback((dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    loadDir(dir); // refresh on every expand — tree always shows current state
  }, [loadDir]);

  const accessFor = useCallback((p: string): 'read' | 'rw' => {
    let best: FileRoot | null = null;
    for (const r of roots) {
      if ((p === r.path || p.startsWith(r.path + '/')) && (!best || r.path.length > best.path.length)) best = r;
    }
    return best?.access ?? 'read';
  }, [roots]);

  const openFile = useCallback(async (p: string, isRestore = false) => {
    setSelected(p);
    setError(null);
    setRepoDetail(null);
    setDetailRoot(null);
    setFileCommits(null);
    setDetailTab('editor');
    try {
      const d = await api(API.browse.read(p));
      setReadInfo({ binary: d.binary, truncated: d.truncated });
      setContent(d.binary ? '' : d.content);
      setBaseline(d.binary ? '' : d.content);
      onParam?.({ file: p, repo: null });
    } catch (e: any) {
      // Missing file (stale deep link or deleted after opening): fall back
      // to the default state instead of a dead selection.
      if (isRestore || /\b404\b|ENOENT/i.test(e.message)) {
        setSelected(null);
        setBaseline(null);
        setContent('');
        setReadInfo(null);
        onParam?.({ file: null, repo: null });
      }
      if (!isRestore) setError(e.message);
      setBaseline(null);
    }
    // Opening a file counts as repo interaction — refresh its repo's status
    // in the background if the cache is stale
    const root = roots.find((r) => p === r.path || p.startsWith(r.path + '/'));
    if (reposMode && root) refreshStatuses([root.path]);
  }, [reposMode, roots, refreshStatuses, onParam]);

  // Git status (repositories view): full absolute path → 'modified'|'removed'|'created'
  // from the worktree status letter. Ancestor dirs inherit the status of their
  // contents so a collapsed folder still marks the tree.
  const rootsFrom = (p: string): string[] => {
    const out: string[] = [];
    for (const root of statusMap.keys()) {
      let dir = p.slice(0, p.lastIndexOf('/'));
      while (dir.length >= root.length && dir.startsWith(root)) {
        out.push(dir);
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
    }
    return out;
  };

  // Tree status markers: background-fetched status for every configured repo
  // (refreshed on demand, e.g. after save/delete), plus the open detail pane's
  // fresher copy. Root rows are repos, so paths are repo-root-prefixed.
  const statusMap = useMemo(() => {
    const m = new Map<string, RepoDetail['changed']>();
    for (const [root, chs] of rootStatus) m.set(root, chs);
    if (repoDetail && rootStatus.get(repoDetail.root) !== repoDetail.changed) m.set(repoDetail.root, repoDetail.changed);
    return m;
  }, [rootStatus, repoDetail]);

  const changeStatus = useMemo(() => {
    const m = new Map<string, string>();
    const kind = (ch: { x: string; y: string }) => {
      const c = ch.y === ' ' ? ch.x : ch.y;
      if (c === 'D') return 'removed';
      if (c === 'A' || c === '?') return 'created';
      return 'modified';
    };
    for (const [root, changed] of statusMap) {
      for (const ch of changed) {
        const p = `${root}/${ch.path}`;
        m.set(p, kind(ch));
        for (const dir of rootsFrom(p)) if (!m.has(dir)) m.set(dir, kind(ch));
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusMap]);

  // A file changed under a repo → refresh that repo's tree markers (force:
  // the change is known to be new, bypass the TTL). No arg = all repo roots.
  const queueStatusReload = useCallback((root?: string) => {
    refreshStatuses(root ? [root] : roots.filter((r) => (r as RepoEntry).isRepo).map((r) => r.path), true);
  }, [roots, refreshStatuses]);

  const gitStatusFor = useCallback((rowPath: string) => {
    return changeStatus.get(rowPath) || null;
  }, [changeStatus]);

  // Repositories view: file click → editor + Diff (changed files) + Commits
  const openFileInRepo = useCallback(async (p: string, isRestore = false) => {
    const changed = gitStatusFor(p) !== null;
    setDetailTab('editor');
    setDiffText(null);
    openFile(p, isRestore);
    if (changed) {
      // Changed file → the Diff tab becomes the default view
      setDetailTab('diff');
      try { const d = (await api(API.git.diff(p))).diff; setDiffText(typeof d === 'string' ? d : null); } catch { setDiffText(null); }
    }
    try {
      setFileCommits(await api(API.git.commits(p)));
    } catch (e: any) {
      setFileCommits([]);
      setError(e.message);
    }
  }, [openFile, gitStatusFor]);

  const toggleRoot = useCallback((root: string) => {
    // Root click = plain expand/collapse (repo details live behind a
    // dedicated Status button so browsing the tree never hijacks the pane)
    // Refresh that repo's markers too — if the view-onload status fetch
    // failed transiently, expansion is the natural recovery point.
    if (rootIsRepo.get(root)) refreshStatuses([root]);
    setSelected(null);
    setBaseline(null);
    setReadInfo(null);
    setFileCommits(null);
    setDiffText(null);
    setDetailTab('editor');
    toggleDir(root);
  }, [toggleDir, rootIsRepo, refreshStatuses]);

  // Info button: open the repo details pane; refresh its status in the
  // background if the cache is older than the TTL
  const openRepoStatus = useCallback((root: string, isRestore = false) => {
    refreshStatuses([root]);
    setSelected(null);
    setBaseline(null);
    setReadInfo(null);
    setFileCommits(null);
    setDiffText(null);
    setDetailTab('editor');
    if (rootIsRepo.get(root)) loadRepoDetail(root, 10);
    else { setDetailRoot(root); setRepoDetail(null); setRepoError(null); }
    if (!isRestore) onParam?.({ file: null, repo: root });
    // A linked repo that no longer exists just falls back: detail pane shows
    // the clone/init offer which is harmless for a vanished root.
  }, [rootIsRepo, loadRepoDetail, refreshStatuses, onParam]);

  // Deep-link restore: once roots are loaded, open the linked file / repo.

  // True while a repo pane (details or clone/init actions) owns the content area
  const showRepoPane = reposMode && !!detailRoot && (rootIsRepo.get(detailRoot) ? !!repoDetail : true);

  const refreshDir = useCallback((dir: string) => {
    setChildren((prev) => {
      const next = new Map(prev);
      next.delete(dir);
      return next;
    });
    loadDir(dir);
    // A file changed under a repo → that repo's tree markers need a refresh
    if (reposMode) {
      const root = roots.find((r) => dir === r.path || dir.startsWith(r.path + '/'));
      if (root) queueStatusReload(root.path);
    }
  }, [loadDir, reposMode, roots, queueStatusReload]);

  const dirty = baseline !== null && content !== baseline;

  const save = useCallback(async () => {
    if (!selected || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api(API.browse.write, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selected, content }) });
      setBaseline(content);
      refreshDir(parentDir(selected));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [selected, dirty, saving, content, refreshDir]);

  const remove = useCallback(async () => {
    if (!selected || saving) return;
    if (!window.confirm(`Delete file ${selected}?`)) return;
    setSaving(true);
    setError(null);
    try {
      await api(API.browse.remove(selected), { method: 'DELETE' });
      refreshDir(parentDir(selected));
      setSelected(null);
      setBaseline(null);
      setContent('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [selected, saving, refreshDir]);

  const createFile = useCallback(async () => {
    const dir = selected ? parentDir(selected) : roots[0]?.path;
    if (!dir) return;
    const name = window.prompt(`New file name (in ${dir})`);
    if (!name) return;
    const p = name.startsWith('/') ? name : `${dir}/${name}`;
    try {
      const existing = await api(API.browse.read(p));
      // Already exists — just open it
      setReadInfo({ binary: existing.binary, truncated: existing.truncated });
      setSelected(p);
      setContent(existing.content);
      setBaseline(existing.content);
    } catch {
      // New file: empty buffer, created on save
      setSelected(p);
      setReadInfo(null);
      setContent('');
      setBaseline('');
    }
  }, [selected, roots]);

  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    for (const r of roots) {
      out.push({ path: r.path, name: r.path, type: 'root', depth: 0, access: r.access, expanded: expanded.has(r.path) });
      const walk = (dir: string, depth: number) => {
        for (const e of children.get(dir) || []) {
          const p = `${dir}/${e.name}`;
          const isDir = e.type === 'dir';
          out.push({ path: p, name: e.name, type: isDir ? 'dir' : 'file', depth, access: accessFor(p), expanded: isDir && expanded.has(p) });
          if (isDir && expanded.has(p)) walk(p, depth + 1);
        }
      };
      // Root rows only render their children while expanded — an unguarded
      // walk() here made the top-level repository impossible to collapse.
      if (expanded.has(r.path)) walk(r.path, 1);
    }
    return out;
  }, [roots, children, expanded, accessFor]);

  const selAccess = selected ? accessFor(selected) : 'read';
  const editable = canWrite && selAccess === 'rw';

  // Search: parallel BFS from the roots. Plain query → name substring hits;
  // trailing-slash query ('autere/', 'autere/code/') → every folder whose
  // path ends with those segments is matched and its ENTIRE subtree is shown.
  // Matches render as a flat tree with their full ancestor chain, streaming in
  // progressively while the walk runs. Bounded (CAP dirs, node_modules/.git
  // pruned) — ponytail: a background indexer per root would remove the cap.
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Set<string> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selfMatches, setSelfMatches] = useState<Set<string>>(new Set()); // own-name hits (highlighted)
  const [searchDirs, setSearchDirs] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!search.trim()) { setMatches(null); setSearchDirs(new Set()); setScanning(false); return; }
    // New query: clear stale results, mark the walk as running right away —
    // "No matches" only shows once the walk completes with zero hits.
    setMatches(new Set());
    setSelfMatches(new Set());
    setScanning(true);
    const raw = search.toLowerCase();
    const dirMode = raw.endsWith('/');
    const qd = dirMode ? raw.replace(/\/+$/, '') : '';
    let alive = true;
    const t = setTimeout(async () => {
      if (dirMode && !qd) { setMatches(null); return; }
      const found = new Set<string>();
      const selfHits = new Set<string>();
      const matchedDirs = new Set<string>();
      const dirs = new Set<string>();
      let visited = 0, running = 0;
      const CONC = 8, CAP = 10000;
      const isDirMatch = (p: string) => p.toLowerCase() === qd || p.toLowerCase().endsWith('/' + qd);
      const queue: string[] = roots.map((r) => r.path);
      await new Promise<void>((resolve) => {
        const pump = () => {
          if (running === 0 && (queue.length === 0 || visited >= CAP)) return resolve();
          while (running < CONC && queue.length > 0 && visited < CAP) {
            const dir = queue.shift()!;
            visited++; running++;
            fetchDir(dir);
          }
        };
        const fetchDir = async (dir: string) => {
          let list: DirEntry[] = [];
          try { list = await api(listUrl(reposMode, dir)); } catch { /* unreadable dir — skip */ }
          if (alive) {
            // Stash listings so the normal tree benefits from the walk too
            setChildren((prev) => new Map(prev).set(dir, list));
            let inherit = false;
            if (dirMode && (matchedDirs.has(dir) || isDirMatch(dir))) {
              matchedDirs.add(dir); found.add(dir); selfHits.add(dir); inherit = true;
            }
            for (const e of list) {
              const p = `${dir}/${e.name}`;
              const nameHit = !dirMode && e.name.toLowerCase().includes(raw);
              if (inherit || nameHit) found.add(p);
              if (nameHit) selfHits.add(p);
              // Prune the heavy, low-signal dirs that would eat the whole cap
              if (e.type === 'dir') {
                if (inherit) matchedDirs.add(p);
                if (e.name !== 'node_modules' && e.name !== '.git') queue.push(p);
              }
            }
            dirs.add(dir);
            setSearchDirs(new Set([...dirs, ...matchedDirs]));
            setMatches(new Set(found));
            setSelfMatches(selfHits);
          }
          running--;
          pump();
        };
        pump();
      });
      if (alive) setScanning(false);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [search, roots, reposMode]);

  // Search rows: every match plus all of its ancestors, depth sorted
  const searchRows = useMemo<TreeRow[] | null>(() => {
    if (matches === null) return null;
    const out: TreeRow[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      const root = roots.find((r) => m === r.path || m.startsWith(r.path + '/'));
      if (!root) continue;
      const segs = m.slice(root.path.length).split('/').filter(Boolean);
      for (let k = 0; k <= segs.length; k++) {
        const p = k === 0 ? root.path : `${root.path}/${segs.slice(0, k).join('/')}`;
        if (seen.has(p)) continue;
        seen.add(p);
        const isLeaf = k === segs.length;
        out.push({
          path: p,
          name: p === root.path ? p : p.slice(p.lastIndexOf('/') + 1),
          type: p === root.path ? 'root' : !isLeaf || searchDirs.has(m) ? 'dir' : 'file',
          depth: k,
          access: accessFor(p),
          expanded: true,
        });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }, [matches, searchDirs, roots, accessFor]);

  // Session-change paths are recorded relative to the agent cwd → match by suffix
  const modified = useMemo(() => new Set(changedPaths), [changedPaths]);
  const isModified = useCallback(
    (rowPath: string) => modified.has(rowPath) || Array.from(modified).some((p) => rowPath.endsWith(`/${p.replace(/^\//, '')}`)),
    [modified],
  );



  const searching = matches !== null;
  const viewRows = searchRows ?? rows;

  return (
    <>
      <div className="files-tree">
        {/* Reuses the changes bar styles — identical search chrome */}
        <div className="changes-files-bar">
          <input
            className="changes-search files-search"
            type="text"
            placeholder="Search.."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {scanning ? <span className="search-scan" /> : searching && matches!.size > 0 && <span className="changes-count">{matches!.size}</span>}
        </div>
        <div className="files-tree-list">
          {roots.length === 0 && !searching && !error && (
            <div className="files-empty-sm">{reposMode ? 'No repository folders configured — add them in Settings → Files → Repositories' : 'Loading…'}</div>
          )}
          {viewRows.length === 0 && searching && !scanning && <div className="files-empty-sm">No matches</div>}
          {viewRows.map((r) => (
            <div
              key={r.path}
              className={`files-row files-${r.type}${selected === r.path ? ' selected' : ''}${!reposMode && isModified(r.path) ? ' files-modified' : ''}${searching && selfMatches.has(r.path) ? ' files-matched' : ''}`}
              style={{ paddingLeft: `${0.6 + r.depth * 0.45}rem` }}
              onClick={() => {
                if (r.type === 'file') { (reposMode ? openFileInRepo : openFile)(r.path); return; }
                if (r.type === 'root' && reposMode) { toggleRoot(r.path); return; } // plain expand/collapse
                if (searching) setSearch(''); // searching → jump to it expanded
                toggleDir(r.path);
              }}
            >
            <span className="files-chev">{r.type !== 'file' ? (r.expanded ? '▾' : '▸') : ''}</span>
            <span className={`files-name${gitStatusFor(r.path) ? ` files-git-${gitStatusFor(r.path)}` : ''}`}>{r.name}{!reposMode && isModified(r.path) && <span className="files-mod-dot" title="Modified this session">•</span>}</span>
            {r.type === 'root' && (
              <>
                {/* ReposMode roots: Status opens the details pane (repo details
                    or clone/init offer) without collapsing the tree */}
                {reposMode && rootIsRepo.get(r.path) !== undefined && (
                  <span className="repo-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn repo-row-btn" title={`Show info of ${r.path}`} onClick={() => openRepoStatus(r.path)}>info</button>
                  </span>
                )}
                <span className={`files-access files-access-${r.access}`}>{r.access}</span>
              </>
            )}
            </div>
          ))}
        </div>
      </div>
      <div className="files-main">
        {selected && (
          <div className="files-toolbar">
            <span className="files-path" title={selected}>{selected}{readInfo?.truncated ? ' (truncated)' : ''}</span>
            {!editable && <span className="files-ro">read-only</span>}
            {editable && (
              <>
                <button className="btn files-new" onClick={createFile}>New…</button>
                <button className="btn btn-primary files-save" disabled={!dirty || saving} onClick={save}>Save</button>
                <button className="btn files-delete" disabled={saving} onClick={remove}>Delete</button>
              </>
            )}
          </div>
        )}
        {error && <div className="files-error">{error}</div>}
        {detailRoot && reposMode && !rootIsRepo.get(detailRoot) && (
          <div className="repo-detail">
            <div className="repo-detail-title">{detailRoot}</div>
            {repoError && <div className="files-error">{repoError}</div>}
            {canWrite && (
              <div className="repo-actions">
                <button className="btn" onClick={() => {
                  const remote = window.prompt('Remote URL to clone:') || '';
                  if (remote.trim()) void runRepoAction(detailRoot, 'clone', remote.trim());
                }}>Clone remote…</button>
                <button className="btn" onClick={() => {
                  const remote = window.prompt('Optional remote URL for origin:') || '';
                  void runRepoAction(detailRoot, 'init', remote.trim());
                }}>git init</button>
              </div>
            )}
          </div>
        )}
        {detailRoot && repoDetail && rootIsRepo.get(detailRoot) ? (
          <div className="repo-detail">
            <div className="repo-detail-title">{repoDetail.root}</div>
            <div className="repo-meta">
              <span className="repo-branch" title="Current branch">⎇ {repoDetail.branch || 'no commits'}</span>
              <span className="repo-count" title="Uncommitted changes">{repoDetail.changed.length} changed</span>
            </div>
            <div className="repo-section">
              <div className="repo-section-title">Status</div>
              {repoDetail.changed.length === 0 ? (
                <div className="repo-remote-empty">Working tree clean</div>
              ) : (
                <div className="repo-status-list">
                  {repoDetail.changed.map((ch, i) => {
                    const c = ch.y === ' ' ? ch.x : ch.y;
                    const kind = c === 'D' ? 'removed' : (c === 'A' || c === '?') ? 'created' : 'modified';
                    return (
                      <div key={`${ch.path}-${i}`} className={`repo-status-row repo-status-${kind}`} title={`${ch.x}${ch.y} — ${ch.path}`}>{ch.path}</div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="repo-section">
              <div className="repo-section-title">Remotes</div>
              {repoDetail.remotes.length === 0 ? (
                <div className="repo-remote-empty">No remotes</div>
              ) : (
                repoDetail.remotes.map((r) => (
                  <div key={r.name} className="repo-remote-row" title={r.url}><b>{r.name}</b> {r.url}</div>
                ))
              )}
            </div>
            <div className="repo-section repo-log">
              <div className="repo-section-title">History</div>
              {repoDetail.commits.map((cm) => (
                <div key={cm.hash} className="repo-commit-row" title={`${cm.hash} — ${cm.author}`}>
                  <span className="repo-commit-hash">{cm.short}</span>
                  <span className="repo-commit-subject">{cm.subject}</span>
                  <span className="repo-commit-date">{new Date(cm.date).toLocaleDateString()}</span>
                </div>
              ))}
              {repoDetail.commits.length === 0 && <div className="repo-remote-empty">No commits yet</div>}
              {repoError && <div className="files-ro">{repoError}</div>}
              {repoDetail.hasMore && (
                <button className="btn repo-load-more" onClick={() => loadRepoDetail(detailRoot, logCount + 10)}>Load more</button>
              )}
            </div>
          </div>
        ) : null}
        {selected && fileCommits !== null && reposMode && (
          <div className="files-detail-tabs">
            <button className={detailTab === 'editor' ? 'active' : ''} onClick={() => setDetailTab('editor')}>Editor</button>
            {diffText !== null && <button className={detailTab === 'diff' ? 'active' : ''} onClick={() => setDetailTab('diff')}>Diff</button>}
            <button className={detailTab === 'commits' ? 'active' : ''} onClick={() => setDetailTab('commits')}>Commits</button>
          </div>
        )}
        {detailTab === 'commits' && fileCommits !== null ? (
          <div className="repo-log repo-file-log">
            {fileCommits.length === 0 ? (
              <div className="files-empty">No commits recorded for this file</div>
            ) : fileCommits.map((cm) => (
              <div key={cm.hash} className="repo-commit-row" title={cm.hash}>
                <span className="repo-commit-hash">{cm.short}</span>
                <span className="repo-commit-subject">{cm.subject}</span>
                <span className="repo-commit-date">{new Date(cm.date).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        ) : detailTab === 'diff' && diffText !== null ? (
          <div className="files-editor files-diff-editor">{renderEditDiff(diffText, false, 99999)}</div>
        ) : selected && readInfo?.binary ? (
          <div className="files-empty">Binary file — no preview</div>
        ) : selected && baseline !== null ? (
          <div className="files-editor">
            <Editor
              height="100%"
              language={langFor(selected)}
              value={content}
              theme="vs-dark"
              options={{ readOnly: !editable, minimap: { enabled: false }, fontSize: 10, automaticLayout: true, scrollBeyondLastLine: false, wordWrap: 'on', smoothScrolling: true, scrollbar: { alwaysConsumeMouseWheel: false } }}
              onChange={(v) => setContent(v ?? '')}
              onMount={(ed) => {
                (window as any).__autereEd = ed;
                // automaticLayout's ResizeObserver only fires on size CHANGES
                // after creation; if the flex container laid out after the
                // editor measured it (tab/view switch), the initial size can
                // be 0/5px forever. One manual layout pass fixes that case.
                requestAnimationFrame(() => ed.layout());
              }}
            />
          </div>
        ) : showRepoPane ? (
          error ? <div className="files-error">{error}</div> : null
        ) : (
          <div className="files-empty">{selected ? error || 'No file selected' : 'Select a file to view or edit'}</div>
        )}
      </div>
    </>
  );
};

interface EditsPageProps {
  sessionId: string | null;
  userRole?: string | null;
}

/** Edits view: backend-backed file browser + Monaco editor, plus the
 *  per-session change history under a Session Edits tab.
 *  Deep-linking: the open tab, selected file, repo detail and session-change
 *  selection are mirrored to URL query params ('e','f','r','c') so browser
 *  back/forward restores what was open instead of collapsing to the start. */
export const EditsPage: React.FC<EditsPageProps> = ({ sessionId, userRole }) => {
  const [params, setParams] = useSearchParams();
  const paramTab = params.get('e');
  const [tab, setTab] = useState<'files' | 'repos' | 'changes'>(
    paramTab === 'repos' || paramTab === 'changes' || paramTab === 'files' ? paramTab : 'files',
  );
  const writeParams = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      return next;
    });
  }, [setParams]);
  const selectTab = useCallback((t: 'files' | 'repos' | 'changes') => {
    setTab(t);
    writeParams({ e: t, f: null, r: null, c: null });
  }, [writeParams]);
  const canWrite = userRole === 'control' || userRole === 'admin';
  const [changedPaths, setChangedPaths] = useState<string[]>([]);
  useEffect(() => {
    // Session-modified files → highlighted in the file tree
    if (!sessionId) { setChangedPaths([]); return; }
    fetch(url(API.sessions.fileChanges(sessionId)))
      .then((r) => r.json())
      .then((d: any) => setChangedPaths((d.data ?? []).map((e: any) => e.path).filter(Boolean)))
      .catch(() => setChangedPaths([]));
  }, [sessionId]);
  return (
    <div className="edits-page">
      <div className="edits-tabs">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => selectTab('files')}>Files</button>
        <button className={tab === 'repos' ? 'active' : ''} onClick={() => selectTab('repos')}>Repositories</button>
        <button className={tab === 'changes' ? 'active' : ''} onClick={() => selectTab('changes')}>Session Edits</button>
      </div>
      {tab === 'files' ? (
        <FileBrowser canWrite={canWrite} changedPaths={changedPaths}
          initialSelected={tab === 'files' ? params.get('f') : null}
          onParam={(p) => writeParams({ f: p.file ?? null, r: null })} />
      ) : tab === 'repos' ? (
        <FileBrowser canWrite={canWrite} changedPaths={changedPaths} reposMode
          initialSelected={params.get('f')}
          initialDetailRoot={params.get('r')}
          onParam={(p) => writeParams({ f: p.file ?? null, r: p.repo ?? null })} />
      ) : (
        <ChangesPage sessionId={sessionId} initialFile={params.get('c')} onSelect={(p) => writeParams({ c: p })} />
      )}
    </div>
  );
};
