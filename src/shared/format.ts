/**
 * Node-free pure formatting/parsing helpers shared by the backend and
 * frontend tests. Must not import node builtins so Cypress component
 * tests (browser bundle) can import it directly.
 */

// ── Cookie parsing ──

export function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [key, ...val] = part.split('=');
    if (key) cookies[key.trim()] = val.join('=').trim();
  }
  return cookies;
}

// ── Message text extraction ──

/**
 * Extract the display text of a pi message.
 * Matches the streaming path: no prefix for successful tool results,
 * error prefix only for errors. Never emits placeholders for non-text
 * content blocks.
 */
export function extractFullText(message: any): string {
  if (!message.content) return '';
  if (message.role === 'toolResult') {
    const toolName = message.toolName || 'tool';
    const textContent = message.content.find((c: any) => c.type === 'text');
    const output = textContent?.text || '';
    return message.isError ? (output ? `[${toolName} error] ${output}` : `[${toolName} error]`) : output;
  }
  return message.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('');
}

// ── Tool args formatting (ToolsCard / recent tools display) ──

export function formatToolArgs(name: string, args: any): string {
  if (!args) return '';
  if (name === 'bash' && typeof args.command === 'string') return args.command;
  if (name === 'read' && typeof args.path === 'string') return args.path;
  if (name === 'write' && typeof args.path === 'string') return args.path;
  if (name === 'edit' && typeof args.path === 'string') return args.path;
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

// ── Stream history deduplication ──

/**
 * Deduplicate stream history entries while preserving order.
 * First occurrence wins for position, later duplicates overwrite the
 * value (keeps the freshest content). Streaming entries dedupe by
 * role+timestamp; content entries by role+text (+timestamp except for
 * thinking, which updates in place as it grows).
 */
export function dedupHistory(history: any[]): any[] {
  const byKey = new Map<string, any>();
  const order: string[] = [];
  for (const msg of history) {
    if (msg.streaming) {
      const key = `streaming-${msg.role}-${msg.timestamp || 0}`;
      byKey.set(key, msg);
      if (!order.includes(key)) order.push(key);
      continue;
    }
    const isThinking = msg.role === 'thinking';
    const contentKey = isThinking
      ? `${msg.role}|${msg.text?.slice(0, 200) || ''}`
      : `${msg.role}|${msg.text || ''}|${msg.timestamp || 0}`;
    byKey.set(contentKey, msg);
    if (!order.includes(contentKey)) order.push(contentKey);
  }
  return order.map(key => byKey.get(key)!);
}

// ── Image extraction ──

export interface StreamImage {
  mimeType: string;
  data: string; // base64
}

/** Extract base64 image blocks from pi message content arrays */
export function extractImages(content: any[] | undefined | null): StreamImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: any) => c.type === 'image' && c.data)
    .map((c: any) => ({ mimeType: c.mimeType || 'image/png', data: c.data }));
}

// ── rm command detection (bash tool) ──

/** Whether a bash command is an rm invocation (optionally with path prefix) */
export function isRmCommand(command?: string): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  return /^\S*\brm\b/.test(trimmed);
}

/** Extract the target paths of an rm command (flags skipped) */
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
  // NOTE: cost is intentionally NOT accumulated here — session cost flows
  // through UserSession.setCostTotal/accumulateMessageCost, which also
  // price models pi's catalog doesn't know. Accumulating usage.cost here
  // as well would double-count catalog-priced messages.
}

// ── Name sanitization (filesystem-safe user names) ──

/** Sanitize a user name for filesystem use (dirs under ~/.autere) */
export function sanitizeUserName(user: string): string {
  return user.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ── Model scoping ──

/**
 * Filter a model list down to entries matching the enabled-models patterns.
 * A pattern matches either the full `provider/id` or its bare `id` suffix.
 * An empty pattern list disables filtering (all models pass).
 */
export function filterModelsByPatterns(
  models: { provider: string; id: string }[],
  patterns: string[],
): { provider: string; id: string }[] {
  if (!patterns || patterns.length === 0) return models;
  return models.filter(m => {
    const ref = `${m.provider}/${m.id}`;
    return patterns.some(pattern => ref === pattern || ref.endsWith('/' + pattern));
  });
}

/**
 * Look up a per-model map entry for a runtime model, tolerating key-format
 * drift: matches `provider/id`, bare `id`, or any key whose id suffix is `id`.
 * Used for per-model thinking levels and reserve-% maps keyed like
 * `enabledModels` entries (`provider/model`).
 */
export function matchModelMap<T>(
  map: Record<string, T> | undefined | null,
  provider: string | undefined | null,
  id: string | undefined | null,
): T | undefined {
  if (!map || !id) return undefined;
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  for (const key of provider ? [`${provider}/${id}`, id] : [id]) {
    if (key in map) return map[key];
  }
  for (const [key, value] of Object.entries(map)) {
    const slash = key.indexOf('/');
    if (slash > 0 && key.slice(slash + 1) === bare) return value;
  }
  return undefined;
}

// ── Session auto-naming helpers ──

/** Date label used for auto-naming sessions, e.g. "2026-09-05" (local time) */
export function sessionDateLabel(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface SessionStampOptions {
  /** BCP-47 locale tag, e.g. "fi-FI" */
  locale?: string;
  /** IANA time zone, e.g. "Europe/Helsinki" — Intl converts correctly */
  timeZone?: string;
}

/**
 * Session name stamp in the user's locale + timezone, e.g.
 * "3.9.2026 klo 12.00.45" (fi-FI) or "Sep 3, 2026, 12:00:45 PM" (en-US) —
 * includes seconds. Formatting happens where the timezone is known:
 * the frontend for UI-created sessions, backend fallbacks via the user's
 * persisted locale/timeZone (Intl handles the IANA zone conversion).
 */
export function sessionLocaleStamp(opts: SessionStampOptions = {}, date: Date = new Date()): string {
  const format = (timeZone?: string) =>
    date.toLocaleString(opts.locale || undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone });
  try {
    return format(opts.timeZone || undefined);
  } catch {
    // Invalid locale or time zone tag — fall back to runtime defaults
    try {
      return format(undefined);
    } catch {
      return date.toISOString();
    }
  }
}

/** Full auto-generated session name, e.g. "[ui] - Sep 3, 2026, 12:00:45 PM" */
export function autoSessionName(prefix: '[ui]' | '[task]', opts: SessionStampOptions = {}, date: Date = new Date()): string {
  return `${prefix} - ${sessionLocaleStamp(opts, date)}`;
}
