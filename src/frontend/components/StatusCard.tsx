import React, { useState, useEffect, useCallback } from 'react';
import { ModelCard } from './ModelCard';
import { UsageCard } from './UsageCard';
import { ToolsCard } from './ToolsCard';
import { ExtensionsCard } from './ExtensionsCard';
import { useCardState } from '../hooks/useCardState';
import { url } from '../base-path';
import type {
  SessionStats,
  ActiveTool,
  RecentTool,
  ExtensionInfo,
  AvailableModel,
  SessionInfo,
} from '../types';

interface StatusCardProps {
  // Session
  sessionId: string | null;
  sessionName: string | null;
  compacting: boolean;
  statusType: string;
  availableSessions: SessionInfo[];
  onNewSession: () => void;
  onAbort: () => void;
  onCompact: () => void;
  onSwitchSession: (sessionId: string) => void;
  onSessionNameSet: () => void; // called after rename so parent can refresh state
  // Stats / cards
  messageCount: number;
  requestCount: number;
  stats: SessionStats;
  activeTools: ActiveTool[];
  recentTools: RecentTool[];
  extensions: ExtensionInfo[];
  models: AvailableModel[];
  activeModelId: string | null;
  onModelsFetched: (models: AvailableModel[]) => void;
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

function formatSessionTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 60 / 24);
  return `${diffDay}d ago`;
}

