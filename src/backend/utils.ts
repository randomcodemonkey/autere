import { ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { StreamEntry, SessionUsageResult } from './types.js';
import { getUserSetting } from './user-settings.js';
import { log } from './logger.js';
import { buildStreamHistoryFromMessages, readAllMessageEntries } from './stream-history.js';

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

export { extractFullText } from '../shared/format.js';

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
      } catch (lineErr) { log.utils.error('Failed to parse session usage line:', lineErr); continue; }
    }
  } catch (err) { log.utils.error('Failed to read session usage:', err); }
  return stats;
}

export function readSessionHistory(sessionFile: string, limit: number = 30): StreamEntry[] {
  try {
    if (!existsSync(sessionFile)) return [];
    // Rendering is shared with the live streaming path (stream-history.ts) so
    // file-loaded history always matches what live events produce — including
    // edit/write/rm tool rendering that this function used to reimplement.
    return buildStreamHistoryFromMessages(readAllMessageEntries(sessionFile)).slice(-limit) as StreamEntry[];
  } catch (err) {
    log.utils.error('Failed to read session history:', err);
    return [];
  }
}
