import React from 'react';

interface StatusBadgeProps {
  status: string;
  text: string;
  externalActivity?: boolean;
  onClick?: () => void;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, text, externalActivity, onClick }) => {
  const displayText = externalActivity ? `${text} · active elsewhere` : text;
  return (
    <span
      className={`status-badge status-${status}${externalActivity ? ' status-external' : ''}`}
      title="Click to open status"
      onClick={onClick}
    >
      {externalActivity && <span className="connection-dot dot-pulse-amber" />}
      {!externalActivity && <span className={`connection-dot dot-${status === 'connected' ? 'green' : status === 'streaming' ? 'yellow' : status === 'disconnected' ? 'red' : 'gray'}`} />}
      <span>{displayText}</span>
    </span>
  );
};
