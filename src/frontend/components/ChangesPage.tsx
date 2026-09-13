import React, { useState, useEffect, useMemo, useRef } from 'react';
import { url } from '../base-path';
import { renderEditDiff } from './ChatMessage';

interface FileChange {
  ts: number;
  path: string;
  tool: string;
  change: string;
  diff: string;
}

interface ChangesPageProps {
  sessionId: string | null;
}

export const ChangesPage: React.FC<ChangesPageProps> = ({ sessionId }) => {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedChange, setExpandedChange] = useState<number | null>(null);
  const modsRef = useRef<HTMLDivElement>(null);

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
    fetch(url(`/api/sessions/${sessionId}/file-changes`))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setChanges(d.data);
          if (d.data.length > 0) {
            const latest = d.data[d.data.length - 1];
            setSelectedFile(latest.path);
          }
        } else setError(d.error || 'Failed to load');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  // Dedupe: per file+change-type keep only the latest entry (older ones are
  // superseded — e.g. repeated misclassified "created" rows for one file)
  const deduped = useMemo(() => {
    const byKey = new Map<string, FileChange>();
    for (const c of changes) byKey.set(`${c.path}\n${c.change}`, c);
    return [...byKey.values()].sort((a, b) => a.ts - b.ts);
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

  const changesByPath = useMemo(() => {
    const map = new Map<string, FileChange[]>();
    for (const c of filtered) {
      const arr = map.get(c.path) || [];
      arr.push(c);
      map.set(c.path, arr);
    }
    return map;
  }, [filtered]);

  const fileChanges = useMemo(() => {
    if (!selectedFile) return [];
    return filtered.filter((c) => c.path === selectedFile);
  }, [filtered, selectedFile]);

  // Auto-expand latest change when file selection changes
  useEffect(() => {
    if (fileChanges.length > 0) setExpandedChange(fileChanges.length - 1);
    else setExpandedChange(null);
  }, [selectedFile, fileChanges.length]);

  if (!sessionId) {
    return <div className="changes-empty">No session selected</div>;
  }

  return (
    <div className={`changes-page${selectedFile ? '' : ' no-selection'}`}>
      {/* File browser — capped height, scrollable */}
      <div className="changes-files">
        <div className="changes-files-bar">
          <input
            className="changes-search"
            type="text"
            placeholder="Search files…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelectedFile(null); }}
          />
          <span className="changes-count">{filtered.length}</span>
        </div>
        <div className="changes-files-list">
          {loading && <div className="changes-loading">Loading…</div>}
          {error && <div className="changes-error">{error}</div>}
          {!loading && !error && paths.length === 0 && (
            <div className="changes-empty-sm">
              {changes.length === 0 ? 'No file changes yet' : 'No matches'}
            </div>
          )}
          {paths.map((path) => {
            const count = changesByPath.get(path)!.length;
            return (
              <div
                key={path}
                className={`changes-file${selectedFile === path ? ' selected' : ''}`}
                onClick={() => setSelectedFile(selectedFile === path ? null : path)}
              >
                <span className="changes-file-name">{path}</span>
                {count > 1 && <span className="changes-file-count">{count}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Modifications — fills remaining height, scrollable. Hidden entirely
          when no file is selected: the list then uses the full height. */}
      {selectedFile && (
      <div ref={modsRef} className="changes-mods">
        {selectedFile ? (
          fileChanges.length > 0 ? (
            fileChanges.map((c, i) => {
              const isOpen = expandedChange === i;
              return (
                <div key={i} className={`changes-mod${isOpen ? ' expanded' : ''}`}>
                  <div className="changes-mod-header" onClick={() => setExpandedChange(isOpen ? null : i)}>
                    <span className={`changes-badge changes-badge-${c.change}`}>{c.change}</span>
                    <span className="changes-mod-tool">{c.tool}</span>
                    <span className="changes-mod-time">{new Date(c.ts).toLocaleTimeString()}</span>
                    <span className="changes-mod-chevron">{isOpen ? '▾' : '▸'}</span>
                  </div>
                  {isOpen && (
                    <div className="changes-mod-diff">
                      {renderEditDiff(c.diff, false, 9999)}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="changes-empty">No changes for this file</div>
          )
        ) : (
          <div className="changes-empty changes-empty-detail">
            <div className="changes-empty-icon">📝</div>
            <div>No changes for this file</div>
          </div>
        )}
      </div>
      )}
    </div>
  );
};
