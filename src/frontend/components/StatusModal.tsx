import React from 'react';
import { Modal } from './Modal';
import { url } from '../base-path';

interface StatusModalProps {
  open: boolean;
  statusType: string;
  statusText: string;
  onClose: () => void;
  onRestart: () => void;
  onLogout: () => void;
  restarting?: boolean;
}

export const StatusModal: React.FC<StatusModalProps> = ({
  open,
  statusType,
  statusText,
  onClose,
  onRestart,
  onLogout,
  restarting = false,
}) => {
  return (
    <Modal open={open} onClose={onClose} className="modal-status">
      <div className="modal-header">
        <h3><img className="modal-header-logo" src={url('/logo.svg')} alt="autere" /> Status</h3>
        <button className="modal-close" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        <div className="modal-status-connection">
          <span className={`connection-dot dot-${statusType === 'connected' ? 'green' : statusType === 'streaming' ? 'yellow' : statusType === 'disconnected' ? 'red' : 'gray'}`} />
          <span className="modal-status-text">{statusText}</span>
        </div>
        <div className="modal-section">User</div>
        <button className="btn btn-default" onClick={onLogout}>🔒 Logout</button>
        <div className="modal-section spaced">System</div>
        <button className="btn btn-danger" onClick={onRestart} disabled={restarting}>{restarting ? '⟳ Restarting…' : '⟳ Restart PI'}</button>
      </div>
    </Modal>
  );
};
