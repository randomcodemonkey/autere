import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from './Modal';
import { url } from '../base-path';
import { uiSessionName } from '../session-name';
import type { SessionSearchResult, Persona } from '../types';

interface SessionViewProps {
  statusType: string;
  sessionId: string | null;
  sessionName: string | null;
  compacting: boolean;
  isStreaming: boolean;
  onAbort: () => void;
  onAbortCompaction: () => void;
  /** Creates the session: chosen persona id (null = none) + form name */
  onNewSession: (personaId: string | null, sessionName: string) => void;
  onSwitchSession: (sessionId: string) => void;
  /** True while a switch request is in flight — blocks further actions */
  switching?: boolean;
}

type SearchedSession = SessionSearchResult;

export function formatSessionTime(ts: number, locale?: string): string {
  if (!ts) return '';
  // Locale-aware relative age, e.g. "now" / "5m ago" (en) / "5 min sitten" (fi-FI).
  // Uses Intl narrow style which keeps the compact "5m ago" look for en.
  try {
    const diffMin = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
    const rtf = new Intl.RelativeTimeFormat(locale || undefined, { numeric: 'auto', style: 'narrow' });
    if (diffMin < 1) return rtf.format(0, 'second');
    if (diffMin < 60) return rtf.format(-diffMin, 'minute');
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return rtf.format(-diffHr, 'hour');
    return rtf.format(-Math.floor(diffHr / 24), 'day');
  } catch {
    return '';
  }
}

/**
 * Session management modal: rename, abort/compact/new-session actions and a
 * searchable session list. Search matches session name/id (ranked higher)
 * and session file CONTENT (ranked lower), falling back to last-activity
 * order within the same score. The server does the content search.
 */
export const SessionView: React.FC<SessionViewProps> = ({
  statusType, sessionId, sessionName,
  compacting, isStreaming,
  onAbort, onAbortCompaction, onNewSession, onSwitchSession,
  switching = false,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchedSession[]>([]);
  const [searching, setSearching] = useState(false);
  const [nameInput, setNameInput] = useState(sessionName || '');
  const [nameSaving, setNameSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personasStatus, setPersonasStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [personaId, setPersonaId] = useState('');
  // 'list' = sessions listing; 'new' = the new-session form
  const [view, setView] = useState<'list' | 'new'>('list');
  const [newNameInput, setNewNameInput] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const searchSeq = useRef(0);

  // Persona choices for the new-session form
  useEffect(() => {
    fetch(url('/api/personas'))
      .then((res) => res.json())
      .then((data) => {
        if (data.success) { setPersonas(data.data || []); setPersonasStatus('ready'); }
        else setPersonasStatus('error');
      })
      .catch(() => setPersonasStatus('error'));
  }, []);

  // Debounced search — empty query lists all sessions
  useEffect(() => {
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
            setLoaded(true);
          }
        })
        .catch(() => {})
        .finally(() => { if (seq === searchSeq.current) setSearching(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const handleSetName = useCallback(async () => {
    const name = nameInput.trim();
    if (!sessionId) return;
    setNameSaving(true);
    try {
      await fetch(url('/api/session-name'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sessionId }),
      });
    } catch {}
    setNameSaving(false);
  }, [nameInput, sessionId]);

  const handleDeleteSession = useCallback(async (sid: string) => {
    if (!window.confirm('Delete this session? It will be moved to deleted-sessions.')) {
      return;
    }
    try {
      await fetch(url('/api/sessions/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
      setResults((prev) => prev.filter((s) => s.id !== sid));
    } catch {}
  }, []);

  const openNewSessionForm = useCallback(() => {
    setNewNameInput(uiSessionName());
    setView('new');
  }, []);

  const createNewSession = useCallback(() => {
    onNewSession(personaId || null, newNameInput.trim());
  }, [onNewSession, personaId, newNameInput]);

  const visibleSessions = activeOnly ? results.filter((s) => s.active || s.streaming) : results;


  const newSessionForm = (
    <>
      <div className="session-new-form">
        <label className="settings-label" htmlFor="session-new-name">Session name</label>
        <input
          id="session-new-name"
          className="settings-input"
          type="text"
          placeholder="Session name..."
          value={newNameInput}
          onChange={(e) => setNewNameInput(e.target.value)}
          maxLength={128}
        />
        <div className="session-persona-row">
          <label className="settings-label" htmlFor="session-persona-select">Persona for new session</label>
          <select
            id="session-persona-select"
            className="settings-input"
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
            disabled={personasStatus !== 'ready' || personas.length === 0}
          >
            {personasStatus === 'loading' && <option value="">Loading personas</option>}
            {personasStatus === 'error' && <option value="">Failed to load personas</option>}
            {personasStatus === 'ready' && (personas.length === 0 ? (
              <option value="">No personas available</option>
            ) : (
              <>
                <option value="">No persona</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </>
            ))}
          </select>
        </div>
      </div>
      <div className="btn-group">
        <button className="btn btn-primary session-create-btn" onClick={createNewSession} disabled={switching}>
          {switching ? '⏳ Creating…' : '✨ Create Session'}
        </button>
      </div>
    </>
  );

  const listBody = (
    <>
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
        {compacting && (
          <button
            className="btn btn-abort"
            onClick={() => { if (window.confirm('Abort the compaction? Progress is discarded; the session stays as it was.')) onAbortCompaction(); }}
          >
            ⏹ Abort Compaction
          </button>
        )}
        <button className="btn btn-primary" onClick={openNewSessionForm} disabled={switching || statusType === 'disconnected'}>
          ✨ New Session
        </button>
      </div>

      <input
        className="session-search-input"
        type="text"
        placeholder="Search sessions by name, id or content…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <label className="session-active-toggle">
        <input
          type="checkbox"
          checked={activeOnly}
          onChange={(e) => setActiveOnly(e.target.checked)}
        />
        Active sessions only
      </label>

      {switching && (
        <div className="session-switching">Switching session…</div>
      )}
      {visibleSessions.length === 0 ? (
        <div className="session-empty">{(searching || !loaded) ? (loaded || searching ? 'Searching…' : 'Loading sessions…') : (activeOnly ? 'No active sessions' : query.trim().length >= 2 ? 'No matching sessions' : 'No sessions found')}</div>
      ) : (
        <div className="session-list">
          {visibleSessions.map((session) => {
            const isCurrentSession = session.id === sessionId;
            return (
              <div
                key={session.id}
                className={`session-item${isCurrentSession ? ' active' : ''}`}
                onClick={() => { if (!isCurrentSession) onSwitchSession(session.id); }}
              >
                <div className="session-item-content">
                  <div className="session-item-header">
                    <span className="session-item-name">
                      {session.sessionName || session.id}
                      {session.streaming && <span className="badge warning session-live-flag" title="Its agent is working right now">working</span>}
                      {!session.streaming && session.active && <span className="session-live-flag" title="pi process running">running</span>}
                    </span>
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
                    title="Delete session"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <div className="card sessions-page">
      <div className="card-header">
        <span className="card-title">Sessions</span>
      </div>
      <div className="modal-body">{listBody}</div>
      {view === 'new' && (
        <Modal open onClose={() => setView('list')} className="modal-session">
          <div className="modal-header">
            <h3>New session</h3>
            <button className="modal-close" onClick={() => setView('list')}>✕</button>
          </div>
          <div className="modal-body">{newSessionForm}</div>
        </Modal>
      )}
    </div>
  );
};
