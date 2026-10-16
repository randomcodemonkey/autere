// Self-check for the late-thinking reorder in user-session.ts handleMessageEnd.
// Run: npx tsx src/backend/thinking-reorder.check.ts
import assert from 'node:assert';

function reorder(buf: any[], aIdx: number) {
  const movers = buf.slice(aIdx + 1).filter((m) => m.role === 'thinking');
  for (const m of movers) buf.splice(buf.indexOf(m), 1);
  buf.splice(aIdx, 0, ...movers);
  return movers;
}

// text streams before thinking -> thinking moved before assistant, order kept
let buf: any[] = [
  { role: 'user', text: 'q', id: 'q' },
  { role: 'assistant', text: 'answer', id: 'a1' },
  { role: 'thinking', text: 't1', id: 't1' },
  { role: 'thinking', text: 't2', id: 't2' },
];
const movers = reorder(buf, 1);
assert.deepEqual(buf.map((m) => m.id), ['q', 't1', 't2', 'a1']);
assert.deepEqual(movers.map((m) => m.id), ['t1', 't2']);

// thinking-first streaming (common providers) -> untouched, no movers
buf = [
  { role: 'thinking', text: 't0', id: 't0' },
  { role: 'assistant', text: 'answer', id: 'a1' },
  { role: 'user', text: 'next', id: 'u' },
];
assert.deepEqual(reorder(buf, 1), []);
assert.deepEqual(buf.map((m) => m.id), ['t0', 'a1', 'u']);

// no trailing thinking -> no-op
buf = [{ role: 'assistant', text: 'x', id: 'a' }, { role: 'user', id: 'u' }];
assert.deepEqual(reorder(buf, 0), []);
assert.deepEqual(buf.map((m) => m.id), ['a', 'u']);

console.log('thinking-reorder.check: OK');