export const StatusCard: React.FC<StatusCardProps> = ({
  sessionId,
  sessionName,
  compacting,
  statusType,
  availableSessions,
  onNewSession,
  onAbort,
  onCompact,
  onSwitchSession,
  onSessionNameSet,
  messageCount,
  requestCount,
  stats,
  activeTools,
  recentTools,
  extensions,
  models,
  activeModelId,
  onModelsFetched,
  username,
  userRole,
  restarting,
  restartingBackend,
  onRestart,
  onRestartBackend,
  onLogout,
}) => {
  const isAdmin = userRole === 'admin';
  const isActive = statusType === 'streaming' || compacting;
  const { collapsed: sessionCollapsed, toggle: toggleSession } = useCardState('session');
  const { collapsed: systemCollapsed, toggle: toggleSystem } = useCardState('system');

  // ── Session rename ──
  const [nameInput, setNameInput] = useState(sessionName || '');
  const [nameSaving, setNameSaving] = useState(false);
  useEffect(() => { setNameInput(sessionName || ''); }, [sessionName]);

  const handleSetName = useCallback(async () => {
    setNameSaving(true);
    try {
      await fetch(url('/api/session-name'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.trim() }),
      });
      onSessionNameSet();
    } catch (err) {
      console.error('Failed to set session name:', err);
    }
    setNameSaving(false);
  }, [nameInput, onSessionNameSet]);

  // ── Sessions list ──
  // Show the SSE-maintained list instantly and refresh in the background —
  // /api/sessions reads metadata from every session file, which can be slow.
  const [sessions, setSessions] = useState<SessionInfo[]>(availableSessions);
  const cachedSessionsRef = React.useRef(availableSessions);
  cachedSessionsRef.current = availableSessions;
  useEffect(() => {
    let cancelled = false;
    fetch(url('/api/sessions'))
      .then((res) => res.json())
      .then((data) => { if (!cancelled && data.success && data.data) setSessions(data.data); })
      .catch((err) => console.error('Failed to fetch sessions:', err));
    return () => { cancelled = true; };
  }, []);
  const handleSessionDeleted = useCallback(async (deletedId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== deletedId));
  }, []);

  const handleDeleteSession = useCallback(async (deletedId: string) => {
    if (!confirm('Delete this session?')) return;
    try {
      const res = await fetch(url('/api/sessions/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: deletedId }),
      });
      const data = await res.json();
      if (data.success) handleSessionDeleted(deletedId);
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  }, [handleSessionDeleted]);

  // ── Compact ──
  const [compactLoading, setCompactLoading] = useState(false);
  const handleCompact = useCallback(async () => {
    setCompactLoading(true);
    try { await onCompact(); } finally { setCompactLoading(false); }
  }, [onCompact]);

  // ── Uptime (polled; computed locally between polls) ──
  const [uptime, setUptime] = useState<UptimeInfo>(EMPTY_UPTIME);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let cancelled = false;
    const fetchStatus = () => {
      fetch(url('/api/status'))
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
      {/* Session */}
      <div className={`card status-card-session${sessionCollapsed ? ' collapsed' : ''}`}>
        <div className="card-header" onClick={toggleSession}>
          <span className="card-title">Session</span>
          <button className="card-toggle" title={sessionCollapsed ? 'Expand' : 'Collapse'}>{sessionCollapsed ? '▸' : '▾'}</button>
        </div>
        <div className="status-card-body">
        <div className="session-name-input-row">
          <input
            className="session-name-input"
            type="text"
            placeholder="Session label..."
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSetName(); }}
            disabled={nameSaving}
            maxLength={128}
          />
          <button
            className="session-name-save"
            onClick={handleSetName}
            disabled={nameSaving || nameInput.trim() === (sessionName || '')}
          >
            {nameSaving ? '…' : '✓'}
          </button>
        </div>
        <div className="session-current">
          <div className="session-current-id">{sessionId || '—'}</div>
        </div>
        <div className="btn-group">
          <button
            className="btn btn-abort"
            style={{ display: statusType === 'streaming' ? 'block' : 'none' }}
            onClick={onAbort}
          >
            ⏹ Abort Operation
          </button>
          <button className="btn btn-compact" onClick={handleCompact} disabled={compactLoading || compacting || statusType !== 'connected'}>
            {compacting ? '⏳ Compacting…' : compactLoading ? '⏳ Starting…' : '🗜 Compact Context'}
          </button>
          <button className="btn btn-primary" onClick={onNewSession} disabled={statusType === 'disconnected' || isActive}>
            ✨ New Session
          </button>
        </div>
        {sessions.length === 0 ? (
          <div className="session-empty">No sessions found</div>
        ) : (
          <div className="session-list">
            {sessions.map((session) => {
              const isCurrentSession = session.id === sessionId;
              return (
                <div
                  key={session.id}
                  className={`session-item${isCurrentSession ? ' active' : ''}${!isCurrentSession && isActive ? ' disabled' : ''}`}
                  onClick={() => { if (!isCurrentSession && !isActive) onSwitchSession(session.id); }}
                >
                  <div className="session-item-content">
                    <div className="session-item-header">
                      <span className="session-item-name">{session.sessionName || session.id}</span>
                      <span className="session-item-time">{formatSessionTime(session.lastActivity)}</span>
                    </div>
                    <div className="session-item-id">{session.id}</div>
                  </div>
                  {!isCurrentSession && (
                    <button
                      className="session-delete-btn"
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id); }}
                      title="Delete session"
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
      </div>

      {/* Model / Usage / Tools / Extensions */}
      <ModelCard models={models} activeModelId={activeModelId} onModelsFetched={onModelsFetched} />
      <UsageCard messageCount={messageCount} requestCount={requestCount} stats={stats} />
      <ToolsCard activeTools={activeTools} recentTools={recentTools} />
      <ExtensionsCard extensions={extensions} />

      {/* User / System */}
      <div className={`card status-card-system${systemCollapsed ? ' collapsed' : ''}`}>
        <div className="card-header" onClick={toggleSystem}>
          <span className="card-title">System</span>
          <button className="card-toggle" title={systemCollapsed ? 'Expand' : 'Collapse'}>{systemCollapsed ? '▸' : '▾'}</button>
        </div>
        <div className="status-card-body">
        <div className="modal-user-info">
          <span className="modal-username">{username || '—'}</span>
          {userRole && <span className="modal-role">{userRole}</span>}
        </div>
        <div className="modal-uptime-row">
          <span className="modal-uptime-label">pi uptime</span>
          <span className="modal-uptime-value">{formatUptime(uptime.piStartedAt, now)}</span>
        </div>
        <div className="modal-uptime-row">
          <span className="modal-uptime-label">autere uptime</span>
          <span className="modal-uptime-value">{formatUptime(uptime.autereStartedAt, now)}</span>
        </div>
        <div className="status-card-system-actions">
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
