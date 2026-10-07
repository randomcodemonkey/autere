import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from './Modal';
import { SortableList } from './SortableList';
import { url } from '../base-path';
import { API } from '../api-paths';
import { uiSessionName } from '../session-name';
import type { SessionSearchResult, Persona } from '../types';

/** Navigational guard: WorkdirEditor raises this while it has unsaved
 *  edits; beforeunload and AppPage view switches consult it. */
let workdirsDirty = false;
export function workdirsUnsaved(): boolean { return workdirsDirty; }
export function acknowledgeWorkdirsDirty(): void { workdirsDirty = false; }

async function fetchJson(rel: string): Promise<any> {
  const res = await fetch(url(rel));
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body.data;
}

/** Resolve a workdir input like the backend does: '~/' → $HOME-relative,
 *  absolute kept, bare relative → $HOME/$name (home = the caller's first
 *  browsable root, the admin fallback $HOME). */
function resolveWorkdirClient(raw: string, home: string): string {
  const t = raw.trim();
  if (t.startsWith('~/')) return home.replace(/\/+$/, '') + t.slice(1);
  if (t.startsWith('/')) return t.replace(/\/+$/, '');
  return home.replace(/\/+$/, '') + '/' + t.replace(/\/+$/, '');
}

/** Live availability check for workdir entries, mirrors the backend's
 *  session/node validation (exists + inside allowed roots): entries are
 *  checked against the caller's browsable roots via browse/list. Errors are
 *  per-entry; empty → all valid; null errors → check still in flight.
 *  ponytail: entries hidden by a user File-ignores rule read as missing —
 *  add a stat-style endpoint when that bites. */
