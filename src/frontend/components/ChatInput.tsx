import React, { useState, useRef, useCallback } from 'react';
import { url } from '../base-path';

interface ChatInputProps {
  onNewSession: () => void;
  onCompact?: () => void;
  onError?: (message: string) => void;
  disabled?: boolean; // true when compacting — disables everything
  isStreaming?: boolean; // true when agent is streaming — shows Steer/Followup
  isActive?: boolean; // true when streaming or compacting — blocks /new command
  steerPending?: number; // queued steer messages (from pi's queue_update)
  followUpPending?: number; // queued follow-up messages
}

// Detect touch devices: on mobile, the virtual keyboard's Return key should
// insert a newline, not submit.  Users tap the Send button instead.
const IS_TOUCH_DEVICE = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

/** Available slash commands, shown by /help */
const SLASH_COMMANDS: { cmd: string; description: string }[] = [
  { cmd: '/new', description: 'Start a new session (alias: /clear). Idle only.' },
  { cmd: '/compact', description: 'Compact the conversation context. Idle only.' },
  { cmd: '/help', description: 'Show available commands.' },
];

export const ChatInput: React.FC<ChatInputProps> = ({ onNewSession, onCompact, onError, disabled, isStreaming, isActive, steerPending, followUpPending }) => {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
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

    // Slash commands are frontend-only — they never reach the backend/LLM.
    if (text.startsWith('/')) {
      const [cmd] = text.split(/\s+/);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';

      switch (cmd) {
        case '/new':
        case '/clear':
          if (isActive) {
            onError?.('/new can only be used when idle — wait for the agent to finish working.');
            return;
          }
          onNewSession();
          return;
        case '/compact':
          if (isActive) {
            onError?.('/compact can only be used when idle — wait for the agent to finish working.');
            return;
          }
          if (!onCompact) {
            onError?.('/compact is not available.');
            return;
          }
          onCompact();
          return;
        case '/help':
          setShowHelp(true);
          return;
        default:
          onError?.(`Unknown command: ${cmd} — type /help to see available commands.`);
          return;
      }
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
  }, [value, onNewSession, onCompact, onError, isActive]);

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
        placeholder={isStreaming ? 'Steer the agent...' : 'Type a message... (/help for commands)'}
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
      {showHelp && (
        <div className="chat-help-overlay" onClick={() => setShowHelp(false)}>
          <div className="chat-help-box" onClick={(e) => e.stopPropagation()}>
            <div className="chat-help-title">Available commands</div>
            {SLASH_COMMANDS.map(({ cmd, description }) => (
              <div key={cmd} className="chat-help-item">
                <span className="chat-help-cmd">{cmd}</span>
                <span className="chat-help-desc">{description}</span>
              </div>
            ))}
            <button className="chat-help-close" onClick={() => setShowHelp(false)}>Close</button>
          </div>
        </div>
      )}
      {isStreaming ? (
        <div className="chat-action-buttons">
          <button
            className="chat-send-btn chat-steer-btn"
            onClick={() => send('steer')}
            disabled={isDisabled || !value.trim()}
          >
            Steer{steerPending ? <span className="badge warning pending-count">{steerPending}</span> : null}
          </button>
          <button
            className="chat-send-btn chat-followup-btn"
            onClick={() => send('followUp')}
            disabled={isDisabled || !value.trim()}
          >
            Follow-up{followUpPending ? <span className="badge warning pending-count">{followUpPending}</span> : null}
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
