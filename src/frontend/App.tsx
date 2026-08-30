import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation, Routes, Route } from 'react-router-dom';
import { LoginScreen } from './components/LoginScreen';
import { Header } from './components/Header';
import { ModelCard } from './components/ModelCard';
import { UsageCard } from './components/UsageCard';
import { ToolsCard } from './components/ToolsCard';
import { ExtensionsCard } from './components/ExtensionsCard';
import { StreamCard } from './components/StreamCard';
import { StatusModal } from './components/StatusModal';
import { SessionModal } from './components/SessionModal';

import { useSSE } from './hooks/useSSE';
import { useAuth } from './hooks/useAuth';
import { url } from './base-path';
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
} from './types';

function Dashboard() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();

  // Auth
  const { authenticated, authEnabled, loginError, checkAuthStatus, login, logout } = useAuth();
  const [authChecked, setAuthChecked] = useState(false);

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
  const [showLoginScreen, setShowLoginScreen] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const switchingRef = useRef(false);
  const localSwitchInitiatedRef = useRef(false);
  // Set by the navigate SSE handler to prevent the switch effect from firing
  // on the render triggered by navigate(), before sessionState has updated.
  const skipNextSwitchRef = useRef(false);

  const location = useLocation();

  // SSE message handler
  const restartingRef = useRef(restarting);
  restartingRef.current = restarting;

  const handleSSEMessage = useCallback((msg: SSEMessage) => {
    // Clear restarting state only once the new backend sends a status update
    // with a valid sessionId — this ensures session_start has been processed
    // and the history/state are fully loaded.
    if (restartingRef.current && msg.type === 'status' && msg.data?.sessionId) {
      setRestarting(false);
      setShowStatusModal(false);
    }
    switch (msg.type) {
      case 'status':
        setSessionState(msg.data);
        break;
      case 'new_session_creating':
        setCreatingSession(true);
        // Clear frontend state immediately
        setStreamHistory([]);
        setStats({
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
          contextUsage: null,
        });
        setActiveTools([]);
        setRecentTools([]);
        break;
      case 'navigate':
        // Backend tells us to navigate (e.g. after creating a new session).
        // The status broadcast (which updates sessionState.sessionId) was sent
        // before this, but React may not have applied the state update yet.
        // Set skipNextSwitchRef so the switch effect doesn't fire with a stale
        // sessionId during the render triggered by navigate().
        setCreatingSession(false);
        if (msg.data?.url) {
          switchingRef.current = false;
          localSwitchInitiatedRef.current = false;
          skipNextSwitchRef.current = true;
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
        if (msg.data.recentTools) {
          setRecentTools(msg.data.recentTools);
        }
        break;
      case 'extensions':
        setExtensions(msg.data || []);
        break;
    }
  }, [navigate]);

  // SSE connection
  const { connected: sseConnected, connect: sseConnect, disconnect: sseDisconnect } = useSSE({
    onMessage: handleSSEMessage,
    autoConnect: authenticated,
  });

  // Compute display status (must be after useSSE which defines sseConnected)
  const statusType = !authenticated
    ? 'disconnected'
    : !sseConnected
    ? 'disconnected'
    : restarting
    ? 'disconnected'
    : sessionState.compacting
    ? 'streaming'
    : sessionState.isStreaming
    ? 'streaming'
    : 'connected';
  const statusText = !authenticated
    ? 'Disconnected'
    : !sseConnected
    ? 'Disconnected'
    : restarting
    ? 'Disconnected'
    : sessionState.compacting
    ? 'Compacting'
    : sessionState.isStreaming
    ? 'Working'
    : 'Idle';

  // After restart reconnection, fetch session history if empty
  const wasRestartingRef = useRef(false);
  useEffect(() => {
    if (restartingRef.current) {
      wasRestartingRef.current = true;
    }
  });
  // Track SSE reconnection to refresh session list
  const wasConnectedRef = useRef(sseConnected);
  useEffect(() => {
    // When SSE transitions from disconnected to connected, refresh sessions
    if (sseConnected && !wasConnectedRef.current) {
      // Small delay to let backend finish its delayed readSessions()
      const timer = setTimeout(() => {
        fetch(url('/api/sessions'))
          .then((res) => res.json())
          .then((data) => {
            if (data.success && data.data) {
              setAvailableSessions(data.data);
            }
          })
          .catch(() => {});
      }, 1000);
      return () => clearTimeout(timer);
    }
    wasConnectedRef.current = sseConnected;
  }, [sseConnected]);

  useEffect(() => {
    if (wasRestartingRef.current && sseConnected && !restartingRef.current) {
      wasRestartingRef.current = false;
      // SSE re-established after restart — if history is empty, fetch it
      if (streamHistory.length === 0 && sessionState.sessionId) {
        fetch(url(`/api/sessions/${sessionState.sessionId}/history?limit=50`))
          .then((res) => res.json())
          .then((data) => {
            if (data.success && data.data?.length > 0) {
              setStreamHistory(data.data);
            }
          })
          .catch(() => {});
      }
      // Also refresh stats if they're zero (server-side already loaded them via SSE,
      // but as a safety net, re-fetch via the state endpoint)
      if (stats.tokens.input === 0 && sessionState.sessionId) {
        fetch(url('/api/stats'))
          .then((res) => res.json())
          .then((data) => {
            if (data.success && data.data) {
              setStats(data.data);
            }
          })
          .catch(() => {});
      }
    }
  }, [sseConnected, streamHistory.length, sessionState.sessionId, stats.tokens.input]);

  // Auth check on mount
  useEffect(() => {
    checkAuthStatus().then((ok) => {
      setAuthChecked(true);
      if (!ok) {
        setShowLoginScreen(true);
      }
    });
  }, [checkAuthStatus]);

  // Apply chat-fullscreen class on mount if stored in localStorage
  useEffect(() => {
    if (localStorage.getItem('autere-chat-fullscreen') === '1') {
      const container = document.querySelector('.container');
      if (container) container.classList.add('chat-fullscreen');
    }
  }, []);

  // After login, connect SSE and hide login screen
  useEffect(() => {
    if (authenticated) {
      setShowLoginScreen(false);
    }
  }, [authenticated]);

  // URL-driven session switching: when URL differs from current session state,
  // send a switch request to the backend.
  useEffect(() => {
    if (!authenticated || !sseConnected || !urlSessionId) return;
    if (urlSessionId === sessionState.sessionId) {
      switchingRef.current = false;
      localSwitchInitiatedRef.current = false;
      skipNextSwitchRef.current = false;
      return;
    }
    if (skipNextSwitchRef.current) return;
    if (switchingRef.current) return;
    switchingRef.current = true;
    localSwitchInitiatedRef.current = true;
    fetch(url('/api/sessions/switch-by-id'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: urlSessionId }),
    }).catch(() => { switchingRef.current = false; localSwitchInitiatedRef.current = false; });
  }, [authenticated, sseConnected, urlSessionId, sessionState.sessionId]);

  // When another tab switches sessions, update the URL to match the new session
  useEffect(() => {
    if (!authenticated || !sessionState.sessionId) return;
    if (localSwitchInitiatedRef.current) return;
    if (urlSessionId !== sessionState.sessionId) {
      navigate(`/session/${sessionState.sessionId}`, { replace: true });
    }
  }, [authenticated, sessionState.sessionId, urlSessionId, navigate]);

  const handleLogin = useCallback(async (password: string): Promise<boolean> => {
    const success = await login(password);
    if (success) {
      setShowLoginScreen(false);
    }
    return success;
  }, [login]);

  const handleLogout = useCallback(async () => {
    await logout();
    setShowStatusModal(false);
    setShowLoginScreen(true);
  }, [logout]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    // Disconnect SSE so it doesn't auto-reconnect to the dying backend
    sseDisconnect();
    try {
      await fetch(url('/api/restart'), { method: 'POST' });
    } catch (err) {
      console.error('Restart error:', err);
    }
    // Wait for the backend to fully restart, then reconnect SSE
    setTimeout(() => {
      sseConnect();
    }, 4000);
  }, [sseDisconnect, sseConnect]);

  const handleAbort = useCallback(async () => {
    try {
      await fetch(url('/api/abort'), { method: 'POST' });
    } catch (err) {
      console.error('Abort error:', err);
    }
  }, []);

  const handleNewSession = useCallback(() => {
    setStreamHistory([]);
    setStats({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsage: null,
    });
    setActiveTools([]);
    setRecentTools([]);
    setCreatingSession(true);
    setShowSessionModal(false);
    // POST to backend — it will broadcast new_session_creating + navigate events
    fetch(url('/api/new-session'), { method: 'POST' }).catch((err) => {
      console.error('Failed to create new session:', err);
      setCreatingSession(false);
    });
  }, []);

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    switchingRef.current = false;
    navigate(`/session/${sessionId}`);
    setShowSessionModal(false);
  }, [navigate]);

  const activeModelId = sessionState.model?.id || null;

  // Show loading overlay while creating a new session
  if (creatingSession) {
    return (
      <>
        <LoginScreen
          open={showLoginScreen}
          error={loginError}
          onLogin={handleLogin}
        />
        <div id="main-app" className={authenticated ? 'authenticated' : ''}>
          <div className="loading-new-session">
            <div className="loading-spinner" />
            <div className="loading-text">Creating new session…</div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <LoginScreen
        open={showLoginScreen}
        error={loginError}
        onLogin={handleLogin}
      />

      <div id="main-app" className={authenticated ? 'authenticated' : ''}>
        <Header
          statusType={statusType}
          statusText={statusText}
          onStatusClick={() => setShowStatusModal(true)}
          sessionId={sessionState.sessionId}
          sessionName={sessionState.sessionName}
          onSessionClick={() => setShowSessionModal(true)}
          externalActivity={sessionState.externalActivity}
          isActive={sessionState.isStreaming || sessionState.compacting}
        />

        <div className="container">
          <div className="cards-scroll">
            <ModelCard models={models} activeModelId={activeModelId} onModelsFetched={setModels} />
            <UsageCard
              messageCount={sessionState.messageCount}
              requestCount={sessionState.requestCount}
              stats={stats}
            />
            <ToolsCard activeTools={activeTools} recentTools={recentTools} />
            <ExtensionsCard extensions={extensions} />
          </div>

          <div className={`chat-wrapper${sessionState.externalActivity ? ' chat-external-activity' : ''}`}>
            <StreamCard messages={streamHistory} isStreaming={sessionState.isStreaming} compacting={sessionState.compacting} onNewSession={handleNewSession} />
          </div>
        </div>
      </div>

      <StatusModal
        open={showStatusModal}
        statusType={statusType}
        statusText={statusText}
        onClose={() => setShowStatusModal(false)}
        onRestart={handleRestart}
        onLogout={handleLogout}
        restarting={restarting}
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
    </>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/session/:sessionId" element={<Dashboard />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
  );
}

export default App;
