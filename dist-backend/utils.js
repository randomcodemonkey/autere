import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { streamHistory, newSessionCreating, sseClients } from './state.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
// ── SSE broadcast ──
export function broadcast(event) {
    // Suppress stale stream_history while a new session is being created.
    if (newSessionCreating && event.type === 'stream_history')
        return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(data);
        }
        catch {
            sseClients.delete(client);
        }
    }
}
// ── JSON response ──
export function sendJSON(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
// ── HTML serving ──
export function getDashboardHTML() {
    const distPath = join(__dirname, '..', '..', 'dist', 'index.html');
    if (existsSync(distPath))
        return readFileSync(distPath, 'utf-8');
    const htmlPath = join(__dirname, '..', '..', 'public', 'index.html');
    return readFileSync(htmlPath, 'utf-8');
}
// ── Stream history dedup ──
export function dedupStreamHistory() {
    const byKey = new Map();
    const order = [];
    for (const msg of streamHistory) {
        if (msg.streaming) {
            const key = `streaming-${msg.role}-${msg.timestamp || 0}`;
            byKey.set(key, msg);
            order.push(key);
            continue;
        }
        const contentKey = `${msg.role}|${msg.text?.slice(0, 200) || ''}`;
        const existing = byKey.get(contentKey);
        if (!existing) {
            byKey.set(contentKey, msg);
            order.push(contentKey);
        }
        else if ((msg.timestamp || 0) > (existing.timestamp || 0)) {
            byKey.set(contentKey, msg);
        }
    }
    return order.map(k => byKey.get(k));
}
// ── Tool args formatting ──
export function formatToolArgs(name, args) {
    if (!args)
        return '';
    if (name === 'bash' && args.command)
        return args.command;
    if (name === 'read' && args.path)
        return args.path;
    if (name === 'write' && args.path)
        return args.path + (args.content ? ' (' + args.content.length + ' chars)' : '');
    if (name === 'edit' && args.path)
        return args.path;
    if (name === 'find' && args.path)
        return args.path;
    if (name === 'ls' && args.path)
        return args.path;
    if (name === 'send_wa_message')
        return (args.jid || args.recipient_jid || '') + ' ' + (args.message || '').slice(0, 50);
    if (name === 'send_reaction')
        return (args.jid || '') + ' ' + (args.emoji || '');
    for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.length > 0)
            return v;
    }
    return '';
}
// ── Message extraction ──
export function extractPreview(message) {
    if (!message.content)
        return '';
    if (message.role === 'toolResult') {
        const toolName = message.toolName || 'tool';
        const textContent = message.content.find((c) => c.type === 'text');
        const output = textContent?.text || '';
        const prefix = message.isError ? `[${toolName} error]` : `[${toolName}]`;
        if (!output)
            return prefix;
        const trimmed = output.length > 200 ? output.slice(0, 200) + '...' : output;
        return prefix + ' ' + trimmed;
    }
    const textContent = message.content.find((c) => c.type === 'text');
    if (textContent?.text) {
        return textContent.text.slice(0, 100) + (textContent.text.length > 100 ? '...' : '');
    }
    const types = message.content.map((c) => c.type).filter(Boolean);
    if (types.length > 0) {
        return '[' + types.join(', ') + ']';
    }
    return '[empty]';
}
export function extractFullText(message) {
    if (!message.content)
        return '';
    if (message.role === 'toolResult') {
        const toolName = message.toolName || 'tool';
        const textContent = message.content.find((c) => c.type === 'text');
        const output = textContent?.text || '';
        const prefix = message.isError ? `[${toolName} error]` : `[${toolName}]`;
        return output ? prefix + ' ' + output : prefix;
    }
    const textContent = message.content.find((c) => c.type === 'text');
    if (textContent?.text) {
        return textContent.text;
    }
    const types = message.content.map((c) => c.type).filter(Boolean);
    return types.length > 0 ? '[' + types.join(', ') + ']' : '';
}
// ── Session file I/O ──
export function readSessionUsage(sessionFile) {
    const stats = {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        messageCount: 0,
        requestCount: 0,
    };
    try {
        if (!existsSync(sessionFile))
            return stats;
        const content = readFileSync(sessionFile, 'utf-8');
        const lines = content.split('\n');
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim())
                continue;
            try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'message' && entry.message?.role === 'assistant') {
                    stats.messageCount++;
                    const usage = entry.message.usage;
                    if (usage) {
                        stats.tokens.input += usage.input || 0;
                        stats.tokens.output += usage.output || 0;
                        stats.tokens.cacheRead += usage.cacheRead || 0;
                        stats.tokens.cacheWrite += usage.cacheWrite || 0;
                    }
                }
                if (entry.type === 'message' && entry.message?.role === 'user') {
                    stats.requestCount++;
                }
            }
            catch (lineErr) {
                console.error('[pi-monitor] Failed to parse session usage line:', lineErr);
                continue;
            }
        }
    }
    catch (err) {
        console.error('[pi-monitor] Failed to read session usage:', err);
    }
    return stats;
}
export function readSessionHistory(sessionFile, limit = 30) {
    try {
        if (!existsSync(sessionFile))
            return [];
        const content = readFileSync(sessionFile, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        const messages = [];
        for (let i = 1; i < lines.length; i++) {
            try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'message' && entry.message) {
                    const msg = entry.message;
                    const role = msg.role || '';
                    if (!role || role === 'model_change')
                        continue;
                    const text = extractFullText(msg);
                    const ts = msg.timestamp || (entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now());
                    messages.push({ role, text, streaming: false, timestamp: ts });
                }
            }
            catch (lineErr) {
                console.error('[pi-monitor] Failed to parse history line:', lineErr);
                continue;
            }
        }
        return messages.slice(-limit);
    }
    catch (err) {
        console.error('[pi-monitor] Failed to read session history:', err);
        return [];
    }
}
