/**
 * Chat message rendering for the stream.
 *
 * Pure rendering helpers (markdown, diffs, escaping) plus the memoized
 * ChatMessage component used by StreamCard.
 */

import React, { useState, useEffect, memo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { StreamMessage, StreamImage } from '../types';
import { ZoomableImage } from './ZoomableImage';
import { url } from '../base-path';
import { API } from '../api-paths';

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
  // Locale-aware clock time, e.g. "3:12:45 PM" (en-US) or "15.12.45" (fi-FI)
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
  /** Stable per-message DOM identity — scroll anchoring looks it up after content updates */
  dataKey?: string;
  /** Present on pending (queued steer/follow-up) user messages — cancels it */
  onCancelPending?: (text: string) => void;
}

export const ChatMessage = memo<ChatMessageProps>(({ msg, role, displayText, isAssistant, isToolResult, isLong, truncLen, lineCount, onCancelPending, dataKey }) => {
  const [expanded, setExpanded] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  // Tool command line: click toggles between one ellipsized line and full wrap
  const [cmdExpanded, setCmdExpanded] = useState(false);

  // Close the image lightbox on Escape
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightbox]);

  // Don't render empty non-streaming messages (image-only messages still render)
  const hasBody = role === 'toolCall' && !!msg.toolCall ? false : !displayText.trim();
  if (!msg.streaming && hasBody && !(msg.images && msg.images.length > 0) && !msg.file) return null;

  const isCallOnly = role === 'toolCall' && !!msg.toolCall;
  const bodyText = isCallOnly ? '' : displayText;
  // Truncate long messages even while streaming — the expand toggle works
  // mid-stream. Bounded height also keeps autoscroll stable on long turns.
  const showText = expanded || !isLong ? bodyText : bodyText.slice(0, truncLen);
  const roleClass = role === 'user' ? 'stream-role-user' : role === 'assistant' ? 'stream-role-assistant' : `stream-role-${role}`;
  const isNonText = displayText.startsWith('[');
  const isError = msg.isError;
  const mdClass = isAssistant ? ' md-rendered' : '';
  const textClass = (isToolResult ? 'stream-tool-output' : 'stream-text' + (isNonText ? ' stream-non-text' : '') + mdClass) + (expanded ? ' expanded' : '') + (isError ? ' stream-error' : '');
  const renderText = role === 'thinking' ? stripExtraNewlines(showText) : showText;
  const renderedText = isAssistant ? renderMd(renderText) : role === 'edit' ? '' : escHtml(renderText);
  const ts = formatTimestamp(msg.timestamp);

  // Download an image. Mobile Safari ignores the download attribute on
  // data: URLs, so use the Web Share API (native save/share sheet on iOS)
  // when available, falling back to a Blob URL + download anchor.
  // Preferred src: backend-served URL (small SSE payloads); inline base64
  // is only a fallback for entries predating the on-disk extraction.
  // url() adds the reverse-proxy base path — raw /api/... 404s behind it.
  const imageSrc = (img: StreamImage) => (img.url ? url(img.url) : `data:${img.mimeType};base64,${img.data ?? ''}`);

  // Save a stream image (or any file) via Web Share (iOS) or a Blob-URL
  // download anchor. Never navigates — safe in standalone PWAs where
  // target=_blank is unreliable (iOS opens the preview over the app).
  const saveImage = async (mimeType: string, src: string, filename?: string) => {
    let blob: Blob;
    if (src.startsWith('data:')) {
      const data = src.slice(src.indexOf(',') + 1);
      blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mimeType });
    } else {
      const resp = await fetch(src);
      blob = await resp.blob();
    }
    const ext = mimeType.split('/')[1] || 'png';
    const file = new File([blob], filename || `image-${Date.now()}.${ext}`, { type: mimeType });
    if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (err) {
        // User cancelled the share sheet — not an error
        if ((err as DOMException)?.name === 'AbortError') return;
        console.error('Web Share failed:', err);
      }
    }
    const url2 = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url2;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url2), 10_000);
  };

  return (
    <div className={`stream-msg${msg.pending ? ' stream-msg-pending' : ''}`} data-msg-key={dataKey}>
      <div className={`stream-role ${roleClass}${msg.isError ? ' stream-role-error' : ''}`}>
        <span>{role}</span>
        {ts && <span className="stream-timestamp">{ts}</span>}
        {msg.pending && <span className="stream-pending-indicator" title="Sending…">⏳ pending</span>}
        {msg.pending && role === 'user' && onCancelPending && (
          <button className="pending-cancel" title="Cancel this queued message" onClick={() => onCancelPending(displayText)}>✕</button>
        )}
        {/* Single active indicator per message: toolCall entries render the
            cursor inside the command header, not out here as well. */}
        {msg.streaming && !(role === 'toolCall' && msg.toolCall) && <span className="stream-cursor" />}
      </div>
      <div className={textClass}>
        {/* Connected tool call: rendered as a header line inside the tool
            result block — call and result are one unit */}
        {msg.toolCall && (
          <div className="tool-call-header">
            <span className="tool-call-name">⚙ {msg.toolCall.name}</span>
            {msg.toolCall.cmd && (
              <span
                className={`tool-call-cmd${cmdExpanded ? ' expanded' : ''}`}
                title={cmdExpanded ? undefined : 'Click to show full command'}
                onClick={(e) => { e.stopPropagation(); setCmdExpanded((v) => !v); }}
              >
                {msg.toolCall.cmd}
              </span>
            )}
            {msg.streaming && <span className="stream-cursor" />}
          </div>
        )}
        {role === 'edit' ? renderEditDiff(showText, !expanded && isLong, 12, isError) : <span dangerouslySetInnerHTML={{ __html: renderedText }} />}
        {msg.file && (
          <div className="file-card">
            <span className="file-icon">📄</span>
            <div className="file-meta">
              <div className="file-name">{msg.file.name}</div>
              <div className="file-size">
                {msg.file.size >= 1048576 ? `${(msg.file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(msg.file.size / 1024))} KB`}
              </div>
            </div>
            <a
              className="file-dl"
              href={url(API.files(msg.file.savedName))}
              download={msg.file.name}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // Route through Web Share / Blob download — never navigate
                // (iOS PWA preview otherwise covers the app, no way back).
                e.preventDefault();
                void saveImage(msg.file!.mimeType || 'application/octet-stream', url(API.files(msg.file!.savedName)), msg.file!.name)
                  .catch((err) => console.error('File download failed:', err));
              }}
            >
              Download
            </a>
          </div>
        )}
        {msg.images && msg.images.length > 0 && (
          <div className="stream-images">
            {msg.images.map((img, i) => (
              <React.Fragment key={i}>
                <img
                  className="stream-image"
                  src={imageSrc(img)}
                  alt="generated image"
                  title="Click to view full size"
                  onClick={() => setLightbox(true)}
                />
                <button
                  className="stream-image-save"
                  onClick={(e) => { e.stopPropagation(); void saveImage(img.mimeType, imageSrc(img)); }}
                >
                  Save image
                </button>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
      {lightbox && msg.images && msg.images.length > 0 && (
        <div className="image-lightbox" onClick={() => setLightbox(false)}>
          {msg.images.map((img, i) => (
            <ZoomableImage
              key={i}
              src={imageSrc(img)}
              alt="generated image (full size)"
              onTap={() => setLightbox(false)}
            />
          ))}
        </div>
      )}
      {/* Call-only toolCall (active execution): body is empty, expansion
          happens via the command header — a footer toggle would be dead */}
      {isLong && !isCallOnly && (
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
