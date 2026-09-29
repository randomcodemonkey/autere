import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync, fstatSync, statSync } from 'fs';
import { join } from 'path';
import { SessionInfo } from './types.js';
import { getPiEnvDir, sandboxWorkPathToHost } from './pi-env.js';
import { log } from './logger.js';

/**
 * Resolve a session by id, tolerating id drift (see shared/find-session.ts
 * for details — this is a re-export so backend callers keep importing it
 * from the sessions module).
 */
export { findSession } from '../shared/find-session.js';


// ── Partial session file reading ──
// Session JSONL layout: line 1 is always the session header (id, timestamp);
// pi appends every event to the file, so the file's mtime IS the last
// activity time. The name lives in 'session_info' events which can appear
// anywhere. So we stat the file, read only the first chunk for the header,
// and scan backward in chunks for the name — avoiding a full readFileSync of
// every session file on each /api/sessions request.
const HEADER_CHUNK_BYTES = 8 * 1024;
const NAME_CHUNK_BYTES = 64 * 1024;
const NAME_OVERLAP_BYTES = 4 * 1024;

interface HeaderChunk { lines: string[]; coversStart: boolean; start: number }

/** Read [start, start + length + overlap) as lines. `coversStart` is true
 *  only when start === 0; otherwise the first line may be truncated. */
function readChunkAt(fd: number, start: number, length: number, overlap = 0): HeaderChunk {
  const buf = Buffer.alloc(length + overlap);
  const bytesRead = readSync(fd, buf, 0, length + overlap, start);
  return { lines: buf.subarray(0, bytesRead).toString('utf-8').split('\n'), coversStart: start === 0, start };
}

/** Split a chunk into lines, dropping the first (possibly truncated) line
 *  unless the chunk begins at the start of the file. */
function chunkLines(chunk: HeaderChunk): string[] {
  const lines = chunk.lines;
  if (!chunk.coversStart && lines.length > 0) lines.shift();
  return lines;
}

/**
 * Read a session's metadata using partial reads. Returns null when the fast
 * path can't produce a trustworthy result (caller falls back to a full read).
 *
 * `prev` (a cached info from an earlier, smaller version of this file) turns
 * this into an append-mode scan: header fields are reused (the JSONL header
 * is line 1 and never changes) and the backward name scan only covers the
 * appended region — session_info entries are append-only, so the newest name
 * is either in the appended tail or was already found by a previous scan.
 */
function readSessionInfoPartial(fullPath: string, prev?: SessionInfo & { cachedSize: number }): SessionInfo | null {
  let fd: number | null = null;
  try {
    fd = openSync(fullPath, 'r');
    const stats = fstatSync(fd);
    const size = stats.size;
    if (size === 0) return null;
    // mtime is the last time pi appended to the session file — i.e. the last
    // activity. Close enough for sorting/badges, and avoids reading the file
    // body for a timestamp entirely.
    const lastActivity = stats.mtimeMs;

    // ── Header: line 1 (reused from cache in append mode) ──
    let header: any;
    if (prev) {
      header = { id: prev.id, timestamp: prev.createdAt ? new Date(prev.createdAt).toISOString() : undefined, parentSession: prev.parentSession, cwd: prev.cwd };
    } else {
      const headerChunk = readChunkAt(fd, 0, Math.min(HEADER_CHUNK_BYTES, size));
      const headerLines = chunkLines(headerChunk);
      if (headerLines.length === 0 || !headerLines[0].trim()) return null;
      try {
        header = JSON.parse(headerLines[0]);
      } catch {
        return null; // oversized/corrupt header — full read will handle it
      }
      if (header.type !== 'session' || !header.id) return null;
    }

    const createdAt = header.timestamp ? new Date(header.timestamp).getTime() : 0;

    let sessionName: string | null = null;
    const findName = (lines: string[]): boolean => {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const e = JSON.parse(lines[i]);
          if (e.type === 'session_info' && e.name) {
            sessionName = e.name;
            return true;
          }
        } catch {
          // truncated boundary line — skip
        }
      }
      return false;
    };

    // ── Backward seek for the name ──
    // session_info events can appear anywhere, so scan backward from the
    // end of the file in chunks until found or file start. Each chunk
    // overlaps the previously scanned region so a session_info line
    // straddling a chunk boundary is still complete.
    // In append mode the scan floor is the cached size: everything below it
    // was already scanned in a previous pass (session_info is append-only,
    // so nothing new can appear there) — a miss falls back to the cached name.
    let pos = size;
    const floor = prev ? Math.max(0, prev.cachedSize - NAME_OVERLAP_BYTES) : 0;
    while (pos > floor && sessionName === null) {
      const len = Math.min(NAME_CHUNK_BYTES, pos - floor);
      const start = pos - len;
      findName(chunkLines(readChunkAt(fd, start, len, start > floor ? NAME_OVERLAP_BYTES : 0)));
      pos = start;
    }
    if (sessionName === null && prev) sessionName = prev.sessionName;

    return {
      id: header.id,
      sessionFile: fullPath,
      sessionName,
      parentSession: header.parentSession || null,
      createdAt,
      lastActivity,
      cwd: header.cwd || null,
    };
  } catch (err) {
    log.sessions.error(`Partial read failed for ${fullPath}, falling back to full read:`, err);
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
  }
}

