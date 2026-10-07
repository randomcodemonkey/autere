/**
 * In-process mock 9router for e2e — an OpenAI-compatible server pi can run
 * real multi-round agent turns against with no network access.
 *
 * Started by run-e2e.ts when no live router is reachable; the pi-9router-ext
 * extension then discovers two always-available chat models here:
 *
 *   9router/mock-chat       — "Mock Chat"
 *   9router/mock-chat-mini  — "Mock Mini"
 *
 * Response protocol driven by the LAST user message text:
 *   "essays"  → ~700 words of prose delivered over many chunks (streams for
 *               several seconds — mid-stream reload/switch tests depend on it)
 *   "2 + 2"   → reply "4" (chat.cy asserts the answer)
 *   "tool"    → one bash tool call running `echo hello`, then a plain answer
 *               after the result (tools.cy, edits-feature's smoke turn)
 *   otherwise → "MOCK-ANSWER ok"
 *
 * Tool-call state: a tool call is only emitted when the conversation does
 * NOT end with a tool result — the post-result round gets the final text.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';

const BLOCK = 'The oak grows slowly and with quiet strength, its broad canopy sheltering generations of the forest floor beneath steady, patient boughs. ';

function chunk(res: ServerResponse, data: unknown): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamText(res: ServerResponse, model: string, text: string, wordChunks = 1, delayMs = 0): void {
    const words = text.split(/\s+/);
    let i = 0;
    const emit = () => {
        if (i >= words.length) {
            chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: words.length, total_tokens: words.length + 25 } });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        const parts = words.slice(i, i + wordChunks).join(' ');
        i += wordChunks;
        chunk(res, { choices: [{ index: 0, delta: { content: parts + ' ' } }] });
        if (delayMs > 0) setTimeout(emit, delayMs);
        else emit();
    };
    chunk(res, { choices: [{ index: 0, delta: { role: 'assistant' } }] });
    emit();
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
        res.end(JSON.stringify({
            object: 'list',
            data: [
                { id: 'mock-chat', owned_by: 'mock', contextWindow: 128000, maxTokens: 8192 },
                { id: 'mock-chat-mini', owned_by: 'mock', contextWindow: 128000, maxTokens: 4096 },
            ],
        }));
        return;
    }
    if (req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
            let parsed: any = {};
            try { parsed = JSON.parse(body); } catch { /* empty body */ }
            // Realistic time-to-first-token. Instant mock turns complete in
            // ~35ms — inside one Cypress poll (50ms) — so the UI's transient
            // 'Working' status is never observed and the realtime specs flake
            // (real model turns take seconds; only the mock is this fast).
            await new Promise((r) => setTimeout(r, 400));
            const messages: any[] = parsed.messages || [];
            const lastUser = [...messages].reverse().find((m) => m.role === 'user');
            const lastRole = messages.length > 0 ? messages[messages.length - 1].role : '';
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');

            const lastUserText = JSON.stringify(lastUser?.content ?? '');
            // Exact-reply protocol (cli/test/run.sh followUp): "Reply with exactly: X"
            const exact = lastUserText.match(/Reply with exactly:\s*([A-Za-z0-9.!?-]+)/);
            if (exact && lastRole !== 'tool') {
                streamText(res, parsed.model, exact[1]);
                return;
            }
            if (/essay|600 words/i.test(lastUserText) && lastRole !== 'tool') {
                // ~1.7k words over ~210 chunks with delays — a turn that stays
                // mid-stream for ~20s (reload/switch tests depend on it).
                const essay = BLOCK.repeat(70);
                streamText(res, parsed.model, essay, 8, 100);
                return;
            }
            if (/2 \+ 2/i.test(lastUserText)) {
                streamText(res, parsed.model, '4');
                return;
            }
            const toolCalls: { id: string; name: string; arguments: unknown }[] = [];
            // No tool emission after tool results — pi would loop forever
            // re-running the same scripted calls.
            if (/write tool/i.test(lastUserText) && lastRole !== 'tool') {
                // edits-feature protocol: "use the write tool to create <path>
                // with exactly this content: <token>" ... "use the edit tool
                // to replace A with B in <path>". Emit the matching real
                // write/edit tool calls so pi (not the model) performs them.
                let n = 0;
                for (const m of lastUserText.matchAll(/create\s+([^" ]+?\.[^" ]+)\s+with exactly this content:\s+"?([a-z0-9]+)"?/gi)) {
                    toolCalls.push({ id: `mock-call-${++n}`, name: 'write', arguments: { path: m[1], content: m[2] } });
                }
                for (const m of lastUserText.matchAll(/replace\s+([^\s"]+)\s+with\s+([^\s"]+)\s+in\s+([^\s"]+\.\w+)/gi)) {
                    toolCalls.push({ id: `mock-call-${++n}`, name: 'edit', arguments: { path: m[3], edits: [{ oldText: m[1], newText: m[2] }] } });
                }
            }
            if (toolCalls.length === 0 && /command|use bash|tool/i.test(lastUserText) && lastRole !== 'tool') {
                toolCalls.push({ id: 'mock-call-1', name: 'bash', arguments: { command: 'echo hello' } });
            }
            if (toolCalls.length > 0) {
                chunk(res, { choices: [{ index: 0, delta: { role: 'assistant' } }] });
                let i = 0;
                for (const tc of toolCalls) {
                    chunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: i++, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] } }] });
                }
                chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            streamText(res, parsed.model, 'MOCK-ANSWER ok');
        });
        return;
    }
    res.statusCode = 404;
    res.end('{}');
});

/** Start on a fixed-ish port; resolve null when busy (another mock owns it). */
export function startMockRouter(port = 45123): Promise<{ port: number; stop: () => Promise<void> } | null> {
    return new Promise((resolve) => {
        const onError = () => {};
        const timer = setTimeout(() => resolve(null), 4000);
        server.once('error', onError);
        try {
            server.listen(port, () => {
                clearTimeout(timer);
                server.removeAllListeners('error');
                resolve({
                    port: (server.address() as { port: number }).port ?? port,
                    stop: () => new Promise<void>((res) => server.close(() => res())),
                });
            });
        } catch {
            clearTimeout(timer);
            resolve(null);
        }
    });
}
