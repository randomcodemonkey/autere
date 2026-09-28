import { ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { StreamEntry, SessionUsageResult } from './types.js';
import { getUserSetting } from './user-settings.js';
import { log } from './logger.js';
import { filterModelsByPatterns } from '../shared/format.js';
import { buildStreamHistoryFromMessages, readAllMessageEntries } from './stream-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Scoped models from user settings ──

export function getEnabledModelPatterns(): string[] {
  return getUserSetting('admin', 'enabledModels', []);
}

/** Filter models to only those matching the enabled/scoped models list */
export function filterScopedModels(models: any[]): any[] {
  return filterModelsByPatterns(models, getEnabledModelPatterns());
}

/**
 * Filter to enabled models, always keeping the session's actual current model
 * (visible even if it isn't in the enabled list).
 */
export function scopeModelsForSession(models: any[], current?: { provider?: string; id?: string; name?: string } | null): any[] {
  const scoped = filterScopedModels(models).map((m: any) => ({
    provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined,
  }));
  if (current?.id && !scoped.some((m: any) => m.id === current.id && m.provider === (current.provider || ''))) {
    scoped.unshift({ provider: current.provider || '', id: current.id, name: current.name || current.id, thinkingLevel: undefined });
  }
  return scoped;
}

/**
 * Enabled models for sessions with no running pi process (no RPC to ask).
 * enabledModels entries are "provider/model" or bare "model" strings; no
 * richer metadata is available without a router dependency.
 */
export function getEnabledModelEntries(): any[] {
  return getEnabledModelPatterns().map((p) => {
    const slash = p.indexOf('/');
    if (slash > 0) return { provider: p.slice(0, slash), id: p.slice(slash + 1), name: p.slice(slash + 1), thinkingLevel: undefined };
    return { provider: '', id: p, name: p, thinkingLevel: undefined };
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
  let html: string;
  if (existsSync(distPath)) {
    html = readFileSync(distPath, 'utf-8');
  } else {
    const htmlPath = join(__dirname, '..', '..', 'public', 'index.html');
    html = readFileSync(htmlPath, 'utf-8');
  }
  if (basePath) {
    // 1. Rewrite Vite-baked absolute asset paths so the browser loads
    //    them from the correct proxied location.
    //    e.g.  src="/assets/index.js"  →  src="/autere/assets/index.js"
    html = html.replace(/(src|href)="\//g, `$1="${basePath}/`);

    // 2. Inject runtime base path so the frontend JS knows the prefix.
    //    The frontend reads window.__AUTERE_BASE__ and uses it for
    //    all fetch() / EventSource calls.
    const script = `<script>window.__AUTERE_BASE__ = ${JSON.stringify(basePath)}</script>`;
    html = html.replace('<head>', `<head>${script}`);
  }
  return html;
}

export { extractFullText } from '../shared/format.js';

// ── Session file I/O ──

export function readSessionUsage(
  sessionFile: string,
  price?: (modelId: string | undefined, usage: any) => number,
): SessionUsageResult {
  const stats: SessionUsageResult = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    messageCount: 0,
    requestCount: 0,
    cost: 0,
  };
  try {
    if (!existsSync(sessionFile)) return stats;
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n');
    let lastModel: string | undefined;
    const addCost = (modelId: string | undefined, usage: any) => {
      const piCost = Number(usage?.cost?.total);
      stats.cost += Number.isFinite(piCost) && piCost > 0 ? piCost : price ? price(modelId, usage) : 0;
    };
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'compaction' && entry.usage) {
          // Compaction is a real billed LLM call; price it at the model in
          // effect when it ran (compaction entries carry no model of their own).
          const u = entry.usage;
          stats.tokens.input += u.input || 0;
          stats.tokens.output += u.output || 0;
          stats.tokens.cacheRead += u.cacheRead || 0;
          stats.tokens.cacheWrite += u.cacheWrite || 0;
          addCost(lastModel, u);
          continue;
        }
        if (entry.type !== 'message') continue;
        stats.messageCount++;
        const message = entry.message;
        if (message?.role === 'assistant') {
          stats.requestCount++;
          lastModel = message.model || lastModel;
          const usage = message.usage;
          if (usage) {
            stats.tokens.input += usage.input || 0;
            stats.tokens.output += usage.output || 0;
            stats.tokens.cacheRead += usage.cacheRead || 0;
            stats.tokens.cacheWrite += usage.cacheWrite || 0;
            addCost(message.model, usage);
          }
        } else if (message?.role === 'toolResult' && message.usage) {
          // pi counts toolResult usage in its session stats — mirror it
          const usage = message.usage;
          stats.tokens.input += usage.input || 0;
          stats.tokens.output += usage.output || 0;
          stats.tokens.cacheRead += usage.cacheRead || 0;
          stats.tokens.cacheWrite += usage.cacheWrite || 0;
        }
      } catch (lineErr) { log.utils.error('Failed to parse session usage line:', lineErr); continue; }
    }
  } catch (err) { log.utils.error('Failed to read session usage:', err); }
  return stats;
}

// Session auto-naming helpers live in shared/format.ts (pure, browser-safe —
// component tests import them from there); re-exported for backend callers.
export { sessionDateLabel, sessionLocaleStamp, autoSessionName } from '../shared/format.js';

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
