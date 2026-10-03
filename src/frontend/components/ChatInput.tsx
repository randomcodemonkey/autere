import React, { useState, useRef, useCallback, useEffect } from 'react';
import { url } from '../base-path';
import { API } from '../api-paths';

interface AttachedFile {
  mimeType: string;
  /** base64 data without the data: URL prefix */
  data: string;
  /** Original file name — non-images render as a name chip, not a preview */
  name: string;
}

interface ChatInputProps {
  /** Opens the new-session form (does not create anything itself) */
  onNewSession: () => void;
  onCompact?: () => void;
  /** Slash commands that navigate: /settings, /tasks, /files */
  onGoToView?: (view: 'settings' | 'tasks' | 'files') => void;
  /** /model <name> — change the active model (AppPage resolves + PUTs) */
  onSetModel?: (name: string) => void;
  /** /persona <name> — bind a persona to the viewed session */
  onSetPersona?: (name: string) => void;
  /** Model ids for slash-command tab completion */
  modelNames?: string[];
  onError?: (message: string) => void;
  /** Called after a successful send with the sent text and type — used for
   * optimistic display of the user message in the chat. */
  onSent?: (text: string, type: 'prompt' | 'steer' | 'followUp') => void;
  disabled?: boolean; // true when compacting — disables everything
  isStreaming?: boolean; // true when agent is streaming — shows Steer/Followup
  isActive?: boolean; // true when streaming or compacting — blocks /new command
  steerPending?: number; // queued steer messages (from pi's queue_update)
  followUpPending?: number; // queued follow-up messages
  /** Active session id — keys the persisted input draft (survives tab navigation + reloads) */
  sessionId?: string | null;
}

// Detect touch devices: on mobile, the virtual keyboard's Return key should
// insert a newline, not submit.  Users tap the Send button instead.
const IS_TOUCH_DEVICE = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

const MAX_ATTACHED = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file — matches backend limit

/** All supported slash commands — /help lists these; Tab completes them */
const SLASH_COMMANDS: { cmd: string; use: string; description: string }[] = [
  { cmd: '/new', use: '/new', description: 'Open the new-session form.' },
  { cmd: '/clear', use: '/clear', description: 'Start a fresh session directly. Idle only.' },
  { cmd: '/compact', use: '/compact', description: 'Compact the conversation context. Idle only.' },
  { cmd: '/help', use: '/help', description: 'Show available commands.' },
  { cmd: '/settings', use: '/settings', description: 'Open settings.' },
  { cmd: '/tasks', use: '/tasks', description: 'Open scheduled tasks.' },
  { cmd: '/files', use: '/files', description: 'Open the files view.' },
  { cmd: '/model', use: '/model <name>', description: 'Change the active model.' },
  { cmd: '/persona', use: '/persona <name>', description: 'Set the persona for this session.' },
];

