/**
 * Session lookup by id, tolerant of id drift (pure, shared with the
 * frontend test suite — must not import Node or backend modules).
 */

/** Structural subset of the backend's SessionInfo */
export interface SessionRef {
  id: string;
  sessionFile: string;
}

/**
 * Resolve a session by id, tolerating id drift: pi rewrites the session
 * header (with a fresh id) in the same file when a session is resumed,
 * while the filename keeps the original id. So an id known to the
 * frontend (bookmark / client tracking) may match a filename but no
 * longer match the header id that readSessions() uses. Fall back to a
 * filename match in that case.
 *
 * Guards against missing/empty ids — callers (e.g. the SSE connect path)
 * may legitimately pass null/undefined while state is mid-transition.
 */
export function findSession<S extends SessionRef>(sessionId: string | null | undefined, sessions: S[]): S | undefined {
  if (!sessionId) return undefined;
  const byId = sessions.find(s => s.id === sessionId);
  if (byId) return byId;
  const lower = sessionId.toLowerCase();
  return sessions.find(s => {
    const file = s.sessionFile;
    if (!file) return false;
    const name = file.split('/').pop() || '';
    return name.toLowerCase().includes(lower);
  });
}
