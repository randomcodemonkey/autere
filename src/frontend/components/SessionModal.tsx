import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Modal } from './Modal';
import { SortableList } from './SortableList';
import { API } from '../api-paths';
import { uiSessionName } from '../session-name';
import { PinIcon } from './PinIcon';
import type { SessionSearchResult, Persona, AvailableModel } from '../types';
import { apiJSON, apiSend } from '../api';

/** Navigational guard: WorkdirEditor raises this while it has unsaved
 *  edits; beforeunload and AppPage view switches consult it. */
let workdirsDirty = false;
export function workdirsUnsaved(): boolean { return workdirsDirty; }
export function acknowledgeWorkdirsDirty(): void { workdirsDirty = false; }

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
          const roots: { path: string; access: string }[] = await apiJSON(API.browse.roots);
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
              const entries = await apiJSON(API.browse.list(parent));
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
  /** Creates the session: chosen persona id (null = none) + form name + sandbox workdirs + docker.sock opt-in + optional initial model. clearSessionId deletes that session after the new one is bound ("clear" flow) */
  onNewSession: (personaId: string | null, sessionName: string, workdirs?: string[], mountDockerSocket?: boolean, clearSessionId?: string, peers?: string[], model?: { provider: string; modelId: string }) => void;
  onSwitchSession: (sessionId: string) => void;
  pinnedSessionFiles?: string[];
  onTogglePinnedSession?: (session: SessionSearchResult) => void;
  /** True while a switch request is in flight — blocks further actions */
  switching?: boolean;
  /** Open directly on the new-session form tab (e.g. chat '/new' command) */
  initialView?: 'new';
  /** Fired once the initialView has been consumed */
  onConsumedInitial?: () => void;
  /** Scoped model catalog (AUTERE_PROVIDER-filtered) for the provider/model pickers */
  models?: AvailableModel[];
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
  pinnedSessionFiles = [], onTogglePinnedSession,
  switching = false,
  initialView, onConsumedInitial,
  models = [],
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
  const [newProvider, setNewProvider] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newWorkdirs, setNewWorkdirs] = useState<string[]>([]);
  const [newMountDockerSocket, setNewMountDockerSocket] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const searchSeq = useRef(0);
  // Clone modal state — target session + prefilled name/workdirs
  const [cloneTarget, setCloneTarget] = useState<SearchedSession | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloneWorkdirs, setCloneWorkdirs] = useState<string[]>([]);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  // Persona choices for the new-session form
  useEffect(() => {
    apiJSON<any[]>(API.personas.root)
      .then((list) => { setPersonas(list || []); setPersonasStatus('ready'); })
      .catch(() => setPersonasStatus('error'));
  }, []);

  // Debounced search — empty query lists all sessions
  useEffect(() => {
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      const q = query.trim();
      const listPath = q.length >= 2
        ? API.sessions.search(q)
        : API.sessions.list;
      if (q.length >= 2) setSearching(true);
      apiJSON<any[]>(listPath)
        .then((list) => {
          if (seq === searchSeq.current) {
            setResults(list || []);
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
    try { await apiSend(API.session.name, 'PUT', { name, sessionId }); } catch {}
    setNameSaving(false);
  }, [nameInput, sessionId]);

  const handleDeleteSession = useCallback(async (sid: string) => {
    if (!window.confirm('Delete this session? It will be moved to deleted-sessions.')) {
      return;
    }
    try {
      await apiSend(API.sessions.item(sid), 'DELETE');
      setResults((prev) => prev.filter((s) => s.id !== sid));
    } catch {}
  }, []);

  // "Clear": replace the current session with a fresh one that keeps the
  // same name and workdirs. handleNewSession creates + switches to the new
  // session, then deletes the old one once the client is bound to it.
  const handleClearSession = useCallback((session: SearchedSession) => {
    if (!window.confirm(`Clear session "${session.sessionName || session.id}"? A fresh session with the same name and workdirs is created, and this session is deleted.`)) {
      return;
    }
    onNewSession(null, session.sessionName || '', session.workdirs, undefined, session.id);
  }, [onNewSession]);

  // "Clone": modal prefilled with the source's name/workdirs; on confirm
  // pi duplicates the active branch into a new session.
  const openCloneForm = useCallback((session: SearchedSession) => {
    setCloneTarget(session);
    setCloneName(session.sessionName || '');
    setCloneWorkdirs(session.workdirs ? [...session.workdirs] : []);
    setCloneError(null);
  }, []);

  const handleCloneSession = useCallback(async () => {
    if (!cloneTarget) return;
    setCloneBusy(true);
    setCloneError(null);
    try {
      await apiSend(API.sessions.clone(cloneTarget.id), 'POST', {
        sessionName: cloneName.trim(),
        ...(canSetWorkdir && cloneWorkdirs.length ? { workdirs: cloneWorkdirs } : {}),
      });
      setCloneTarget(null);
    } catch (err: any) {
      setCloneError(err.message);
    } finally {
      setCloneBusy(false);
    }
  }, [cloneTarget, cloneName, cloneWorkdirs, canSetWorkdir]);

  // Sessions the new session may message (applied right after creation).
  const [newPeers, setNewPeers] = useState<string[]>([]);
  const [peerCandidates, setPeerCandidates] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (view !== 'new') return;
    let cancelled = false;
    setNewPeers([]);
    apiJSON(API.sessions.list)
      .then((list: any[]) => {
        if (!cancelled) setPeerCandidates((list || []).map((s: any) => ({ id: s.id, name: s.sessionName || s.id })));
      })
      .catch(() => { if (!cancelled) setPeerCandidates([]); });
    return () => { cancelled = true; };
  }, [view]);

  const openNewSessionForm = useCallback(() => {
    setNewNameInput(uiSessionName());
    setView('new');
  }, []);

  // Provider/model pickers: providers come from the scoped catalog (the
  // backend already applied AUTERE_PROVIDER), the pi default model seeds the
  // initial selection. Alphabetical within a provider.
  const providers = useMemo(() => {
    const seen = new Set<string>();
    for (const m of models) if (m.provider) seen.add(m.provider);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [models]);
  const defaultModel = models.find((m) => m.isDefault);
  const selectedProvider = newProvider || defaultModel?.provider || providers[0] || '';
  const providerModels = useMemo(
    () => models
      .filter((m) => m.provider === selectedProvider)
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [models, selectedProvider],
  );
  const selectedModelId = (providerModels.some((m) => m.id === newModelId) ? newModelId : '')
    || (defaultModel?.provider === selectedProvider ? defaultModel.id : '')
    || providerModels[0]?.id
    || '';

  const createNewSession = useCallback(() => {
    const model = selectedProvider && selectedModelId ? { provider: selectedProvider, modelId: selectedModelId } : undefined;
    onNewSession(personaId || null, newNameInput.trim(), canSetWorkdir ? newWorkdirs : undefined, canSetWorkdir ? newMountDockerSocket : false, undefined, newPeers, model);
  }, [onNewSession, personaId, newNameInput, newWorkdirs, canSetWorkdir, newMountDockerSocket, newPeers, selectedProvider, selectedModelId]);

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
        {providers.length > 0 && (
          <div className="session-model-row">
            <div className="settings-field">
              <label className="settings-label" htmlFor="session-provider-select">Provider</label>
              <select
                id="session-provider-select"
                className="settings-input"
                value={selectedProvider}
                onChange={(e) => { setNewProvider(e.target.value); setNewModelId(''); }}
                disabled={providers.length <= 1}
              >
                {providers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="settings-field">
              <label className="settings-label" htmlFor="session-model-select">Model</label>
              <select
                id="session-model-select"
                className="settings-input"
                value={selectedModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                disabled={providerModels.length === 0}
              >
                {providerModels.map((m) => (
                  <option key={`${m.provider}/${m.id}`} value={m.id}>{m.name || m.id}</option>
                ))}
              </select>
            </div>
          </div>
        )}
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
              addButtonVariant="info"
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
        <div className="settings-field session-messaging">
          <label className="settings-label">Messaging</label>
          <div className="settings-description">Sessions this one may message, and be messaged by. Agents can only reach their parent, their own task runs and the sessions paired here.</div>
          <SessionPeerPicker
            candidates={peerCandidates}
            selected={newPeers}
            onToggle={(id, on) => setNewPeers((prev) => (on ? [...new Set([...prev, id])] : prev.filter((p) => p !== id)))}
          />
        </div>
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

        <SessionMessaging sessionId={sessionId} />
      </div>

      <div className="sessions-section">
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
                  {onTogglePinnedSession && (
                    <button
                      type="button"
                      className={`btn btn-default btn-row session-pin-toggle${pinnedSessionFiles.includes(session.sessionFile) ? ' pinned' : ''}`}
                      title={`${pinnedSessionFiles.includes(session.sessionFile) ? 'Unpin' : 'Pin'} session ${session.sessionName || session.id}`}
                      aria-label={`${pinnedSessionFiles.includes(session.sessionFile) ? 'Unpin' : 'Pin'} session ${session.sessionName || session.id}`}
                      aria-pressed={pinnedSessionFiles.includes(session.sessionFile)}
                      onClick={(e) => { e.stopPropagation(); onTogglePinnedSession(session); }}
                    >
                      <PinIcon /> {pinnedSessionFiles.includes(session.sessionFile) ? 'Unpin' : 'Pin'}
                    </button>
                  )}
                  {!isCurrentSession && (
                    <button
                      className="btn btn-danger btn-row session-delete-btn"
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id); }}
                      title="Delete session"
                    >
                      delete
                    </button>
                  )}
                  {isCurrentSession && (
                    <button
                      className="btn btn-warning btn-row session-clear-btn"
                      onClick={(e) => { e.stopPropagation(); handleClearSession(session); }}
                      title="Clear session: start fresh with the same name and workdirs"
                    >
                      clear
                    </button>
                  )}
                  <button
                    className="btn btn-default btn-row session-clone-btn"
                    onClick={(e) => { e.stopPropagation(); openCloneForm(session); }}
                    title="Clone session: copy its history into a new session"
                  >
                    clone
                  </button>
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
        <button className="btn btn-primary sessions-new-btn" onClick={openNewSessionForm} disabled={switching || statusType === 'disconnected'}>
          New Session
        </button>
      </div>
      <div className="sessions-body">{listBody}</div>
      {view === 'new' && (
        <Modal open onClose={() => setView('list')} className="modal-session">
          <div className="modal-header">
            <h3>New session</h3>
            <button className="modal-close" onClick={() => setView('list')}>✕</button>
          </div>
          <div className="modal-body">{newSessionForm}</div>
        </Modal>
      )}
      {cloneTarget && (
        <Modal open onClose={() => { if (!cloneBusy) setCloneTarget(null); }} className="modal-session">
          <div className="modal-header">
            <h3>Clone session</h3>
            <button className="modal-close" onClick={() => { if (!cloneBusy) setCloneTarget(null); }}>✕</button>
          </div>
          <div className="modal-body">
            <div className="session-new-form">
              <div className="settings-description">
                Copies the history of “{cloneTarget.sessionName || cloneTarget.id}” into a new session.
              </div>
              <label className="settings-label" htmlFor="session-clone-name">Session name</label>
              <input
                id="session-clone-name"
                className="settings-input"
                type="text"
                value={cloneName}
                onChange={(e) => setCloneName(e.target.value)}
                maxLength={128}
              />
              {canSetWorkdir && (
                <div className="settings-field session-workdirs-row">
                  <label className="settings-label">Workdirs</label>
                  <SortableList
                    items={cloneWorkdirs}
                    onChange={setCloneWorkdirs}
                    placeholder="/home/autere/code/… (or relative to $HOME)"
                    addLabel="Add workdir"
                    addButtonVariant="info"
                  />
                </div>
              )}
              {cloneError && <div className="settings-description" style={{ color: 'var(--c-danger-strong)' }}>{cloneError}</div>}
              <div className="btn-group">
                <button className="btn btn-primary session-clone-confirm" onClick={handleCloneSession} disabled={cloneBusy}>
                  {cloneBusy ? '⏳ Cloning…' : 'Clone'}
                </button>
                <button className="btn" onClick={() => setCloneTarget(null)} disabled={cloneBusy}>Cancel</button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

/**
 * Checkbox list of sessions: which of them the viewed session may message.
 * Shown in Create session (applied right after creation) and in Edit session.
 */
/**
 * Multi-select typeahead over sessions: type to filter, click or Enter to
 * pair, chips to remove. Used for the messaging grants in Create/Edit session.
 */
const SessionPeerPicker: React.FC<{
  candidates: { id: string; name: string; relationship?: string | null }[];
  selected: string[];
  disabled?: boolean;
  onToggle: (id: string, on: boolean) => void;
}> = ({ candidates, selected, disabled, onToggle }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Click outside closes the menu (the input keeps focus otherwise).
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  if (!candidates.length) {
    return <div className="settings-description">No other sessions yet.</div>;
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const q = query.trim().toLowerCase();
  const matches = candidates
    .filter((c) => !selected.includes(c.id))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    .slice(0, 50);

  const add = (id: string) => {
    onToggle(id, true);
    setQuery('');
    setOpen(true);
  };

  return (
    <div className="session-peers" ref={boxRef}>
      {selected.length > 0 && (
        <div className="session-peer-chips">
          {selected.map((id) => (
            <span key={id} className="session-peer-chip" title={byId.get(id)?.name ?? id}>
              {byId.get(id)?.name ?? id}
              <button
                type="button"
                className="session-peer-chip-x"
                title="Unpair"
                disabled={disabled}
                onClick={() => onToggle(id, false)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="session-peer-search"
        type="text"
        placeholder={selected.length ? 'Add another session…' : 'Type to find a session…'}
        value={query}
        disabled={disabled}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches.length) {
            e.preventDefault();
            add(matches[0].id);
          } else if (e.key === 'Backspace' && !query && selected.length) {
            // Backspace on an empty field undoes the last pairing.
            onToggle(selected[selected.length - 1], false);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (
        <div className="session-peer-menu">
          {matches.length === 0 ? (
            <div className="session-peer-empty">{q ? 'No matching sessions' : 'Every session is paired'}</div>
          ) : (
            matches.map((c) => (
              <div
                key={c.id}
                className="session-peer-option"
                // Keep focus in the input so typing can continue.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(c.id)}
              >
                <span className="session-peer-name">{c.name}</span>
                {c.relationship && c.relationship !== 'peer' && (
                  <span className="session-peer-rel">{c.relationship}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Cross-session messaging grants for the CURRENT session: a session may
 * message its parent (the session that created its task), its own task runs,
 * and the sessions paired here. Parent/child edges are derived from tasks and
 * shown read-only; grants are symmetric and apply immediately.
 */
const SessionMessaging: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const [links, setLinks] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!sessionId) return;
    const data = await apiJSON(`${API.session.links}?sessionId=${encodeURIComponent(sessionId)}`);
    setLinks(data);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    setLinks(null);
    setError('');
    load().catch((err) => setError(err?.message || 'Failed to load messaging links'));
  }, [sessionId, load]);

  const toggle = async (peerId: string, on: boolean) => {
    if (!sessionId || saving) return;
    const current = (links?.peers ?? []).map((p: any) => p.id);
    const peers = on ? [...current, peerId] : current.filter((p: string) => p !== peerId);
    setSaving(true);
    setError('');
    try {
      await apiSend(API.session.links, 'PUT', { sessionId, peers });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to save messaging links');
    } finally {
      setSaving(false);
    }
  };

  if (!sessionId) return null;
  const selected: string[] = (links?.peers ?? []).map((p: any) => p.id);
  const parent = links?.parent ?? null;
  const children: { id: string; name: string }[] = links?.children ?? [];
  return (
    <div className="session-messaging settings-field">
      <label className="settings-label">Messaging</label>
      <div className="settings-description">
        Sessions that may message this one, and be messaged by it. Agents can only reach their parent, their own task runs and the sessions paired here.
      </div>
      {parent && (
        <div className="session-messaging-link">parent: <b>{parent.name}</b></div>
      )}
      {children.length > 0 && (
        <div className="session-messaging-link">
          task runs: <b>{children.map((c) => c.name).join(', ')}</b>
        </div>
      )}
      {links === null ? (
        <div className="settings-description">Loading…</div>
      ) : (
        <SessionPeerPicker
          candidates={links.candidates ?? []}
          selected={selected}
          disabled={saving}
          onToggle={(id, on) => void toggle(id, on)}
        />
      )}
      {error && <div className="settings-description" style={{ color: 'var(--c-danger-strong)' }}>{error}</div>}
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
  const [savedWorkdirs, setSavedWorkdirs] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Current session's workdirs from the sessions listing. Until BOTH the
  // session id and the listing are available we stay in the loading state —
  // no blank gap and no premature empty-list.
  useEffect(() => {
    if (!sessionId) return; // wait for the session state to arrive
    let cancelled = false;
    setWorkdirs(null);
    setSavedWorkdirs(null);
    apiJSON<any[]>(API.sessions.list)
      .then((list) => {
        if (!cancelled) {
          const cur = (list || []).find((s: { id: string }) => s.id === sessionId);
          const loadedWorkdirs = [...(cur?.workdirs || [])];
          setWorkdirs(loadedWorkdirs);
          setSavedWorkdirs(loadedWorkdirs);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkdirs([]);
          setSavedWorkdirs([]);
        }
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  const wdCheck = useWorkdirCheck(workdirs || []);
  const dirty = workdirs !== null && savedWorkdirs !== null && (
    workdirs.length !== savedWorkdirs.length || workdirs.some((item, index) => item !== savedWorkdirs[index])
  );

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
    apiSend(API.session.workdirs, 'PUT', { sessionId, workdirs })
      .then(() => {
        setSavedWorkdirs([...workdirs]);
        // pi respawned — rebind this client view (no-op when same id)
        onSwitching(sessionId);
      })
      .catch((err: any) => setError(err?.message || 'Network error'))
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
        onChange={setWorkdirs}
        placeholder="/home/autere/code/… (or relative to $HOME)"
        addLabel="Add workdir"
        addButtonVariant="info"
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
      {dirty && (
        <div className="btn-group">
          <button className="btn btn-primary session-workdirs-save" onClick={apply} disabled={disabled}>
            {saving ? '⏳ Restarting…' : '💾 Save workdirs'}
          </button>
        </div>
      )}
    </div>
  );
};
