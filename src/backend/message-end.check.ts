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

try { await s.stop(); } catch { /* never started */ } // clears the idle timer
console.log('message-end.check: OK');
