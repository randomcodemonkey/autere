// Self-check for streamed tool-call arguments.
// Run: npx tsx src/backend/toolcall-args.check.ts
import assert from 'node:assert';
import { ToolArgStream, partialToolArgs, toolCallPreview } from './toolcall-args.js';

// ── partialToolArgs: only complete "key": "value" pairs ──
assert.deepEqual(partialToolArgs('{"path":"a/b.txt","content":"unfinis'), { path: 'a/b.txt' });
assert.deepEqual(partialToolArgs('{"path":"a\\"b\\n.txt"}'), { path: 'a"b\n.txt' });
assert.deepEqual(partialToolArgs('{"path":"'), {});
assert.deepEqual(partialToolArgs('{}'), {});
assert.equal(Object.keys(partialToolArgs(Array.from({ length: 20 }, (_, i) => `"k${i}":"v"`).join(','))).length, 8);

// ── preview: path early, command only once its string is closed ──
assert.equal(toolCallPreview('write', '{"path":"platform/standalone/deploy.py","content":"import'), 'platform/standalone/deploy.py');
assert.equal(toolCallPreview('bash', '{"command":"ls -l'), '');
assert.equal(toolCallPreview('bash', '{"command":"ls -l"}'), 'ls -l');
assert.equal(toolCallPreview('write', `{"path":"${'x'.repeat(500)}"}`).length, 403);

// ── stream bookkeeping: keyed by contentIndex, adopted by id ──
const stream = new ToolArgStream();
const a = stream.start({ contentIndex: 1, id: 'call_a', toolName: 'write' });
const b = stream.start({ contentIndex: 2, id: 'call_b', toolName: 'bash' });
assert.equal(a.name, 'write');
assert.equal(b.name, 'bash');

stream.delta({ contentIndex: 1, delta: '{"path":"one.md"' });
stream.delta({ contentIndex: 2, delta: '{"command":"ls"}' });
stream.delta({ contentIndex: 1, delta: '}' });
assert.equal(a.json, '{"path":"one.md"}');
assert.equal(b.json, '{"command":"ls"}');
assert.equal(stream.delta({ contentIndex: 9, delta: 'x' }), null, 'unknown index ignored');

const endA = stream.end({ contentIndex: 1, toolCall: { id: 'call_a', name: 'write', arguments: { path: 'one.md' } } });
assert.equal(endA?.json, '{"path":"one.md"}');

// adoption by id, then by name for providers without ids
assert.equal(stream.take('call_a')?.index, 1);
assert.equal(stream.take('call_a'), null, 'taken once');
const noId = stream.start({ contentIndex: 3, toolName: 'read' });
assert.equal(stream.take('call_x', 'read')?.index, noId.index);
assert.equal(stream.take('call_x', 'read'), null);

// leftovers drain (turn end / failed attempt)
stream.start({ contentIndex: 4, id: 'call_d', toolName: 'edit' });
assert.deepEqual(stream.drain().map((r) => r.id), ['call_b', 'call_d']);
assert.deepEqual(stream.drain(), []);

// end without start still yields a record
const onlyEnd = stream.end({ contentIndex: 5, toolCall: { id: 'call_e', name: 'ls', arguments: { path: '.' } } });
assert.equal(onlyEnd?.name, 'ls');
assert.equal(onlyEnd?.json, '{"path":"."}');

console.log('toolcall-args.check: ok');
