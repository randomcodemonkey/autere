import React, { useState, useEffect } from 'react';
import { AgentCard } from './AgentCard';
import { useCardState } from '../hooks/useCardState';
import { url } from '../base-path';
import { API } from '../api-paths';
import type {
  SessionStats,
  ExtensionInfo,
  AvailableModel,
} from '../types';

interface StatusCardProps {
  statusType: string;
  // Stats / cards
  messageCount: number;
  requestCount: number;
  stats: SessionStats;
  extensions: ExtensionInfo[];
  models: AvailableModel[];
  activeModelId: string | null;
  onModelsFetched: (models: AvailableModel[]) => void;
  /** Persona bound to the active session */
  persona: { id: string; name: string } | null | undefined;
  /** False = the viewed session has no live pi process (idle, disk-only) */
  sessionActive?: boolean;
  /** Spawns the session's pi process (the "Load" click on an idle session) */
  onActivateSession?: () => void;
  /** Compact-context action, shown in the Usage card */
  onCompact?: () => void;
  compacting?: boolean;
  /** Abort the running operation — shown in the Usage card */
  onAbort?: () => void;
  isStreaming?: boolean;
  // System / user
  username: string | null;
  userRole: string | null;
  restarting: boolean;
  restartingBackend: boolean;
  onRestart: () => void;
  onRestartBackend: () => void;
  onLogout: () => void;
}

interface UptimeInfo {
  autereStartedAt: number | null;
  piStartedAt: number | null;
}

const EMPTY_UPTIME: UptimeInfo = { autereStartedAt: null, piStartedAt: null };

// Build id injected by Vite (see vite.config.ts define) — an ISO timestamp
// of the build. Shown in the System card so a client can verify which UI
// version it is running; formatted client-side into the viewer's timezone.
declare const __BUILD_ID__: string;
function formatBuildId(): string {
  // Component tests mount the source without Vite's define — fall back
  if (typeof __BUILD_ID__ === 'undefined') return 'dev';
  const d = new Date(__BUILD_ID__);
  return isNaN(d.getTime()) ? __BUILD_ID__ : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

function formatUptime(startedAt: number | null, now: number): string {
  if (!startedAt) return '—';
  let s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}


export const StatusCard: React.FC<StatusCardProps> = ({

  statusType,
  messageCount,
  requestCount,
  stats,
  extensions,
  models,
  activeModelId,
  onModelsFetched,
  persona,
  sessionActive = true,
  onActivateSession,
  onCompact,
  compacting,
  onAbort,
  isStreaming,
  username,
  userRole,
  restarting,
  restartingBackend,
  onRestart,
  onRestartBackend,
  onLogout,
}) => {
  const isAdmin = userRole === 'admin';

  const { collapsed: systemCollapsed, toggle: toggleSystem } = useCardState('system');

  // ── Uptime (polled; computed locally between polls) ──
  const [uptime, setUptime] = useState<UptimeInfo>(EMPTY_UPTIME);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let cancelled = false;
    const fetchStatus = () => {
      fetch(url(API.status))
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled && data.success && data.data) {
            setUptime(data.data);
            setNow(Date.now());
          }
        })
        .catch((err) => console.error('Failed to fetch status:', err));
    };
    fetchStatus();
    const poll = setInterval(fetchStatus, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  return (
    <>
      {/* Idle session: no pi process — offer to load one instead of the
          live agent cards (which would show misleading zeros). */}
      {!sessionActive && (
        <div className="card status-card-inactive">
          <span>Inactive session — the pi process is not running.</span>
          <button className="btn btn-primary" onClick={onActivateSession}>Load status</button>
        </div>
      )}
      {sessionActive && (
      /* Agent: Model / Extensions / Tools / Usage grouped in one card */
      <AgentCard
        models={models}
        activeModelId={activeModelId}
        onModelsFetched={onModelsFetched}
        messageCount={messageCount}
        requestCount={requestCount}
        stats={stats}
        extensions={extensions}
        persona={persona}
        onCompact={onCompact}
        compactDisabled={compacting || statusType !== 'connected'}
        compacting={compacting}
        onAbort={onAbort}
        isStreaming={isStreaming}
      />
      )}

      {/* User / System */}
      <div className={`card status-card-system${systemCollapsed ? ' collapsed' : ''}`}>
        <div className="card-header" onClick={toggleSystem}>
          <span className="card-title">System</span>
          <button className="card-toggle" title={systemCollapsed ? 'Expand' : 'Collapse'}>{systemCollapsed ? '▸' : '▾'}</button>
        </div>
        <div className="status-card-body">
        <div className="modal-user-info">
          <span className="modal-username">{username || '—'}</span>
          {userRole && <span className="badge">{userRole}</span>}
        </div>
        <div className="modal-uptime-row">
          <span className="modal-uptime-label">pi uptime</span>
          <span className="modal-uptime-value">{formatUptime(uptime.piStartedAt, now)}</span>
        </div>
        <div className="modal-uptime-row">
          <span className="modal-uptime-label">autere uptime</span>
          <span className="modal-uptime-value">{formatUptime(uptime.autereStartedAt, now)}</span>
        </div>
        <div className="modal-uptime-row">
          <span className="modal-uptime-label">UI build</span>
          <span className="modal-uptime-value">{formatBuildId()}</span>
        </div>
        <div className="status-card-system-actions">
          <button className="btn btn-default" onClick={() => window.location.reload()}>⟲ Reload UI</button>
          <button className="btn btn-default" onClick={onLogout}>🔒 Logout</button>
          <button className="btn btn-danger" onClick={onRestart} disabled={restarting}>{restarting ? '⟳ Restarting…' : '⟳ Restart PI'}</button>
          {isAdmin && (
            <button className="btn btn-danger" onClick={onRestartBackend} disabled={restartingBackend}>{restartingBackend ? '⟳ Restarting…' : '⟳ Restart Autere'}</button>
          )}
        </div>
        </div>
      </div>
    </>
  );
};
