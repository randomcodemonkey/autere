import React from 'react';

interface StatusBadgeProps {
  status: string;
  text: string;
  workingExternal?: boolean;
  onClick?: () => void;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, text, workingExternal, onClick }) => {
  const displayText = workingExternal ? 'Working (external)' : text;
  return (
    <span
      className={`status-badge status-${status}${workingExternal ? ' status-external' : ''}`}
      title="Click to open status"
      onClick={onClick}
    >
      {workingExternal && <span className="connection-dot dot-pulse-amber" />}
      {!workingExternal && <span className={`connection-dot dot-${status === 'connected' ? 'green' : status === 'streaming' ? 'yellow' : status === 'disconnected' ? 'red' : 'gray'}`} />}
      <span>{displayText}</span>
    </span>
  );
};
