/**
 * Stream-history rendering.
 *
 * Single source of truth for converting pi messages (live events, RPC
 * get_messages results, or raw session-file entries) into the stream
 * history entries the frontend renders. Used by:
 * - UserSession: live tool_end events and RPC history loading
 * - utils.readSessionHistory: /api/sessions/:id/history from session files
 * - routes.ts: deduplication of freshly loaded history
 */

import { existsSync, readFileSync } from 'fs';

// ── rm command detection ──

export function isRmCommand(command?: string): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  return /^\S*\brm\b/.test(trimmed);
}

export function extractRmPaths(command: string): string[] {
  const paths: string[] = [];
  const parts = command.trim().split(/\s+/);
  let seenRm = false;
  for (const part of parts) {
    if (!seenRm) {
      if (/rm$/.test(part)) seenRm = true;
      continue;
    }
    if (part.startsWith('-')) continue;
    paths.push(part);
  }
  return paths;
}

// ── Tool result formatting ──

/**
 * Shared formatting for tool results into stream history entries.
 * Used by both live tool_end events and history loading from session files.
 */
export function formatToolResult(
  toolName: string,
  toolArgs: any,
  resultContent: any[] | undefined,
  isError: boolean,
  timestamp?: number,
  resultDetails?: any,
  rmSnapshots?: Record<string, string>,
): { role: string; text: string; streaming: boolean; timestamp?: number; isError?: boolean } | null {
  let text = '';
  let role: string;

  if (toolName === 'edit') {
    // Edit tools: content.text as header, details.diff as body
    const header = resultContent
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n') || '';
    const diff = resultDetails?.diff || '';
    text = diff ? header + '\n\n' + diff : header;
    role = 'edit';
  } else if (toolName === 'write') {
    // Write as edit with all lines shown as added
    const filePath = toolArgs.path || '';
    const content = toolArgs.content || '';
    const lines = typeof content === 'string' ? content.split('\n') : [];
    const diffLines = lines.map((line: string) => '+ ' + line);
    const header = filePath ? `Write ${filePath}` : 'Write';
    text = header + '\n' + diffLines.join('\n');
    role = 'edit';
  } else if (toolName === 'bash' && isRmCommand(toolArgs.command)) {
    // Rm commands as edit with removed lines
    const paths = extractRmPaths(toolArgs.command);
    const parts: string[] = [];
    for (const p of paths) {
      let content = '';
      // Use snapshot if available (live events), otherwise try to read (history)
      if (rmSnapshots && p in rmSnapshots) {
        content = rmSnapshots[p];
      } else {
        try { if (existsSync(p)) content = readFileSync(p, 'utf-8'); } catch {}
      }
      const lines = content.split('\n');
      const diffLines = lines.map((line: string) => '- ' + line);
      parts.push(`Delete ${p}\n` + diffLines.join('\n'));
    }
    text = parts.length > 0 ? parts.join('\n\n') : paths.map(p => `Delete ${p}`).join(', ');
    role = 'edit';
  } else if (resultContent) {
    text = resultContent
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
    role = 'toolResult';
  } else {
    return null;
  }

  const prefix = isError ? `[${toolName} error]` : '';
  const displayText = prefix ? (text ? prefix + ' ' + text : prefix) : text;
  if (!displayText) return null;

  return { role, text: displayText, streaming: false, timestamp, ...(isError ? { isError: true } : {}) };
}

// ── Session file reading ──

/**
 * Read message entries directly from a session JSONL file.
 * Used where RPC cached messages may be stale (external activity) or
 * unavailable (session-file history). Entries have the shape
 * `{ type: 'message', message: {...}, timestamp?: string }`.
 */
export function readMessageEntries(sessionFile: string, limit: number = 100): any[] {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const messages: any[] = [];
    // Read from end (most recent) up to limit
    for (let i = lines.length - 1; i >= 0 && messages.length < limit; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'message' && obj.message) messages.unshift(obj);
      } catch {}
    }
    return messages;
  } catch { return []; }
}

/**
 * Read ALL message entries from a session JSONL file, in order.
 */
export function readAllMessageEntries(sessionFile: string): any[] {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const messages: any[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'message' && obj.message) messages.push(obj);
      } catch {}
    }
    return messages;
  } catch { return []; }
}

// ── Stream history building ──

/**
 * Convert raw pi message entries into stream history entries.
 * Accepts either bare message objects or full session-file entries
 * (`{ type: 'message', message, timestamp }`) — the entry-level timestamp
 * is used as a fallback when the message itself has none.
 */
export function buildStreamHistoryFromMessages(rawMessages: any[]): any[] {
  const entries = rawMessages.map((raw: any) => ({
    msg: raw.message || raw,
    entryTimestamp: raw.timestamp,
  })).filter((e: any) => Boolean(e.msg));

  // Build a map of toolCallId -> tool call args from assistant messages
  const toolCallArgs = new Map<string, any>();
  for (const { msg } of entries) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'toolCall' && block.id && block.arguments) {
          toolCallArgs.set(block.id, { name: block.name, args: block.arguments });
        }
      }
    }
  }

  return entries
    .flatMap(({ msg, entryTimestamp }: any) => {
      const role = msg.role || '';
      const timestamp = msg.timestamp
        ? new Date(msg.timestamp).getTime()
        : (entryTimestamp ? new Date(entryTimestamp).getTime() : undefined);

      if (role === 'toolResult') {
        const call = msg.toolCallId ? toolCallArgs.get(msg.toolCallId) : undefined;
        const toolArgs = call?.args || {};
        const formatted = formatToolResult(msg.toolName, toolArgs, msg.content, msg.isError, timestamp, msg.details);
        return formatted ? [formatted] : [];
      }

      // Assistant messages can contain a thinking block before the text
      // block. While streaming these render as separate entries (a
      // 'thinking' entry from deltas, then the assistant text at
      // message_end) — mirror that here.
      if (role === 'assistant' && Array.isArray(msg.content)) {
        const out: any[] = [];
        const thinking = msg.content
          .filter((c: any) => c.type === 'thinking')
          .map((c: any) => c.thinking || '')
          .join('')
          .trim();
        if (thinking) {
          out.push({ role: 'thinking', text: thinking, streaming: false, timestamp });
        }
        const text = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
        if (text) {
          out.push({ role, text, streaming: false, timestamp });
        }
        return out;
      }

      // model_change and other non-renderable roles have no text content
      const text = msg.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || '';
      return text ? [{ role, text, streaming: false, timestamp }] : [];
    });
}

// ── Deduplication ──

export { dedupHistory } from '../shared/format.js';

// ── Usage accumulation ──

/** Accumulate a pi usage object into a sessionStats-shaped accumulator. */
export function accumulateUsage(
  stats: { tokens: Record<string, number>; cost: number },
  usage: any,
): void {
  if (!usage) return;
  if (usage.input) stats.tokens.input = (stats.tokens.input || 0) + usage.input;
  if (usage.output) stats.tokens.output = (stats.tokens.output || 0) + usage.output;
  if (usage.cacheRead) stats.tokens.cacheRead = (stats.tokens.cacheRead || 0) + usage.cacheRead;
  if (usage.cacheWrite) stats.tokens.cacheWrite = (stats.tokens.cacheWrite || 0) + usage.cacheWrite;
  if (usage.cost) stats.cost = (stats.cost || 0) + (usage.cost.total || 0);
}
