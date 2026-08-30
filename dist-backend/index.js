import { resolveAuth } from './auth.js';
import { createMonitorServer } from './routes.js';
import { registerEventHandlers } from './event-handlers.js';
// ── Main extension entry point ──
export default function piMonitor(pi) {
    const PORT = parseInt(pi.getFlag('port')) || 3456;
    let serverStarted = false;
    // Register hidden commands for session operations that need a fresh ctx.
    // We cannot capture ctx from session_start and use it later — it becomes
    // stale after newSession/switchSession/fork/reload. Instead, we route
    // these operations through commands that receive the current ctx at
    // invocation time.
    pi.registerCommand('__pi-monitor-new-session', {
        description: 'Internal: create new session from monitor',
        handler: async (_args, ctx) => {
            if (typeof ctx.newSession === 'function') {
                await ctx.newSession();
            }
        }
    });
    pi.registerCommand('__pi-monitor-abort', {
        description: 'Internal: abort current agent turn from monitor',
        handler: (_args, ctx) => {
            if (typeof ctx.abort === 'function') {
                ctx.abort();
            }
        }
    });
    pi.registerCommand('__pi-monitor-compact', {
        description: 'Internal: compact session from monitor',
        handler: (_args, ctx) => {
            if (typeof ctx.compact === 'function') {
                ctx.compact({
                    onComplete: () => { },
                    onError: (err) => console.error('[pi-monitor] Compaction failed:', err.message)
                });
            }
        }
    });
    pi.registerCommand('__pi-monitor-set-model', {
        description: 'Internal: set model from monitor',
        handler: async (args, ctx) => {
            const [provider, modelId] = args.split(':::');
            if (!provider || !modelId || !ctx?.modelRegistry)
                return;
            const model = ctx.modelRegistry.find(provider, modelId);
            if (model && typeof ctx.setModel === 'function') {
                await ctx.setModel(model);
            }
        }
    });
    // Register CLI flags
    pi.registerFlag('port', {
        description: 'Port for the monitor dashboard',
        type: 'number',
        default: 3456
    });
    pi.registerFlag('monitor-auth', {
        description: 'Enable authentication for the monitor dashboard',
        type: 'boolean',
        default: true
    });
    pi.registerFlag('monitor-password', {
        description: 'Password for the monitor dashboard (env: PI_MONITOR_PASSWORD)',
        type: 'string',
        default: ''
    });
    // Register all pi event handlers
    registerEventHandlers(pi, pi);
    // On first session_start, create the HTTP server
    const origSessionStart = pi.on.bind(null, 'session_start');
    // We intercept session_start to start the server on first call
    // The event handler in event-handlers.ts already handles state updates,
    // but we need to start the server exactly once.
    //
    // Since event-handlers.ts already registers session_start, we piggyback
    // on that by using a wrapper approach: we check serverStarted in a
    // separate session_start listener. Pi allows multiple handlers per event.
    pi.on('session_start', (_event, ctx) => {
        if (serverStarted)
            return;
        serverStarted = true;
        try {
            resolveAuth(pi);
        }
        catch (err) {
            console.error(err.message);
            return;
        }
        createMonitorServer(PORT, pi);
    });
    // Don't reset serverStarted on session_shutdown —
    // the HTTP server should persist for the process lifetime.
    // Sessions come and go, but the dashboard stays up.
}
