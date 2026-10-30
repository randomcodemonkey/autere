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

// File-sharing capability (module level, evaluated once): Web Share with
// file support must be claimed (iOS/iPadOS/macOS Safari, Android Chrome).
const canShareFiles = typeof navigator.share === 'function'
  && navigator.canShare?.({ files: [new File([''], 'probe.txt', { type: 'text/plain' })] }) === true;
const isTouchDevice = navigator.maxTouchPoints > 0;

marked.setOptions({
  gfm: true,
  breaks: true,
});

// Custom renderer to prefix image URLs with the base path. Attributes are
// escaped here (DOMPurify still runs afterwards) so model output can never
// break out of the tag and inject attributes of its own.
const renderer = new marked.Renderer();
renderer.image = function({ href, title, text }: { href: string; title: string | null; text: string }) {
  const src = escHtml(url(href));
  const titleAttr = title ? ` title="${escHtml(title)}"` : '';
  return `<img src="${src}" alt="${escHtml(text)}"${titleAttr} />`;
};
renderer.html = ({ text }: { text: string }) => escHtml(text);

export function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// -- ANSI SGR rendering ---------------------------------------------------
// Tool output frequently carries terminal colors (test runners, ls --color).
// The tokenizer is deliberately hand-written instead of regex-driven: it walks
// the string once, drops every control/escape sequence it does not fully
// understand, and emits React nodes (never HTML strings), so no attacker
// controlled bytes can reach the DOM as markup. The only interpolated values
// are fixed class names and numeric colors.

interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const ansiVar = (n: number) => `var(--ansi-${n})`;

function ansi256(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  const i = Math.min(255, Math.floor(n));
  if (i < 16) return ansiVar(i);
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const steps = [0, 95, 135, 175, 215, 255];
  const j = i - 16;
  return `rgb(${steps[Math.floor(j / 36)]},${steps[Math.floor(j / 6) % 6]},${steps[j % 6]})`;
}

const rgb = (r: number, g: number, b: number) =>
  [r, g, b].every((v) => Number.isFinite(v))
    ? `rgb(${[r, g, b].map((v) => Math.min(255, Math.max(0, Math.floor(v)))).join(',')})`
    : '';

// SGR parameter bytes are digits/semicolons only (checked by the tokenizer)
function applySgr(st: AnsiStyle, params: string): void {
  const codes = params === '' ? [0] : params.split(';').map(Number);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (!Number.isFinite(c)) continue;
    if (c === 0) {
      st.fg = st.bg = undefined;
      st.bold = st.dim = st.italic = st.underline = false;
    } else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 3) st.italic = true;
    else if (c === 4) st.underline = true;
    else if (c === 22) st.bold = st.dim = false;
    else if (c === 23) st.italic = false;
    else if (c === 24) st.underline = false;
    else if (c >= 30 && c <= 37) st.fg = ansiVar(c - 30);
    else if (c >= 90 && c <= 97) st.fg = ansiVar(c - 90 + 8);
    else if (c >= 40 && c <= 47) st.bg = ansiVar(c - 40);
    else if (c >= 100 && c <= 107) st.bg = ansiVar(c - 100 + 8);
    else if (c === 39) st.fg = undefined;
    else if (c === 49) st.bg = undefined;
    else if (c === 38 || c === 48) {
      const target = c === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5) { st[target] = ansi256(codes[i + 2]); i += 2; }
      else if (codes[i + 1] === 2) { st[target] = rgb(codes[i + 2], codes[i + 3], codes[i + 4]); i += 4; }
      else i += 1;
    }
  }
}

const ansiClass = (st: AnsiStyle) => [
  st.bold && 'ansi-bold',
  st.dim && 'ansi-dim',
  st.italic && 'ansi-italic',
  st.underline && 'ansi-underline',
].filter(Boolean).join(' ');

