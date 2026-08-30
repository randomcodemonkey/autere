import React, { useState, useRef, useCallback } from 'react';
import { url } from '../base-path';

interface ChatInputProps {
  onNewSession: () => void;
  disabled?: boolean; // true when compacting — disables everything
  isStreaming?: boolean; // true when agent is streaming — shows Steer/Followup
  isActive?: boolean; // true when streaming or compacting — blocks /new command
}

// Detect touch devices: on mobile, the virtual keyboard's Return key should
// insert a newline, not submit.  Users tap the Send button instead.
const IS_TOUCH_DEVICE = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

export const ChatInput: React.FC<ChatInputProps> = ({ onNewSession, disabled, isStreaming, isActive }) => {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
    }
  }, []);

  const send = useCallback(async (type: 'prompt' | 'steer' | 'followUp') => {
    const text = value.trim();
    if (!text) return;

    if (text === '/new' || text === '/clear') {
      if (isActive) return; // don't create new session while active
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      onNewSession();
      return;
    }

    setSending(true);
    try {
      const res = await fetch(url('/api/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, type }),
      });
      const data = await res.json();
      if (data.success) {
        setValue('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        // On mobile, force the browser to recalculate layout after keyboard dismisses
        requestAnimationFrame(() => window.scrollTo(0, 0));
      }
    } catch (err) {
      console.error('Send error:', err);
    } finally {
      setSending(false);
    }
  }, [value, onNewSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (IS_TOUCH_DEVICE) return; // let the textarea insert a newline on mobile
      e.preventDefault();
      send(isStreaming ? 'steer' : 'prompt');
    }
  };

  const isDisabled = sending || disabled;

  return (
    <div className="chat-input-container">
      <textarea
        ref={textareaRef}
        className="chat-input"
        placeholder={isStreaming ? 'Steer the agent...' : 'Type a message...'}
        rows={1}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          autoResize();
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // On mobile, when the keyboard dismisses, the viewport may not
          // resize correctly, leaving a gray gap.  Scrolling to top forces
          // the browser to recalculate the layout.
          requestAnimationFrame(() => window.scrollTo(0, 0));
        }}
        disabled={isDisabled}
      />
      {isStreaming ? (
        <div className="chat-action-buttons">
          <button
            className="chat-send-btn chat-steer-btn"
            onClick={() => send('steer')}
            disabled={isDisabled || !value.trim()}
          >
            Steer
          </button>
          <button
            className="chat-send-btn chat-followup-btn"
            onClick={() => send('followUp')}
            disabled={isDisabled || !value.trim()}
          >
            Followup
          </button>
        </div>
      ) : (
        <button
          className="chat-send-btn"
          onClick={() => send('prompt')}
          disabled={isDisabled || !value.trim()}
        >
          Send
        </button>
      )}
    </div>
  );
};
