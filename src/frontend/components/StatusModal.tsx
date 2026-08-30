import React from 'react';
import { Modal } from './Modal';
import { url } from '../base-path';

interface StatusModalProps {
  open: boolean;
  statusType: string;
  statusText: string;
  username?: string | null;
  onClose: () => void;
  onRestart: () => void;
  onRestartBackend?: () => void;
  onLogout: () => void;
  restarting?: boolean;
  userRole?: string | null;
}

export const StatusModal: React.FC<StatusModalProps> = ({
  open,
  statusType,
  statusText,
  username,
  onClose,
  onRestart,
  onRestartBackend,
  onLogout,
  restarting = false,
  userRole,
}) => {
  const isAdmin = userRole === 'admin';

  return (
    <Modal open={open} onClose={onClose} className="modal-status">
      <div className="modal-header">
        <h3>
          <img className="modal-header-logo" src={url('/logo.svg')} alt="autere" /> Status
          <span className="modal-header-status">
            <span className={`connection-dot dot-${statusType === 'connected' ? 'green' : statusType === 'streaming' ? 'yellow' : statusType === 'disconnected' ? 'red' : 'gray'}`} />
            <span className="modal-header-status-text">{statusText}</span>
          </span>
        </h3>
        <button className="modal-close" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        <div className="modal-section">User info</div>
        <div className="modal-user-info">
          <span className="modal-username">{username || '—'}</span>
          {userRole && <span className="modal-role">{userRole}</span>}
        </div>
        <button className="btn btn-default" onClick={onLogout}>🔒 Logout</button>
        <div className="modal-section spaced">System</div>
        <button className="btn btn-danger" onClick={onRestart} disabled={restarting}>{restarting ? '⟳ Restarting…' : '⟳ Restart PI'}</button>
        {isAdmin && onRestartBackend && (
          <button className="btn btn-danger" style={{ marginTop: '0.5rem' }} onClick={onRestartBackend} disabled={restarting}>⟳ Restart Autere</button>
        )}
      </div>
    </Modal>
  );
};
