import React, { useState, useEffect, useCallback } from 'react';
import { Modal } from './Modal';
import { url } from '../base-path';
import type { SessionInfo } from '../types';

interface SessionModalProps {
  open: boolean;
  statusType: string;
  statusText: string;
  currentSessionId: string | null;
  currentSessionName: string | null;
  compacting?: boolean;
  isActive?: boolean; // true when agent is streaming or compacting
  onClose: () => void;
  onAbort: () => void;
  onNewSession: () => void;
  onSwitchSession: (sessionId: string) => void;
  onSessionDeleted?: () => void;
}

export const SessionModal: React.FC<SessionModalProps> = ({
  open,
  statusType,
  statusText,
  currentSessionId,
  currentSessionName,
  compacting,
  isActive,
  onClose,
  onAbort,
  onNewSession,
  onSwitchSession,
  onSessionDeleted,
}) => {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [compactLoading, setCompactLoading] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(url('/api/sessions'));
      const json = await res.json();
      if (json.success) {
        setSessions(json.data);
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    }
    setLoading(false);
  }, []);

  // Sync name input when modal opens or current name changes
  useEffect(() => {
    if (open) {
      setNameInput(currentSessionName || '');
      fetchSessions();
    }
  }, [open, currentSessionName, fetchSessions]);

  const handleSetName = useCallback(async () => {
    setNameSaving(true);
    try {
      await fetch(url('/api/session-name'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.trim() }),
      });
    } catch (err) {
      console.error('Failed to set session name:', err);
    }
    setNameSaving(false);
  }, [nameInput]);

  const formatTime = (ts: number) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  };

  const handleCompact = useCallback(async () => {
    setCompactLoading(true);
    try {
      await fetch(url('/api/compact'), { method: 'POST' });
    } catch (err) {
      console.error('Failed to compact:', err);
    }
    setCompactLoading(false);
  }, []);

  const handleDelete = useCallback(async (sessionId: string) => {
    if (!confirm('Delete this session?')) return;
    try {
      const res = await fetch(url('/api/sessions/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (data.success) {
        fetchSessions();
        onSessionDeleted?.();
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  }, [fetchSessions, onSessionDeleted]);

  const getSessionLabel = (session: SessionInfo) => {
    if (session.sessionName) return session.sessionName;
    return session.id;
  };

  return (
    <Modal open={open} onClose={onClose} className="modal-session">
      <div className="modal-header">
        <h3>
          Session
          <span className="modal-header-status">
            <span className={`connection-dot dot-${statusType === 'connected' ? 'green' : statusType === 'streaming' ? 'yellow' : statusType === 'disconnected' ? 'red' : 'gray'}`} />
            <span className="modal-header-status-text">{statusText}</span>
          </span>
        </h3>
        <button className="modal-close" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">

        <div className="modal-section">Current Session</div>
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
            disabled={nameSaving || nameInput.trim() === (currentSessionName || '')}
          >
            {nameSaving ? '…' : '✓'}
          </button>
        </div>
        <div className="session-current">
          <div className="session-current-id">{currentSessionId || '—'}</div>
        </div>

        <div className="btn-group">
          <button
            className="btn btn-abort"
            style={{ display: statusType === 'streaming' ? 'block' : 'none' }}
            onClick={onAbort}
          >
            ⏹ Abort Operation
          </button>
          <button
            className="btn btn-compact"
            onClick={handleCompact}
            disabled={compactLoading || compacting || statusType !== 'connected'}
          >
            {compacting ? '⏳ Compacting…' : compactLoading ? '⏳ Starting…' : '🗜 Compact Context'}
          </button>
          <button className="btn btn-primary" onClick={onNewSession} disabled={statusType === 'disconnected' || isActive}>
            ✨ New Session
          </button>
        </div>

        <div className="modal-section spaced">Available Sessions</div>
        {loading ? (
          <div className="session-empty">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="session-empty">No sessions found</div>
        ) : (
          <div className="session-list">
            {sessions.map((session) => {
              const isCurrentSession = session.id === currentSessionId;
              return (
                <div
                  key={session.id}
                  className={`session-item${isCurrentSession ? ' active' : ''}${!isCurrentSession && isActive ? ' disabled' : ''}`}
                  onClick={() => {
                    if (!isCurrentSession && !isActive) {
                      onSwitchSession(session.id);
                    }
                  }}
                >
                  <div className="session-item-content">
                    <div className="session-item-header">
                      <span className="session-item-name">
                        {getSessionLabel(session)}
                      </span>
                      <span className="session-item-time">{formatTime(session.lastActivity)}</span>
                    </div>
                    <div className="session-item-id">{session.id}</div>
                  </div>
                  {!isCurrentSession && (
                    <button
                      className="session-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(session.id);
                      }}
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
    </Modal>
  );
};