// ── Session listing cache ──
// /api/sessions runs every 2s per connected user (broadcast loop) and on
// every modal open. Session files are append-only JSONL, so a file whose
// mtime+size is unchanged reuses its cached info (zero reads), and an
// appended file only rescans the appended tail — a session_info entry can
// only be appended, so the newest name is either in the appended region or
// already known from a previous scan.
interface CachedInfo { mtimeMs: number; size: number; info: SessionInfo }
const infoCache = new Map<string, CachedInfo>();

function readSessionInfoCached(fullPath: string): SessionInfo | null {
  let st;
  try { st = statSync(fullPath); } catch { infoCache.delete(fullPath); return null; }
  const cached = infoCache.get(fullPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info;
  const prev = cached && st.size > cached.size
    ? { ...cached.info, cachedSize: cached.size }
    : undefined;
  const info = readSessionInfoPartial(fullPath, prev) ?? readSessionInfoFull(fullPath);
  if (info) {
    infoCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, info });
    return info;
  }
  infoCache.delete(fullPath);
  return null;
}

/** Full-file parse (previous behavior) — fallback for files the partial
 *  reader can't handle. */
function readSessionInfoFull(fullPath: string): SessionInfo | null {
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    if (lines[0]) {
      const header = JSON.parse(lines[0]);
      if (header.type === 'session' && header.id) {
        let sessionName: string | null = null;
        for (let i = lines.length - 1; i >= 1; i--) {
          if (!lines[i].trim()) continue;
          try {
            const e = JSON.parse(lines[i]);
            if (e.type === 'session_info' && e.name) {
              sessionName = e.name;
              break;
            }
          } catch (lineErr) { log.sessions.error('Failed to parse session name:', lineErr); break; }
        }

        let lastActivity = header.timestamp ? new Date(header.timestamp).getTime() : 0;
        try { lastActivity = statSync(fullPath).mtimeMs; } catch {}
        for (let i = lines.length - 1; i >= 1; i--) {
          if (!lines[i].trim()) continue;
          try {
            const e = JSON.parse(lines[i]);
            if (e.timestamp) {
              const ts = new Date(e.timestamp).getTime();
              if (ts > lastActivity) lastActivity = ts;
              break;
            }
          } catch (lineErr) { log.sessions.error('Failed to parse session timestamp:', lineErr); break; }
        }

        return {
          id: header.id,
          sessionFile: fullPath,
          sessionName,
          parentSession: header.parentSession || null,
          createdAt: header.timestamp ? new Date(header.timestamp).getTime() : 0,
          lastActivity,
          cwd: header.cwd || null
        };
      }
    }
  } catch (lineErr) { log.sessions.error('Failed to parse session file:', lineErr); }
  return null;
}

// ── Session listing ──

/**
 * Read session files for ONE user — exclusively from that user's own pi
 * environment (~/.autere/pi-envs/{user}/sessions). The default pi location
 * (~/.pi/agent) is never consulted here: the global "admin sees legacy
 * sessions" hack was removed — the global dir belongs to the operator's
 * own CLI pi, not to any autere user.
 */
export function readSessions(user: string): SessionInfo[] {
  try {
    const sessions: SessionInfo[] = [];

    // Sandbox work paths ($HOME/work/<name> — what a docker-wrapped pi
    // records in the session header cwd) are translated back to the host
    // directory so existence checks and Changes navigation work on the host.
    const translateRoot = (info: SessionInfo): SessionInfo | null => {
      if (!info.cwd) return info;
      const host = sandboxWorkPathToHost(user, info.cwd);
      if (!host) return info;
      return { ...info, cwd: host };
    };

    function findJsonlFiles(dir: string) {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          findJsonlFiles(fullPath);
        } else if (entry.name.endsWith('.jsonl')) {
          // Fast path: cached info (unchanged files cost one stat), partial
          // reads for new/appended files (append-mode tail rescan for the
          // latter). Falls back to a full-file parse when neither works.
          const info = readSessionInfoCached(fullPath);
          if (!info) continue;
          const translated = translateRoot(info);
          if (!translated) continue;
          // A session whose stored working directory no longer exists can
          // never be switched to (pi refuses to load it) — don't list it.
          if (translated.cwd && !existsSync(translated.cwd)) continue;
          sessions.push(translated);
        }
      }
    }

    // The user's own pi environment sessions — the ONLY source
    findJsonlFiles(join(getPiEnvDir(user), 'sessions'));

    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return sessions;
  } catch (err) {
    log.sessions.error('Failed to read sessions:', err);
    return [];
  }
}
