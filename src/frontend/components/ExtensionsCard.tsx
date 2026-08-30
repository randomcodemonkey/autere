import React, { useState } from 'react';
import { useCardState } from '../hooks/useCardState';
import { Modal } from './Modal';
import type { ExtensionInfo } from '../types';

interface ExtensionsCardProps {
  extensions: ExtensionInfo[];
}

export const ExtensionsCard: React.FC<ExtensionsCardProps> = ({ extensions }) => {
  const { collapsed, toggle } = useCardState('extensions');
  const [modalIdx, setModalIdx] = useState<number | null>(null);

  const openModal = (idx: number) => {
    const ext = extensions[idx];
    if (ext && ext.hasConfig && Object.keys(ext.details || {}).length > 0) {
      setModalIdx(idx);
    }
  };

  const closeModal = () => setModalIdx(null);

  const modalExt = modalIdx !== null ? extensions[modalIdx] : null;

  // Filter out internal/sensitive fields from the detail display
  const isDisplayableDetail = (key: string): boolean => {
    const hiddenKeys = ['apiKey', 'connectionError'];
    return !hiddenKeys.includes(key);
  };

  const formatValue = (key: string, val: any): string => {
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (typeof val === 'object') return JSON.stringify(val, null, 2);
    return String(val);
  };

  return (
    <>
      <div className={`card${collapsed ? ' collapsed' : ''}`}>
        <div className="card-header" onClick={toggle}>
          <div className="card-title">Extensions</div>
          <button className="card-toggle" title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
        <div>
          {(!extensions || extensions.length === 0) ? (
            <div className="ext-empty">No extensions loaded</div>
          ) : (
            extensions.map((ext, i) => {
              const hasDetails = ext.hasConfig && Object.keys(ext.details || {}).length > 0;
              const dotClass = ext.status === 'connected' ? 'dot-green'
                : ext.status === 'error' ? 'dot-red'
                : 'dot-gray';
              const statusClass = ext.status === 'connected' ? ' ext-status-connected'
                : ext.status === 'error' ? ' ext-status-error'
                : '';
              return (
                <div key={ext.name} className="ext-item">
                  <div
                    className={`ext-header${hasDetails ? ' ext-clickable' : ''}`}
                    onClick={() => hasDetails && openModal(i)}
                  >
                    <span className={`connection-dot ${dotClass}`} />
                    <span className="ext-name">{ext.displayName || ext.name}</span>
                    <span className={`ext-status${statusClass}`}>
                      {ext.status}
                    </span>
                    {hasDetails && <span className="ext-chevron">❯</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Extension Detail Modal */}
      <Modal open={!!modalExt} onClose={closeModal}>
        <div className="modal-header">
          <h3>{modalExt?.displayName || modalExt?.name || ''}</h3>
          <button className="modal-close" onClick={closeModal}>✕</button>
        </div>
        <div className="modal-body">
          {modalExt && Object.entries(modalExt.details || {})
            .filter(([key]) => isDisplayableDetail(key))
            .map(([key, val]) => (
              <div key={key} className="modal-detail-row">
                <span className="modal-detail-key">{key}</span>
                <span className="modal-detail-val">{formatValue(key, val)}</span>
              </div>
            ))
          }
          {modalExt && modalExt.status === 'error' && modalExt.details?.connectionError && (
            <div className="ext-error-detail">
              <span className="ext-error-label">Error:</span>
              <span className="ext-error-message">{modalExt.details.connectionError}</span>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
};