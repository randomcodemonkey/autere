import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import type { StreamMessage } from '../types';
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

export const StreamCard: React.FC<StreamCardProps> = ({ messages, isStreaming, compacting, onNewSession, onCompact, onCommandError, steerPending, followUpPending }) => {
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

  const toggleFilter = useCallback((filter: 'thinking' | 'toolResult' | 'edit') => {
    setFilters((prev) => {
      const next = { ...prev, [filter]: !prev[filter] };
      localStorage.setItem('autere-filter-' + filter, next[filter] ? 'on' : 'off');
      return next;
    });
  }, []);

  // Filter messages: skip empty non-streaming entries, and apply user filters
  const filteredMessages = messages.filter((msg) => {
    // Skip empty finalized messages
    if (!msg.streaming && !msg.text?.trim()) return false;
    if (msg.role === 'thinking' && !filters.thinking) return false;
    if (msg.role === 'toolResult' && !filters.toolResult) return false;
    if (msg.role === 'edit' && !filters.edit) return false;
    return true;
  });

  // Autoscroll: track if user is at bottom
  const isAtBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const hasNewContentRef = useRef(false);

  // Scroll to bottom on initial load
  useEffect(() => {
    const box = boxRef.current;
    if (box) {
      programmaticScrollRef.current = true;
      box.scrollTop = box.scrollHeight;
    }
  }, []);

  // Auto-scroll when messages change, but only if user is at bottom
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && isAtBottomRef.current) {
      programmaticScrollRef.current = true;
      box.scrollTop = box.scrollHeight;
    } else if (!isAtBottomRef.current) {
      hasNewContentRef.current = true;
      setShowScrollButton(true);
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
    if (atBottom) {
      hasNewContentRef.current = false;
      setShowScrollButton(false);
    } else if (hasNewContentRef.current) {
      setShowScrollButton(true);
    }
  }, []);

  // Scroll to bottom and resume autoscroll
  const scrollToBottom = useCallback(() => {
    const box = boxRef.current;
    if (box) {
      isAtBottomRef.current = true;
      hasNewContentRef.current = false;
      setShowScrollButton(false);
      box.scrollTop = box.scrollHeight;
    }
  }, []);

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
      <div className="stream-box-wrapper">
        <div className="stream-box" ref={boxRef} onScroll={handleScroll}>
          {filteredMessages.map((msg, fi) => {
            const role = msg.role || '';
            const displayText = msg.text || '';
            const isToolResult = role === 'toolResult' || role === 'edit';
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
          <button className="scroll-to-bottom" onClick={scrollToBottom}>
            ↓ New messages
          </button>
        )}
      </div>
      <ChatInput onNewSession={onNewSession} onCompact={onCompact} onError={onCommandError} disabled={compacting} isStreaming={isStreaming} isActive={isStreaming || compacting} steerPending={steerPending} followUpPending={followUpPending} />
    </div>
  );
};
