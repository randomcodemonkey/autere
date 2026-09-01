import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { SessionInfo } from './types.js';
import { PI_DIR } from './constants.js';
import { getPiEnvDir } from './pi-env.js';
import { log } from './logger.js';

const SESSIONS_DIR = join(PI_DIR, 'sessions');

// ── Session listing ──

/**
 * Read session files, user-scoped.
 *
 * With per-user pi environments, each user's sessions live in
 * ~/.autere/pi-envs/{user}/sessions. Passing a user scans only that
 * user's environment (plus optionally the legacy global ~/.pi/agent
 * sessions, which predate per-user envs). Without a user, scans the
 * global dir and ALL user envs — only appropriate for tools that need
 * a global view; dashboard routes should always pass the user.
 */
export function readSessions(user?: string, includeGlobal: boolean = true): SessionInfo[] {
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

                sessions.push({
                  id: header.id,
                  sessionFile: fullPath,
                  sessionName,
                  parentSession: header.parentSession || null,
                  createdAt: header.timestamp ? new Date(header.timestamp).getTime() : 0,
                  lastActivity,
                  cwd: header.cwd || null
                });
              }
            }
          } catch (lineErr) { log.sessions.error('Failed to parse session file:', lineErr); }
        }
      }
    }

    // Legacy global sessions (pre-per-user-env, and CLI sessions)
    if (includeGlobal) {
      findJsonlFiles(SESSIONS_DIR);
    }

    // The user's own pi environment sessions
    if (user) {
      findJsonlFiles(join(getPiEnvDir(user), 'sessions'));
    }

    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return sessions;
  } catch (err) {
    log.sessions.error('Failed to read sessions:', err);
    return [];
  }
}