export const ChatInput: React.FC<ChatInputProps> = ({ onNewSession, onGoToView, onSetModel, onSetPersona, modelNames, onCompact, onError, onSent, disabled, isStreaming, isActive, steerPending, followUpPending, sessionId }) => {
  // Draft persistence: the chat view unmounts on tab navigation (edits,
  // settings, ...) and the input text would be lost. Keep it in localStorage
  // keyed by session so each session remembers its own draft. ponytail:
  // attached files are NOT persisted (10 MB base64 each would blow the
  // localStorage quota) — switch to IndexedDB if attachment-drafts are wanted.
  const draftKey = `autere:draft:${sessionId ?? ''}`;
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? '';
    } catch {
      return '';
    }
  });
  // Reload when the session changes without a remount (tab switch back,
  // session switch while chat view stays mounted).
  useEffect(() => {
    try {
      setValue(localStorage.getItem(draftKey) ?? '');
    } catch {
      /* ignore */
    }
  }, [draftKey]);
  const updateValue = useCallback(
    (v: string) => {
      setValue(v);
      try {
        localStorage.setItem(draftKey, v);
      } catch {
        /* quota/private mode — in-memory value still works */
      }
    },
    [draftKey],
  );
  const [sending, setSending] = useState(false);
  // User-dragged input height (in rows) — overrides the focused/collapsed default
  // (capped at ~half viewport height, per the textarea's CSS max-height)
  const [inputRows, setInputRows] = useState<number | null>(null);
  const [draggingInput, setDraggingInput] = useState(false);
  const dragStart = useRef<{ y: number; rows: number } | null>(null);

  // Drag-to-resize: track vertical movement while the handle is held
  useEffect(() => {
    if (!draggingInput) return;
    const lineHeight = parseFloat(getComputedStyle(textareaRef.current!).lineHeight) || 21;
    const move = (e: MouseEvent) => {
      const { y, rows } = dragStart.current!;
      // Ceiling: half the viewport in rows (matches .chat-input max-height)
      const maxRows = Math.max(4, Math.floor((window.innerHeight * 0.5) / lineHeight) - 1);
      setInputRows(Math.min(maxRows, Math.max(1, Math.round(rows - (e.clientY - y) / lineHeight))));
    };
    const up = () => setDraggingInput(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [draggingInput]);
  const [focused, setFocused] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // Persona names for /persona tab-completion (fetched once on demand)
  const personaNamesRef = useRef<string[] | null>(null);
  const [images, setImages] = useState<AttachedFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // NOTE: the textarea has a CONSTANT size in both states (1 row collapsed,
  // 4 rows expanded — set via `rows`). Overflowing text scrolls inside the
  // input. The old auto-resize-on-type grew the input row by row, which
  // resized the stream box on every new line and made the chat scroll
  // jitter up/down while typing.

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = MAX_ATTACHED - images.length;
    if (room <= 0) {
      onError?.(`At most ${MAX_ATTACHED} files can be attached.`);
      return;
    }
    const selected = Array.from(files).slice(0, room);
    for (const file of selected) {
      if (file.size > MAX_FILE_BYTES) {
        onError?.(`"${file.name}" is too large (max 10 MB).`);
        continue;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
        setImages((prev) => prev.length < MAX_ATTACHED
          ? [...prev, { mimeType: file.type || 'application/octet-stream', data: base64, name: file.name }]
          : prev);
      } catch (err) {
        console.error('Failed to read file:', err);
        onError?.(`Failed to read "${file.name}".`);
      }
    }
    // Reset so selecting the same file again still fires onChange
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [images.length, onError]);

  const send = useCallback(async (type: 'prompt' | 'steer' | 'followUp') => {
    const text = value.trim();
    if (!text && images.length === 0) return;

    // Slash commands are frontend-only — they never reach the backend/LLM.
    if (text.startsWith('/')) {
      const tokens = text.split(/\s+/);
      const cmd = tokens[0];
      const arg = tokens.slice(1).join(' ').trim();
      updateValue('');
      if (textareaRef.current) textareaRef.current.style.height = '';

      switch (cmd) {
        case '/new':
          onNewSession(); // opens the new-session form modal
          return;
        case '/clear':
          if (isActive) {
            onError?.('/clear can only be used when idle — wait for the agent to finish working.');
            return;
          }
          onNewSession();
          // /clear created a fresh session directly (legacy alias of the old /new)
          return;
        case '/help':
          setShowHelp(true);
          return;
        case '/settings':
        case '/tasks':
        case '/files':
          if (!onGoToView) {
            onError?.('Navigation is not available here.');
            return;
          }
          onGoToView(cmd === '/files' ? 'files' : cmd === '/tasks' ? 'tasks' : 'settings');
          return;
        case '/model':
          if (!onSetModel) { onError?.('Model selection is not available here.'); return; }
          if (!arg) { onError?.('Usage: /model <name>'); return; }
          onSetModel(arg);
          return;
        case '/persona':
          if (!onSetPersona) { onError?.('Persona selection is not available here.'); return; }
          if (!arg) { onError?.('Usage: /persona <name>'); return; }
          onSetPersona(arg);
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
        default:
          onError?.(`Unknown command: ${cmd}`);
          return;
      }
    }

    setSending(true);
    try {
      // Timeout guard: if the backend event loop is stalled (heavy stream,
      // memory pressure) the request can hang indefinitely — without this
      // the input stays disabled forever and only a UI reload recovers.
      const abort = new AbortController();
      const timeout = window.setTimeout(() => abort.abort(), 20_000);
      let res: Response;
      try {
        res = await fetch(url(API.session.messages), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, type, sessionId, ...(images.length > 0 ? { images } : {}) }),
          signal: abort.signal,
        });
      } finally {
        window.clearTimeout(timeout);
      }
      const data = await res.json();
      if (data.success) {
        updateValue('');
        setImages([]);
        onSent?.(text, type);
        // Collapse the expanded input and release focus so the UI returns to
        // the compact one-row state after sending (Enter submit included).
        setFocused(false);
        textareaRef.current?.blur();
        if (textareaRef.current) textareaRef.current.style.height = '';
        // On mobile, force the browser to recalculate layout after keyboard dismisses
        requestAnimationFrame(() => window.scrollTo(0, 0));
      } else {
        onError?.(data.error || 'Failed to send message.');
      }
    } catch (err) {
      console.error('Send error:', err);
      onError?.('Failed to send message.');
    } finally {
      setSending(false);
    }
  }, [value, images, onNewSession, onGoToView, onCompact, onError, onSent, isActive, updateValue, sessionId]);

  // Tab completion for slash commands (and /model, /persona arguments).
  // Completes to the longest common prefix of the candidates; a command with
  // an argument gets a trailing space so typing Tab twice walks the arg.
  const completeSlash = useCallback((val: string, update: (v: string) => void) => {
    const setC = (v: string) => { setValue(v); updateValue(v); update(v); };
    const space = val.indexOf(' ');
    if (space === -1) {
      // completing the command token
      const candidates = SLASH_COMMANDS.map((c) => c.cmd).filter((c) => c.startsWith(val));
      if (candidates.length === 0) return false;
      let lcp = candidates[0];
      for (const c of candidates.slice(1)) {
        let i = 0;
        while (i < lcp.length && i < c.length && lcp[i] === c[i]) i++;
        lcp = lcp.slice(0, i);
      }
      if (lcp.length <= val.length) return false; // no progress (ambiguous)
      setC(lcp);
      return true;
    }
    // completing an argument: only /model and /persona take free-text args
    const cmd = val.slice(0, space);
    const arg = val.slice(space + 1);
    if (cmd !== '/model' && cmd !== '/persona') return false;
    const list = cmd === '/model' ? (modelNames ?? []) : (personaNamesRef.current ?? []);
    const candidates = list.filter((n) => n.toLowerCase().startsWith(arg.toLowerCase()));
    if (candidates.length === 0) return false;
    const lower = arg.toLowerCase();
    const exact = candidates.find((n) => n.toLowerCase() === lower);
    const pick = exact ?? candidates[0];
    setC(`${cmd} ${pick}`);
    return true;
  }, [modelNames, updateValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && value.startsWith('/')) {
      const ta = textareaRef.current;
      const el = e.target as HTMLTextAreaElement;
      completeSlash(value, (v) => {
        if (ta) {
          const end = v.length;
          ta.setSelectionRange(end, end);
        }
        void el;
      });
      e.preventDefault();
      return;
    }
    // Kick off the persona-name fetch for /persona tab completion
    if (e.key === 'Tab' && value.startsWith('/persona') && personaNamesRef.current === null) {
      personaNamesRef.current = []; // sentinel while loading
      fetch(url(API.personas.root)).then((r) => r.json()).then((d) => {
        personaNamesRef.current = (d?.data ?? []).map((x: { id: string; name: string }) => x.name);
      }).catch(() => { personaNamesRef.current = []; });
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (IS_TOUCH_DEVICE) return; // let the textarea insert a newline on mobile
      e.preventDefault();
      send(isStreaming ? 'steer' : 'prompt');
    }
  };

  const isDisabled = sending || disabled;
  const canSend = !isDisabled && (value.trim().length > 0 || images.length > 0);
  const expanded = focused;

  return (
    <div className={`chat-input-container${expanded ? ' expanded' : ''}${draggingInput ? ' dragging' : ''}`}>
      <div
        className="chat-resize-handle"
        role="separator"
        aria-label="Resize chat input"
        title="Drag to resize the input"
        onMouseDown={(e) => {
          e.preventDefault(); // keep textarea selection/focus
          dragStart.current = { y: e.clientY, rows: inputRows ?? (expanded ? 4 : 1) };
          setDraggingInput(true);
        }}
      />
      {images.length > 0 && (
        <div className="chat-attachments">
          {images.map((img, i) =>
            img.mimeType.startsWith('image/') ? (
              <div key={i} className="chat-attachment">
                <img src={`data:${img.mimeType};base64,${img.data}`} alt={`attachment ${i + 1}`} />
                <button
                  type="button"
                  className="chat-attachment-remove"
                  aria-label={`Remove attachment ${i + 1}`}
                  onMouseDown={(e) => e.preventDefault()} // keep textarea focus
                  onClick={() => removeImage(i)}
                >
                  ×
                </button>
              </div>
            ) : (
              <div key={i} className="chat-attachment is-file">
                <span className="chat-file-icon">📄</span>
                <span className="chat-file-name" title={img.name}>{img.name}</span>
                <button
                  type="button"
                  className="chat-attachment-remove"
                  aria-label={`Remove ${img.name}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeImage(i)}
                >
                  ×
                </button>
              </div>
            )
          )}
        </div>
      )}
      {expanded && (
        <div className="chat-toolbar">
          <button
            type="button"
            className="chat-tool-btn"
            title="Attach files (any type, max 10 MB each)"
            aria-label="Attach files"
            onMouseDown={(e) => e.preventDefault()} // keep textarea focus (no blur collapse)
            onClick={() => fileInputRef.current?.click()}
            disabled={isDisabled || images.length >= MAX_ATTACHED}
          >
            ⬆️ Upload
          </button>
        </div>
      )}
      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder={isStreaming ? 'Steer the agent...' : 'Type a message... (/help for commands)'}
          rows={inputRows ?? (expanded ? 4 : 1)}
          value={value}
          onChange={(e) => updateValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // On mobile, when the keyboard dismisses, the viewport may not
            // resize correctly, leaving a gray gap.  Scrolling to top forces
            // the browser to recalculate the layout.
            requestAnimationFrame(() => window.scrollTo(0, 0));
          }}
          disabled={disabled}
        />
        {isStreaming ? (
          <div className="chat-action-buttons">
            <button
              className="chat-send-btn chat-steer-btn"
              onMouseDown={(e) => e.preventDefault()} // keep textarea focus (no collapse)
              onClick={() => send('steer')}
              disabled={canSend ? false : true}
            >
              Steer{steerPending ? <span className="badge warning pending-count">{steerPending}</span> : null}
            </button>
            <button
              className="chat-send-btn chat-followup-btn"
              onMouseDown={(e) => e.preventDefault()} // keep textarea focus (no collapse)
              onClick={() => send('followUp')}
              disabled={canSend ? false : true}
            >
              Follow-up{followUpPending ? <span className="badge warning pending-count">{followUpPending}</span> : null}
            </button>
          </div>
        ) : (
          <button
            className="chat-send-btn"
            onMouseDown={(e) => e.preventDefault()} // keep textarea focus (no collapse)
            onClick={() => send('prompt')}
            disabled={canSend ? false : true}
          >
            Send
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => handleFiles(e.target.files)}
      />
      {showHelp && (
        <div className="chat-help-overlay" onClick={() => setShowHelp(false)}>
          <div className="chat-help-box" onClick={(e) => e.stopPropagation()}>
            <div className="chat-help-title">Available commands</div>
            {SLASH_COMMANDS.map(({ cmd, use, description }) => (
              <div key={cmd} className="chat-help-item">
                <span className="chat-help-cmd">{use}</span>
                <span className="chat-help-desc">{description}</span>
              </div>
            ))}
            <button className="chat-help-close" onClick={() => setShowHelp(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
};
