import { useState, useEffect, useRef, useCallback } from 'react';
import type { SSEMessage } from '../types';
import { url } from '../base-path';

interface UseSSEOptions {
  onMessage?: (msg: SSEMessage) => void;
  autoConnect?: boolean;
}

const HEARTBEAT_INTERVAL = 3000; // backend sends heartbeat every 3s
const HEARTBEAT_TIMEOUT = 6000;  // consider dead if no heartbeat within 6s (2 missed)

export function useSSE(options: UseSSEOptions = {}) {
  const { onMessage, autoConnect = true } = options;
  const [connected, setConnected] = useState(false);
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
        console.log(`[autere] No heartbeat for ${Math.round(elapsed / 1000)}s, marking disconnected`);
        connectedRef.current = false;
        setConnected(false);
        // Force-close the EventSource to trigger reconnect
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
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
    }

    const es = new EventSource(url('/events'));
    eventSourceRef.current = es;

    es.onopen = () => {
      connectedRef.current = true;
      setConnected(true);
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
  }, [stopHeartbeatCheck]);

  useEffect(() => {
    if (autoConnect) {
      connect();
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
        connect();
      }, timeout);
      return () => clearTimeout(timer);
    }
  }, [connected, reconnectAttempts, connect]);

  // Reconnect when page becomes visible again (e.g. phone screen unlocked)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !connectedRef.current && autoConnect) {
        console.log('[autere] Page became visible, reconnecting...');
        connect();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
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

  return { connected, connect, disconnect, reconnectAttempts };
}
