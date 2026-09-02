import React, { useState } from 'react';
import { url } from '../base-path';

export type ViewId = 'status' | 'chat' | 'settings';

const VIEW_LABELS: Record<ViewId, string> = {
  status: 'Status',
  chat: 'Chat',
  settings: 'Settings',
};

interface HeaderProps {
  statusType: string;
  statusText: string;
  sessionId: string | null;
  sessionName: string | null;
  activeView: ViewId;
  onViewChange: (view: ViewId) => void;
  onStatusClick: () => void;
  workingExternal?: boolean;
  isActive?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  statusType,
  statusText,
  sessionId,
  sessionName,
  activeView,
  onViewChange,
  onStatusClick,
  workingExternal,
  isActive,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const displayName = sessionName
    ? (sessionName.length > 64 ? sessionName.slice(0, 62) + '…' : sessionName)
    : (sessionId ? sessionId.slice(0, 6) + '…' : 'session');
  const dotClass = statusType === 'connected' ? 'green' : statusType === 'streaming' ? 'yellow' : statusType === 'disconnected' ? 'red' : 'gray';

  const viewIds: ViewId[] = ['status', 'chat', 'settings'];

  return (
    <div className={`header${statusType === 'disconnected' ? ' header-disconnected' : ''}${workingExternal ? ' header-external' : ''}`}>
      <h1><img className="logo-icon" src={url('/logo.svg')} alt="autere" /> autere</h1>
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
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="view-menu-hamburger">☰</span>
            <span className="view-menu-label">{VIEW_LABELS[activeView]}</span>
            <span className="view-menu-caret">{menuOpen ? '▴' : '▾'}</span>
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
                  {VIEW_LABELS[id]}
                </button>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Combined session + status badge: session name/id colored by status.
          Mobile: switches to the full-screen status card. Desktop: the status
          cards are always visible — just scroll to the session card (and
          restore the chat if the status view was somehow active). */}
      <span
        className={`session-badge status-badge status-${statusType}${workingExternal ? ' status-external' : ''}`}
        title={`${statusText} — click to manage session`}
        onClick={() => {
          if (window.matchMedia('(max-width: 768px)').matches) {
            onViewChange('status');
          } else if (activeView === 'status') {
            onViewChange('chat');
          }
          onStatusClick();
        }}
      >
        {workingExternal
          ? <span className="connection-dot dot-pulse-amber" />
          : <span className={`connection-dot dot-${dotClass}`} />}
        <span className="session-badge-text">{displayName}</span>
      </span>
    </div>
  );
};
