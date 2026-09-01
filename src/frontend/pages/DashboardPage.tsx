import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header } from '../components/Header';
import { ModelCard } from '../components/ModelCard';
import { UsageCard } from '../components/UsageCard';
import { ToolsCard } from '../components/ToolsCard';
import { ExtensionsCard } from '../components/ExtensionsCard';
import { StreamCard } from '../components/StreamCard';
import { StatusModal } from '../components/StatusModal';
import { SessionModal } from '../components/SessionModal';
import { Modal } from '../components/Modal';
import { url } from '../base-path';
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
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();

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

  const [stats, setStats] = useState<SessionStats>({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    contextUsage: null,
  });

  const [streamHistory, setStreamHistory] = useState<StreamMessage[]>([]);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [recentTools, setRecentTools] = useState<RecentTool[]>([]);
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [availableSessions, setAvailableSessions] = useState<SessionInfo[]>([]);
  // UI state
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [restartingBackend, setRestartingBackend] = useState(false);
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Ref to track the current session ID so SSE handler comparisons aren't stale
  const sessionIdRef = useRef<string | null>(null);

  // SSE message handler
  // Guards fetch responses and status events against session changes: a
  // response/snapshot for a previous session that resolves after a
  // navigation must NOT affect the newly viewed session's state.
  const viewedSessionRef = useRef<string | null>(null);
  viewedSessionRef.current = urlSessionId || null;

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
	  // clear data before navigating. TODO: move this to utility function.
	  setCreatingSession(false);
          setStreamHistory([]);
          setStats({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: null });
          setActiveTools([]);
          setRecentTools([]);	
          navigate(msg.data.url, { replace: true });
        }
        break;
      case 'stats':
        setStats(msg.data);
        break;
      case 'stream_history':
        setStreamHistory(msg.data || []);
        break;
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
      case 'extensions':
        setExtensions(msg.data || []);
        break;
    }
  }, [navigate, urlSessionId]);

  // Register our handler with the parent's useSSE via the ref.
  // Set synchronously during render so no messages are missed.
  pageHandlerRef.current = handleDashboardSSEMessage;

  // After restart reconnection, fetch session history if empty
  const wasConnectedRef = useRef(sseConnected);
  useEffect(() => {
    if (sseConnected && !wasConnectedRef.current) {
      // Clear restarting states on reconnection
      if (restarting) setRestarting(false);
      if (restartingBackend) setRestartingBackend(false);
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

  // Apply chat-fullscreen class on mount if stored in localStorage
  useEffect(() => {
    if (localStorage.getItem('autere-chat-fullscreen') === '1') {
      const container = document.querySelector('.container');
      if (container) container.classList.add('chat-fullscreen');
    }
  }, []);

  // When URL changes (browser back/forward, direct navigation, or programmatic
  // navigate), send a switch request. React Router handles the URL — we just
  // react to param changes.
  useEffect(() => {
    if (!authenticated || !sseConnected || !urlSessionId) return;
    const sid = urlSessionId;

    if (sid === sessionState.sessionId) {
      // If stream history is empty (e.g. after initial SSE sent empty data),
      // fetch it from the API for the current session.
      if (streamHistory.length === 0 && sid) {
        fetch(url(`/api/sessions/${sid}/history?limit=50`))
          .then((res) => res.json())
          .then((data) => {
            // Stale-response guard: only apply if still viewing this session
            if (viewedSessionRef.current === sid && data.success && data.data?.length > 0) setStreamHistory(data.data);
          })
          .catch(() => {});
      }
       return;
    }
    fetch(url('/api/sessions/switch-by-id'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    }).then(res => res.json()).then(data => {
      // Stale-response guard: only apply if still viewing this session
      if (viewedSessionRef.current !== sid) return;
      if (data.success && data.streamHistory) {
        setStreamHistory(data.streamHistory);
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
    }).catch(() => {});
  }, [authenticated, sseConnected, urlSessionId, sessionState.sessionId, creatingSession]);

  const handleLogout = useCallback(async () => {
    await logout();
    setShowStatusModal(false);
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
    setShowSessionModal(false);
    fetch(url('/api/new-session'), { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.success && data.navigateUrl) {
          const newId = data.navigateUrl.split('/').pop();
          // Navigate directly from the response — no SSE broadcast needed
          setCreatingSession(false);
          setStreamHistory([]);
          // Update sessionState immediately so the URL effect doesn't fire a
          // redundant switch-by-id while sessionState still holds the previous
          // session's id (the SSE status event may lag behind).
          if (newId) setSessionState((prev: any) => ({ ...prev, sessionId: newId }));
          setStats({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: null });
          setActiveTools([]);
          setRecentTools([]);
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

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    setSessionError(null);
    navigate(`/session/${sessionId}`);
    setShowSessionModal(false);
  }, [navigate]);

  const activeModelId = sessionState.model?.id || null;

  // Full status computation (combines base auth/SSE status with session streaming state)
  const statusType = baseStatusType === 'disconnected'
    ? 'disconnected'
    : baseStatusType === 'loading'
    ? 'loading'
    : sessionState.compacting
    ? 'streaming'
    : sessionState.isStreaming
    ? 'streaming'
    : 'connected';
  const statusText = baseStatusText === 'Disconnected'
    ? 'Disconnected'
    : baseStatusText === 'Loading…'
    ? 'Loading…'
    : sessionState.compacting
    ? 'Compacting'
    : sessionState.isStreaming
    ? 'Working'
    : 'Idle';

  if (creatingSession) {
    return (
      <div id="main-app" className={authenticated ? 'authenticated' : ''}>
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
    <div id="main-app" className={authenticated ? 'authenticated' : ''}>
      <Header
        statusType={statusType}
        statusText={statusText}
        onStatusClick={() => setShowStatusModal(true)}
        sessionId={urlSessionId || sessionState.sessionId}
        sessionName={sessionState.sessionName}
        onSessionClick={() => setShowSessionModal(true)}
        workingExternal={sessionState.externalActivity}
        isActive={sessionState.isStreaming || sessionState.compacting}
      />

      <div className="container">
        <div className="cards-scroll">
          <ModelCard models={models} activeModelId={activeModelId} onModelsFetched={setModels} />
          <UsageCard messageCount={sessionState.messageCount} requestCount={sessionState.requestCount} stats={stats} />
          <ToolsCard activeTools={activeTools} recentTools={recentTools} />
          <ExtensionsCard extensions={extensions} />
        </div>
        <div className={`chat-wrapper${sessionState.externalActivity ? ' chat-external-activity' : ''}`}>
          <StreamCard messages={streamHistory} isStreaming={sessionState.isStreaming} compacting={sessionState.compacting} onNewSession={handleNewSession} onCompact={handleCompact} onCommandError={setSessionError} />
        </div>
      </div>

      <StatusModal
        open={showStatusModal}
        statusType={statusType}
        statusText={statusText}
        username={username}
        onClose={() => setShowStatusModal(false)}
        onRestart={handleRestart}
        onRestartBackend={handleRestartBackend}
        onLogout={handleLogout}
        onSettings={() => { setShowStatusModal(false); navigate('/settings'); }}
        restarting={restarting}
        restartingBackend={restartingBackend}
        userRole={userRole}
      />

      <SessionModal
        open={showSessionModal}
        statusType={statusType}
        statusText={statusText}
        currentSessionId={sessionState.sessionId}
        currentSessionName={sessionState.sessionName}
        compacting={sessionState.compacting}
        isActive={sessionState.isStreaming || sessionState.compacting}
        onClose={() => setShowSessionModal(false)}
        onAbort={handleAbort}
        onNewSession={handleNewSession}
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
