import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route } from 'react-router-dom';
import { LoginScreen } from './components/LoginScreen';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
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
  const [showLoginScreen, setShowLoginScreen] = useState(false);
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
      if (!ok) setShowLoginScreen(true);
    });
  }, [checkAuthStatus]);

  useEffect(() => {
    if (authenticated) setShowLoginScreen(false);
  }, [authenticated]);

  const handleLogin = useCallback(async (user: string, password: string): Promise<boolean> => {
    const success = await login(user, password);
    if (success) setShowLoginScreen(false);
    return success;
  }, [login]);

  if (!authChecked) return null;

  return (
    <>
      <LoginScreen open={showLoginScreen} error={loginError} onLogin={handleLogin} />

      <Routes>
        <Route path="/" element={
          <RootRedirect />
        } />
        <Route path="/session/:sessionId" element={
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
        <Route path="/settings" element={
          <SettingsPage
            authenticated={authenticated}
            username={username}
            statusType={baseStatusType}
            statusText={baseStatusText}
            onStatusClick={() => {}}
            sseConnected={sseConnected}
          />
        } />
        <Route path="*" element={
          <NotFound />
        } />
      </Routes>
    </>
  );
}

export default App;
