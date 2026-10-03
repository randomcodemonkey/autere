import React, { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header, ViewId } from '../components/Header';
import { StatusCard } from '../components/StatusCard';
import { SettingsCard } from '../components/SettingsCard';
import { ScheduledTasksCard } from '../components/ScheduledTasksCard';
import { EditsPage } from '../components/EditsPage';
import { UsersCard } from '../components/UsersCard';
import { UserCard } from '../components/UserCard';
import { StreamCard } from '../components/StreamCard';
import { Modal } from '../components/Modal';
import { SessionView } from '../components/SessionModal';
import { url, basePath } from '../base-path';
import { API } from '../api-paths';
import { uiSessionName } from '../session-name';
import { useSessionStream } from '../hooks/useSessionStream';
import type { SSEMessage } from '../types';

/** Combine base auth/SSE status with session streaming state */
function computeStatus(baseType: string, baseText: string, s: { compacting?: boolean; isStreaming?: boolean }): { type: string; text: string } {
  if (baseType === 'disconnected') return { type: 'disconnected', text: 'Disconnected' };
  if (baseType === 'loading') return { type: 'loading', text: 'Loading…' };
  if (s.compacting) return { type: 'streaming', text: 'Compacting' };
  if (s.isStreaming) return { type: 'streaming', text: 'Working' };
  return { type: 'connected', text: baseText === 'Disconnected' ? 'Disconnected' : 'Idle' };
}

/** Map the URL :view segment to a view. Non-admins never get the users view. */
function resolveView(view: string | undefined, userRole: string | null): ViewId {
  switch (view) {
    case 'settings':
    case 'status':
    case 'sessions':
    case 'tasks':
    case 'edits':
    case 'user':
      return view;
    case 'users':
      return userRole === 'admin' ? 'users' : 'chat';
    default:
      return 'chat';
  }
}

interface AppPageProps {
  authenticated: boolean;
  username: string | null;
  userRole: string | null;
  logout: () => Promise<void>;
  sseConnected: boolean;
  pageHandlerRef: React.MutableRefObject<(msg: SSEMessage) => void>;
  baseStatusType: string;
  baseStatusText: string;
  restarting: boolean;
  setRestarting: (v: boolean) => void;
  sseDisconnect: () => void;
  sseConnect: () => void;
}

