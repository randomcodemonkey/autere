import React, { useState, useEffect, useMemo, useRef } from 'react';
import { url } from '../base-path';
import { API } from '../api-paths';
import { renderEditDiff } from './ChatMessage';

interface FileChange {
  ts: number;
  path: string;
  tool: string;
  change: string;
  diff: string;
}

interface ChangeTreeRow {
  path: string;
  name: string;
  type: 'root' | 'dir' | 'file';
  depth: number;
  expanded: boolean;
  count?: number;
}

interface ChangeTreeNode {
  path: string;
  name: string;
  type: 'root' | 'dir' | 'file';
  children: Map<string, ChangeTreeNode>;
  count?: number;
}

function buildChangeTreeRows(
  allPaths: string[],
  visiblePaths: string[],
  changesByPath: Map<string, FileChange[]>,
  collapsed: Set<string>,
  forceExpanded: boolean,
): ChangeTreeRow[] {
  if (!allPaths.length || !visiblePaths.length) return [];
  const parsed = allPaths.map((path) => {
    const absolute = path.startsWith('/');
    const parts = path.split('/').filter(Boolean);
    return { path, absolute, parts: absolute ? ['/', ...parts] : parts };
  });
  const dirs = parsed.map(({ parts }) => parts.slice(0, -1));
  let commonLength = 0;
  while (dirs[0][commonLength] && dirs.every((parts) => parts[commonLength] === dirs[0][commonLength])) commonLength++;
  const rootParts = dirs[0].slice(0, commonLength);
  const allAbsolute = parsed.every(({ absolute }) => absolute);
  const rootPath = rootParts.length
    ? rootParts[0] === '/' ? `/${rootParts.slice(1).join('/')}` : rootParts.join('/')
    : allAbsolute ? '/' : '.';
  const root: ChangeTreeNode = { path: rootPath, name: rootPath, type: 'root', children: new Map() };
  const parsedByPath = new Map(parsed.map((entry) => [entry.path, entry]));
  const pathFor = (parts: string[], absolute: boolean) => {
    const joined = parts.filter((part) => part !== '/').join('/');
    return absolute ? `/${joined}` : joined || '.';
  };

  for (const path of visiblePaths) {
    const entry = parsedByPath.get(path);
    if (!entry) continue;
    let parent = root;
    const directories = entry.parts.slice(commonLength, -1);
    let currentParts = rootParts;
    for (const name of directories) {
      currentParts = [...currentParts, name];
      const dirPath = pathFor(currentParts, entry.absolute);
      let dir = parent.children.get(`dir:${dirPath}`);
      if (!dir) {
        dir = { path: dirPath, name, type: 'dir', children: new Map() };
        parent.children.set(`dir:${dirPath}`, dir);
      }
      parent = dir;
    }
    const name = entry.parts[entry.parts.length - 1] || path;
    parent.children.set(`file:${path}`, {
      path, name, type: 'file', children: new Map(), count: changesByPath.get(path)?.length || 0,
    });
  }

  const rows: ChangeTreeRow[] = [];
  const visit = (node: ChangeTreeNode, depth: number) => {
    const expanded = node.type !== 'file' && (forceExpanded || !collapsed.has(node.path));
    rows.push({ path: node.path, name: node.name, type: node.type, depth, expanded, count: node.count });
    if (!expanded) return;
    const children = [...node.children.values()].sort((a, b) =>
      Number(a.type === 'file') - Number(b.type === 'file') || a.name.localeCompare(b.name));
    children.forEach((child) => visit(child, depth + 1));
  };
  const roots = [...root.children.values()].sort((a, b) =>
    Number(a.type === 'file') - Number(b.type === 'file') || a.name.localeCompare(b.name));
  if (rootPath === '.' || rootPath === '/') roots.forEach((node) => visit(node, 0));
  else visit(root, 0);
  return rows;
}

interface ChangesPageProps {
  sessionId: string | null;
  /** Deep link: file to open initially (URL ?c=); changes are recorded
   *  per-session so a vanished path simply falls back to the newest file. */
  initialFile?: string | null;
  /** Called on selection changes so EditsPage can mirror to the URL. */
  onSelect?: (path: string | null) => void;
}

