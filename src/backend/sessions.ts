import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { SessionInfo } from './types.js';
import { PI_DIR } from './constants.js';

const SESSIONS_DIR = join(PI_DIR, 'sessions');

// ── Session listing ──

export function readSessions(): SessionInfo[] {
  try {
    const sessions: SessionInfo[] = [];
    if (!existsSync(SESSIONS_DIR)) return sessions;

    function findJsonlFiles(dir: string) {
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
                  } catch (lineErr) { console.error('[autere] Failed to parse session name:', lineErr); break; }
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
                  } catch (lineErr) { console.error('[autere] Failed to parse session timestamp:', lineErr); break; }
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
          } catch (lineErr) { console.error('[autere] Failed to parse session file:', lineErr); }
        }
      }
    }

    findJsonlFiles(SESSIONS_DIR);
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return sessions;
  } catch (err) {
    console.error('[autere] Failed to read sessions:', err);
    return [];
  }
}
