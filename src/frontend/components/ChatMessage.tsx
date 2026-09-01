/**
 * Chat message rendering for the stream.
 *
 * Pure rendering helpers (markdown, diffs, escaping) plus the memoized
 * ChatMessage component used by StreamCard.
 */

import React, { useState, memo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { StreamMessage } from '../types';
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

export function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderMd(text: string): string {
  if (!text) return '';
  const html = marked.parse(text, { renderer }) as string;
  return DOMPurify.sanitize(html);
}

export function renderEditDiff(text: string, collapsed: boolean = false, maxLines: number = 12, isError: boolean = false): React.ReactNode {
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

export function stripExtraNewlines(text: string): string {
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

export function formatTimestamp(ts?: number): string {
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

export const ChatMessage = memo<ChatMessageProps>(({ msg, role, displayText, isAssistant, isToolResult, isLong, truncLen, lineCount }) => {
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
