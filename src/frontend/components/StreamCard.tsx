import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, memo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { StreamMessage } from '../types';
import { ChatInput } from './ChatInput';
import { url } from '../base-path';

marked.setOptions({
  gfm: true,
  breaks: true,
});

// Custom renderer to prefix image URLs with the base path
const renderer = new marked.Renderer();
renderer.image = function({ href, title, text }: { href: string; title: string | null; text: string }) {
  const src = url(href);
  const titleAttr = title ? ` title="${title}"` : '';
  return `<img src="${src}" alt="${text}"${titleAttr} />`;
};

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMd(text: string): string {
  if (!text) return '';
  const html = marked.parse(text, { renderer }) as string;
  return DOMPurify.sanitize(html);
}

function renderEditDiff(text: string, collapsed: boolean = false, maxLines: number = 12, isError: boolean = false): React.ReactNode {
  if (!text) return null;
  
  // Parse: first line is header (e.g. "Successfully replaced..."), rest is diff
  const lines = text.split('\n');
  const header = lines[0] || '';
  // Skip empty line after header if present
  const diffStartIndex = lines[1] === '' ? 2 : 1;
  const diffLines = lines.slice(diffStartIndex);
  const displayLines = collapsed ? diffLines.slice(0, maxLines) : diffLines;
  const hiddenLineCount = diffLines.length - displayLines.length;
  
  return (
    <div className={`edit-diff${isError ? ' stream-error' : ''}`}>
      <div className="edit-file-header">{header}</div>
      {diffLines.length > 0 && (
        <div className="edit-diff-content">
          {displayLines.map((line, i) => {
            let lineClass = 'diff-line';
            if (line.startsWith('+')) lineClass += ' diff-add';
            else if (line.startsWith('-')) lineClass += ' diff-remove';
            else if (line.startsWith('@@')) lineClass += ' diff-header';
            else if (line.startsWith('---') || line.startsWith('+++')) lineClass += ' diff-filename';
            return (
              <div key={i} className={lineClass}>
                <span className="diff-line-number">{i + 1}</span>
                <span className="diff-line-content">{line}</span>
              </div>
            );
          })}
          {collapsed && hiddenLineCount > 0 && (
            <div className="diff-line diff-hidden">
              <span className="diff-line-number">...</span>
              <span className="diff-line-content">{hiddenLineCount} more rows hidden</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stripExtraNewlines(text: string): string {
  // 0) When one or more newlines are followed by whitespace, remove the newlines and keep the whitespace
  let result = text.replace(/\n+\s/g, (match) => match[match.length - 1]);
  // 1) Collapse 3+ consecutive newlines into exactly 2
  result = result.replace(/\n{3,}/g, '\n\n');
  // 2) Replace singular newlines with a space, but retain after punctuation (:,.,;,;)
  result = result.replace(/(?<![\n:,. ;])\n(?!\n)/g, ' ');
  // 3) Collapse 2+ consecutive spaces into a single space
  result = result.replace(/ {2,}/g, ' ');
  return result;
}

function formatTimestamp(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

interface ChatMessageProps {
  msg: StreamMessage;
  role: string;
  displayText: string;
  isAssistant: boolean;
  isToolResult: boolean;
  isLong: boolean;
  truncLen: number;
  lineCount?: number;
}

const ChatMessage = memo<ChatMessageProps>(({ msg, role, displayText, isAssistant, isToolResult, isLong, truncLen, lineCount }) => {
  const [expanded, setExpanded] = useState(false);

  // Don't render empty non-streaming messages
  if (!msg.streaming && !displayText.trim()) return null;

  const showText = expanded || !isLong ? displayText : displayText.slice(0, truncLen);
  const roleClass = role === 'user' ? 'stream-role-user' : role === 'assistant' ? 'stream-role-assistant' : `stream-role-${role}`;
  const isNonText = displayText.startsWith('[');
  const isError = msg.isError;
  const mdClass = isAssistant ? ' md-rendered' : '';
  const textClass = (isToolResult ? 'stream-tool-output' : 'stream-text' + (isNonText ? ' stream-non-text' : '') + mdClass) + (expanded ? ' expanded' : '') + (isError ? ' stream-error' : '');
  const renderText = role === 'thinking' ? stripExtraNewlines(showText) : showText;
  const renderedText = isAssistant ? renderMd(renderText) : role === 'edit' ? '' : escHtml(renderText);
  const ts = formatTimestamp(msg.timestamp);

  return (
    <div className="stream-msg">
      <div className={`stream-role ${roleClass}${msg.isError ? ' stream-role-error' : ''}`}>
        <span>{role}</span>
        {ts && <span className="stream-timestamp">{ts}</span>}
        {msg.streaming && <span className="stream-cursor" />}
      </div>
      <div className={textClass}>
        {role === 'edit' ? renderEditDiff(showText, !expanded && isLong, 12, isError) : <span dangerouslySetInnerHTML={{ __html: renderedText }} />}
      </div>
      {isLong && (
        <div
          className="stream-text-truncated"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded 
            ? '▾ collapse' 
            : role === 'edit' 
              ? `▸ ${lineCount} rows - click to expand`
              : `▸ ${displayText.length - truncLen} more characters - click to expand`}
        </div>
      )}
    </div>
  );
});

ChatMessage.displayName = 'ChatMessage';

interface StreamCardProps {
  messages: StreamMessage[];
  isStreaming: boolean;
  compacting?: boolean;
  onNewSession: () => void;
  onCompact?: () => void;
  onCommandError?: (message: string) => void;
}

export const StreamCard: React.FC<StreamCardProps> = ({ messages, isStreaming, compacting, onNewSession, onCompact, onCommandError }) => {
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

  const dedupedMessages = filteredMessages;

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

  // Full-screen toggle for mobile
  const [fullscreen, setFullscreen] = useState(() => {
    return localStorage.getItem('autere-chat-fullscreen') === '1';
  });

  const toggleFullscreen = useCallback(() => {
    setFullscreen(prev => {
      const next = !prev;
      localStorage.setItem('autere-chat-fullscreen', next ? '1' : '0');
      // Toggle the class on the container element
      const container = document.querySelector('.container');
      if (container) {
        container.classList.toggle('chat-fullscreen', next);
      }
      return next;
    });
  }, []);

  // Apply fullscreen class on mount and when fullscreen changes
  useEffect(() => {
    const container = document.querySelector('.container');
    if (container) {
      container.classList.toggle('chat-fullscreen', fullscreen);
    }
  }, [fullscreen]);

  return (
    <div className={`card stream-card${isStreaming ? ' working' : ''}`}>
      <div className="card-title" onClick={toggleFullscreen} style={{ cursor: 'pointer' }}>
        <span className="chat-title-group">
          Chat
          <span className="chat-collapse-icon">{fullscreen ? '▾' : '▸'}</span>
        </span>
        <div className="stream-filters" onClick={(e) => e.stopPropagation()}>
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
          {dedupedMessages.map((msg, fi) => {
            const origIdx = filteredMessages.indexOf(msg);
            const isLast = origIdx === filteredMessages.length - 1;
            const role = msg.role || '';
            const displayText = msg.text || '';
            const isToolResult = role === 'toolResult' || role === 'edit';
            // For edit messages, count only diff lines (skip header line and empty line after it)
            const editParts = role === 'edit' ? displayText.split('\n') : [];
            const editLines = editParts.length > 1 ? editParts.slice(editParts[1] === '' ? 2 : 1) : [];
            const lineCount = editLines.length;
            const editCollapseThreshold = 12;
            const isEdit = role === 'edit';
            const effectiveLen = displayText.length;
            const truncLen = role === 'toolResult' || role === 'thinking' ? 128 : role === 'system' ? effectiveLen : 2048;
            const isLong = isEdit ? lineCount > editCollapseThreshold : effectiveLen > truncLen;
            const isAssistant = role === 'assistant';

            return (
              <ChatMessage
                key={getKey(msg, origIdx)}
                msg={msg}
                role={role}
                displayText={displayText}
                isAssistant={isAssistant}
                isToolResult={isToolResult}
                isLong={isLong}
                truncLen={truncLen}
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
      <ChatInput onNewSession={onNewSession} onCompact={onCompact} onError={onCommandError} disabled={compacting} isStreaming={isStreaming} isActive={isStreaming || compacting} />
    </div>
  );
};
