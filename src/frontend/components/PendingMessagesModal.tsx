import React, { useState } from 'react';
import { Modal } from './Modal';

export type PendingType = 'steer' | 'followUp';

/**
 * The queued steer/follow-up messages of the running turn, as pi holds them.
 * Editing is cancel-and-requeue: if pi consumed the message before the save
 * lands, the cancel fails and the edit is dropped (the model already saw the
 * original).
 */
export const PendingMessagesModal: React.FC<{
  steer: string[];
  followUp: string[];
  onClose: () => void;
  onCancel: (text: string) => Promise<boolean>;
  onSave: (text: string, newText: string, type: PendingType) => Promise<boolean>;
}> = ({ steer, followUp, onClose, onCancel, onSave }) => {
  // Drafts keyed by type+index; the queue itself is replace-on-event state.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows: { text: string; type: PendingType }[] = [
    ...steer.map((text) => ({ text, type: 'steer' as const })),
    ...followUp.map((text) => ({ text, type: 'followUp' as const })),
  ];

  const key = (row: { text: string; type: PendingType }, i: number) => `${row.type}:${i}`;
  const draft = (row: { text: string; type: PendingType }, i: number) => drafts[key(row, i)] ?? row.text;

  const run = async (id: string, fn: () => Promise<boolean>) => {
    setBusy(id);
    setError(null);
    try {
      if (!(await fn())) setError('That message was already processed — the change was ignored.');
      else setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
    } catch {
      setError('The message was already processed — the change was ignored.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} className="modal-pending-messages">
      <div className="modal-header">
        <h3>Queued messages</h3>
        <button className="modal-close" type="button" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        {error && <div className="settings-error">{error}</div>}
        {rows.length === 0 && <div className="settings-empty">Nothing is queued for this turn.</div>}
        {rows.map((row, i) => {
          const id = key(row, i);
          return (
            <div className="pending-message" key={id}>
              <div className="pending-message-head">
                <span className={`badge ${row.type === 'steer' ? 'info' : 'warning'}`}>
                  {row.type === 'steer' ? 'Steer' : 'Follow-up'}
                </span>
                <div className="pending-message-actions">
                  <button
                    className="btn"
                    type="button"
                    disabled={busy !== null || draft(row, i).trim() === row.text.trim() || !draft(row, i).trim()}
                    onClick={() => run(id, () => onSave(row.text, draft(row, i).trim(), row.type))}
                  >
                    Save
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => run(id, () => onCancel(row.text))}
                  >
                    Cancel
                  </button>
                </div>
              </div>
              <textarea
                className="pending-message-text"
                value={draft(row, i)}
                rows={3}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [id]: e.target.value }))}
              />
            </div>
          );
        })}
      </div>
    </Modal>
  );
};
