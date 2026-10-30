/**
 * Streaming tool-call arguments.
 *
 * pi emits toolcall_start/delta/end inside message_update while the model is
 * still writing the call's arguments — for a big `write` that is seconds
 * before tool_execution_start. Deltas carry only the assistant message's
 * contentIndex, so pending calls are keyed by it; tool_execution_start
 * carries the tool call id (known from the start, or only at end for some
 * providers) and adopts the streaming card instead of pushing a duplicate.
 */

import { formatToolArgs } from '../shared/format.js';

export interface PendingToolCall {
  /** contentIndex inside the assistant message (deltas carry only this) */
  index: number;
  name: string;
  /** tool call id, when the provider reports one */
  id: string | null;
  /** raw streamed JSON arguments, as received */
  json: string;
  /** last preview broadcast (throttling is the caller's business) */
  at: number;
  /** streaming history entry this call renders into */
  entry?: any;
}

/**
 * Best-effort fields of a half-written JSON argument object: only complete
 * "key": "value" pairs are picked up, so the preview never shows torn text.
 */
export function partialToolArgs(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /"([A-Za-z0-9_-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    if (!(m[1] in out)) {
      try { out[m[1]] = JSON.parse(`"${m[2]}"`); } catch { /* incomplete escape — skip */ }
    }
    if (Object.keys(out).length >= 8) break;
  }
  return out;
}

/** Cap for the streamed preview — the full command arrives on toolcall_end */
const PREVIEW_MAX = 400;

/** One-line preview of a call whose arguments are still streaming in. */
export function toolCallPreview(name: string, json: string): string {
  const text = formatToolArgs(name, partialToolArgs(json));
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}...` : text;
}

export class ToolArgStream {
  private pending = new Map<number, PendingToolCall>();

  start(evt: any): PendingToolCall {
    const rec: PendingToolCall = {
      index: evt.contentIndex,
      name: evt.toolName || evt.toolCall?.name || 'tool',
      id: evt.id || evt.toolCall?.id || null,
      json: '',
      at: 0,
    };
    this.pending.set(rec.index, rec);
    return rec;
  }

  delta(evt: any): PendingToolCall | null {
    const rec = this.pending.get(evt.contentIndex);
    if (!rec) return null;
    if (typeof evt.delta === 'string') rec.json += evt.delta;
    return rec;
  }

  end(evt: any): PendingToolCall | null {
    // Defensive: a provider may report only the finished call
    const rec = this.pending.get(evt.contentIndex) ?? this.start(evt);
    const call = evt.toolCall;
    if (call?.id) rec.id = call.id;
    if (call?.name) rec.name = call.name;
    if (call?.arguments) rec.json = JSON.stringify(call.arguments);
    return rec;
  }

  /** Adopt a pending call at tool_execution_start (by id, then by name). */
  take(id: string, name?: string): PendingToolCall | null {
    for (const rec of this.pending.values()) {
      if (rec.id && rec.id === id) {
        this.pending.delete(rec.index);
        return rec;
      }
    }
    // Providers that never report ids: oldest pending call of that name.
    // Without a name there is nothing to safely match against — never steal
    // an unrelated call.
    if (!name) return null;
    let fallback: PendingToolCall | null = null;
    for (const rec of this.pending.values()) {
      if (rec.name !== name) continue;
      if (!fallback || rec.index < fallback.index) fallback = rec;
    }
    if (fallback) this.pending.delete(fallback.index);
    return fallback;
  }

  /** Drop and return everything still pending (turn end, failed attempt). */
  drain(): PendingToolCall[] {
    const all = [...this.pending.values()];
    this.pending.clear();
    return all;
  }
}
