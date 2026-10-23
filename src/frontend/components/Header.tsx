import React, { useEffect, useMemo, useRef, useState } from 'react';
import { url } from '../base-path';
import { API } from '../../shared/api-paths';
import type { SessionInfo } from '../types';
import { PinIcon } from './PinIcon';
import { apiJSON, apiSend } from '../api';

export type ViewId = 'status' | 'sessions' | 'chat' | 'settings' | 'tasks' | 'edits' | 'users' | 'user';

const VIEW_LABELS: Record<ViewId, string> = {
  status: 'Status',
  sessions: 'Sessions',
  chat: 'Chat',
  settings: 'Settings',
  tasks: 'Tasks',
  user: 'User',
  edits: 'Files',
  users: 'Users',
};

// Mobile (hamburger) menu labels — overrides for views whose desktop
// title doesn't fit the mobile top-bar context
const MOBILE_VIEW_LABELS: Partial<Record<ViewId, string>> = {
  status: 'Agent/System',
};
const mobileLabel = (id: ViewId) => MOBILE_VIEW_LABELS[id] ?? VIEW_LABELS[id];

interface HeaderProps {
  /** compacting flag of the viewed session (drives selected-tab underline) */
  sessionState?: { compacting?: boolean };
  statusType: string;
  statusText: string;
  sessionId: string | null;
  sessionName: string | null;
  activeView: ViewId;
  onViewChange: (view: ViewId) => void;
  /** Sessions ordered by recent activity; the selected one renders as the
   *  session badge/status button in place */
  runningSessions?: SessionInfo[];
  /** Tab cap (1-20, default 8); pinned sessions remain visible beyond it. */
  sessionTabLimit?: number;
  pinnedSessionFiles?: string[];
  onTogglePinnedSession?: (session: SessionInfo) => void;
  /** Receive a fresh sessions list (e.g. after deleting a tab's session) */
  onSessionsRefreshed?: (sessions: SessionInfo[]) => void;
  /** false until the first sessions list arrives — shows a loading
   *  placeholder instead of an empty tabs row */
  sessionsLoaded?: boolean;
  onRunningSessionClick?: (sessionId: string) => void;
  isActive?: boolean;
  /** Admin-only views (e.g. Users) are only rendered for this role */
  userRole?: string | null;
}