/** Convert ANSI colored text to React nodes. Unknown sequences are dropped. */
export function renderAnsi(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const st: AnsiStyle = {};
  let buf = '';
  let key = 0;

  const flush = () => {
    if (!buf) return;
    const cls = ansiClass(st);
    const style: React.CSSProperties = {};
    if (st.fg) style.color = st.fg;
    if (st.bg) style.background = st.bg;
    nodes.push(cls || st.fg || st.bg
      ? <span key={key++} className={cls || undefined} style={style}>{buf}</span>
      : buf);
    buf = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    if (ch === '\n' || ch === '\t' || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))) {
      buf += ch;
      continue;
    }
    if (ch !== '\u001b') continue; // other C0/C1 controls are dropped
    flush();
    const next = text[i + 1];
    if (next === '[') {
      // CSI: parameter/intermediate bytes (0x20-0x3F), terminated by a final
      // byte (0x40-0x7E). Only short, digits-only "...m" is an SGR we apply.
      let j = i + 2;
      while (j < text.length && j - (i + 2) < 32 && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++;
      const params = text.slice(i + 2, j);
      const fin = text.charCodeAt(j);
      if (fin === 0x6d /* m */ && /^[0-9;]*$/.test(params)) {
        applySgr(st, params);
        i = j;
      } else {
        // Oversized/truncated or non-SGR CSI: skip to its final byte
        let k = j;
        while (k < text.length && !(text.charCodeAt(k) >= 0x40 && text.charCodeAt(k) <= 0x7e)) k++;
        i = Math.min(text.length - 1, k);
      }
    } else if (next === ']') {
      // OSC (e.g. terminal hyperlinks): drop until BEL or ST
      let j = i + 2;
      while (j < text.length && text[j] !== '\u0007' && !(text[j] === '\u001b' && text[j + 1] === '\\')) j++;
      i = text[j] === '\u0007' ? j : Math.min(text.length - 1, j + 1);
    } else {
      // Two-byte escape; charset designators ESC ( / ) / # take one more byte
      i += next === '(' || next === ')' || next === '#' ? 2 : 1;
    }
  }
  flush();
  return nodes;
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

