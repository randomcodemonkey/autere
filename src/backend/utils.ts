import { ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { StreamEntry, SessionUsageResult } from './types.js';
import { getUserSetting } from './user-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Scoped models from user settings ──

export function getEnabledModelPatterns(): string[] {
  return getUserSetting('admin', 'enabledModels', []);
}

/** Filter models to only those matching the enabled/scoped models list */
export function filterScopedModels(models: any[]): any[] {
  const enabled = getEnabledModelPatterns();
  if (enabled.length === 0) return models; // no scope configured, show all
  return models.filter(m => {
    const ref = `${m.provider}/${m.id}`;
    return enabled.some(pattern => ref === pattern || ref.endsWith('/' + pattern));
  });
}

// ── JSON response ──

export function sendJSON(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── HTML serving ──

export function getDashboardHTML(basePath: string = ''): string {
  const distPath = join(__dirname, '..', '..', 'dist', 'index.html');
  let html = '';
  if (existsSync(distPath)) {
    html = readFileSync(distPath, 'utf-8');
  } else {
    const htmlPath = join(__dirname, '..', '..', 'public', 'index.html');
    html = readFileSync(htmlPath, 'utf-8');
  }
  if (basePath) {
    // 1. Rewrite Vite-baked absolute asset paths so the browser loads
    //    them from the correct proxied location.
    //    e.g.  src="/assets/index.js"  →  src="/monitor/assets/index.js"
    html = html.replace(/(src|href)="\//g, `$1="${basePath}/`);

    // 2. Inject runtime base path so the frontend JS knows the prefix.
    //    The frontend reads window.__PI_MONITOR_BASE__ and uses it for
    //    all fetch() / EventSource calls.
    const script = `<script>window.__PI_MONITOR_BASE__ = ${JSON.stringify(basePath)}</script>`;
    html = html.replace('<head>', `<head>${script}`);
  }
  return html;
}

// ── Message extraction ──

export function extractFullText(message: any): string {
  if (!message.content) return '';
  if (message.role === 'toolResult') {
    const toolName = message.toolName || 'tool';
    const textContent = message.content.find((c: any) => c.type === 'text');
    const output = textContent?.text || '';
    // Match the streaming path (formatToolResult): no prefix for successful
    // results, prefix only for errors. Errors keep the output if present.
    return message.isError ? (output ? `[${toolName} error] ${output}` : `[${toolName} error]`) : output;
  }
  // Only text blocks are shown while streaming (toolCall/thinking blocks are
  // rendered as separate tool/thinking entries), so a message without text
  // content yields '' — never a '[type, ...]' placeholder.
  return message.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('');
}

// ── Session file I/O ──

export function readSessionUsage(sessionFile: string): SessionUsageResult {
  const stats: SessionUsageResult = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    messageCount: 0,
    requestCount: 0,
  };
  try {
    if (!existsSync(sessionFile)) return stats;
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n');
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'message' && entry.message?.role === 'assistant') {
          stats.messageCount++;
          const usage = entry.message.usage;
          if (usage) {
            stats.tokens.input += usage.input || 0;
            stats.tokens.output += usage.output || 0;
            stats.tokens.cacheRead += usage.cacheRead || 0;
            stats.tokens.cacheWrite += usage.cacheWrite || 0;
          }
        }
        if (entry.type === 'message' && entry.message?.role === 'user') {
          stats.requestCount++;
        }
      } catch (lineErr) { console.error('[autere] Failed to parse session usage line:', lineErr); continue; }
    }
  } catch (err) { console.error('[autere] Failed to read session usage:', err); }
  return stats;
}

export function readSessionHistory(sessionFile: string, limit: number = 30): StreamEntry[] {
  try {
    if (!existsSync(sessionFile)) return [];
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const messages: StreamEntry[] = [];

    for (let i = 1; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'message' && entry.message) {
          const msg = entry.message;
          const role = msg.role || '';
          if (!role || role === 'model_change') continue;

          // Handle toolResult messages - detect edit tool specially
          if (role === 'toolResult') {
            const toolName = msg.toolName || 'tool';
            const textContent = msg.content?.find((c: any) => c.type === 'text');
            const output = textContent?.text || '';
            const isError = msg.isError || false;
            const ts = msg.timestamp || (entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now());

            if (toolName === 'edit') {
              // Edit tool - use content.text as header, details.diff as body
              const header = output; // e.g. "Successfully replaced 1 block(s) in /path/to/file"
              const diff = msg.details?.diff || '';
              // Combine header and diff with empty line separator
              const text = diff ? header + '\n\n' + diff : header;
              messages.push({ role: 'edit', text, streaming: false, timestamp: ts, isError });
            } else {
              // Match the streaming path (formatToolResult): raw output, error
              // prefix only for errors. Skip empty results — streaming never
              // emits empty tool result entries.
              const displayText = isError ? (output ? `[${toolName} error] ${output}` : `[${toolName} error]`) : output;
              if (!displayText) continue;
              messages.push({ role: 'toolResult', text: displayText, streaming: false, timestamp: ts, isError });
            }
          } else {
            // Regular message (user, assistant, thinking, etc.)
            const ts = msg.timestamp || (entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now());
            const text = extractFullText(msg);

            // Assistant messages can contain a thinking block before the text
            // block. While streaming these render as separate entries (a
            // 'thinking' entry from deltas, then the assistant text at
            // message_end) — mirror that here.
            if (role === 'assistant' && Array.isArray(msg.content)) {
              const thinking = msg.content
                .filter((c: any) => c.type === 'thinking')
                .map((c: any) => c.thinking || '')
                .join('')
                .trim();
              if (thinking) {
                messages.push({ role: 'thinking', text: thinking, streaming: false, timestamp: ts });
              }
            }

            // Skip messages with no text (e.g. assistant messages that only
            // contain toolCall blocks) — the streaming path never shows them.
            if (!text) continue;
            messages.push({ role, text, streaming: false, timestamp: ts });
          }
        }
      } catch (lineErr) { console.error('[autere] Failed to parse history line:', lineErr); continue; }
    }

    return messages.slice(-limit);
  } catch (err) {
    console.error('[autere] Failed to read session history:', err);
    return [];
  }
}