export const ChangesPage: React.FC<ChangesPageProps> = ({ sessionId, initialFile, onSelect }) => {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [selectedChange, setSelectedChange] = useState<number | null>(null);
  const modsRef = useRef<HTMLDivElement>(null);

  useEffect(() => setCollapsedDirs(new Set()), [sessionId]);

  // Switching files swaps the diff content under the (persistent) scroll
  // container — a long diff scrolled down left a short diff scrolled out of
  // view. Reset to the top on every selection change.
  useEffect(() => {
    modsRef.current?.scrollTo(0, 0);
  }, [selectedFile]);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    fetch(url(API.sessions.fileChanges(sessionId)))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setChanges(d.data);
          if (d.data.length > 0) {
            // Deep link first: the linked file if it still has changes,
            // otherwise the newest change's file (default state fallback).
            const linked = initialFile ? d.data.find((c: FileChange) => c.path === initialFile) : null;
            setSelectedFile((linked ?? d.data[d.data.length - 1]).path);
          }
        } else setError(d.error || 'Failed to load');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionId, initialFile]);

  // Dedupe: collapse only EXACT duplicate rows (same file/type/timestamp/
  // diff — e.g. a file hit by both the sweep and the explicit-target diff).
  // Everything else is a genuine incremental diff (each entry diffs against
  // the previous state) — collapsing per path+change would silently drop
  // real edits from the session history.
  const deduped = useMemo(() => {
    const seen = new Set<string>();
    const out: FileChange[] = [];
    for (const c of changes) {
      const k = JSON.stringify([c.path, c.change, c.ts, c.tool, c.diff]);
      if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
    return out;
  }, [changes]);

  const filtered = useMemo(() => {
    if (!search.trim()) return deduped;
    const q = search.toLowerCase();
    return deduped.filter(
      (c) =>
        c.path.toLowerCase().includes(q) ||
        c.tool.toLowerCase().includes(q) ||
        c.change.toLowerCase().includes(q)
    );
  }, [deduped, search]);

  const paths = useMemo(() => {
    const seen = new Set<string>();
    return filtered.map((c) => c.path).filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });
  }, [filtered]);
  const allPaths = useMemo(() => [...new Set(deduped.map((c) => c.path))], [deduped]);

  const changesByPath = useMemo(() => {
    const map = new Map<string, FileChange[]>();
    for (const c of filtered) {
      const arr = map.get(c.path) || [];
      arr.push(c);
      map.set(c.path, arr);
    }
    return map;
  }, [filtered]);

  const treeRows = useMemo(
    () => buildChangeTreeRows(allPaths, paths, changesByPath, collapsedDirs, !!search.trim()),
    [allPaths, paths, changesByPath, collapsedDirs, search],
  );

  const fileChanges = useMemo(() => {
    if (!selectedFile) return [];
    return filtered.filter((c) => c.path === selectedFile);
  }, [filtered, selectedFile]);

  // Pre-select the newest change of the selected file
  useEffect(() => {
    if (fileChanges.length > 0) setSelectedChange(fileChanges.length - 1);
    else setSelectedChange(null);
  }, [selectedFile, fileChanges.length]);

  if (!sessionId) {
    return <div className="changes-empty">No session selected</div>;
  }

  return (
    <>
      {/* File list — left card on desktop, capped strip on mobile */}
      <div className="files-tree changes-files">
        <div className="changes-files-bar">
          <input
            className="changes-search files-search"
            type="text"
            placeholder="Search.."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelectedFile(null); }}
          />
          <span className="changes-count">{filtered.length}</span>
        </div>
        <div className="files-tree-list changes-files-list">
          {loading && <div className="changes-loading">Loading…</div>}
          {error && <div className="changes-error">{error}</div>}
          {!loading && !error && paths.length === 0 && (
            <div className="files-empty-sm">
              {changes.length === 0 ? 'No file changes yet' : 'No matches'}
            </div>
          )}
          {treeRows.map((row) => (
            <div
              key={`${row.type}:${row.path}`}
              className={`files-row files-${row.type}${row.type === 'file' && selectedFile === row.path ? ' selected' : ''}`}
              style={{ paddingLeft: `${0.6 + row.depth * 0.45}rem` }}
              title={row.path}
              onClick={() => {
                if (row.type !== 'file') {
                  if (search.trim()) setSearch('');
                  setCollapsedDirs((prev) => {
                    const next = new Set(prev);
                    if (next.has(row.path)) next.delete(row.path);
                    else next.add(row.path);
                    return next;
                  });
                  return;
                }
                const path = selectedFile === row.path ? null : row.path;
                setSelectedFile(path);
                onSelect?.(path);
              }}
            >
              <span className="files-chev">{row.type === 'file' ? '' : row.expanded ? '▾' : '▸'}</span>
              <span className="files-name">{row.name}</span>
              {row.type === 'file' && <span className="changes-file-count">{row.count}</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Change history for the selected file — the selected change's diff is
          shown inline; the newest change is pre-selected. */}
      <div ref={modsRef} className="changes-mods">
        {selectedFile && fileChanges.length > 0 ? (
          fileChanges.map((c, i) => {
            const isSel = i === selectedChange;
            return (
              <div key={i} className={`changes-mod${isSel ? ' selected' : ''}`}>
                <div className="changes-mod-header" onClick={() => setSelectedChange(i)}>
                  <span className={`changes-badge changes-badge-${c.change}`}>{c.change}</span>
                  <span className="changes-mod-tool">{c.tool}</span>
                  <span className="changes-mod-time">{new Date(c.ts).toLocaleTimeString()}</span>
                </div>
                {isSel && (
                  <div className="changes-mod-diff">
                    {renderEditDiff(c.diff, false, 9999)}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="changes-empty changes-empty-detail">
            <div className="changes-empty-icon">📝</div>
            <div>{selectedFile ? 'No changes for this file' : 'Select a file to view its changes'}</div>
          </div>
        )}
      </div>
    </>
  );
};
