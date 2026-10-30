import React, { useEffect, useState } from 'react';
import { Modal } from './Modal';
import type { ExtensionUiRequest } from '../types';

/**
 * pi's extension UI dialogs (select/confirm/input/editor) block the extension
 * and the turn until a client answers with extension_ui_response. Render the
 * request and send the answer back; closing the dialog cancels it.
 */
export const ExtensionUiModal: React.FC<{
  request: ExtensionUiRequest | null;
  onRespond: (payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}> = ({ request, onRespond }) => {
  const [text, setText] = useState('');

  useEffect(() => {
    setText(request?.method === 'editor' ? request.prefill || '' : '');
  }, [request?.id, request?.method, request?.prefill]);

  if (!request) return null;
  const cancel = () => onRespond({ cancelled: true });
  const submit = () => onRespond({ value: text });

  return (
    <Modal open onClose={cancel} className="modal-extension-ui">
      <div className="modal-header">
        <h3>{request.title || 'Extension request'}</h3>
        <button className="modal-close" type="button" onClick={cancel}>✕</button>
      </div>
      <div className="modal-body">
        {request.message && <div className="extension-ui-message">{request.message}</div>}

        {request.method === 'select' && (
          <div className="extension-ui-options">
            {(request.options || []).map((option) => (
              <button key={option} className="btn" type="button" onClick={() => onRespond({ value: option })}>
                {option}
              </button>
            ))}
            {(request.options || []).length === 0 && <div className="settings-empty">No options offered.</div>}
          </div>
        )}

        {request.method === 'input' && (
          <input
            className="settings-input"
            type="text"
            autoFocus
            value={text}
            placeholder={request.placeholder || ''}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          />
        )}

        {request.method === 'editor' && (
          <textarea
            className="settings-input extension-ui-editor"
            autoFocus
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}

        <div className="btn-group">
          {request.method === 'confirm' && (
            <>
              <button className="btn btn-primary" type="button" onClick={() => onRespond({ confirmed: true })}>Yes</button>
              <button className="btn" type="button" onClick={() => onRespond({ confirmed: false })}>No</button>
            </>
          )}
          {(request.method === 'input' || request.method === 'editor') && (
            <>
              <button className="btn btn-primary" type="button" onClick={submit}>Submit</button>
              <button className="btn" type="button" onClick={cancel}>Cancel</button>
            </>
          )}
          {request.method === 'select' && (
            <button className="btn" type="button" onClick={cancel}>Cancel</button>
          )}
        </div>

        {typeof request.timeout === 'number' && request.timeout > 0 && (
          <div className="settings-description">
            pi resolves this automatically after {Math.max(1, Math.round(request.timeout / 1000))}s.
          </div>
        )}
      </div>
    </Modal>
  );
};
