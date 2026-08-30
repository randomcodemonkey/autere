import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { PI_DIR } from './constants.js';
import { availableSessions, sessionsRetryTimeout, setSessionsRetryTimeout } from './state.js';
import { broadcast } from './utils.js';
// ── Session listing ──
export function readSessions() {
    // Clear any pending retry so we don't stack duplicates
    if (sessionsRetryTimeout) {
        clearTimeout(sessionsRetryTimeout);
        setSessionsRetryTimeout(null);
    }
    try {
        const sessions = [];
        const sessionsDir = join(PI_DIR, 'sessions');
        if (!existsSync(sessionsDir)) {
            availableSessions.length = 0;
            return;
        }
        function findJsonlFiles(dir) {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                    findJsonlFiles(fullPath);
                }
                else if (entry.name.endsWith('.jsonl')) {
                    try {
                        const content = readFileSync(fullPath, 'utf-8');
                        const lines = content.split('\n');
                        if (lines[0]) {
                            const header = JSON.parse(lines[0]);
                            if (header.type === 'session' && header.id) {
                                let sessionName = null;
                                for (let i = lines.length - 1; i >= 1; i--) {
                                    if (!lines[i].trim())
                                        continue;
                                    try {
                                        const e = JSON.parse(lines[i]);
                                        if (e.type === 'session_info' && e.name) {
                                            sessionName = e.name;
                                            break;
                                        }
                                    }
                                    catch (lineErr) {
                                        console.error('[pi-monitor] Failed to parse session name:', lineErr);
                                        break;
                                    }
                                }
                                let lastActivity = header.timestamp ? new Date(header.timestamp).getTime() : 0;
                                for (let i = lines.length - 1; i >= 1; i--) {
                                    if (!lines[i].trim())
                                        continue;
                                    try {
                                        const e = JSON.parse(lines[i]);
                                        if (e.timestamp) {
                                            const ts = new Date(e.timestamp).getTime();
                                            if (ts > lastActivity)
                                                lastActivity = ts;
                                            break;
                                        }
                                    }
                                    catch (lineErr) {
                                        console.error('[pi-monitor] Failed to parse session timestamp:', lineErr);
                                        break;
                                    }
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
                    }
                    catch (lineErr) {
                        console.error('[pi-monitor] Failed to parse session file:', lineErr);
                    }
                }
            }
        }
        findJsonlFiles(sessionsDir);
        sessions.sort((a, b) => b.lastActivity - a.lastActivity);
        const prev = JSON.stringify(availableSessions);
        availableSessions.length = 0;
        availableSessions.push(...sessions);
        if (JSON.stringify(sessions) !== prev) {
            broadcast({ type: 'sessions', data: availableSessions });
        }
        else {
            setSessionsRetryTimeout(setTimeout(() => {
                setSessionsRetryTimeout(null);
                readSessions();
            }, 1500));
        }
    }
    catch (err) {
        console.error('[pi-monitor] Failed to read sessions:', err);
    }
}
