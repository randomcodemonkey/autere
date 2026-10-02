import React, { useEffect, useRef, useState } from 'react';
import { url } from '../base-path';
import { API } from '../../shared/api-paths';
import type { SessionInfo } from '../types';

export type ViewId = 'status' | 'sessions' | 'chat' | 'settings' | 'tasks' | 'edits' | 'users';

const VIEW_LABELS: Record<ViewId, string> = {
  status: 'Status',
  sessions: 'Sessions',
  chat: 'Chat',
  settings: 'Settings',
  tasks: 'Tasks',
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
  /** Running pi sessions (api order: most recent first) — up to 4 recent
   *  tabs kept alphabetically; the selected one renders as the session
   *  badge/status button in place */
  runningSessions?: SessionInfo[];
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
  statusText,
  sessionId,
  sessionName,
  activeView,
  onViewChange,
  runningSessions,
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
  // Stable membership for session tabs: the viewed session always keeps its
  // ordered slot. Legacy ids (spawn alias) resolve to the live session with
  // the same short 29-char id prefix, so switching sessions does not shuffle
  // the row — only which item renders as the badge (modal button).

  const availableTabs = runningSessions ?? [];


  // Session tabs per spec: up to 5 slots — running sessions first (api
  // order = most recent first), padded with non-running sessions to fill
  // the row when fewer than 5 running; the selected session guaranteed
  // among them (replace the last slot if the cap is full, one extra slot
  // when there is room), then sorted alphabetically. The selected slot
  // renders as the session badge (opens session chat); every other slot
  // as a running tab.
  // Selected session: exact id, then legacy-alias prefix (id drift on
  // resume), then name equality (reheaded running sessions lose the id
  // link). Not matching at all → slot labeled from the header's own name.
  const selectedEntry = (sessionId
    ? availableTabs.find((s) => s.id === sessionId)
      ?? availableTabs.find((s) => sessionId.startsWith(s.id))
      ?? (sessionName ? availableTabs.find((s) => s.sessionName === sessionName) : undefined)
    : undefined)
    ?? { sessionFile: '', cwd: null, createdAt: 0, lastActivity: 0, parentSession: null, id: sessionId ?? '', sessionName: sessionName ?? null, active: false };
  const running = availableTabs.filter((s) => s.active);
  const idle = availableTabs.filter((s) => !s.active);
  const SESSION_TAB_CAP = 8; // running + most recent idle historic sessions
  // running take precedence: keep every running slot, pad with the most
  // recent idle sessions below the cap
  let tabs = [...running.slice(0, SESSION_TAB_CAP), ...idle.slice(0, Math.max(0, SESSION_TAB_CAP - running.length))];
  if (tabs.length === 0) {
    // No sessions known yet (initial load) or none exist — no tabs at all,
    // rather than a raw synthetic id placeholder
    tabs = [];
  } else if (!tabs.some((s) => s === selectedEntry || s.id === sessionId || sessionId?.startsWith(s.id))) {
    // Replace the last slot — constant item count, never a 9th;
    // append instead when there is room below the cap.
    if (tabs.length < SESSION_TAB_CAP) {
      // selection always wins a running slot for consistency: drop the
      // tepmost idle pad if a slot was created by pad (from idle) else append
      const lastIsPad = tabs.length > running.length && tabs[tabs.length - 1] === idle[Math.min(idle.length, SESSION_TAB_CAP - running.length) - 1];
      tabs = lastIsPad ? [...tabs.slice(0, -1), selectedEntry] : [...tabs, selectedEntry];
    } else {
      tabs = [...tabs.slice(0, -1), selectedEntry];
    }
  }
  tabs = [...tabs].sort((a, b) => (a.sessionName || a.id).localeCompare(b.sessionName || b.id));
  // Ctrl+Shift + digit (1..8) jumps to that session tab; the session must be
  // known (tabs rendered) — digits beyond the cap do nothing. (Alt/opt is
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

  // Users management is admin-only
  const viewIds: ViewId[] = ['status', 'sessions', 'chat', 'edits', 'settings', 'tasks'];
  if (userRole === 'admin') viewIds.push('users');

  return (
    <div ref={headerRef} className={`header${statusType === 'disconnected' ? ' header-disconnected' : ''}`}>
      <h1><img className="logo-icon" src={url('/logo.svg')} alt="autere" /> autere</h1>
      <div className="session-tabs">
        {!sessionsLoaded && <span className="session-tabs-loading">Loading sessions…</span>}
        {tabs.map((s, ti) => {
          const label = tabLabel(s);
          return s === selectedEntry ? (
            <span
              key={s.id}
              className={`session-badge status-badge status-${statusType} session-badge-tab${statusType === 'disconnected' ? ' tab-offline' : ' tab-' + (sessionState?.compacting ? 'compacting' : statusType === 'streaming' ? 'working' : 'idle')}`}
              title={statusText}
              onClick={() => { onViewChange('chat'); if (window.innerWidth <= 768) { setMenuOpen(false); setSessionsMenuOpen((o) => !o); } }}
            >
              <span className={`connection-dot dot-${dotClass}`} />
              <span className="session-badge-text">{label}</span>
            </span>
          ) : (
            <button
              key={s.id}
              className={`session-tab ${statusType === 'disconnected' ? 'offline' : s.compacting ? 'compacting' : s.active ? (s.streaming ? 'working' : 'running') : 'idle'}`}
              title={`Switch to ${s.sessionName || s.id}${ti < 9 ? ` (Ctrl+Shift+${ti + 1})` : ''}`}
              onClick={() => onRunningSessionClick?.(s.id)}
            >
              <span className="session-badge-text">{label}</span>
              {/* Delete affordance: never on the viewed session or one with a
                  turn in flight; the tab click still switches on the delete
                  click's stopPropagation */}
              {!s.streaming && !s.compacting && (
                <span
                  className="session-tab-close"
                  title="Delete session"
                  aria-label={`Delete session ${label}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!window.confirm(`Delete session "${label}"? It will be moved to deleted-sessions.`)) return;
                    try {
                      await fetch(url(API.sessions.item(s.id)), { method: 'DELETE' });
                      const res = await fetch(url(API.sessions.list));
                      const d = await res.json();
                      if (d.success) onSessionsRefreshed?.(d.data);
                    } catch {}
                  }}
                >×</span>
              )}
            </button>
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
        <div className="session-tabs-dropdown" onClick={() => setSessionsMenuOpen(false)}>
          {tabs.filter((s) => s !== selectedEntry).map((s) => (
            <button
              key={s.id}
              className="session-menu-item"
              onClick={() => { setSessionsMenuOpen(false); onRunningSessionClick?.(s.id); }}
            >
              <span className={`connection-dot ${s.compacting ? 'dot-blue' : s.active ? (s.streaming ? 'dot-yellow' : 'dot-amber') : 'dot-gray'}`} />
              <span className="session-menu-item-label">{tabLabel(s)}</span>
            </button>
          ))}
        </div>
      )}

    </div>
  );
};
