/**
 * Notification limits and pure helpers shared by the backend routes, the
 * pi-autere `send_notification` tool (own copy — it is a standalone
 * extension) and the component tests.
 */

/** Maximum characters in a notification body (explicit content and the
 *  turn-end preview). Counted in code points, so emoji count as one. */
export const NOTIFICATION_MAX_CONTENT = 256;

/** The body a notification carries: `content` as-is, or the first
 *  NOTIFICATION_MAX_CONTENT characters of `text` (turn-end preview). */
export function clipNotification(text: string, max: number = NOTIFICATION_MAX_CONTENT): string {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/** Validation for explicit notification content — an error message, or null
 *  when the content is acceptable. */
export function validateNotificationContent(content: unknown): string | null {
  if (typeof content !== 'string' || !content.trim()) return 'content is required';
  const len = [...content].length;
  if (len > NOTIFICATION_MAX_CONTENT) {
    return `content must be at most ${NOTIFICATION_MAX_CONTENT} characters (got ${len}) — shorten it and retry`;
  }
  return null;
}

/** The minimum work length shared by the turn-end and all-done notifications. */
export function workedLongEnough(minMinutes: number, elapsedMs: number): boolean {
  if (!Number.isFinite(minMinutes) || minMinutes <= 0) return true;
  return elapsedMs >= minMinutes * 60_000;
}

/**
 * Policy for "all tasks completed", evaluated once a work block has gone
 * quiet: gated by the same minimum length as the turn-end notification (a
 * long run finishing is the news), and a turn-end notification sent moments
 * ago wins so enabling both options never double-notifies one moment. The
 * caller owns the busy checks (still streaming / queued → not quiet yet).
 */
export function shouldNotifyAllDone(
  state: { workedMs: number; msSinceTurnEndNotify: number },
  opts: { minMinutes: number; dedupeMs: number },
): boolean {
  if (!workedLongEnough(opts.minMinutes, state.workedMs)) return false;
  return state.msSinceTurnEndNotify >= opts.dedupeMs;
}
