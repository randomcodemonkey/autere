import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header, ViewId } from '../components/Header';
import { StatusCard } from '../components/StatusCard';
import { SettingsCard } from '../components/SettingsCard';
import { ScheduledTasksCard } from '../components/ScheduledTasksCard';
import { StreamCard } from '../components/StreamCard';
import { Modal } from '../components/Modal';
import { SessionModal } from '../components/SessionModal';
import { url, basePath } from '../base-path';
import { uiSessionName } from '../session-name';
import type {
  SessionState,
  SessionStats,
  StreamMessage,
  ActiveTool,
  RecentTool,
  ExtensionInfo,
  AvailableModel,
  SessionInfo,
  SSEMessage,
} from '../types';

const EMPTY_STATS: SessionStats = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  contextUsage: null,
};

/** Combine base auth/SSE status with session streaming state */
function computeStatus(baseType: string, baseText: string, s: SessionState): { type: string; text: string } {
  if (baseType === 'disconnected') return { type: 'disconnected', text: 'Disconnected' };
  if (baseType === 'loading') return { type: 'loading', text: 'Loading…' };
  if (s.compacting) return { type: 'streaming', text: 'Compacting' };
  if (s.isStreaming) return { type: 'streaming', text: 'Working' };
  return { type: 'connected', text: baseText === 'Disconnected' ? 'Disconnected' : 'Idle' };
}

interface DashboardPageProps {
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

export function DashboardPage({
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
}: DashboardPageProps) {
  const { sessionId: urlSessionId, view } = useParams<{ sessionId?: string; view?: string }>();
  const navigate = useNavigate();

  // View switching (chat / status / settings). On desktop the status card is
  // always visible on the left and the selection swaps the right pane; on
  // mobile each view is a full-screen card (CSS).
  const activeView: ViewId = view === 'settings' ? 'settings' : view === 'status' ? 'status' : view === 'tasks' ? 'tasks' : 'chat';
  const handleSetView = useCallback((v: ViewId) => {
    if (!urlSessionId) return;
    navigate(v === 'chat' ? `/session/${urlSessionId}` : `/session/${urlSessionId}/${v}`);
  }, [navigate, urlSessionId]);

  // Session state
  const [sessionState, setSessionState] = useState<SessionState>({
    model: null,
    thinkingLevel: 'off',
    isStreaming: false,
    messageCount: 0,
    requestCount: 0,
    pendingMessageCount: 0,
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    connected: false,
    startTime: Date.now(),
    externalActivity: false,
    compacting: false,
  });

  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS);

  const [streamHistory, setStreamHistory] = useState<StreamMessage[]>([]);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [recentTools, setRecentTools] = useState<RecentTool[]>([]);
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [availableSessions, setAvailableSessions] = useState<SessionInfo[]>([]);
  // UI state
  const [restartingBackend, setRestartingBackend] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // True while a session switch request is in flight — shown as a banner
  const [switchingSession, setSwitchingSession] = useState(false);
  const [showSessionModal, setShowSessionModal] = useState(false);

  // SSE message handler
  // Guards fetch responses and status events against session changes: a
  // response/snapshot for a previous session that resolves after a
  // navigation must NOT affect the newly viewed session's state.
  const viewedSessionRef = useRef<string | null>(null);
  viewedSessionRef.current = urlSessionId || null;
  // Canonical session id (pi's id may drift from the URL's file-derived id)
  const canonicalSessionIdRef = useRef<string | null>(null);
  canonicalSessionIdRef.current = sessionState.sessionId;

