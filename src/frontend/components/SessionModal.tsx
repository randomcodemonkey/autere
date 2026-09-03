import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from './Modal';
import { url } from '../base-path';
import type { SessionSearchResult } from '../types';

interface SessionModalProps {
  open: boolean;
  onClose: () => void;
  statusType: string;
  sessionId: string | null;
  sessionName: string | null;
  compacting: boolean;
  isStreaming: boolean;
  isActive: boolean;
  onAbort: () => void;
  onNewSession: () => void;
  onCompact: () => void;
  onSwitchSession: (sessionId: string) => void;
}

type SearchedSession = SessionSearchResult;

export function formatSessionTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Session management modal: rename, abort/compact/new-session actions and a
 * searchable session list. Search matches session name/id (ranked higher)
 * and session file CONTENT (ranked lower), falling back to last-activity
 * order within the same score. The server does the content search.
 */
export const SessionModal: React.FC<SessionModalProps> = ({
  open, onClose, statusType, sessionId, sessionName,
  compacting, isStreaming, isActive,
  onAbort, onNewSession, onCompact, onSwitchSession,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchedSession[]>([]);
  const [searching, setSearching] = useState(false);
  const [nameInput, setNameInput] = useState(sessionName || '');
  const [nameSaving, setNameSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const searchSeq = useRef(0);

  // Reset per open
  useEffect(() => {
    if (open) {
      setQuery('');
      setNameInput(sessionName || '');
      setConfirmDeleteId(null);
    }
  }, [open, sessionName]);

  // Debounced search — empty query lists all sessions
  useEffect(() => {
    if (!open) return;
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      const q = query.trim();
      const fetchUrl = q.length >= 2
        ? url(`/api/sessions/search?q=${encodeURIComponent(q)}`)
        : url('/api/sessions');
      if (q.length >= 2) setSearching(true);
      fetch(fetchUrl)
        .then((res) => res.json())
        .then((data) => {
          if (seq === searchSeq.current && data.success) {
            setResults(data.data || []);
          }
        })
        .catch(() => {})
        .finally(() => { if (seq === searchSeq.current) setSearching(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open]);

  const handleSetName = useCallback(async () => {
    const name = nameInput.trim();
    if (!sessionId) return;
    setNameSaving(true);
    try {
      await fetch(url('/api/session-name'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch {}
    setNameSaving(false);
  }, [nameInput, sessionId]);

  const handleDeleteSession = useCallback(async (sid: string) => {
    if (confirmDeleteId !== sid) {
      setConfirmDeleteId(sid);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await fetch(url('/api/sessions/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
      setResults((prev) => prev.filter((s) => s.id !== sid));
    } catch {}
  }, [confirmDeleteId]);

  const compactLoading = false;

  return (
    <Modal open={open} onClose={onClose} className="modal-session">
      <div className="modal-header">
        <h3>Sessions</h3>
        <button className="modal-close" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        <div className="session-name-input-row">
          <input
            className="session-name-input"
            type="text"
            placeholder="Session label..."
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSetName(); }}
            disabled={nameSaving}
            maxLength={128}
          />
          <button
            className="session-name-save"
            onClick={handleSetName}
            disabled={nameSaving || nameInput.trim() === (sessionName || '')}
          >
            {nameSaving ? '…' : '✓'}
          </button>
        </div>

        <div className="session-current">
          <div className="session-current-id">{sessionId || '—'}</div>
        </div>

        <div className="btn-group">
          <button
            className="btn btn-abort"
            style={{ display: isStreaming ? 'block' : 'none' }}
            onClick={onAbort}
          >
            ⏹ Abort Operation
          </button>
          <button className="btn btn-compact" onClick={onCompact} disabled={compactLoading || compacting || statusType !== 'connected'}>
            {compacting ? '⏳ Compacting…' : compactLoading ? '⏳ Starting…' : '🗜 Compact Context'}
          </button>
          <button className="btn btn-primary" onClick={onNewSession} disabled={statusType === 'disconnected' || isActive}>
            ✨ New Session
          </button>
        </div>

        <input
          className="session-search-input"
          type="text"
          placeholder="Search sessions by name, id or content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        {results.length === 0 ? (
          <div className="session-empty">{searching ? 'Searching…' : (query.trim().length >= 2 ? 'No matching sessions' : 'No sessions found')}</div>
        ) : (
          <div className="session-list">
            {results.map((session) => {
              const isCurrentSession = session.id === sessionId;
              return (
                <div
                  key={session.id}
                  className={`session-item${isCurrentSession ? ' active' : ''}${!isCurrentSession && isActive ? ' disabled' : ''}`}
                  onClick={() => { if (!isCurrentSession && !isActive) onSwitchSession(session.id); }}
                >
                  <div className="session-item-content">
                    <div className="session-item-header">
                      <span className="session-item-name">{session.sessionName || session.id}</span>
                      <span className="session-item-time">{formatSessionTime(session.lastActivity)}</span>
                    </div>
                    <div className="session-item-id">{session.id}</div>
                    {session.match === 'content' && (
                      <span className="badge info session-match-tag">content match</span>
                    )}
                  </div>
                  {!isCurrentSession && (
                    <button
                      className="session-delete-btn"
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id); }}
                      title={confirmDeleteId === session.id ? 'Click again to confirm' : 'Delete session'}
                    >
                      {confirmDeleteId === session.id ? '❗' : '✕'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
};
