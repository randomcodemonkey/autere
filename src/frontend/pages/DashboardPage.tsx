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
        // id: null is the initial-state sync on (re)connect: the payload
        // carries the backend's authoritative active-tools snapshot (may be
        // empty, e.g. right after a backend restart). Applying it — instead
        // of blindly clearing — keeps a running tool visible when the SSE
        // connect burst lands after a fast /history response.
        if (msg.data.id == null) {
          setActiveTools(Array.isArray(msg.data.activeTools) ? msg.data.activeTools : []);
        } else {
          setActiveTools((prev) => prev.filter((t) => t.id !== msg.data.id));
        }
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

  // After reconnect (e.g. a device waking from sleep), refresh session list
  // and re-fetch the viewed session's history from the file — messages sent
  // while the client was away must appear even though no live events were
  // delivered in the meantime. Only applied when the content differs, so an
  // unchanged chat does not re-render (no blink).
  const wasConnectedRef = useRef(sseConnected);
  useEffect(() => {
    if (sseConnected && !wasConnectedRef.current) {
      // Clear restarting states on reconnection
      if (restarting) setRestarting(false);
      if (restartingBackend) setRestartingBackend(false);
      const sid = viewedSessionRef.current;
      if (sid) {
        fetch(url(`/api/sessions/${sid}/history?limit=50`))
          .then((res) => res.json())
          .then((data) => {
            if (!data.success || !data.data) return;
            if (JSON.stringify(streamHistoryRef.current) === JSON.stringify(data.data)) return;
            setStreamHistory(data.data);
            historyRenderedForRef.current = sid;
          })
          .catch(() => {});
      }
      const timer = setTimeout(() => {
        fetch(url('/api/sessions'))
          .then((res) => res.json())
          .then((data) => { if (data.success && data.data) setAvailableSessions(data.data); })
          .catch(() => {});
      }, 1000);
      return () => clearTimeout(timer);
    }
    wasConnectedRef.current = sseConnected;
  }, [sseConnected]);

  useEffect(() => {
    if (sseConnected && stats.tokens.input === 0 && sessionState.sessionId) {
      fetch(url('/api/stats'))
        .then((res) => res.json())
        .then((data) => { if (data.success && data.data) setStats(data.data); })
        .catch(() => {});
    }
  }, [sseConnected, sessionState.sessionId, stats.tokens.input]);

  // Load chat history for the URL session IMMEDIATELY on mount/navigation —
  // don't wait for the SSE stream (which itself waits for the pi process to
  // spawn). This removes the 'Waiting for messages…' delay after login:
  // the history fetch runs in parallel with the SSE setup instead of after
  // it. Only applies when the chat is still empty, so live SSE updates that
  // arrived first (e.g. a switch-by-id response) are never overwritten.
  const streamHistoryRef = useRef<StreamMessage[]>([]);
  streamHistoryRef.current = streamHistory;
  // Session whose chat content has already been rendered by the /history
  // fetch. The switch-by-id response must not replace it — both are built
  // from the same session file, and a second application (which re-adds
  // the '— Loaded N messages —' banner and rebuilds the DOM) causes the
  // shown -> cleared -> shown flash on every (re)load.
  const historyRenderedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authenticated || !urlSessionId) return;
    const sid = urlSessionId;
    let cancelled = false;
    fetch(url(`/api/sessions/${sid}/history?limit=50`))
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success && data.data?.length > 0
            && viewedSessionRef.current === sid
            && streamHistoryRef.current.length === 0) {
          setStreamHistory(data.data);
          historyRenderedForRef.current = sid;
        }
        // A session opened mid-turn must show its in-flight tools immediately
        if (data.success && viewedSessionRef.current === sid) {
          setActiveTools(data.activeTools ?? []);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authenticated, urlSessionId]);

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
      // If stream history is empty (e.g. after initial SSE sent empty data),
      // fetch it from the API for the current session.
      if (streamHistory.length === 0 && sid) {
        fetch(url(`/api/sessions/${sid}/history?limit=50`))
          .then((res) => res.json())
          .then((data) => {
            // Stale-response guard: only apply if still viewing this session
            if (viewedSessionRef.current === sid && data.success && data.data?.length > 0) setStreamHistory(data.data);
            if (data.success && viewedSessionRef.current === sid) {
              setActiveTools(data.activeTools ?? []);
              if (data.data?.length > 0) historyRenderedForRef.current = sid;
            }
          })
          .catch(() => {});
      }
       return;
    }
    // Only switch when the URL itself changed (user navigation). A render
    // where only sessionState changed (e.g. the optimistic update from
    // handleNewSession landing before the router updates the URL) must NOT
    // switch the backend — it would switch BACK to the stale URL's session
    // right after creating a new one, sending subsequent messages there.
    if (!urlChanged) return;
    fetch(url('/api/sessions/switch-by-id'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    }).then(res => res.json()).then(data => {
      // Stale-response guard: only apply if still viewing this session
      if (viewedSessionRef.current !== sid) return;
      if (data.success && data.streamHistory) {
        // Skip when the /history fetch already rendered this session's chat:
        // the payloads are built from the same file; re-applying only adds
        // the loaded-messages banner and rebuilds the DOM (visible flash).
        if (historyRenderedForRef.current !== sid) {
          setStreamHistory(data.streamHistory);
          historyRenderedForRef.current = sid;
        }
      }
      if (data.success && data.sessionState) {
        setSessionState(data.sessionState);
        // The backend may resolve an id alias (e.g. a stale filename id)
        // to the canonical session id — sync the URL to it.
        if (data.sessionState.sessionId && data.sessionState.sessionId !== sid) {
          navigate(`/session/${data.sessionState.sessionId}`, { replace: true });
        }
      }
      if (data.success && data.sessionStats) {
        setStats(data.sessionStats);
      }
      // In-flight tools snapshot (non-empty when joining a session mid-turn)
      if (data.success) {
        setActiveTools(data.activeTools ?? []);
      }
    }).catch(() => {});
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
    fetch(url('/api/new-session'), { method: 'POST' })
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
    // switch.) Close the modal — it must not linger over the new session.
    setShowSessionModal(false);
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
            activeTools={activeTools}
            recentTools={recentTools}
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
            <StreamCard messages={streamHistory} isStreaming={sessionState.isStreaming} compacting={sessionState.compacting} onNewSession={handleNewSession} onCompact={handleCompact} onCommandError={setSessionError} steerPending={sessionState.steerPending} followUpPending={sessionState.followUpPending} model={sessionState.model} externalActivity={sessionState.externalActivity} />
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
