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
// A prompt pi decorated with an attachment note must retire the committed
// entry, not append a decorated second copy.
s.addUserEntry('Look at this');
s.handleMessageEnd({ message: { role: 'user', content: [{ type: 'text', text: 'Look at this\n\n[Attached file saved to:\n/tmp/x.png\nUse these paths.]' }] } });
const users = s.history().filter((e: any) => e.role === 'user');
assert.equal(users.length, 1, `expected 1 user entry, got ${users.length}`);
assert.equal(users[0].text, 'Look at this');
assert.notEqual(users[0].pending, true);

console.log('message-end.check: OK');
