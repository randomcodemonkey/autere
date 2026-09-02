import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route } from 'react-router-dom';
import { LoginScreen } from './components/LoginScreen';
import { DashboardPage } from './pages/DashboardPage';
import { RootRedirect } from './pages/RootRedirect';
import { NotFound } from './pages/NotFound';
import { useSSE } from './hooks/useSSE';
import { useAuth } from './hooks/useAuth';
import { url } from './base-path';
import type { SSEMessage } from './types';

function App() {
  // Auth
  const { authenticated, authEnabled, loginError, userRole, username, checkAuthStatus, login, logout } = useAuth();
  const [authChecked, setAuthChecked] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartingBackend, setRestartingBackend] = useState(false);

  const restartingRef = useRef(restarting);
  restartingRef.current = restarting;

  // Mutable ref for the active page's SSE handler.
  const pageHandlerRef = useRef<(msg: SSEMessage) => void>(() => {});

  const handleSSEMessage = useCallback((msg: SSEMessage) => {
    if (restartingRef.current && msg.type === 'status' && msg.data?.sessionId) {
      setRestarting(false);
    }
    pageHandlerRef.current(msg);
  }, []);

  const { connected: sseConnected, connecting: sseConnecting, connect: sseConnect, disconnect: sseDisconnect } = useSSE({
    onMessage: handleSSEMessage,
    autoConnect: authenticated,
  });

  // A connection attempt is in flight (initial load, SPA navigation remount,
  // or reconnect after a drop). Show "Loading" rather than "Disconnected" —
  // the backend is fine, we're just re-establishing the SSE stream.
  const sseLoading = !sseConnected && sseConnecting;
  const baseStatusType = !authenticated
    ? 'disconnected'
    : sseLoading
    ? 'loading'
    : !sseConnected
    ? 'disconnected'
    : restarting
    ? 'disconnected'
    : 'connected';
  const baseStatusText = !authenticated
    ? 'Disconnected'
    : sseLoading
    ? 'Loading…'
    : !sseConnected
    ? 'Disconnected'
    : restarting
    ? 'Disconnected'
    : 'Idle';

  useEffect(() => {
    checkAuthStatus().then((ok) => {
      setAuthChecked(true);
    });
  }, [checkAuthStatus]);

  const handleLogin = useCallback(async (user: string, password: string): Promise<boolean> => {
    return login(user, password);
  }, [login]);

  if (!authChecked) return null;

  // Unauthenticated: show ONLY the login screen. Routes (and their data
  // fetching, e.g. RootRedirect's session list) stay unmounted until login
  // succeeds — otherwise they fire 401s on page load and get stuck in
  // error states that never retry after login.
  if (!authenticated) {
    return <LoginScreen open={true} error={loginError} onLogin={handleLogin} />;
  }

  return (
    <>
      <Routes>
        <Route path="/" element={
          <RootRedirect />
        } />
        <Route path="/session/:sessionId/:view?" element={
          <DashboardPage
            authenticated={authenticated}
            username={username}
            userRole={userRole}
            logout={logout}
            sseConnected={sseConnected}
            pageHandlerRef={pageHandlerRef}
            baseStatusType={baseStatusType}
            baseStatusText={baseStatusText}
            restarting={restarting}
            setRestarting={setRestarting}
            sseDisconnect={sseDisconnect}
            sseConnect={sseConnect}
          />
        } />
        <Route path="/settings" element={<RootRedirect />} />
        <Route path="*" element={
          <NotFound />
        } />
      </Routes>
    </>
  );
}

export default App;
