import { existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { sessionState, sessionStats, streamHistory, lastEventTime, lastKnownFileSize, externalCheckInterval, externalWatchActive, currentPollInterval, consecutiveNoMessagePolls, lastExternalActivityTime, setLastEventTime, setLastKnownFileSize, setExternalCheckInterval, setExternalWatchActive, setCurrentPollInterval, setConsecutiveNoMessagePolls, setLastExternalActivityTime } from './state.js';
import { extractFullText, dedupStreamHistory, broadcast } from './utils.js';
// ── External activity detection ──
export function updateLastEventTime() {
    setLastEventTime(Date.now());
    if (externalWatchActive && sessionState.externalActivity) {
        sessionState.externalActivity = false;
        broadcast({ type: 'status', data: { ...sessionState } });
    }
}
export function checkExternalActivity() {
    if (sessionState.externalActivity && lastExternalActivityTime > 0 && Date.now() - lastExternalActivityTime > 60_000) {
        sessionState.externalActivity = false;
        broadcast({ type: 'status', data: { ...sessionState } });
    }
    const sessionFile = sessionState.sessionFile;
    if (!sessionFile || !existsSync(sessionFile))
        return;
    try {
        const st = statSync(sessionFile);
        const currentSize = st.size;
        if (currentSize < lastKnownFileSize) {
            setLastKnownFileSize(0);
        }
        const eventSilence = Date.now() - lastEventTime;
        if (currentSize > lastKnownFileSize && eventSilence > 5_000) {
            const fd = openSync(sessionFile, 'r');
            const buf = Buffer.alloc(currentSize - lastKnownFileSize);
            readSync(fd, buf, 0, buf.length, lastKnownFileSize);
            closeSync(fd);
            const newLines = buf.toString('utf-8').split('\n').filter(l => l.trim());
            let newMessagesFound = false;
            for (const line of newLines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'message' && entry.message) {
                        const msg = entry.message;
                        const role = msg.role || '';
                        if (!role || role === 'model_change')
                            continue;
                        const text = extractFullText(msg);
                        const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
                        const contentPrefix = text.slice(0, 200);
                        const isDuplicate = streamHistory.some(m => !m.streaming && m.role === role && m.text?.slice(0, 200) === contentPrefix);
                        if (!isDuplicate) {
                            streamHistory.push({ role, text, streaming: false, timestamp: ts });
                            newMessagesFound = true;
                            if (role === 'user') {
                                sessionState.messageCount++;
                            }
                            else if (role === 'assistant') {
                                sessionState.messageCount++;
                                const usage = msg.usage;
                                if (usage) {
                                    sessionStats.tokens.input += usage.input || 0;
                                    sessionStats.tokens.output += usage.output || 0;
                                    sessionStats.tokens.cacheRead += usage.cacheRead || 0;
                                    sessionStats.tokens.cacheWrite += usage.cacheWrite || 0;
                                }
                            }
                        }
                    }
                }
                catch (lineErr) {
                    console.error('[pi-monitor] Failed to parse external activity line:', lineErr);
                    continue;
                }
            }
            if (streamHistory.length > 200) {
                streamHistory.splice(0, streamHistory.length - 200);
            }
            sessionState.externalActivity = true;
            setLastExternalActivityTime(Date.now());
            setLastKnownFileSize(currentSize);
            if (newMessagesFound) {
                setConsecutiveNoMessagePolls(0);
                adaptPollRate();
                broadcast({ type: 'stream_history', data: dedupStreamHistory().slice(-50) });
                broadcast({ type: 'status', data: { ...sessionState } });
                broadcast({ type: 'stats', data: { ...sessionStats } });
            }
            else {
                setConsecutiveNoMessagePolls(consecutiveNoMessagePolls + 1);
                adaptPollRate();
            }
        }
        else if (currentSize !== lastKnownFileSize) {
            setLastKnownFileSize(currentSize);
        }
    }
    catch (err) {
        console.error('[pi-monitor] Failed to check external activity:', err);
    }
}
// ── Polling rate adaptation ──
export function adaptPollRate() {
    if (!externalCheckInterval)
        return;
    clearInterval(externalCheckInterval);
    if (consecutiveNoMessagePolls >= 5) {
        setCurrentPollInterval(15_000);
    }
    else if (sessionState.externalActivity) {
        setCurrentPollInterval(2_000);
    }
    else {
        setCurrentPollInterval(15_000);
    }
    setExternalCheckInterval(setInterval(checkExternalActivity, currentPollInterval));
}
// ── Start / stop monitoring ──
export function startExternalMonitoring() {
    stopExternalMonitoring();
    setLastEventTime(Date.now());
    setExternalWatchActive(true);
    setCurrentPollInterval(15_000);
    setConsecutiveNoMessagePolls(0);
    const sessionFile = sessionState.sessionFile;
    if (sessionFile && existsSync(sessionFile)) {
        try {
            setLastKnownFileSize(statSync(sessionFile).size);
        }
        catch (err) {
            console.error('[pi-monitor] Failed to get initial file size:', err);
        }
    }
    setExternalCheckInterval(setInterval(checkExternalActivity, currentPollInterval));
}
export function stopExternalMonitoring() {
    if (externalCheckInterval) {
        clearInterval(externalCheckInterval);
        setExternalCheckInterval(null);
    }
    setExternalWatchActive(false);
    if (sessionState.externalActivity) {
        sessionState.externalActivity = false;
    }
}
