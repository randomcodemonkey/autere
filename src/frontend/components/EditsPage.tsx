import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
// Editor core + Monarch syntax highlighting for all bundled basic languages,
// WITHOUT the semantic language-service contribs (ts/json/css/html) — their
// workers crash in monaco 0.56 (unhandled rejections). Highlighting is
// Monarch-based and runs on the main thread; the base editor worker covers
// the remaining editor services.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { url } from '../base-path';
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

// ── Files tab: lazy file tree + Monaco viewer/editor ──
const FileBrowser: React.FC<{ canWrite: boolean; changedPaths: string[] }> = ({ canWrite, changedPaths }) => {
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState<string | null>(null); // null = no file open
  const [readInfo, setReadInfo] = useState<{ binary: boolean; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/api/browse/roots').then((r) => {
      setRoots(r);
      // Auto-expand the sole fallback root ($HOME) so the tree isn't empty
      if (r.length === 1) toggleDir(r[0].path);
    }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDir = useCallback(async (dir: string) => {
    try {
      const list = await api(`/api/browse/list?path=${encodeURIComponent(dir)}`);
      setChildren((prev) => new Map(prev).set(dir, list));
    } catch (e: any) {
      // Surface load failures on the directory row itself
      setChildren((prev) => new Map(prev).set(dir, [{ name: `⚠ ${e.message}`, type: 'file', size: 0, mtime: 0 }]));
    }
  }, []);

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

  const openFile = useCallback(async (p: string) => {
    setSelected(p);
    setError(null);
    try {
      const d = await api(`/api/browse/read?path=${encodeURIComponent(p)}`);
      setReadInfo({ binary: d.binary, truncated: d.truncated });
      setContent(d.binary ? '' : d.content);
      setBaseline(d.binary ? '' : d.content);
    } catch (e: any) {
      setError(e.message);
      setBaseline(null);
    }
  }, []);

  const refreshDir = useCallback((dir: string) => {
    setChildren((prev) => {
      const next = new Map(prev);
      next.delete(dir);
      return next;
    });
    loadDir(dir);
  }, [loadDir]);

  const dirty = baseline !== null && content !== baseline;

  const save = useCallback(async () => {
    if (!selected || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api('/api/browse/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selected, content }) });
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
      await api('/api/browse/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selected }) });
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
      const existing = await api(`/api/browse/read?path=${encodeURIComponent(p)}`);
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
      walk(r.path, 1);
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
    const qName = dirMode ? '' : raw;
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
          try { list = await api(`/api/browse/list?path=${encodeURIComponent(dir)}`); } catch { /* unreadable dir — skip */ }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, roots]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          {roots.length === 0 && !searching && !error && <div className="files-empty-sm">Loading…</div>}
          {viewRows.length === 0 && searching && !scanning && <div className="files-empty-sm">No matches</div>}
          {viewRows.map((r) => (
            <div
              key={r.path}
              className={`files-row files-${r.type}${selected === r.path ? ' selected' : ''}${isModified(r.path) ? ' files-modified' : ''}${searching && selfMatches.has(r.path) ? ' files-matched' : ''}`}
              style={{ paddingLeft: `${0.6 + r.depth * 0.45}rem` }}
              onClick={() => {
                if (r.type === 'file') { openFile(r.path); return; }
                if (searching) setSearch(''); // searching → jump to it expanded
                toggleDir(r.path);
              }}
            >
            <span className="files-chev">{r.type !== 'file' ? (r.expanded ? '▾' : '▸') : ''}</span>
            <span className="files-name">{r.name}{isModified(r.path) && <span className="files-mod-dot" title="Modified this session">•</span>}</span>
            {r.type === 'root' && <span className={`files-access files-access-${r.access}`}>{r.access}</span>}
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
        {selected && readInfo?.binary ? (
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
 *  per-session change history under a Changes tab. */
export const EditsPage: React.FC<EditsPageProps> = ({ sessionId, userRole }) => {
  const [tab, setTab] = useState<'files' | 'changes'>('files');
  const canWrite = userRole === 'control' || userRole === 'admin';
  const [changedPaths, setChangedPaths] = useState<string[]>([]);
  useEffect(() => {
    // Session-modified files → highlighted in the file tree
    if (!sessionId) { setChangedPaths([]); return; }
    fetch(url(`/api/sessions/${sessionId}/file-changes`))
      .then((r) => r.json())
      .then((d: any) => setChangedPaths((d.data ?? []).map((e: any) => e.path).filter(Boolean)))
      .catch(() => setChangedPaths([]));
  }, [sessionId]);
  return (
    <div className="edits-page">
      <div className="edits-tabs">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Files</button>
        <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>Changes</button>
      </div>
      {tab === 'files' ? <FileBrowser canWrite={canWrite} changedPaths={changedPaths} /> : <ChangesPage sessionId={sessionId} />}
    </div>
  );
};