/** Tool timeout as a compact duration. Values >= 1000 are milliseconds. */
/** Compact tool run time: 320ms / 4.2s / 12s / 1m 5s */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function formatTimeout(value: number): string {
  const seconds = value >= 1000 ? value / 1000 : value;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
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
  // Empty thinking blocks are kept on purpose: models that withhold their
  // reasoning stream start/end with no content, and the block is the only
  // sign of activity in the chat.
  const emptyThinking = role === 'thinking' && hasBody;
  if (!msg.streaming && hasBody && !emptyThinking && !(msg.images && msg.images.length > 0) && !msg.file) return null;

  const isCallOnly = role === 'toolCall' && !!msg.toolCall;
  // Streaming tool calls show the tail of their partial output under the
  // command header; the final result replaces the whole entry.
  const bodyText = isCallOnly ? (msg.partial || '') : displayText;
  // Truncate long messages even while streaming — the expand toggle works
  // mid-stream. Bounded height also keeps autoscroll stable on long turns.
  const showText = expanded || !isLong ? bodyText : bodyText.slice(0, truncLen);
  const roleClass = role === 'user' ? 'stream-role-user' : role === 'assistant' ? 'stream-role-assistant' : `stream-role-${role}`;
  // Task deliveries (scheduled-task reports committed as user-role messages)
  // read like assistant output: markdown body, distinct "task" sender.
  const isTaskReport = role === 'taskReport';
  const roleLabel = isTaskReport ? 'task' : role;
  const renderMarkdown = isAssistant || isTaskReport || role === 'user';
  const isNonText = displayText.startsWith('[') && !isTaskReport;
  const isError = msg.isError;
  const mdClass = renderMarkdown ? ' md-rendered' : '';
  const textClass = (isToolResult ? 'stream-tool-output' : 'stream-text' + (isNonText ? ' stream-non-text' : '') + mdClass) + (expanded ? ' expanded' : '') + (isError ? ' stream-error' : '');
  const renderText = role === 'thinking' ? stripExtraNewlines(showText) : showText;
  const renderedText = renderMarkdown ? renderMd(renderText) : '';
  const ansiNodes = renderMarkdown || role === 'edit' ? null : renderAnsi(renderText);
  const ts = formatTimestamp(msg.timestamp);

  // Download an image. Mobile Safari ignores the download attribute on
  // data: URLs, so use the Web Share API (native save/share sheet on iOS)
  // when available, falling back to a Blob URL + download anchor.
  // Preferred src: backend-served URL (small SSE payloads); inline base64
  // is only a fallback for entries predating the on-disk extraction.
  // url() adds the reverse-proxy base path — raw /api/... 404s behind it.
  const imageSrc = (img: StreamImage) => (img.url ? url(img.url) : `data:${img.mimeType};base64,${img.data ?? ''}`);

  // Fetch the file's bytes (backend URL or inline data:) into a File.
  const toFile = async (mimeType: string, src: string, filename?: string): Promise<File> => {
    let blob: Blob;
    if (src.startsWith('data:')) {
      const data = src.slice(src.indexOf(',') + 1);
      blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mimeType });
    } else {
      const resp = await fetch(src);
      blob = await resp.blob();
    }
    const ext = mimeType.split('/')[1] || 'png';
    return new File([blob], filename || `image-${Date.now()}.${ext}`, { type: mimeType });
  };

  // Open the OS share sheet. Never navigates — safe in standalone PWAs
  // where target=_blank is unreliable (iOS covers the app with a preview).
  const shareFile = async (mimeType: string, src: string, filename?: string) => {
    const file = await toFile(mimeType, src, filename);
    try { await navigator.share({ files: [file] }); } catch (err) {
      // User cancelled the share sheet — not an error
      if ((err as DOMException)?.name === 'AbortError') return;
      console.error('Web Share failed:', err);
    }
  };

  // Plain local download (Blob URL + download anchor — ~/Downloads, no UI).
  // iOS Safari ignores the download attribute → touch devices use Share.
  const downloadFile = async (mimeType: string, src: string, filename?: string) => {
    const blob = (await toFile(mimeType, src, filename)) as File & { blob?: Blob };
    const url2 = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url2;
    a.download = blob.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url2), 10_000);
  };

  // Image save: touch devices without share fallback → share; else download
  const saveImage = (mimeType: string, src: string, filename?: string) =>
    (isTouchDevice && canShareFiles ? shareFile(mimeType, src, filename) : downloadFile(mimeType, src, filename))
      .catch((err) => console.error('Image save failed:', err));

  return (
    <div className={`stream-msg${msg.pending ? ' stream-msg-pending' : ''}`} data-msg-key={dataKey}>
      <div className={`stream-role ${roleClass}${msg.isError ? ' stream-role-error' : ''}`}>
        <span>{roleLabel}</span>
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
          <div className={`tool-call-header${msg.toolCall.parentToolCallId ? ' tool-call-nested' : ''}`}>
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
            {typeof msg.toolCall.durationMs === 'number' && (
              <span className="tool-call-duration" title={`Tool ran for ${formatDuration(msg.toolCall.durationMs)}`}>
                {formatDuration(msg.toolCall.durationMs)}
              </span>
            )}
            {msg.toolCall.timeout ? (
              <span className="tool-call-timeout" title={`Tool timeout: ${formatTimeout(msg.toolCall.timeout)}`}>⏱ {formatTimeout(msg.toolCall.timeout)}</span>
            ) : null}
            {msg.streaming && <span className="stream-cursor" />}
          </div>
        )}
        {role === 'edit'
          ? renderEditDiff(showText, !expanded && isLong, 12, isError)
          : emptyThinking
          ? <span className="stream-empty-marker">…</span>
          : renderMarkdown
            ? <span dangerouslySetInnerHTML={{ __html: renderedText }} />
            : ansiNodes}
        {msg.file && (
          <div className="file-card">
            <span className="file-icon">📄</span>
            <div className="file-meta">
              <div className="file-name">{msg.file.name}</div>
              <div className="file-size">
                {msg.file.size >= 1048576 ? `${(msg.file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(msg.file.size / 1024))} KB`}
              </div>
            </div>
            {canShareFiles && (
              <button
                className="file-dl"
                onClick={() => void shareFile(msg.file!.mimeType || 'application/octet-stream', url(API.files(msg.file!.savedName)), msg.file!.name)}
              >
                Share
              </button>
            )}
            {(!isTouchDevice || !canShareFiles) && (
              <a
                className="file-dl"
                href={url(API.files(msg.file.savedName))}
                download={msg.file.name}
                onClick={(e) => {
                  // Blob download — never navigate (iOS PWA preview otherwise
                  // covers the app, no way back).
                  e.preventDefault();
                  void downloadFile(msg.file!.mimeType || 'application/octet-stream', url(API.files(msg.file!.savedName)), msg.file!.name)
                    .catch((err) => console.error('File download failed:', err));
                }}
              >
                Download
              </a>
            )}
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
