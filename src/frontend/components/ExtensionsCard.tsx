import React, { useCallback, useEffect, useState } from 'react';
import { useCardState } from '../hooks/useCardState';
import { Modal } from './Modal';
import { url } from '../base-path';
import type { ExtensionInfo } from '../types';
import type { ExtensionSection } from '../types';
import { formatTimestamp } from './ChatMessage';

/** Clock time today, date + time otherwise — for last-active stamps. */
const formatLastActive = (ts?: number): string => {
  if (!ts) return '-';
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
};

interface ExtensionsCardProps {
  extensions: ExtensionInfo[];
}

export const ExtensionsCard: React.FC<ExtensionsCardProps> = ({ extensions }) => {
  const { collapsed, toggle } = useCardState('extensions');
  const [modalIdx, setModalIdx] = useState<number | null>(null);

  // The shared state copy carries only zero placeholders for per-user
  // extensions (enrich is user-agnostic by design) — /api/extensions is the
  // per-request injection point for the real stats.
  const [patched, setPatched] = useState<ExtensionInfo[] | null>(null);
  const fetchPatched = useCallback(() => {
    fetch(url('/api/extensions'))
      .then((r) => r.json())
      .then((res) => {
        if (res?.success && Array.isArray(res.data)) setPatched(res.data);
      })
      .catch(() => { /* fall back to the state copy */ });
  }, []);
  useEffect(() => {
    fetchPatched();
  }, [extensions, fetchPatched]);

  // Janitor sweeps / dedup elisions write their stats files server-side with
  // no push event — poll while the detail modal is open so the numbers
  // (and the session rows) update without a UI reload. Stats change on turn
  // boundaries, so 3s granularity is plenty.
  const modalOpen = modalIdx !== null;
  useEffect(() => {
    if (!modalOpen) return;
    const t = setInterval(fetchPatched, 3000);
    return () => clearInterval(t);
  }, [modalOpen, fetchPatched]);
  const list = patched ?? extensions;

  // Extensions with a known runtime status — surfaced as counts in the
  // card title (matching the Tools card's badge style).
  const availableCount = list.filter((e) => e.status === 'ok').length;
  const errorCount = list.filter((e) => e.status === 'error').length;

  const openModal = (idx: number) => {
    const ext = list[idx];
    const hasContent = (ext.hasConfig && Object.keys(ext.details || {}).length > 0)
      || (ext.sections && ext.sections.length > 0);
    if (hasContent) {
      setModalIdx(idx);
    }
  };

  const closeModal = () => setModalIdx(null);

  const modalExt = modalIdx !== null ? list[modalIdx] : null;

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
          <div className="card-title">
            Extensions
            {collapsed && availableCount > 0 && (
              <span className="badge success" title={`${availableCount} available`}>{availableCount}</span>
            )}
            {collapsed && errorCount > 0 && (
              <span className="badge danger" title={`${errorCount} in error`}>{errorCount}</span>
            )}
          </div>
          <button className="card-toggle" title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
        <div>
          {(!list || list.length === 0) ? (
            <div className="ext-empty">No extensions loaded</div>
          ) : (
            list.map((ext, i) => {
              const hasDetails = (ext.hasConfig && Object.keys(ext.details || {}).length > 0)
                || (ext.sections && ext.sections.length > 0);
              // Backend decides status (ok/error/neutral) and text — we
              // only map the machine state to presentation classes.
              const dotClass = ext.status === 'ok' ? 'dot-green'
                : ext.status === 'error' ? 'dot-red'
                : 'dot-gray';
              const statusClass = ext.status === 'ok' ? 'success'
                : ext.status === 'error' ? 'danger'
                : '';
              const statusText = ext.statusText || ext.status;
              return (
                <div key={ext.name} className="ext-item">
                  <div
                    className={`ext-header${hasDetails ? ' ext-clickable' : ''}`}
                    onClick={() => hasDetails && openModal(i)}
                  >
                    <span className={`connection-dot ${dotClass}`} />
                    <span className="ext-name">{ext.displayName || ext.name}</span>
                    <span className={`badge ${statusClass}`}>
                      {statusText}
                    </span>
                    {/* Always rendered: reserves the chevron column so badges align across rows */}
                    <span className="ext-chevron" style={hasDetails ? undefined : { visibility: 'hidden' }}>❯</span>
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
          {modalExt && modalExt.sections && modalExt.sections.map((section: ExtensionSection, si: number) => (
            <div key={si} className="ext-section">
              <div className="ext-section-header">{section.header}</div>
              {section.items.length === 0 ? (
                <div className="ext-section-empty">No data</div>
              ) : (
                <div className="ext-section-list">
                  {section.items.map((item: Record<string, any>, ii: number) => (
                    <div key={ii} className="ext-section-item">
                      {Object.entries(item).map(([k, v]) => (
                        <div key={k} className="ext-section-field">
                          <span className="ext-section-field-key">{k}</span>
                          <span className="ext-section-field-val">
                            {k === 'Last active' && typeof v === 'number' ? formatLastActive(v)
                              : k === 'Time' && typeof v === 'number' ? formatTimestamp(v)
                              : String(v ?? '-')}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
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