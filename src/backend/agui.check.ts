// Self-check for the AG-UI adapter's pure translation logic.
// Run: npx tsx src/backend/agui.check.ts
import assert from 'node:assert';
import { AguiInputError, AguiTranslator, formatContextBlock, formatPrompt, parseRunInput, toAguiMessages } from './agui.js';

// ── parseRunInput: trailing user message, text parts, attachments ──
const input = parseRunInput({
  threadId: 't1',
  runId: 'r1',
  messages: [
    { id: 'm1', role: 'user', content: 'old turn' },
    { id: 'm2', role: 'assistant', content: 'old answer' },
    {
      id: 'm3',
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'data', mimeType: 'image/png', value: Buffer.from('img').toString('base64') }, metadata: { filename: 'shot.png' } },
        { type: 'image', source: { type: 'data', mimeType: 'image/png', value: `data:image/png;base64,${Buffer.from('img2').toString('base64')}` } },
        { type: 'document', source: { type: 'data', mimeType: 'text/plain', value: Buffer.from('doc').toString('base64') }, metadata: { filename: 'notes.txt' } },
      ],
    },
  ],
  tools: [],
  context: [{ description: 'page', value: '{"route":"/inbox"}' }, { value: '   ' }],
  forwardedProps: { personaId: 'p1' },
});
assert.equal(input.text, 'look at this');
assert.equal(input.threadId, 't1');
assert.equal(input.images.length, 2);
assert.equal(input.images[0].name, 'shot.png');
assert.equal(input.images[0].data.toString(), 'img');
assert.equal(input.images[1].data.toString(), 'img2'); // data: URL prefix stripped
assert.equal(input.files.length, 1);
assert.equal(input.files[0].name, 'notes.txt');
assert.equal(input.context.length, 1);
assert.equal(input.props.personaId, 'p1');

assert.throws(() => parseRunInput({ threadId: 't', runId: 'r', messages: [] }), AguiInputError);
assert.throws(() => parseRunInput({ threadId: '', runId: 'r', messages: [{ role: 'user', content: 'x' }] }), AguiInputError);
assert.throws(() => parseRunInput({ threadId: 't', runId: 'r', messages: [{ role: 'user', content: '   ' }] }), AguiInputError);
// Oversized image is rejected before any session work
assert.throws(() => parseRunInput({
  threadId: 't', runId: 'r',
  messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'data', mimeType: 'image/png', value: Buffer.alloc(9 * 1024 * 1024).toString('base64') } }] }],
}), /Image too large/);

// ── context / prompt formatting ──
const block = formatContextBlock([{ description: 'page"<x>', value: 'state' }]);
assert.ok(block.startsWith('<agui-run-context>'));
assert.ok(block.includes('description="page'));
const prompt = formatPrompt({ ...input, context: [{ description: 'page', value: 'state' }] }, ['/tmp/a.txt']);
assert.ok(prompt.startsWith('look at this'));
assert.ok(prompt.includes('<context description="page">'));
assert.ok(prompt.includes('/tmp/a.txt'));

// ── toAguiMessages: assistant thinking + tool calls, tool results ──
const messages = toAguiMessages([
  { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  {
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'checking' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/tmp/x' } },
      ],
    },
  },
  { message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] } },
]);
assert.deepEqual(messages.map((m) => m.role), ['user', 'reasoning', 'assistant', 'tool']);
assert.equal(messages[1].content, 'hmm');
assert.equal(messages[2].content, 'checking');
assert.equal(messages[2].toolCalls[0].function.name, 'read');
assert.equal(messages[2].toolCalls[0].function.arguments, '{"path":"/tmp/x"}');
assert.equal(messages[3].toolCallId, 'c1');
assert.equal(messages[3].content, 'file body');

// ── translator: cumulative deltas become one text message with deltas ──
let state = { sessionId: 's1', streaming: true };
const tr = new AguiTranslator(() => state);
const types = (events: any[]) => events.map((e) => e.type);

let out = tr.onEvent({ type: 'stream_delta', data: { role: 'assistant', id: 'a1', text: 'Hel' } });
assert.deepEqual(types(out), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
assert.equal(out[1].delta, 'Hel');
out = tr.onEvent({ type: 'stream_delta', data: { role: 'assistant', id: 'a1', text: 'Hello' } });
assert.deepEqual(types(out), ['TEXT_MESSAGE_CONTENT']);
assert.equal(out[0].delta, 'lo');
// Thinking opens its own reasoning stream
out = tr.onEvent({ type: 'stream_delta', data: { role: 'thinking', id: 'th1', text: 'why' } });
assert.deepEqual(types(out), ['REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT']);
// A tool call closes the open reasoning stream
out = tr.onEvent({ type: 'tool_start', data: { id: 'c1', name: 'bash', args: { command: 'ls' } } });
assert.deepEqual(types(out), ['TEXT_MESSAGE_END', 'REASONING_MESSAGE_END', 'TOOL_CALL_START', 'TOOL_CALL_ARGS']);
assert.equal(out[2].toolCallName, 'bash');
assert.equal(out[3].delta, '{"command":"ls"}');
// tool_end -> TOOL_CALL_END; result entry -> TOOL_CALL_RESULT (once)
out = tr.onEvent({ type: 'tool_end', data: { id: 'c1' } });
assert.deepEqual(types(out), ['TOOL_CALL_END']);
out = tr.onEvent({ type: 'history_upsert', data: [{ role: 'toolResult', toolCallId: 'c1', text: 'a b' }] });
assert.deepEqual(types(out), ['TOOL_CALL_RESULT']);
assert.equal(out[0].content, 'a b');
out = tr.onEvent({ type: 'history_upsert', data: [{ role: 'toolResult', toolCallId: 'c1', text: 'a b' }] });
assert.deepEqual(out, []);
// Final text after a tool call starts a NEW text message
out = tr.onEvent({ type: 'stream_delta', data: { role: 'assistant', id: 'a2', text: 'Done' } });
assert.deepEqual(types(out), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
assert.equal(out[0].messageId, 'a2');
// Final assistant upsert without deltas must not duplicate text
out = tr.onEvent({ type: 'history_upsert', data: [{ role: 'assistant', id: 'a2', streaming: false, text: 'Done' }] });
assert.deepEqual(types(out), ['TEXT_MESSAGE_END']);
assert.deepEqual(tr.close(), []);

// ── translator: state snapshots are deduped ──
const tr2 = new AguiTranslator(() => ({ streaming: true }));
assert.equal(tr2.onEvent({ type: 'status' })[0].type, 'STATE_SNAPSHOT');
assert.deepEqual(tr2.onEvent({ type: 'status' }), []);
state = { sessionId: 's1', streaming: false };
const tr3 = new AguiTranslator(() => state);
const snap = tr3.onEvent({ type: 'status' });
assert.equal(snap[0].snapshot.streaming, false);
assert.deepEqual(tr3.onEvent({ type: 'stats' }), []);

console.log('agui.check: OK');
