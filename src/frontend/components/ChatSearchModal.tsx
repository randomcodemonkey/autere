import React, { useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../api-paths';
import { apiJSON } from '../api';
import { getStored, setStored } from '../storage';
import { Modal } from './Modal';

/** Message kinds the user can include in results (mirrors the chat filters). */
const KINDS: { key: string; label: string; roles: string[] }[] = [
  { key: 'assistant', label: 'assistant', roles: ['assistant'] },
  { key: 'user', label: 'user', roles: ['user', 'taskReport'] },
  { key: 'thinking', label: 'thinking', roles: ['thinking'] },
  { key: 'tools', label: 'tools', roles: ['toolCall', 'toolResult'] },
  { key: 'edits', label: 'edits', roles: ['edit'] },
  { key: 'system', label: 'system', roles: ['system'] },
];

const MAX_HITS = 200;
const MIN_QUERY = 2;

interface Hit {
  role: string;
  timestamp?: number;
  snippet: string;
  text?: string;
  truncated?: boolean;
}

/** Chosen kinds survive reloads; only assistant + tools are on by default. */
const KINDS_KEY = 'autere.chatSearchKinds';
const DEFAULT_KINDS: Record<string, boolean> = { assistant: true, user: false, thinking: false, tools: true, edits: false, system: false };

function loadKinds(): Record<string, boolean> {
  try {
    const saved = JSON.parse(getStored(KINDS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      return Object.fromEntries(KINDS.map((k) => [k.key, saved[k.key] === true]));
    }
  } catch { /* corrupt entry: fall through to the defaults */ }
  return { ...DEFAULT_KINDS };
}

interface ChatSearchModalProps {
  open: boolean;
  onClose: () => void;
  sessionId?: string | null;
}

/** Split a snippet on the (case-insensitive) query so the match can be marked. */
function highlight(text: string, query: string): React.ReactNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [text];
  const out: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (;;) {
    const hit = lower.indexOf(q, at);
    if (hit < 0) { out.push(text.slice(at)); break; }
    if (hit > at) out.push(text.slice(at, hit));
    out.push(<mark key={`${hit}-${out.length}`}>{text.slice(hit, hit + q.length)}</mark>);
    at = hit + q.length;
  }
  return out;
}

/**
 * Full-text search inside one session's history. Results come from the
 * backend's whole-session scan (mapped like the chat renders it), so matches
 * older than the loaded window are found too. Capped at 200 hits.
 */
export const ChatSearchModal: React.FC<ChatSearchModalProps> = ({ open, onClose, sessionId }) => {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<Record<string, boolean>>(loadKinds);
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const roles = useMemo(() => KINDS.filter((k) => kinds[k.key]).flatMap((k) => k.roles), [kinds]);
  const rolesKey = roles.join(',');

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Debounced search on query / kind changes; a stale response is dropped.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_QUERY || !sessionId) { setHits([]); setTotal(0); setTruncated(false); setError(''); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      (async () => {
        try {
          const params = new URLSearchParams({ sessionId, q, roles: rolesKey, limit: String(MAX_HITS) });
          const data = await apiJSON(`${API.session.search}?${params}`);
          if (cancelled) return;
          setHits(data?.hits ?? []);
          setTotal(data?.total ?? 0);
          setTruncated(!!data?.truncated);
          setError('');
        } catch (err: any) {
          if (!cancelled) setError(err?.message || 'Search failed');
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); setSearching(false); };
  }, [open, query, rolesKey, sessionId]);

  const toggleKind = (key: string) => setKinds((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    setStored(KINDS_KEY, JSON.stringify(next));
    return next;
  });
  const status = query.trim().length < MIN_QUERY
    ? `Type at least ${MIN_QUERY} characters.`
    : searching
      ? 'Searching…'
      : total === 0
        ? 'No matches.'
        : `${hits.length} of ${total} match${total === 1 ? '' : 'es'}${total > hits.length ? ` (showing the first ${hits.length})` : ''}`;
  const stamp = (ts?: number) => (ts ? new Date(ts).toLocaleString() : '');

  return (
    <Modal open={open} onClose={onClose} className="modal-chat-search">
      <div className="modal-header">
        <h3>Search session</h3>
        <button className="modal-close" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="modal-body chat-search-body">
        <input
          ref={inputRef}
          className="settings-input chat-search-input"
          type="search"
          placeholder="Find text in this session…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chat-search-kinds">
          {KINDS.map((k) => (
            <button
              key={k.key}
              className={`stream-toggle chat-search-kind${kinds[k.key] ? ' active' : ''}`}
              onClick={() => toggleKind(k.key)}
              title={`Include ${k.label} messages in results`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="settings-description chat-search-status" data-total={total}>{status}</div>
        {truncated && (
          <div className="settings-description">This session is very long — only the most recent part was searched.</div>
        )}
        {error && <div className="settings-description" style={{ color: 'var(--c-danger-strong)' }}>{error}</div>}
        <div className="chat-search-results">
          {hits.map((hit, i) => {
            const open = !!expanded[i];
            return (
              <div key={`${hit.timestamp ?? 0}-${i}`} className={`chat-search-hit${open ? ' expanded' : ''}`}>
                <div className="chat-search-hit-meta">
                  <span className={`chat-search-role stream-role-${hit.role}`}>{hit.role}</span>
                  <span className="chat-search-time">{stamp(hit.timestamp)}</span>
                  <button
                    className="chat-search-expand"
                    onClick={() => setExpanded((prev) => ({ ...prev, [i]: !open }))}
                  >
                    {open ? 'show less' : 'show full message'}
                  </button>
                </div>
                <div className={`chat-search-snippet${open ? ' full' : ''}`}>
                  {highlight(open && hit.text ? hit.text : hit.snippet, query)}
                </div>
                {open && hit.truncated && (
                  <div className="settings-description">Message cut at 20000 characters.</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
};