export function AppPage({
  authenticated,
  username,
  userRole,
  logout,
  sseConnected,
  pageHandlerRef,
  baseStatusType,
  baseStatusText,
  restarting,
  setRestarting,
  sseDisconnect,
  sseConnect,
}: AppPageProps) {
  const { sessionId: urlSessionId, view } = useParams<{ sessionId?: string; view?: string }>();
  const navigate = useNavigate();
  // When set, opening the Sessions view shows the new-session form tab ('/new')
  const [newFormRequested, setNewFormRequested] = useState(false);

  // View switching (chat / status / settings). On desktop the status card is
  // always visible on the left and the selection swaps the right pane; on
  // mobile each view is a full-screen card (CSS).
  const activeView = resolveView(view, userRole);
  const handleSetView = useCallback((v: ViewId) => {
    if (!urlSessionId) return;
    navigate(v === 'chat' ? `/session/${urlSessionId}` : `/session/${urlSessionId}/${v}`);
  }, [navigate, urlSessionId]);

  // UI state
  const [restartingBackend, setRestartingBackend] = useState(false);

  const {
    sessionState, setSessionState,
    stats,
    streamHistory,
    pendingUser, setPendingUser,
    extensions,
    models, setModels,
    availableSessions,
    setAvailableSessions,
    sessionsLoaded,
    sessionError, setSessionError,
    creatingSession, setCreatingSession,
    switchingSession, switchLabel,
    resetSessionUI,
    targetSessionRef,
    applyBootstrap,
  } = useSessionStream({
    authenticated,
    urlSessionId,
    sseConnected,
    baseStatusType,
    pageHandlerRef,
    setRestarting,
    onBootstrapped: () => setRestartingBackend(false),
  });

  // RootRedirect failures (e.g. sandbox/docker unavailable during the very
  // first session create) are stashed there — surface once in the error
  // modal over the normal app shell, not as a blocking page.
  useEffect(() => {
    if (!authenticated) return;
    const stored = sessionStorage.getItem('bootstrapError');
    if (stored) {
      sessionStorage.removeItem('bootstrapError');
      setSessionError(stored);
    }
  }, [authenticated, setSessionError]);

  // Cancel a queued (steer/follow-up) message: optimistic UI removal; the
  // backend prunes pi's queue and broadcasts history_remove for the
  // committed pending copy in streamHistory.
  const handleCancelPending = useCallback(async (text: string) => {
    setPendingUser((prev) => prev.filter((p) => p.text !== text));
    try {
      await fetch(url(API.session.pending), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sessionId: targetSessionRef.current }),
      });
    } catch {}
  }, [setPendingUser, targetSessionRef]);

  const handleLogout = useCallback(async () => {
    await logout();
    // Full reload to index: resets all SPA state (session view, SSE, modals)
    // and presents a clean login screen. After re-login the app starts from
    // the root redirect as on a fresh visit.
    window.location.href = (basePath() || '/') as string;
  }, [logout]);

  // Spawn the viewed session's pi process on demand (status card "Load").
  const handleActivateSession = useCallback(() => {
    const sid = urlSessionId || sessionState.sessionId;
    if (!sid) return;
    fetch(url(API.sessions.activate(sid)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, spawn: true }),
    }).then((r) => r.json()).then((d) => {
      if (d.success && d.data) applyBootstrap(d.data);
    }).catch(() => {});
  }, [urlSessionId, sessionState.sessionId, applyBootstrap]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try { await fetch(url(API.session.restart), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: targetSessionRef.current }) }); } catch {}
  }, [setRestarting, targetSessionRef]);

  const handleRestartBackend = useCallback(async () => {
    if (!confirm('Restart the entire autere backend? All users will be disconnected.')) return;
    setRestartingBackend(true);
    sseDisconnect();
    try { await fetch(url(API.backend.restart), { method: 'POST' }); } catch {}
    setTimeout(() => { sseConnect(); }, 4000);
  }, [setRestartingBackend, sseDisconnect, sseConnect]);

  const handleAbort = useCallback(async () => {
    try { await fetch(url(API.session.abort), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: targetSessionRef.current }) }); } catch {}
  }, [targetSessionRef]);

  const handleCompact = useCallback(async () => {
    try {
      const res = await fetch(url(API.session.compact), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: targetSessionRef.current }) });
      const data = await res.json();
      if (!data.success) setSessionError(data.error || 'Failed to compact');
    } catch (err) {
      console.error('Failed to compact:', err);
      setSessionError('Failed to compact');
    }
  }, [setSessionError, targetSessionRef]);

  const handleAbortCompaction = useCallback(async () => {
    // Confirm lives at the button (SessionModal) — this handler must fire directly.
    try {
      const res = await fetch(url(API.session.compact), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: targetSessionRef.current }) });
      const data = await res.json();
      if (!data.success) setSessionError(data.error || 'Failed to abort compaction');
    } catch (err) {
      console.error('Failed to abort compaction:', err);
      setSessionError('Failed to abort compaction');
    }
  }, [setSessionError, targetSessionRef]);

  // '/model <name>': resolve the name against the known model list (id or
  // name, case-insensitive; unique-prefix match) and switch via PUT.
  const handleCommandSetModel = useCallback(async (name: string) => {
    const q = name.toLowerCase();
    let hits = models.filter((m) => (m.id ?? '').toLowerCase() === q || (m.name ?? '').toLowerCase() === q || `${m.provider}/${m.id}`.toLowerCase() === q);
    if (hits.length !== 1) {
      const starts = models.filter((m) => (m.id ?? '').toLowerCase().startsWith(q) || (m.name ?? '').toLowerCase().startsWith(q));
      if (starts.length >= 1) hits = starts;
    }
    if (hits.length !== 1) {
      setSessionError(hits.length === 0 ? `Unknown model: ${name}` : `Ambiguous model: ${name} — ${hits.length} matches`);
      return;
    }
    try {
      const res = await fetch(url(API.session.model), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: hits[0].provider, modelId: hits[0].id, sessionId: sessionState.sessionId }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.success) setSessionError(data?.error || `Failed to switch model to ${name}`);
    } catch { setSessionError(`Failed to switch model to ${name}`); }
  }, [models, sessionState.sessionId]);

  // '/persona <name>': resolve persona by id or name on the server list and bind
  const handleCommandSetPersona = useCallback(async (name: string) => {
    try {
      const res = await fetch(url(API.personas.root));
      const data = await res.json().catch(() => null);
      const list: { id: string; name: string }[] = data?.data ?? [];
      const q = name.toLowerCase();
      const hits = list.filter((x) => x.id.toLowerCase() === q || x.name.toLowerCase() === q);
      if (hits.length !== 1) {
        setSessionError(hits.length === 0 ? `Unknown persona: ${name}` : `Ambiguous persona: ${name} — ${hits.length} matches`);
        return;
      }
      const put = await fetch(url(API.session.persona), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId: hits[0].id, sessionId: sessionState.sessionId }),
      });
      const d = await put.json().catch(() => null);
      if (d?.success) setSessionState((s) => ({ ...s, persona: d.data?.persona ?? s.persona }));
      else setSessionError(d?.error || `Failed to set persona to ${name}`);
    } catch { setSessionError(`Failed to set persona to ${name}`); }
  }, [sessionState.sessionId]);

  const handleNewSession = useCallback((personaId?: string | null, sessionName?: string, workdirs?: string[], mountDockerSocket?: boolean) => {
    // Relative (or ~) workdir paths are allowed: the backend resolves them
    // against the autere backend container's $HOME before spawning.
    setCreatingSession(true);
    setSessionError(null);
    fetch(url(API.sessions.list), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The modal form prefills this — browser locale + timezone stay authoritative
        sessionName: (sessionName || '').trim() || uiSessionName(),
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(personaId ? { personaId } : {}),
        ...(workdirs && workdirs.length ? { workdirs } : {}),
        ...(mountDockerSocket ? { mountDockerSocket: true } : {}),
      }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.success && data.navigateUrl) {
          const newId = data.navigateUrl.split('/').pop();
          // Navigate directly from the response — no SSE broadcast needed
          setCreatingSession(false);
          // Apply the fresh session state returned by the backend. The SSE
          // status broadcast for the new session is dropped while we're still
          // on the old URL (stale-snapshot guard), and the URL-change effect
          // early-returns because sessionId was set optimistically — so this
          // response is the only chance to sync sessionName/sessionFile etc.
          // Without it, the session badge keeps the previous session's
          // name/id until the next interaction.
          if (data.sessionState) setSessionState(data.sessionState);
          else if (newId) setSessionState((prev: any) => ({ ...prev, sessionId: newId }));
          resetSessionUI();
          navigate(data.navigateUrl, { replace: true });
        } else if (!data.success) {
          setCreatingSession(false);
          setSessionError(data.error || 'Failed to create session');
        }
      })
      .catch(() => {
        setCreatingSession(false);
        setSessionError('Failed to create session');
      });
  }, [navigate, resetSessionUI, setCreatingSession, setSessionError, setSessionState]);

  const handleSwitchSession = useCallback((sessionId: string) => {
    setSessionError(null);
    // Mark the upcoming (navigation-triggered) switch as user-initiated so
    // its completion closes the sessions modal. Automatic switches don't.
    // Navigate to the target session — the URL 'view' param defaults to chat,
    // so no explicit view change is needed. (Calling handleSetView('chat')
    // here would navigate BACK to the previous urlSessionId and swallow the
    // switch.) The modal stays open with a "Switching session…" indicator
    // until the switch completes — it's closed on success below.
    navigate(`/session/${sessionId}`);
  }, [navigate, setSessionError]);

  const activeModelId = sessionState.model?.id || null;
  // Optimistic pending copies whose text is already committed to the real
  // history are hidden. Retirement by event ordering is unreliable: the
  // backend broadcasts the user entry (history_upsert) BEFORE the send
  // response returns, so the optimistic copy is created after the real one
  // and no upsert ever targets it again.
  const visiblePendingUser = pendingUser.filter(
    // Retire by prefix too: queued sends get an attachment note appended
    // server-side, so committed text can be pending text + note (same rule
    // the stream_history snapshot retirement uses). Exact match alone kept
    // those copies visible forever.
    (p) => !streamHistory.some((m) => m.role === 'user' && !m.streaming && (m.text === p.text || m.text.startsWith(p.text))),
  );
  const { type: statusType, text: statusText } = computeStatus(baseStatusType, baseStatusText, sessionState);

  if (creatingSession) {
    return (
      <div id="main-app" className={`authenticated view-${activeView}`}>
        <div className="loading-new-session">
          <>
            <div className="loading-spinner" />
            <div className="loading-text">Creating new session…</div>
          </>
        </div>
      </div>
    );
  }

  return (
    <div id="main-app" className={`authenticated view-${activeView}`}>
      <Header
        sessionState={sessionState}
        statusType={statusType}
        statusText={statusText}
        sessionId={targetSessionRef.current}
        sessionName={sessionState.sessionName}
        activeView={activeView}
        onViewChange={handleSetView}
        runningSessions={availableSessions}
        sessionsLoaded={sessionsLoaded}
        onSessionsRefreshed={setAvailableSessions}
        onRunningSessionClick={handleSwitchSession}
        isActive={sessionState.isStreaming || sessionState.compacting}
        userRole={userRole}
      />

      <div className="container">
        <div className="cards-scroll">
          <StatusCard
            statusType={statusType}
            messageCount={sessionState.messageCount}
            requestCount={sessionState.requestCount}
            stats={stats}
            extensions={extensions}
            models={models}
            activeModelId={activeModelId}
            modelProvider={sessionState.model?.provider ?? null}
            onModelsFetched={setModels}
            username={username}
            userRole={userRole}
            restarting={restarting}
            restartingBackend={restartingBackend}
            onRestart={handleRestart}
            onRestartBackend={handleRestartBackend}
            onLogout={handleLogout}
            persona={sessionState.persona}
            sessionActive={availableSessions.find((x) => x.id === (urlSessionId || sessionState.sessionId))?.active ?? true}
            onActivateSession={handleActivateSession}
            onCompact={handleCompact}
            compacting={sessionState.compacting}
            onAbort={handleAbort}
            onAbortCompaction={handleAbortCompaction}
            isStreaming={sessionState.isStreaming}
          />
        </div>
        <div className="chat-wrapper">
          {activeView === 'sessions' && (
            <SessionView
              initialView={newFormRequested ? 'new' : undefined}
              onConsumedInitial={() => setNewFormRequested(false)}
              statusType={statusType}
              sessionId={sessionState.sessionId}
              sessionName={sessionState.sessionName}
              compacting={sessionState.compacting}
              isStreaming={sessionState.isStreaming}
              canSetWorkdir={userRole === 'admin'}
              onNewSession={handleNewSession}
              onSwitchSession={handleSwitchSession}
              switching={switchingSession}
            />
          )}
          {activeView === 'chat' && (
            <StreamCard messages={[...streamHistory, ...visiblePendingUser]} isStreaming={sessionState.isStreaming} compacting={sessionState.compacting} onNewSession={() => { setNewFormRequested(true); handleSetView('sessions'); }} onGoToView={(v) => handleSetView(v === 'files' ? 'edits' : v)} onSetModel={handleCommandSetModel} onSetPersona={handleCommandSetPersona} modelNames={models.map((m) => m.id)} onCompact={handleCompact} onCommandError={setSessionError} steerPending={sessionState.steerPending} followUpPending={sessionState.followUpPending} model={sessionState.model} models={models} activeModelId={sessionState.model?.id || null} onModelsFetched={setModels} onSent={(text) => setPendingUser((prev) => [...prev, { role: 'user', text, streaming: false, pending: true, timestamp: Date.now() }])} onCancelPending={handleCancelPending} sessionId={urlSessionId || sessionState.sessionId} />
          )}
          {activeView === 'settings' && (
            <SettingsCard sseConnected={sseConnected} />
          )}
          {activeView === 'tasks' && (
            <ScheduledTasksCard sseConnected={sseConnected} />
          )}
          {activeView === 'edits' && (
            <div className="card edits-card">
              <EditsPage sessionId={targetSessionRef.current} userRole={userRole} />
            </div>
          )}
          {activeView === 'users' && (
            <UsersCard username={username} />
          )}
          {activeView === 'user' && (
            <UserCard username={username} />
          )}
        </div>
      </div>

      {switchingSession && (
        <div
          style={{
            position: 'fixed',
            top: '3rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--c-blue-strong)',
            color: 'var(--c-white)',
            fontSize: '0.75rem',
            fontWeight: 600,
            padding: '0.35rem 1rem',
            borderRadius: '1rem',
            zIndex: 9000,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          {switchLabel}
        </div>
      )}
      <Modal open={!!sessionError} onClose={() => setSessionError(null)} className="modal-status">
        <div className="modal-header">
          <h3>Error</h3>
          <button className="modal-close" onClick={() => setSessionError(null)}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ color: 'var(--c-danger-strong)' }}>{sessionError}</div>
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            {/* No auto-retry button: the error may be a command/model failure
                rather than session creation, and a blind "Try Again" spawn
                created an unrelated unsandboxed session. Users retry via the
                visible controls (+ / model picker / re-send). */}
            <button className="btn" onClick={() => setSessionError(null)}>Close</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