  const handleDashboardSSEMessage = useCallback((msg: SSEMessage) => {
    switch (msg.type) {
      case 'status': {
        const incoming = msg.data;
        const viewed = viewedSessionRef.current;
        // Ignore status snapshots from a DIFFERENT session than the one being
        // viewed (e.g. a late broadcast from the previous session after
        // creating a new session) — applying them would revert
        // sessionState.sessionId and trigger a redundant switch-by-id that
        // aborts an in-flight prompt.
        if (viewed && incoming?.sessionId && incoming.sessionId !== viewed) break;
        // Null sessionId (mid-switch snapshot) must not clear the viewed id
        setSessionState((prev: any) => ({ ...prev, ...incoming, sessionId: incoming?.sessionId ?? prev.sessionId }));
        break;
      }
      case 'error':
        setCreatingSession(false);
        setSessionError(msg.data?.message || 'An error occurred');
        break;
      case 'navigate':
        if (msg.data?.url) {
          setCreatingSession(false);
          resetSessionUI();
          navigate(msg.data.url, { replace: true });
        }
        break;
      case 'stats':
        setStats(msg.data);
        break;
      case 'stream_history': {
        // Ignore history from a session other than the one being viewed
        // (defense against cross-session bleed during switch races).
        const viewed = viewedSessionRef.current;
        if (msg.sessionId && viewed && msg.sessionId !== viewed) break;
        // Ignore EMPTY snapshots that carry no session id — that shape only
        // comes from the SSE connect-time initializer. Applying it would
        // clear already-rendered chat content (the load-time blink).
        if (!msg.sessionId && (!msg.data || msg.data.length === 0)) break;
        // Skip no-op updates: the connect-time replay may deliver exactly
        // what is already rendered — re-applying identical content rebuilds
        // the DOM for nothing.
        const incoming = msg.data || [];
        if (JSON.stringify(streamHistoryRef.current) === JSON.stringify(incoming)) break;
        setStreamHistory(incoming);
        break;
      }
      case 'models':
        setModels(msg.data || []);
        break;
      case 'sessions':
        setAvailableSessions(msg.data || []);
        break;
      case 'tool_start':
        setActiveTools((prev) => {
          const tool = msg.data;
          return [...prev, { id: tool.id, name: tool.name, cmd: tool.cmd, args: {}, startTime: Date.now() }];
        });
        break;
      case 'tool_end':
        setActiveTools((prev) => prev.filter((t) => t.id !== msg.data.id));
        if (msg.data.recentTools) setRecentTools(msg.data.recentTools);
        break;
      case 'external_activity': {
        // Cross-session 'active elsewhere' signal. Accept both the URL id and
        // the canonical sessionState id — pi id-drift can make them differ.
        const esid = msg.data?.sessionId;
        if (esid && (esid === viewedSessionRef.current || esid === canonicalSessionIdRef.current)) {
          setSessionState((prev) => ({ ...prev, externalActivity: !!msg.data.active }));
        }
        break;
      }
      case 'extensions':
        setExtensions(msg.data || []);
        break;
    }
  }, [navigate, urlSessionId]);

  // Register our handler with the parent's useSSE via the ref.
  // Set synchronously during render so no messages are missed.
  pageHandlerRef.current = handleDashboardSSEMessage;

  // Apply a bootstrap payload (from GET /api/bootstrap or the switch-by-id
  // response — same shape) to the UI state.
  const applyBootstrap = useCallback((d: any) => {
    setSessionState((prev: any) => ({ ...prev, ...d.sessionState, sessionId: d.sessionState?.sessionId ?? prev.sessionId }));
    if (d.sessionStats) setStats(d.sessionStats);
    setActiveTools(d.activeTools ?? []);
    setRecentTools(d.recentTools ?? []);
    // Apply history only if it belongs to the session being viewed
    const viewed = viewedSessionRef.current;
    if (!viewed || !d.historySessionId || d.historySessionId === viewed) {
      setStreamHistory(d.streamHistory ?? []);
    }
    setAvailableSessions(d.availableSessions ?? []);
    setModels(d.availableModels ?? []);
    setExtensions(d.extensions ?? []);
  }, []);

