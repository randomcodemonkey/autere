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
