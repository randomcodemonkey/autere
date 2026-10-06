import { useState, useEffect, useRef, useCallback } from 'react';
import type { SSEMessage } from '../types';
import { url } from '../base-path';
import { API } from '../api-paths';
import { getClientId } from '../client-id';

interface UseSSEOptions {
  onMessage?: (msg: SSEMessage) => void;
  autoConnect?: boolean;
}

const _HEARTBEAT_INTERVAL = 3000; // backend sends heartbeat every 3s
const HEARTBEAT_TIMEOUT = 20000; // consider dead if no heartbeat within 20s — mobile browsers suspend JS timers when backgrounded, so short timeouts cause false "disconnected" on return
const MAX_SILENT_ATTEMPTS = 4;   // reconnect attempts before showing Disconnected (≈2+4+6+8s ≈ 20s)

export function useSSE(options: UseSSEOptions = {}) {
  const { onMessage, autoConnect = true } = options;
  const [connected, setConnected] = useState(false);
  // True while a connection attempt is in flight (initial connect or
  // reconnect). Lets the UI show "Loading" instead of "Disconnected" for
  // transient cases like SPA navigation or a full page (re)load, where the
  // SSE connection is simply being re-established. Initialized to autoConnect
  // so the very first render (before the connect effect runs) already counts
  // as "connecting", not "disconnected" — otherwise a full page load flashes
  // Disconnected before the SSE stream opens.
  const [connecting, setConnecting] = useState(autoConnect);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onMessageRef = useRef(onMessage);
  const lastHeartbeatRef = useRef<number>(Date.now());
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectedRef = useRef(false);
  onMessageRef.current = onMessage;

  // Check for missed heartbeats
  const startHeartbeatCheck = useCallback(() => {
    lastHeartbeatRef.current = Date.now();
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - lastHeartbeatRef.current;
      if (elapsed > HEARTBEAT_TIMEOUT && connectedRef.current) {
        console.log(`[autere] No heartbeat for ${Math.round(elapsed / 1000)}s, reconnecting`);
        connectedRef.current = false;
        setConnected(false);
        setConnecting(true); // show Loading/Reconnecting, not Disconnected
        // Force-close the EventSource to trigger reconnect via backoff
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        setReconnectAttempts((prev) => prev + 1);
      }
    }, 1000); // check every 1s
  }, []);

  const stopHeartbeatCheck = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      // Report the dip: replacing an open stream otherwise keeps `connected`
      // true across the gap, useSessionStream never sees the false→true
      // transition, and its reconnect bootstrap (the ONLY healing for the
      // live-only SSE stream) never runs — events lost in the gap are lost
      // forever (stuck 'Working', missing assistant turns).
      if (connectedRef.current) {
        connectedRef.current = false;
        setConnected(false);
      }
    }

    setConnecting(true);
    const es = new EventSource(url(`${API.events}?clientId=${encodeURIComponent(getClientId())}`));
    eventSourceRef.current = es;

    es.onopen = () => {
      connectedRef.current = true;
      setConnected(true);
      setConnecting(false);
      setReconnectAttempts(0);
      startHeartbeatCheck();
    };

    es.onmessage = (e) => {
      try {
        const msg: SSEMessage = JSON.parse(e.data);
        // Track heartbeats
        if (msg.type === 'heartbeat') {
          lastHeartbeatRef.current = Date.now();
          return; // don't forward to app
        }
        onMessageRef.current?.(msg);
      } catch {}
    };

    es.onerror = () => {
      connectedRef.current = false;
      setConnected(false);
      // Stay in "connecting" (shown as Loading/Reconnecting) during the
      // backoff retries — a dropped SSE stream is almost always transient
      // (sleep/wake, network blip, backend restart). Only surface
      // "Disconnected" after several consecutive failed attempts.
      stopHeartbeatCheck();
      es.close();
      setReconnectAttempts((prev) => prev + 1);
    };
  }, [startHeartbeatCheck, stopHeartbeatCheck]);

  const disconnect = useCallback(() => {
    stopHeartbeatCheck();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);
    setConnecting(false);
  }, [stopHeartbeatCheck]);

  useEffect(() => {
    if (autoConnect) {
      setConnecting(true);
      connect();
    } else {
      setConnecting(false);
    }
    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  // Reconnect with backoff on error
  useEffect(() => {
    if (!connected && reconnectAttempts > 0) {
      const timeout = Math.min(2000 * reconnectAttempts, 10000);
      const timer = setTimeout(() => {
        // Give up showing 'Loading': connecting flag by the matched attempts.
        // connect() sets connecting=true itself — order matters, or the
        // batched update wins and the badge stays blue 'Loading…' forever
        // instead of surfacing Disconnected (backend killed, no respawn).
        const silent = reconnectAttempts >= MAX_SILENT_ATTEMPTS;
        connect();
        if (silent) setConnecting(false);
      }, timeout);
      return () => clearTimeout(timer);
    }
  }, [connected, reconnectAttempts, connect]);

  // Reconnect when page becomes visible again (e.g. phone screen unlocked)
  useEffect(() => {
    let lastResume = 0;
    const handleResume = () => {
      // visibilitychange, pageshow and focus fire together on resume (when
      // they fire at all — iOS standalone PWAs sometimes skip visibilitychange
      // on snapshot resume) — dedupe so the logic runs once per wake.
      const now = Date.now();
      if (now - lastResume < 2000) return;
      lastResume = now;
      if (!autoConnect) return;
      if (!connectedRef.current) {
        console.log('[autere] Page became visible, reconnecting...');
        connect();
        return;
      }
      if (Date.now() - lastHeartbeatRef.current > HEARTBEAT_TIMEOUT) {
        // Zombie EventSource: browser kept the socket "open" through
        // suspension but no heartbeats arrived. Force a reconnect so the
        // post-reconnect bootstrap refreshes stats/history/pending state.
        console.log('[autere] Page visible with stale heartbeat, forcing reconnect');
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        connectedRef.current = false;
        setConnected(false);
        connect();
      }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') handleResume(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', handleResume);
    window.addEventListener('focus', handleResume);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', handleResume);
      window.removeEventListener('focus', handleResume);
    };
  }, [autoConnect, connect]);

  // Periodic polling to detect and recover from silent disconnections
  useEffect(() => {
    if (!autoConnect) return;
    const interval = setInterval(() => {
      if (!connectedRef.current && !eventSourceRef.current) {
        console.log('[autere] Polling: not connected, attempting reconnect...');
        connect();
      }
    }, 15000); // check every 15s
    return () => clearInterval(interval);
  }, [autoConnect, connect]);

  return { connected, connecting, connect, disconnect };
}
