import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync, fstatSync, statSync } from 'fs';
import { join } from 'path';
import { SessionInfo } from './types.js';
import { getPiEnvDir } from './pi-env.js';
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
 */
function readSessionInfoPartial(fullPath: string): SessionInfo | null {
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

    // ── Header: line 1 ──
    const headerChunk = readChunkAt(fd, 0, Math.min(HEADER_CHUNK_BYTES, size));
    const headerLines = chunkLines(headerChunk);
    if (headerLines.length === 0 || !headerLines[0].trim()) return null;
    let header: any;
    try {
      header = JSON.parse(headerLines[0]);
    } catch {
      return null; // oversized/corrupt header — full read will handle it
    }
    if (header.type !== 'session' || !header.id) return null;

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
    let pos = size;
    while (pos > 0 && sessionName === null) {
      const len = Math.min(NAME_CHUNK_BYTES, pos);
      const start = pos - len;
      findName(chunkLines(readChunkAt(fd, start, len, NAME_OVERLAP_BYTES)));
      pos = start;
    }

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

    function findJsonlFiles(dir: string) {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          findJsonlFiles(fullPath);
        } else if (entry.name.endsWith('.jsonl')) {
          // Fast path: partial reads (stat + header line + backward name
          // scan). Falls back to a full-file parse when the fast path can't
          // produce a result.
          const info = readSessionInfoPartial(fullPath) ?? readSessionInfoFull(fullPath);
          // A session whose stored working directory no longer exists can
          // never be switched to (pi refuses to load it) — don't list it.
          if (info && (!info.cwd || existsSync(info.cwd))) sessions.push(info);
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
