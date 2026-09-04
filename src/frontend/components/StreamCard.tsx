import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { url } from '../base-path';
import type { StreamMessage, AvailableModel } from '../types';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';

interface StreamCardProps {
  messages: StreamMessage[];
  isStreaming: boolean;
  compacting?: boolean;
  onNewSession: () => void;
  onCompact?: () => void;
  onCommandError?: (message: string) => void;
  steerPending?: number;
  followUpPending?: number;
  model?: { provider: string; id: string; name: string } | null;
  externalActivity?: boolean;
  models?: AvailableModel[];
  activeModelId?: string | null;
  onModelsFetched?: (models: AvailableModel[]) => void;
}

/** Truncation limits per role (characters), for non-edit messages */
const TRUNC_LEN: Record<string, number> = {
  toolResult: 128,
  thinking: 128,
  system: Number.MAX_SAFE_INTEGER,
  default: 2048,
};

/** Collapse edit diffs longer than this many diff rows */
const EDIT_COLLAPSE_ROWS = 12;

export const StreamCard: React.FC<StreamCardProps> = ({ messages, isStreaming, compacting, onNewSession, onCompact, onCommandError, steerPending, followUpPending, model, externalActivity, models, activeModelId, onModelsFetched }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [filters, setFilters] = useState({
    thinking: localStorage.getItem('autere-filter-thinking') !== 'off',
    toolResult: localStorage.getItem('autere-filter-toolResult') !== 'off',
    edit: localStorage.getItem('autere-filter-edit') !== 'off',
  });

  // Generate a stable key based on message content, not array index
  const getKey = useCallback((msg: StreamMessage, idx: number): string => {
    if (msg.streaming) {
      return `streaming-${msg.role}-${idx}`;
    }
    const text = msg.text || '';
    let hash = 0;
    for (let i = 0; i < Math.min(text.length, 200); i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    const ts = msg.timestamp || 0;
    return `msg-${msg.role}-${hash}-${ts}`;
  }, []);

  // Filter messages: skip empty non-streaming entries, and apply user filters
  const filteredMessages = messages.filter((msg) => {
    // Skip empty finalized messages (image-only messages still render)
    if (!msg.streaming && !msg.text?.trim() && !(msg.images && msg.images.length > 0)) return false;
    if (msg.role === 'thinking' && !filters.thinking) return false;
    if ((msg.role === 'toolResult' || msg.role === 'toolCall') && !filters.toolResult) return false;
    if (msg.role === 'edit' && !filters.edit) return false;
    return true;
  });

  // Autoscroll: track if user is at bottom
  const isAtBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  // Model dropdown on the chat model row
  const [modelOpen, setModelOpen] = useState(false);
  const modelWrapperRef = useRef<HTMLSpanElement>(null);
  const modelsFetchedRef = useRef(false);
  const modelsList = models || [];
  const openModelDropdown = useCallback(() => {
    setModelOpen((v) => !v);
    // Fetch models on first open if the list is empty (SSE timing fallback)
    if (!modelsFetchedRef.current && modelsList.length === 0) {
      modelsFetchedRef.current = true;
      fetch(url('/api/models'))
        .then((res) => res.json())
        .then((data) => {
          if (data.success && data.data?.length > 0) onModelsFetched?.(data.data);
        })
        .catch(() => {});
    }
  }, [modelsList.length, onModelsFetched]);
  const selectModel = useCallback(async (provider: string, modelId: string) => {
    setModelOpen(false);
    try {
      const res = await fetch(url('/api/set-model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId }),
      });
      const data = await res.json();
      if (!data.success) onCommandError?.('Failed to change model');
    } catch {
      onCommandError?.('Failed to change model');
    }
  }, [onCommandError]);

  // Close the model dropdown on Escape or click outside
  useEffect(() => {
    if (!modelOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModelOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (modelWrapperRef.current && !modelWrapperRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    // 'mousedown' so selecting an item inside isn't beaten by outside-click
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [modelOpen]);

  // Button appears whenever the user is scrolled up: "Scroll to bottom" by
  // default, switching to "New messages" when content arrives while away.
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasNewContent, setHasNewContent] = useState(false);

  // Scroll to bottom on initial load
  useEffect(() => {
    const box = boxRef.current;
    if (box) {
      programmaticScrollRef.current = true;
      box.scrollTop = box.scrollHeight;
    }
  }, []);

  // Images expand asynchronously AFTER the message-update autoscroll has run
  // (an <img> has no height until it loads), which would leave the chat
  // scrolled to only part of the image. Listen for load events (capture
  // phase — load doesn't bubble) and re-stick to the bottom if we were there.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onLoad = () => {
      if (isAtBottomRef.current) {
        programmaticScrollRef.current = true;
        box.scrollTop = box.scrollHeight;
      }
    };
    box.addEventListener('load', onLoad, true);
    return () => box.removeEventListener('load', onLoad, true);
  }, []);

  // Auto-scroll when messages change, but only if user is at bottom
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && isAtBottomRef.current) {
      programmaticScrollRef.current = true;
      box.scrollTop = box.scrollHeight;
    } else if (!isAtBottomRef.current) {
      setHasNewContent(true);
    }
  }, [messages, isStreaming]);

  // Track user scroll position
  const handleScroll = useCallback(() => {
    // Ignore scroll events from our own programmatic scrolls
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    const box = boxRef.current;
    if (!box) return;
    const threshold = 40;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
    isAtBottomRef.current = atBottom;
    // Show as soon as the user is scrolled up; label upgrades to
    // "New messages" when content arrives while they're away.
    setShowScrollButton(!atBottom);
    if (atBottom) setHasNewContent(false);
  }, []);

  // Scroll to bottom and resume autoscroll
  const scrollToBottom = useCallback(() => {
    const box = boxRef.current;
    if (box) {
      isAtBottomRef.current = true;
      setHasNewContent(false);
      setShowScrollButton(false);
      box.scrollTop = box.scrollHeight;
    }
  }, []);

  const toggleFilter = useCallback((filter: 'thinking' | 'toolResult' | 'edit') => {
    setFilters((prev) => {
      const next = { ...prev, [filter]: !prev[filter] };
      localStorage.setItem('autere-filter-' + filter, next[filter] ? 'on' : 'off');
      return next;
    });
    // Filtering changes which messages are rendered (and their offsets);
    // without this the chat can end up mid-scroll. Always go back to the
    // latest message after touching the toggles.
    requestAnimationFrame(() => scrollToBottom());
  }, [scrollToBottom]);

  return (
    <div className={`card stream-card${isStreaming ? ' working' : ''}`}>
      <div className="card-title">
        <span>Chat</span>
        <div className="stream-filters">
          <button
            className={`stream-toggle${filters.thinking ? ' active' : ''}`}
            onClick={() => toggleFilter('thinking')}
          >
            thinking
          </button>
          <button
            className={`stream-toggle${filters.toolResult ? ' active' : ''}`}
            onClick={() => toggleFilter('toolResult')}
          >
            tools
          </button>
          <button
            className={`stream-toggle${filters.edit ? ' active' : ''}`}
            onClick={() => toggleFilter('edit')}
          >
            edits
          </button>
        </div>
      </div>
      <div className="chat-model-row">
        <span className="chat-model-label">model</span>
        <span className="chat-model-wrapper" ref={modelWrapperRef}>
          <button className="chat-model-name" onClick={openModelDropdown} title="Change model">
            {model?.name || model?.id || '—'}
            <span className="chat-model-caret">▾</span>
          </button>
          {modelOpen && (
            <div className="chat-model-dropdown">
              {modelsList.length === 0 ? (
                <div className="chat-model-empty">No scoped models configured</div>
              ) : (
                modelsList.map((m: AvailableModel) => (
                  <div
                    key={`${m.provider}/${m.id}`}
                    className={`chat-model-item${m.id === (activeModelId ?? model?.id) ? ' active' : ''}`}
                    onClick={() => selectModel(m.provider, m.id)}
                  >
                    <span className="model-dot" />
                    <span className="model-name">{m.name || m.id}</span>
                    <span className="model-provider">{m.provider}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </span>
        {(externalActivity || isStreaming || compacting) && (
          <span className={`chat-model-external${externalActivity ? '' : ' chat-model-active'}`}>
            {externalActivity ? 'Active elsewhere' : 'Active'}
          </span>
        )}
      </div>
      <div className="stream-box-wrapper">
        <div className="stream-box" ref={boxRef} onScroll={handleScroll}>
          {filteredMessages.map((msg, fi) => {
            const role = msg.role || '';
            const displayText = msg.text || '';
            const isToolResult = role === 'toolResult' || role === 'toolCall' || role === 'edit';
            // For edit messages, count only diff lines (skip header line and empty line after it)
            const editParts = role === 'edit' ? displayText.split('\n') : [];
            const editLines = editParts.length > 1 ? editParts.slice(editParts[1] === '' ? 2 : 1) : [];
            const lineCount = editLines.length;
            const isEdit = role === 'edit';
            const truncLen = TRUNC_LEN[role] ?? TRUNC_LEN.default;
            const isLong = isEdit ? lineCount > EDIT_COLLAPSE_ROWS : displayText.length > truncLen;
            const isAssistant = role === 'assistant';

            return (
              <ChatMessage
                key={getKey(msg, fi)}
                msg={msg}
                role={role}
                displayText={displayText}
                isAssistant={isAssistant}
                isToolResult={isToolResult}
                isLong={isLong}
                truncLen={truncLen === Number.MAX_SAFE_INTEGER ? displayText.length : truncLen}
                lineCount={lineCount}
              />
            );
          })}
        </div>
        {showScrollButton && (
          <button className={`scroll-to-bottom${hasNewContent ? ' has-new' : ''}`} onClick={scrollToBottom}>
            ↓ {hasNewContent ? 'New messages' : 'Scroll to bottom'}
          </button>
        )}
      </div>
      <ChatInput onNewSession={onNewSession} onCompact={onCompact} onError={onCommandError} disabled={compacting || externalActivity} isStreaming={isStreaming} isActive={isStreaming || compacting} steerPending={steerPending} followUpPending={followUpPending} />
    </div>
  );
};
