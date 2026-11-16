/**
 * A long-running tool call (codemode looping on bash output) must follow its
 * timestamp: while it runs, and when it finishes, the card belongs at the
 * present - not above the dozens of nested entries that landed below it.
 */
import assert from 'node:assert';
import { UserSession } from './user-session.js';

function session(): { s: any; events: any[] } {
  const s: any = new UserSession('admin', null, {}, 60_000, { autoName: false, restartable: false });
  s.setHistory([]);
  s.state.sessionState.sessionId = 'check-session';
  s.rpc.getSessionStats = () => Promise.resolve({});
  const events: any[] = [];
  s.broadcast = (m: any) => events.push(m);
  return { s, events };
}

/** Start a codemode call and run `n` nested tool calls under it. */
function driftingCall(s: any, n: number, parentId = 'c0'): any {
  s.handleToolStart({ toolCallId: parentId, toolName: 'codemode', args: { script: 'loop until output' } });
  const parent = s.history().find((e: any) => e.toolCallId === parentId);
  for (let i = 0; i < n; i++) {
    s.handleToolStart({ toolCallId: `n${i}`, toolName: 'bash', args: { command: `echo ${i}` }, parentToolCallId: parentId });
    s.handleToolEnd({ toolCallId: `n${i}`, toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: `out ${i}` }] } });
  }
  return parent;
}

// ── Prompt output: the active card is promoted to the end ──
{
  const { s, events } = session();
  const parent = driftingCall(s, 12);
  const startedAt = parent.timestamp;
  assert.ok(s.history().indexOf(parent) <= 1, 'the call must start near the top');
  assert.ok(s.history().length > 12, 'nested calls must have been recorded');

  events.length = 0;
  s.handleToolUpdate({ toolCallId: 'c0', partialResult: { content: [{ type: 'text', text: 'tick 1' }] } });
  assert.equal(s.history().at(-1), parent, 'an updated active card must be at the end');
  assert.ok(parent.timestamp >= startedAt, 'timestamp must advance with the position');

  const removeAt = events.findIndex((e) => e.type === 'history_remove');
  const upsertAt = events.findIndex((e) => e.type === 'history_upsert');
  assert.ok(removeAt >= 0, 'client must be told to drop the card first');
  assert.ok(upsertAt > removeAt, 'the re-append must follow the remove');
  assert.deepEqual(events[removeAt].data, [parent.id]);
  const moved = events[upsertAt].data[0];
  assert.equal(moved.id, parent.id, 'same id - the client keeps the card identity');
  assert.equal(moved.partial, 'tick 1', 'the snapshot carries the output so far');

  // The bookkeeping survives the move: the next tick still streams a delta.
  s.state.activeTools.get('c0').partialAt = 0;
  events.length = 0;
  s.handleToolUpdate({ toolCallId: 'c0', partialResult: { content: [{ type: 'text', text: 'tick 1 tick 2' }] } });
  const delta = events.find((e) => e.type === 'tool_output');
  assert.ok(delta, 'streaming must continue after the promote');
  assert.equal(delta.data.text, ' tick 2', `delta must carry only the new text, got ${JSON.stringify(delta.data.text)}`);
  assert.equal(delta.data.replace, false);
}

// ── The finished result lands at the end too, matching its timestamp ──
{
  const { s, events } = session();
  const parent = driftingCall(s, 12);
  events.length = 0;
  s.handleToolEnd({ toolCallId: 'c0', toolName: 'codemode', isError: false, result: { content: [{ type: 'text', text: 'found the line' }] } });
  const last = s.history().at(-1);
  assert.equal(last.role, 'toolResult', `expected the result last, got ${last.role}`);
  assert.equal(last.toolCallId, 'c0');
  assert.equal(last.id, parent.id, 'the result keeps the call card id');
  assert.ok(!s.history().includes(parent), 'the streaming card must not linger above');
  const removeAt = events.findIndex((e) => e.type === 'history_remove');
  const upsertAt = events.findIndex((e) => e.type === 'history_upsert');
  assert.ok(removeAt >= 0 && upsertAt > removeAt, 'remove then re-append');
}

// ── A short call keeps its place: no churn, the result replaces in place ──
{
  const { s } = session();
  const parent = driftingCall(s, 3);
  s.handleToolUpdate({ toolCallId: 'c0', partialResult: { content: [{ type: 'text', text: 'tick' }] } });
  assert.notEqual(s.history().at(-1), parent, 'a small gap must not move the card');
  s.handleToolEnd({ toolCallId: 'c0', toolName: 'codemode', isError: false, result: { content: [{ type: 'text', text: 'done' }] } });
  const idx = s.history().findIndex((e: any) => e.toolCallId === 'c0');
  assert.equal(idx, 0, `short call must stay first, got ${idx}`);
  assert.equal(s.history()[0].role, 'toolResult');
}

console.log('tool-order.check: OK');