export const Header: React.FC<HeaderProps> = ({
  sessionState,
  statusType,
  sessionId,
  sessionName,
  activeView,
  onViewChange,
  runningSessions,
  sessionTabLimit = 8,
  pinnedSessionFiles,
  onTogglePinnedSession,
  onSessionsRefreshed,
  sessionsLoaded = true,
  onRunningSessionClick,
  userRole,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionsMenuOpen, setSessionsMenuOpen] = useState(false);
  // Close any open dropdown when tapping/clicking outside the header
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen && !sessionsMenuOpen) return;
    const onOutside = (e: MouseEvent | TouchEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setSessionsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('touchstart', onOutside, true);
    return () => {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('touchstart', onOutside, true);
    };
  }, [menuOpen, sessionsMenuOpen]);
  // Full UUID for unnamed sessions — CSS (ellipsis) does the truncation
  const displayName = sessionName
    ? (sessionName.length > 64 ? sessionName.slice(0, 62) + '…' : sessionName)
    : (sessionId || 'session');
  const dotClass = statusType === 'connected' ? 'green' : statusType === 'streaming' ? 'yellow' : statusType === 'disconnected' ? 'red' : 'gray';
  // Keep the viewed session in the capped tab set. Legacy ids (spawn aliases)
  // resolve to the live session by id prefix, then by session name.

  const availableTabs = useMemo(() => runningSessions ?? [], [runningSessions]);


  // Keep running sessions ahead of idle history when choosing the capped set,
  // then display that set by most recent activity. The selected session is
  // guaranteed a slot and renders as the session badge; other slots are tabs.
  // Selected session: exact id, then legacy-alias prefix (id drift on resume),
  // then name equality (reheaded sessions lose the id link). If unmatched, use
  // the header's own name for the selected slot.
  // Memoized: the effect below depends on it and tabs, so the deps must
  // not change identity every render (react-hooks/exhaustive-deps).
  const selectedEntry = useMemo(() => (sessionId
    ? availableTabs.find((s) => s.id === sessionId)
      ?? availableTabs.find((s) => sessionId.startsWith(s.id))
      ?? (sessionName ? availableTabs.find((s) => s.sessionName === sessionName) : undefined)
    : undefined)
    ?? { sessionFile: '', cwd: null, createdAt: 0, lastActivity: 0, parentSession: null, id: sessionId ?? '', sessionName: sessionName ?? null, active: false }, [availableTabs, sessionId, sessionName]);
  const pinnedSet = useMemo(() => new Set(pinnedSessionFiles ?? []), [pinnedSessionFiles]);
  const tabCap = Number.isFinite(sessionTabLimit) ? Math.max(1, Math.min(20, Math.floor(sessionTabLimit))) : 8;
  const tabs = useMemo(() => {
    if (availableTabs.length === 0) return [];
    const pinned = availableTabs.filter((s) => pinnedSet.has(s.sessionFile)).sort((a, b) =>
      (a.sessionName || a.id).localeCompare(b.sessionName || b.id, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    const running = availableTabs.filter((s) => s.active && !pinnedSet.has(s.sessionFile));
    const idle = availableTabs.filter((s) => !s.active && !pinnedSet.has(s.sessionFile));
    const remaining = Math.max(0, tabCap - pinned.length);
    const recent = [...running.slice(0, remaining), ...idle.slice(0, Math.max(0, remaining - running.length))];
    const isSelected = (s: SessionInfo) => s === selectedEntry || s.id === sessionId || !!sessionId?.startsWith(s.id);
    if (!pinned.some(isSelected) && !recent.some(isSelected)) {
      if (recent.length >= remaining && recent.length > 0) recent[recent.length - 1] = selectedEntry;
      else recent.push(selectedEntry);
    }
    recent.sort((a, b) => b.lastActivity - a.lastActivity || (a.sessionName || a.id).localeCompare(b.sessionName || b.id));
    return [...pinned, ...recent];
  }, [availableTabs, selectedEntry, sessionId, tabCap, pinnedSet]);
  // Ctrl+Shift + digit (1..9) jumps to that session tab; digits beyond the
  // rendered tabs do nothing. (Alt/opt is
  // reserved for typing special characters on many layouts.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m) return;
      const n = Number(m[1]);
      const target = tabs[n - 1];
      if (!target?.id) return;
      e.preventDefault();
      if (target === selectedEntry || target.id === sessionId) onViewChange('chat');
      else if (onRunningSessionClick) onRunningSessionClick(target.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, selectedEntry, sessionId, onViewChange, onRunningSessionClick]);
  const tabLabel = (s: SessionInfo) =>
    s.sessionName
      ? (s.sessionName.length > 64 ? s.sessionName.slice(0, 62) + '…' : s.sessionName)
      : (s.id || displayName);
  const renderPinToggle = (session: SessionInfo, className: string) => {
    if (!onTogglePinnedSession || !session.sessionFile) return null;
    const pinned = pinnedSet.has(session.sessionFile);
    const name = session.sessionName || session.id;
    return (
      <button
        type="button"
        className={`${className}${pinned ? ' pinned' : ''}`}
        aria-label={`${pinned ? 'Unpin' : 'Pin'} session ${name}`}
        aria-pressed={pinned}
        onClick={(e) => { e.stopPropagation(); onTogglePinnedSession(session); }}
      >
        <PinIcon />{className === 'session-menu-pin' && <span>{pinned ? 'Unpin' : 'Pin'}</span>}
      </button>
    );
  };

  // Users management is admin-only
  const viewIds: ViewId[] = ['status', 'sessions', 'chat', 'edits', 'settings', 'tasks', 'user'];
  if (userRole === 'admin') viewIds.push('users');

  return (
    <div ref={headerRef} className={`header${statusType === 'disconnected' ? ' header-disconnected' : ''}`}>
      <h1><img className="logo-icon" src={url('/logo.svg')} alt="autere" /> autere</h1>
      <div className="session-tabs">
        {!sessionsLoaded && <span className="session-tabs-loading">Loading sessions…</span>}
        {tabs.map((s, ti) => {
          const label = tabLabel(s);
          const fullName = s.sessionName || s.id;
          const selected = s === selectedEntry;
          return (
            <div key={s.sessionFile || s.id} className={`session-tab-item${selected ? ' selected' : ''}${pinnedSet.has(s.sessionFile) ? ' pinned' : ''}`} data-tooltip={fullName}>
              {selected ? (
                <span
                  className={`session-badge status-badge status-${statusType} session-badge-tab${statusType === 'disconnected' ? ' tab-offline' : ' tab-' + (sessionState?.compacting ? 'compacting' : statusType === 'streaming' ? 'working' : 'idle')}`}
                  aria-label={fullName}
                  onClick={() => { onViewChange('chat'); if (window.innerWidth <= 768) { setMenuOpen(false); setSessionsMenuOpen((o) => !o); } }}
                >
                  <span className={`connection-dot dot-${dotClass}`} />
                  <span className="session-badge-text">{label}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className={`session-tab ${statusType === 'disconnected' ? 'offline' : s.compacting ? 'compacting' : s.active ? (s.streaming ? 'working' : 'running') : 'idle'}`}
                  aria-label={`${fullName}${ti < 9 ? ` (Ctrl+Shift+${ti + 1})` : ''}`}
                  onClick={() => onRunningSessionClick?.(s.id)}
                >
                  <span className="session-badge-text">{label}</span>
                </button>
              )}
              {renderPinToggle(s, 'session-tab-pin')}
              {!selected && !s.streaming && !s.compacting && (
                <button
                  type="button"
                  className="session-tab-close"
                  aria-label={`Delete session ${s.sessionName || s.id}`}
                  onClick={async () => {
                    if (!window.confirm(`Delete session "${label}"? It will be moved to deleted-sessions.`)) return;
                    try {
                      await apiSend(API.sessions.item(s.id), 'DELETE');
                      onSessionsRefreshed?.(await apiJSON(API.sessions.list));
                    } catch {}
                  }}
                >
                  <svg className="session-tab-close-icon" viewBox="0 0 320 512" aria-hidden="true"><path fill="currentColor" d="M310.6 150.6c-12.5-12.5-32.8-12.5-45.3 0L160 255.9 54.6 150.6c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L114.7 301.3 9.4 406.6c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L160 346.7l105.4 105.3c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L205.3 301.3l105.3-105.4c12.5-12.5 12.5-32.8 0-45.3z"/></svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="header-menu">
        {/* Desktop: inline segmented menu (status item hidden via CSS) */}
        <nav className="view-menu" aria-label="Views">
          {viewIds.map((id) => (
            <button
              key={id}
              className={`view-btn view-btn-${id}${activeView === id ? ' active' : ''}`}
              onClick={() => onViewChange(id)}
            >
              {VIEW_LABELS[id]}
            </button>
          ))}
        </nav>

        {/* Mobile: hamburger dropdown, label shows the active view */}
        <div className="view-menu-mobile">
          <button
            className="view-menu-toggle"
            aria-label="Switch view"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => { if (!o) setSessionsMenuOpen(false); return !o; })}
          >
            <span className="view-menu-hamburger">☰</span>
            <span className="view-menu-label">{mobileLabel(activeView)}</span>
          </button>
          {menuOpen && (
            <div className="view-menu-dropdown">
              {viewIds.map((id) => (
                <button
                  key={id}
                  className={`view-menu-item${activeView === id ? ' active' : ''}`}
                  onClick={() => {
                    setMenuOpen(false);
                    if (id !== activeView) onViewChange(id);
                  }}
                >
                  {mobileLabel(id)}
                </button>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Mobile: the collapsed tab badge toggles this session dropdown */}
      {sessionsMenuOpen && (
        <div className="session-tabs-dropdown">
          {tabs.filter((s) => s !== selectedEntry).map((s) => (
            <div key={s.sessionFile || s.id} className="session-menu-item">
              <button
                type="button"
                className="session-menu-switch"
                title={s.sessionName || s.id}
                onClick={() => { setSessionsMenuOpen(false); onRunningSessionClick?.(s.id); }}
              >
                <span className={`connection-dot ${s.compacting ? 'dot-blue' : s.active ? (s.streaming ? 'dot-yellow' : 'dot-amber') : 'dot-gray'}`} />
                <span className="session-menu-item-label">{tabLabel(s)}</span>
              </button>
              {renderPinToggle(s, 'session-menu-pin')}
            </div>
          ))}
        </div>
      )}

    </div>
  );
};
