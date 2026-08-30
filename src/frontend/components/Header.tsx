import React from 'react';
import { StatusBadge } from './StatusBadge';
import { url } from '../base-path';

interface HeaderProps {
  statusType: string;
  statusText: string;
  onStatusClick: () => void;
  sessionId: string | null;
  sessionName: string | null;
  onSessionClick: () => void;
  externalActivity?: boolean;
  isActive?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ statusType, statusText, onStatusClick, sessionId, sessionName, onSessionClick, externalActivity, isActive }) => {
  const displayName = sessionName
    ? (sessionName.length > 64 ? sessionName.slice(0, 62) + '…' : sessionName)
    : (sessionId ? sessionId.slice(0, 6) + '…' : 'session');
  return (
    <div className={`header${statusType === 'disconnected' ? ' header-disconnected' : ''}${externalActivity ? ' header-external' : ''}`}>
      <h1><img className="logo-icon" src={url('/logo.svg')} alt="autere" /> autere</h1>
      <div>
        <span
          className="session-badge"
          title="Click to manage session"
          onClick={onSessionClick}
        >
          <span className="session-badge-icon">◉</span>
          <span className="session-badge-text">{displayName}</span>
        </span>
        <StatusBadge status={statusType} text={statusText} externalActivity={externalActivity} onClick={onStatusClick} />
      </div>
    </div>
  );
};