  // ── Bootstrap: ONE request loads everything at (re)load time ──
  // Runs on mount and on every SSE (re)connect (a reconnect is a reload:
  // the stream may have missed events while it was down). Navigation
  // between sessions is handled separately by switch-by-id. The SSE stream
  // carries LIVE events only — no history replays or state snapshots.
  const prevConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!authenticated) return;
    const isFirstLoad = prevConnectedRef.current === null;
    const isReconnect = prevConnectedRef.current === false && sseConnected === true;
    prevConnectedRef.current = sseConnected;
    if (!isFirstLoad && !isReconnect) return;

    let cancelled = false;
    const sid = viewedSessionRef.current;
    fetch(url(`/api/bootstrap${sid ? `?sessionId=${encodeURIComponent(sid)}` : ''}`))
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data.success || !data.data) return;
        applyBootstrap(data.data);
        // A successful bootstrap means the backend is up — clear restart flags
        if (restarting) setRestarting(false);
        if (restartingBackend) setRestartingBackend(false);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // restarting/restartingBackend intentionally excluded — flags only ever
    // transition true→false here, and the closure value is still valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, sseConnected]);

  // After reconnect (e.g. a device waking from sleep), bootstrap refreshes
  // everything above — no per-resource refetching needed here.

  // Chat history for a directly-opened URL is loaded by the bootstrap fetch
  // above. Navigation between sessions goes through switch-by-id (below).
  const streamHistoryRef = useRef<StreamMessage[]>([]);
  streamHistoryRef.current = streamHistory;

  // Session whose chat content has already been rendered (by bootstrap or a
  // switch-by-id response — both build from the same session file; a second
  // application re-adds the loaded-messages banner and rebuilds the DOM,
  // causing a visible flash on every (re)load).
  const historyRenderedForRef = useRef<string | null>(null);

  // When URL changes (browser back/forward, direct navigation, or programmatic
  // navigate), send a switch request. React Router handles the URL — we just
  // react to param changes.
  const prevUrlSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authenticated || !sseConnected || !urlSessionId) return;
    const sid = urlSessionId;
    const urlChanged = prevUrlSessionRef.current !== sid;
    prevUrlSessionRef.current = sid;

    if (sid === sessionState.sessionId) {
      return;
    }
    // Only switch when the URL itself changed (user navigation). A render
    // where only sessionState changed (e.g. the optimistic update from
    // handleNewSession landing before the router updates the URL) must NOT
    // switch the backend — it would switch BACK to the stale URL's session
    // right after creating a new one, sending subsequent messages there.
    if (!urlChanged) return;
    setSwitchingSession(true);
    fetch(url('/api/sessions/switch-by-id'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    }).then(res => res.json()).then(data => {
      // Stale-response guard: only apply if still viewing this session
      if (viewedSessionRef.current !== sid) return;
      // The switch response carries the same bootstrap payload shape as
      // GET /api/bootstrap — apply it with the exact same code path.
      if (data.success && data.data) {
        applyBootstrap(data.data);
        historyRenderedForRef.current = sid;
        setSwitchingSession(false);
        setShowSessionModal(false);
        // The backend may resolve an id alias (e.g. a stale filename id)
        // to the canonical session id — sync the URL to it.
        const resolved = data.data.sessionState?.sessionId;
        if (resolved && resolved !== sid) {
          navigate(`/session/${resolved}`, { replace: true });
        }
      } else if (!data.success) {
        // Surface switch failures (e.g. session cwd vanished) instead of
        // silently leaving the UI on the old session.
        setSessionError(data.error || 'Failed to switch session');
        setSwitchingSession(false);
      }
    }).catch(() => {
      setSwitchingSession(false);
    });
  }, [authenticated, sseConnected, urlSessionId, sessionState.sessionId, creatingSession]);

  // Clear per-session UI state (used when entering a fresh session)
  const resetSessionUI = useCallback(() => {
    setStreamHistory([]);
    setStats(EMPTY_STATS);
    setActiveTools([]);
    setRecentTools([]);
  }, []);

  // Badge click: on desktop the status card lives in the always-visible left
  // column — scroll it into view and flash it so the click gives visible
  // feedback. (On mobile onViewChange('status') shows the card full-screen.)
  const handleStatusClick = useCallback(() => {
    setShowSessionModal(true);
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    // Full reload to index: resets all SPA state (session view, SSE, modals)
    // and presents a clean login screen. After re-login the app starts from
    // the root redirect as on a fresh visit.
    window.location.href = (basePath() || '/') as string;
  }, [logout]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try { await fetch(url('/api/restart'), { method: 'POST' }); } catch {}
  }, [setRestarting]);

  const handleRestartBackend = useCallback(async () => {
    if (!confirm('Restart the entire autere backend? All users will be disconnected.')) return;
    setRestartingBackend(true);
    sseDisconnect();
    try { await fetch(url('/api/restart-backend'), { method: 'POST' }); } catch {}
    setTimeout(() => { sseConnect(); }, 4000);
  }, [setRestartingBackend, sseDisconnect, sseConnect]);

  const handleAbort = useCallback(async () => {
    try { await fetch(url('/api/abort'), { method: 'POST' }); } catch {}
  }, []);

  const handleCompact = useCallback(async () => {
    try {
      const res = await fetch(url('/api/compact'), { method: 'POST' });
      const data = await res.json();
      if (!data.success) setSessionError(data.error || 'Failed to compact');
    } catch (err) {
      console.error('Failed to compact:', err);
      setSessionError('Failed to compact');
    }
  }, []);

  const handleNewSession = useCallback(() => {
    setCreatingSession(true);
    setSessionError(null);
    fetch(url('/api/new-session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Name generated HERE — browser locale + timezone are authoritative
        sessionName: uiSessionName(),
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.success && data.navigateUrl) {
          const newId = data.navigateUrl.split('/').pop();
          // Navigate directly from the response — no SSE broadcast needed
          setCreatingSession(false);
          setShowSessionModal(false);
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
  }, []);

  const handleSwitchSession = useCallback((sessionId: string) => {
    setSessionError(null);
    // Navigate to the target session — the URL 'view' param defaults to chat,
    // so no explicit view change is needed. (Calling handleSetView('chat')
    // here would navigate BACK to the previous urlSessionId and swallow the
    // switch.) The modal stays open with a "Switching session…" indicator
    // until the switch completes — it's closed on success below.
    navigate(`/session/${sessionId}`);
  }, [navigate]);

  const activeModelId = sessionState.model?.id || null;
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
        statusType={statusType}
        statusText={statusText}
        sessionId={urlSessionId || sessionState.sessionId}
        sessionName={sessionState.sessionName}
        activeView={activeView}
        onViewChange={handleSetView}
        onStatusClick={handleStatusClick}
        workingExternal={sessionState.externalActivity}
        isActive={sessionState.isStreaming || sessionState.compacting}
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
            onModelsFetched={setModels}
            username={username}
            userRole={userRole}
            restarting={restarting}
            restartingBackend={restartingBackend}
            onRestart={handleRestart}
            onRestartBackend={handleRestartBackend}
            onLogout={handleLogout}
          />
        </div>
        <div className={`chat-wrapper${sessionState.externalActivity ? ' chat-external-activity' : ''}`}>
          {activeView === 'chat' && (
            <StreamCard messages={streamHistory} isStreaming={sessionState.isStreaming} compacting={sessionState.compacting} onNewSession={handleNewSession} onCompact={handleCompact} onCommandError={setSessionError} steerPending={sessionState.steerPending} followUpPending={sessionState.followUpPending} model={sessionState.model} externalActivity={sessionState.externalActivity} models={models} activeModelId={sessionState.model?.id || null} onModelsFetched={setModels} />
          )}
          {activeView === 'settings' && (
            <SettingsCard sseConnected={sseConnected} />
          )}
          {activeView === 'tasks' && (
            <ScheduledTasksCard sseConnected={sseConnected} />
          )}
        </div>
      </div>

      <SessionModal
        open={showSessionModal}
        onClose={() => setShowSessionModal(false)}
        statusType={statusType}
        sessionId={sessionState.sessionId}
        sessionName={sessionState.sessionName}
        compacting={sessionState.compacting}
        isStreaming={sessionState.isStreaming}
        isActive={sessionState.isStreaming || sessionState.compacting}
        onAbort={handleAbort}
        onNewSession={handleNewSession}
        onCompact={handleCompact}
        onSwitchSession={handleSwitchSession}
      />

      {switchingSession && (
        <div
          style={{
            position: 'fixed',
            top: '3rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#2563eb',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 600,
            padding: '0.35rem 1rem',
            borderRadius: '1rem',
            zIndex: 9000,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          Switching session…
        </div>
      )}
      <Modal open={!!sessionError} onClose={() => setSessionError(null)} className="modal-status">
        <div className="modal-header">
          <h3>Error</h3>
          <button className="modal-close" onClick={() => setSessionError(null)}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ color: '#f44336' }}>{sessionError}</div>
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            <button className="btn btn-primary" onClick={handleNewSession}>Try Again</button>
            <button className="btn" onClick={() => setSessionError(null)}>Close</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
