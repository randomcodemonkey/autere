/** Regression: a text block that ends (text_end clears streaming) must not
 *  make message_end append a second copy of the same assistant message. */
import assert from 'node:assert';
import { UserSession } from './user-session.js';

const s: any = new UserSession('admin', null, {}, 60_000, { autoName: false, restartable: false });
s.setHistory([]);
s.state.sessionState.sessionId = 'check-session';
// No pi process here — the post-end stats refresh would only log an error.
s.rpc.getSessionStats = () => Promise.resolve({});

const update = (assistantMessageEvent: any) => s.handleMessageUpdate({ assistantMessageEvent });
update({ type: 'text_start', contentIndex: 0 });
update({ type: 'text_delta', contentIndex: 0, delta: 'Hel' });
update({ type: 'text_delta', contentIndex: 0, delta: 'lo' });
update({ type: 'text_end', contentIndex: 0, content: 'Hello' });
assert.equal(s.history().length, 1);
assert.equal(s.history()[0].streaming, false);

s.handleMessageEnd({ message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Hello' }] } });
const buf = s.history();
assert.equal(buf.length, 1, `expected 1 assistant entry, got ${buf.length}`);
assert.equal(buf[0].text, 'Hello');
assert.equal(buf[0].streaming, false);

// A message with no streamed entry at all (synthetic / no deltas) still lands once.
s.handleMessageEnd({ message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Second' }] } });
assert.equal(s.history().length, 2);
assert.deepEqual(s.history().map((e: any) => e.text), ['Hello', 'Second']);
// pi can report a text block's end AFTER a following block already streamed
// (provider batching). That late text_end must not wipe the newer text.
s.state.activeAssistantId = null;
s.state.currentStreamText = '';
s.state.textBlockStart = 0;
update({ type: 'text_start', contentIndex: 0 });
update({ type: 'text_delta', contentIndex: 0, delta: '   ' });
update({ type: 'text_start', contentIndex: 1 });
update({ type: 'text_delta', contentIndex: 1, delta: 'LATE-CONTENT' });
update({ type: 'text_end', contentIndex: 0, content: '   ' }); // late block 0 end
assert.equal(s.history().at(-1).text, '   LATE-CONTENT', 'late text_end wiped streamed text');
assert.notEqual(s.history().at(-1).streaming, true);

// Streamed tool output: the buffer keeps it all (bootstrap sends it once),
// live clients get deltas.
{
	const line = (i: number) => `line ${i}`;
	const first = Array.from({ length: 400 }, (_, i) => line(i)).join('\n');
	const entry: any = { id: 'tool-entry', role: 'toolCall', text: '', streaming: true, toolCallId: 'call1', partial: '' };
	s.history().push(entry);
	const tool: any = { entry, partialAt: 0 };
	s.state.activeTools.set('call1', tool);
	const sent: any[] = [];
	s.broadcast = (m: any) => sent.push(m);
	s.handleToolUpdate({ toolCallId: 'call1', partialResult: { content: [{ type: 'text', text: first }] } });
	assert.equal(entry.partial, first, 'buffer lost part of the streamed output');
	const d1 = sent.at(-1);
	assert.equal(d1.type, 'tool_output');
	assert.equal(d1.data.replace, false);
	assert.ok(d1.data.text.endsWith(first), 'first delta should carry what was not sent yet');
	// Next snapshot only adds a line: the delta carries just that line.
	tool.partialAt = 0;
	const second = first + '\n' + line(400);
	s.handleToolUpdate({ toolCallId: 'call1', partialResult: { content: [{ type: 'text', text: second }] } });
	assert.equal(sent.at(-1).data.text, '\n' + line(400), 'delta should only carry the new output');
	// A tool that rewrites its output gets a full replacement instead.
	tool.partialAt = 0;
	s.handleToolUpdate({ toolCallId: 'call1', partialResult: { content: [{ type: 'text', text: 'rewritten' }] } });
	assert.equal(sent.at(-1).data.replace, true);
	assert.equal(sent.at(-1).data.text, 'rewritten');
	s.state.activeTools.delete('call1');
}

// The whitespace guard applies to the assistant text entry only — empty
// thinking blocks stay (they are the activity signal for withheld reasoning).
s.state.activeAssistantId = null;
s.state.currentStreamText = '';
s.state.textBlockStart = 0;
const sent: any[] = [];
s.broadcast = (m: any) => sent.push(m);
update({ type: 'thinking_start' });
const thinking = s.history().at(-1);
assert.equal(thinking.role, 'thinking');
assert.equal(thinking.text, '');
assert.ok(sent.some((m) => m.type === 'history_upsert' && m.data.some((e: any) => e.id === thinking.id)),
  'empty thinking block is not broadcast');
sent.length = 0;
update({ type: 'thinking_end', content: '' });
sent.length = 0; // the thinking block's own finalize upsert is expected
update({ type: 'text_start', contentIndex: 0 });
update({ type: 'text_delta', contentIndex: 0, delta: '   ' });
update({ type: 'text_end', contentIndex: 0, content: '   ' });
assert.equal(sent.filter((m) => m.type === 'history_upsert').length, 0, 'whitespace-only assistant entry broadcast');
assert.equal(s.history().find((e: any) => e.id === thinking.id).text, '');

// A prompt pi decorated with an attachment note must retire the committed
// entry, not append a decorated second copy.
s.addUserEntry('Look at this');
s.handleMessageEnd({ message: { role: 'user', content: [{ type: 'text', text: 'Look at this\n\n[Attached file saved to:\n/tmp/x.png\nUse these paths.]' }] } });
const users = s.history().filter((e: any) => e.role === 'user');
assert.equal(users.length, 1, `expected 1 user entry, got ${users.length}`);
assert.equal(users[0].text, 'Look at this');
assert.notEqual(users[0].pending, true);

// A steered message pi consumed without a user message_end must leave PENDING.
let onEvent: any;
s.rpc.onEvent = (h: any) => { onEvent = h; };
s.registerEventHandlers();
s.addUserEntry('queued question', true);
s.addUserEntry('still queued', true);
assert.equal(s.history().find((e: any) => e.text === 'queued question').pending, true);
// pi lists only what is still queued; attachment notes must not break the match.
onEvent({ type: 'queue_update', steering: ['still queued\n\n[Attached file saved to:\n/tmp/a.png]'], followUp: [] });
assert.notEqual(s.history().find((e: any) => e.text === 'queued question').pending, true);
assert.equal(s.history().find((e: any) => e.text === 'still queued').pending, true);

// Cancelling a queued message: pi's clearQueue() emits an empty queue_update
// before its RPC response, which must not retire the other badges; the
// cancelled copy must leave the chat instead of looking sent.
s.rpc.clearQueue = async () => {
  onEvent({ type: 'queue_update', steering: [], followUp: [] }); // pi's own emission
  return { steering: ['drop me', 'keep me'], followUp: [] };
};
const requeued: string[] = [];
s.rpc.steer = async (t: string) => { requeued.push(t); };
s.rpc.followUp = async () => {};
s.addUserEntry('drop me', true);
s.addUserEntry('keep me', true);
const removed: string[] = [];
s.broadcast = (m: any) => { if (m.type === 'history_remove') removed.push(...m.data); };
assert.equal(await s.cancelPending('drop me'), true);
const texts = s.history().filter((e: any) => e.role === 'user').map((e: any) => e.text);
assert.ok(!texts.includes('drop me'), 'cancelled message stayed in chat');
assert.equal(removed.length, 1, 'client was not told to drop the cancelled message');
assert.equal(s.history().find((e: any) => e.text === 'keep me').pending, true, 'remaining queued message lost its pending marker');
assert.deepEqual(requeued, ['keep me']);

// Streaming text travels as DELTAS (only the new chunk): re-sending the whole
// message on every token was O(n^2) bytes for a long answer. A full snapshot
// every few KB heals a lost frame.
{
  s.setHistory([]);
  s.state.activeAssistantId = null;
  s.state.currentStreamText = '';
  s.state.sentText = 0;
  s.state.textBlockStart = 0;
  const sent: any[] = [];
  s.broadcast = (m: any) => sent.push(m);
  update({ type: 'text_start' });
  update({ type: 'text_delta', delta: 'hello ' });   // first visible text -> snapshot
  update({ type: 'text_delta', delta: 'world' });
  update({ type: 'text_delta', delta: '!' });
  assert.deepEqual(
    sent.filter((m) => m.type === 'stream_delta').map((m) => m.data.text),
    ['world', '!'],
    'deltas must not repeat the whole message',
  );
  sent.length = 0;
  let snapshots = 0;
  for (let i = 0; i < 900; i++) {
    update({ type: 'text_delta', delta: '0123456789' });
    snapshots += sent.filter((m) => m.type === 'history_upsert').length;
    sent.length = 0;
  }
  assert.ok(snapshots >= 1, 'no periodic snapshot — a lost delta would never heal');
  s.setHistory([]);
}

// Aborting while an automatic compaction starts: pi refuses the prompt and the
// queue was already cleared, so the salvaged texts have to wait, not vanish.
{
  s.setHistory([]);
  const prompts: string[] = [];
  let busy = 0;
  s.rpc.clearQueue = async () => ({ steering: ['one'], followUp: ['two', 'three'] });
  s.rpc.abort = async () => {
    // pi hands control to auto-compaction right after the abort
    busy = 1;
  };
  s.rpc.prompt = async (text: string) => {
    if (busy) throw new Error('Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.');
    prompts.push(text);
  };
  for (const t of ['one', 'two', 'three']) s.addUserEntry(t, true);
  await s.abortAndRequeue();
  await new Promise((r) => setTimeout(r, 0));   // let the refusal land
  assert.deepEqual(prompts, [], 'a prompt was sent into the compaction');
  const texts = s.history().filter((e: any) => e.role === 'user').map((e: any) => e.text);
  assert.deepEqual(texts, ['one', 'two', 'three'], 'salvaged messages left the chat');
  busy = 0;   // compaction finished
  onEvent({ type: 'compaction_end', aborted: false });
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(prompts, ['one', 'two', 'three'], `delivered ${JSON.stringify(prompts)}`);
  s.setHistory([]);
}

// Streamed tool arguments (Claude-style): the file's content stays an
// incomplete JSON pair for the WHOLE stream, so the body must carry it while
// it streams - via the same tool_output delta channel as tool output.
{
  s.setHistory([]);
  s.toolArgs.drain();
  const sent: any[] = [];
  s.broadcast = (m: any) => sent.push(m);
  update({ type: 'toolcall_start', contentIndex: 1, id: 'toolu_1', toolName: 'write' });
  update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"a.js","content":"function f(' });
  const first = sent.filter((m) => m.type === 'history_upsert').at(-1);
  assert.equal(first.data[0].partial, 'function f(', 'body did not start streaming');
  assert.equal(first.data[0].toolCall.cmd, 'a.js', 'header preview lost');
  await new Promise((r) => setTimeout(r, 130));   // preview throttle
  update({ type: 'toolcall_delta', contentIndex: 1, delta: ') { return 1; }' });
  const out = sent.filter((m) => m.type === 'tool_output').at(-1);
  assert.deepEqual({ id: out.data.id, text: out.data.text, replace: out.data.replace },
    { id: 'toolu_1', text: ') { return 1; }', replace: false }, 'args delta malformed');
  // toolcall_end flushes the throttled tail with the complete value
  update({ type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'toolu_1', name: 'write', arguments: { path: 'a.js', content: 'function f() { return 1; }' } } });
  assert.equal(s.history()[0].partial, 'function f() { return 1; }', 'throttled tail not flushed at end');
  // execution adopts the card; the first output REPLACES the args preview
  onEvent({ type: 'tool_execution_start', toolCallId: 'toolu_1', toolName: 'write', args: { path: 'a.js', content: 'x' } });
  onEvent({ type: 'tool_execution_update', toolCallId: 'toolu_1', partialResult: { content: [{ type: 'text', text: 'written ok' }] } });
  const res = sent.filter((m) => m.type === 'tool_output').at(-1);
  assert.deepEqual({ text: res.data.text, replace: res.data.replace },
    { text: 'written ok', replace: true }, 'output appended after the args preview instead of replacing it');
  s.setHistory([]);
}

// Provider errors that arrive as an HTML page (GitHub's "Unicorn!" 503 page
// through Copilot) must not dump markup into the chat: one readable line.
{
  s.setHistory([]);
  s.handleMessageEnd({
    message: {
      role: 'assistant', stopReason: 'error',
      errorMessage: 'github-copilot API error (503): 503 <!DOCTYPE html><html><head><title>Unicorn! &middot; GitHub</title></head><body><h1>Unicorn!</h1><p>This page is taking too long to load.</p></body></html>',
    },
  });
  const entries = s.history();
  assert.equal(entries.length, 1, `expected 1 system entry, got ${entries.length}`);
  assert.equal(entries[0].role, 'system');
  assert.equal(entries[0].isError, true);
  assert.ok(!entries[0].text.includes('<'), `markup leaked: ${entries[0].text}`);
  assert.ok(entries[0].text.startsWith('github-copilot API error (503):'), entries[0].text);
  assert.ok(entries[0].text.includes('Unicorn!'), entries[0].text);
  assert.ok(entries[0].text.includes('KB of HTML omitted'), entries[0].text);
  s.setHistory([]);
}

try { await s.stop(); } catch { /* never started */ } // clears the idle timer
console.log('message-end.check: OK');
