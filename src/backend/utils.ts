import { ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { StreamEntry, SessionUsageResult } from './types.js';
import { streamHistory, newSessionCreating, sseClients } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_DIR = join(homedir(), '.pi', 'agent');

// ── Scoped models from settings.json ──

export function getEnabledModelPatterns(): string[] {
  try {
    const settingsPath = join(PI_DIR, 'settings.json');
    if (!existsSync(settingsPath)) return [];
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings.enabledModels || [];
  } catch {
    return [];
  }
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

// ── SSE broadcast ──

export function broadcast(event: any) {
  // Suppress stale stream_history while a new session is being created.
  if (newSessionCreating && event.type === 'stream_history') return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
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

// ── Stream history dedup ──

export function dedupStreamHistory(): StreamEntry[] {
  const byKey = new Map<string, StreamEntry>();
  const order: string[] = [];
  for (const msg of streamHistory) {
    if (msg.streaming) {
      const key = `streaming-${msg.role}-${msg.timestamp || 0}`;
      byKey.set(key, msg);
      order.push(key);
      continue;
    }
    // For thinking messages: deduplicate by role + text (keep newest)
    // For other messages: use role + text + timestamp (each is unique)
    const isThinking = msg.role === 'thinking';
    const contentKey = isThinking
      ? `${msg.role}|${msg.text?.slice(0, 200) || ''}`
      : `${msg.role}|${msg.text?.slice(0, 200) || ''}|${msg.timestamp || 0}`;
    const existing = byKey.get(contentKey);
    if (!existing) {
      byKey.set(contentKey, msg);
      order.push(contentKey);
    } else if (isThinking && (msg.timestamp || 0) > (existing.timestamp || 0)) {
      // For thinking messages, keep the newest one
      byKey.set(contentKey, msg);
    }
  }
  return order.map(k => byKey.get(k)!);
}

// ── Tool args formatting ──

export function formatToolArgs(name: string, args: any): string {
  if (!args) return '';
  if (name === 'bash' && args.command) return args.command;
  if (name === 'read' && args.path) return args.path;
  if (name === 'write' && args.path) return args.path + (args.content ? ' (' + args.content.length + ' chars)' : '');
  if (name === 'edit' && args.path) return args.path;
  if (name === 'find' && args.path) return args.path;
  if (name === 'ls' && args.path) return args.path;
  if (name === 'send_wa_message') return (args.jid || args.recipient_jid || '') + ' ' + (args.message || '').slice(0, 50);
  if (name === 'send_reaction') return (args.jid || '') + ' ' + (args.emoji || '');
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

// ── Message extraction ──

export function extractPreview(message: any): string {
  if (!message.content) return '';
  if (message.role === 'toolResult') {
    const toolName = message.toolName || 'tool';
    const textContent = message.content.find((c: any) => c.type === 'text');
    const output = textContent?.text || '';
    const prefix = message.isError ? `[${toolName} error]` : `[${toolName}]`;
    if (!output) return prefix;
    const trimmed = output.length > 200 ? output.slice(0, 200) + '...' : output;
    return prefix + ' ' + trimmed;
  }
  const textContent = message.content.find((c: any) => c.type === 'text');
  if (textContent?.text) {
    return textContent.text.slice(0, 100) + (textContent.text.length > 100 ? '...' : '');
  }
  const types = message.content.map((c: any) => c.type).filter(Boolean);
  if (types.length > 0) {
    return '[' + types.join(', ') + ']';
  }
  return '[empty]';
}

export function extractFullText(message: any): string {
  if (!message.content) return '';
  if (message.role === 'toolResult') {
    const toolName = message.toolName || 'tool';
    const textContent = message.content.find((c: any) => c.type === 'text');
    const output = textContent?.text || '';
    const prefix = message.isError ? `[${toolName} error]` : `[${toolName}]`;
    return output ? prefix + ' ' + output : prefix;
  }
  const textContent = message.content.find((c: any) => c.type === 'text');
  if (textContent?.text) {
    return textContent.text;
  }
  const types = message.content.map((c: any) => c.type).filter(Boolean);
  return types.length > 0 ? '[' + types.join(', ') + ']' : '';
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
            
            if (toolName === 'edit') {
              // Edit tool - use content.text as header, details.diff as body
              const header = output; // e.g. "Successfully replaced 1 block(s) in /path/to/file"
              const diff = msg.details?.diff || '';
              // Combine header and diff with empty line separator
              const text = diff ? header + '\n\n' + diff : header;
              const ts = msg.timestamp || (entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now());
              messages.push({ role: 'edit', text, streaming: false, timestamp: ts, isError });
            } else {
              // Other tool - show as toolResult with prefix
              const prefix = isError ? `[${toolName} error]` : `[${toolName}]`;
              const displayText = output ? prefix + ' ' + output : prefix;
              const ts = msg.timestamp || (entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now());
              messages.push({ role: 'toolResult', text: displayText, streaming: false, timestamp: ts, isError });
            }
          } else {
            // Regular message (user, assistant, thinking, etc.)
            const text = extractFullText(msg);
            const ts = msg.timestamp || (entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now());
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