function useWorkdirCheck(items: string[]): { errors: string[]; checking: boolean } | null {
  const [state, setState] = useState<{ errors: string[]; checking: boolean } | null>(null);
  const itemsKey = items.join('\u0000');
  useEffect(() => {
    if (!itemsKey) { setState(null); return; }
    let cancelled = false;
    setState({ errors: [], checking: true });
    const timer = setTimeout(() => {
      (async () => {
        const errors: string[] = [];
        try {
          const roots: { path: string; access: string }[] = await fetchJson(API.browse.roots);
          if (!roots?.length) {
            if (itemsKey && !cancelled) setState({ errors: [], checking: false });
            return;
          }
          await Promise.all(itemsKey.split('\u0000').map(async (raw) => {
            if (!raw.trim()) { errors.push('Workdir must not be empty'); return; }
            const home = roots[0].path;
            const abs = resolveWorkdirClient(raw, home);
            const root = roots.find((r) => abs === r.path || abs.startsWith(r.path + '/'));
            if (!root) { errors.push(`${abs} is outside your allowed directories (${roots.map((r) => r.path).join(', ')})`); return; }
            const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
            const name = abs.slice(abs.lastIndexOf('/') + 1);
            try {
              const entries = await fetchJson(`${API.browse.list}?path=${encodeURIComponent(parent)}`);
              const hit = (entries || []).find((e: { name: string; type: string }) => e.name === name);
              if (!hit) errors.push(`${abs} does not exist on the server`);
              else if (hit.type !== 'dir') errors.push(`${abs} is not a directory`);
            } catch {
              // e.g. entry inside an ignore-filtered subtree or a transient
              // fetch failure — leave the final gate to the save/create
              // validation on the backend.
            }
          }));
        } catch { /* roots unavailable — backend validates on save */ }
        if (!cancelled) setState({ errors, checking: false });
      })();
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [itemsKey]);
  return state;
}

interface SessionViewProps {
  statusType: string;
  sessionId: string | null;
  sessionName: string | null;
  compacting: boolean;
  isStreaming: boolean;
  /** Admin-only: show the sandbox workdir field in the new-session form */
  canSetWorkdir?: boolean;
  /** Creates the session: chosen persona id (null = none) + form name + sandbox workdirs + docker.sock opt-in */
  onNewSession: (personaId: string | null, sessionName: string, workdirs?: string[], mountDockerSocket?: boolean) => void;
  onSwitchSession: (sessionId: string) => void;
  /** True while a switch request is in flight — blocks further actions */
  switching?: boolean;
  /** Open directly on the new-session form tab (e.g. chat '/new' command) */
  initialView?: 'new';
  /** Fired once the initialView has been consumed */
  onConsumedInitial?: () => void;
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
  compacting, isStreaming, canSetWorkdir = false,
  onNewSession, onSwitchSession,
  switching = false,
  initialView, onConsumedInitial,
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
  const [view, setView] = useState<'list' | 'new'>(initialView === 'new' ? 'new' : 'list');

  // '/new' request arriving while already mounted (no remount happens)
  useEffect(() => {
    if (initialView === 'new') {
      setView('new');
      onConsumedInitial?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialView]);
  const [newNameInput, setNewNameInput] = useState('');
  const [newWorkdirs, setNewWorkdirs] = useState<string[]>([]);
  const [newMountDockerSocket, setNewMountDockerSocket] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const searchSeq = useRef(0);

  // Persona choices for the new-session form
  useEffect(() => {
    fetch(url(API.personas.root))
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
        ? url(API.sessions.search(q))
        : url(API.sessions.list);
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
      await fetch(url(API.session.name), {
        method: 'PUT',
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
      await fetch(url(API.sessions.item(sid)), { method: 'DELETE' });
      setResults((prev) => prev.filter((s) => s.id !== sid));
    } catch {}
  }, []);

  const openNewSessionForm = useCallback(() => {
    setNewNameInput(uiSessionName());
    setView('new');
  }, []);

  const createNewSession = useCallback(() => {
    onNewSession(personaId || null, newNameInput.trim(), canSetWorkdir ? newWorkdirs : undefined, canSetWorkdir ? newMountDockerSocket : false);
  }, [onNewSession, personaId, newNameInput, newWorkdirs, canSetWorkdir, newMountDockerSocket]);

  const visibleSessions = activeOnly ? results.filter((s) => s.active || s.streaming) : results;


  const newWdCheck = useWorkdirCheck(canSetWorkdir ? newWorkdirs : []);

  const newSessionForm = (() => { 
  const wdCheck = newWdCheck;
  const workdirsInvalid = canSetWorkdir && !!newWorkdirs.length && !!wdCheck?.errors.length;
  return (
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
        {canSetWorkdir && (
          <label className="session-sock-row">
            <input
              type="checkbox"
              checked={newMountDockerSocket}
              onChange={(e) => setNewMountDockerSocket(e.target.checked)}
            />
            <span>Mount host docker.sock into the sandbox</span>
          </label>
        )}
        {canSetWorkdir && newMountDockerSocket && (
          <div className="settings-description users-sock-warning">
            ⚠ Security risk: the docker socket grants root-equivalent access to the host.
          </div>
        )}
        {canSetWorkdir && (
          <div className="settings-field session-workdirs-row">
            <label className="settings-label">Workdirs</label>
            <div className="settings-description">If workdirs are added, a sandboxed session is created. Relative paths resolve from the server's $HOME</div>
            <SortableList
              items={newWorkdirs}
              onChange={setNewWorkdirs}
              placeholder="/home/autere/code/… (or relative to $HOME)"
              addLabel="Add workdir"
            />
            {wdCheck && (wdCheck.checking ? (
              <div className="settings-description">Checking workdirs…</div>
            ) : wdCheck.errors.length ? (
              <div className="settings-description" style={{ color: 'var(--c-danger-strong)' }}>
                {wdCheck.errors.join(' · ')}
              </div>
            ) : null)}
          </div>
        )}
      </div>
      <div className="btn-group">
        <button className="btn btn-primary session-create-btn" onClick={createNewSession} disabled={switching || workdirsInvalid || wdCheck?.checking}>
          {switching ? '⏳ Creating…' : '✨ Create Session'}
        </button>
      </div>
    </>
  );
  })();

  const listBody = (
    <>
      <div className="sessions-section">
        <div className="sessions-section-title">Current session</div>
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

        {canSetWorkdir && (
          <WorkdirEditor
            sessionId={sessionId}
            busy={isStreaming || compacting}
            onSwitching={onSwitchSession}
          />
        )}
      </div>

      <div className="sessions-section">
        <div className="btn-group">
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
      </div>
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

/**
 * Admin-only workdirs editor for the CURRENT session. Loads the session's
 * workdirs from the sessions list, allows edit/add/remove, and PUTs them
 * (backend respawns the sandboxed pi so the mounts take effect).
 */
const WorkdirEditor: React.FC<{
  sessionId: string | null;
  busy: boolean;
  onSwitching: (id: string) => void;
}> = ({ sessionId, busy, onSwitching }) => {
  const [workdirs, setWorkdirs] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);

  // Current session's workdirs from the sessions listing. Until BOTH the
  // session id and the listing are available we stay in the loading state —
  // no blank gap and no premature empty-list.
  useEffect(() => {
    if (!sessionId) return; // wait for the session state to arrive
    let cancelled = false;
    fetch(url(API.sessions.list))
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.success) {
          const cur = (data.data || []).find((s: { id: string }) => s.id === sessionId);
          setWorkdirs(cur?.workdirs || []);
        }
      })
      .catch(() => { if (!cancelled) setWorkdirs([]); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const wdCheck = useWorkdirCheck(workdirs || []);

  // Unsaved-changes guard: browser reload/close warns, and in-app view
  // switches confirm via workdirsUnsaved() in AppPage's handleSetView.
  useEffect(() => {
    if (!dirty) return;
    workdirsDirty = true;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      workdirsDirty = false;
    };
  }, [dirty]);

  const apply = useCallback(() => {
    if (!workdirs || !sessionId) return;
    if (wdCheck?.errors.length || wdCheck?.checking) return;
    setSaving(true);
    setError('');
    fetch(url(API.session.workdirs), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, workdirs }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.success === false) {
          setError(body.error || `Failed (${res.status})`);
        } else {
          setDirty(false);
          // pi respawned — rebind this client view (no-op when same id)
          onSwitching(sessionId);
        }
      })
      .catch(() => setError('Network error'))
      .finally(() => setSaving(false));
  }, [workdirs, sessionId, onSwitching, wdCheck]);

  if (workdirs === null) {
    return (
      <div className="session-workdirs-edit">
        <label className="settings-label">Workdirs (applied at next pi restart — session respawns on save)</label>
        <div className="session-workdirs-loading">Loading workdirs…</div>
      </div>
    );
  }
  const disabled = busy || saving || !dirty || !!wdCheck?.errors.length || !!wdCheck?.checking;

  return (
    <div className="session-workdirs-edit">
      <label className="settings-label">Workdirs (applied at next pi restart — session respawns on save)</label>
      {busy && <span className="settings-description">Session busy — wait for the current turn to finish.</span>}
      <SortableList
        items={workdirs}
        onChange={(items) => { setWorkdirs(items); setDirty(true); }}
        placeholder="/home/autere/code/… (or relative to $HOME)"
        addLabel="Add workdir"
        disabled={busy || saving}
      />
      {wdCheck && (wdCheck.checking ? (
        <div className="settings-description">Checking workdirs…</div>
      ) : wdCheck.errors.length ? (
        <div className="settings-description" style={{ color: 'var(--c-danger-strong)' }}>
          {wdCheck.errors.join(' · ')}
        </div>
      ) : null)}
      {error && <div className="settings-description" style={{ color: 'var(--c-danger-strong)' }}>{error}</div>}
      <div className="btn-group">
        <button className="btn btn-primary session-workdirs-save" onClick={apply} disabled={disabled}>
          {saving ? '⏳ Restarting…' : '💾 Save workdirs'}
        </button>
      </div>
    </div>
  );
};
