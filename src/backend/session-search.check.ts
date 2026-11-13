/** Chat history search: role filters, snippet windowing and the 200 hit cap. */
import assert from 'node:assert';
import { searchEntries, FULL_TEXT_LIMIT, SEARCH_LIMIT } from './session-search.js';

const entries = [
  { role: 'user', text: 'please fix the KLUVI bug in kymi_threshold_check.sh', timestamp: 1 },
  { role: 'assistant', text: 'Fixed the threshold check; the KLUVI typo is gone.', timestamp: 2 },
  { role: 'thinking', text: 'maybe the Kymi threshold file needs a clamp', timestamp: 3 },
  { role: 'toolResult', text: 'line 1\nline 2 with KLUVI inside\nline 3', timestamp: 4 },
  { role: 'edit', text: 'Modified kymi_threshold_check.sh\n\n@@ -1 +1 @@\n-kluvi\n+Kymi', timestamp: 5 },
  { role: 'system', text: 'unrelated notice', timestamp: 6 },
  { role: 'thinking', text: `${'a'.repeat(300)} KLUVI ${'b'.repeat(300)}`, timestamp: 7, long: true },
];

// Case-insensitive substring, snippets keep the match and both ellipses
const all = searchEntries(entries, 'KluVi', null);
assert.strictEqual(all.total, 5, `expected 5 hits, got ${all.total}`);
assert.deepStrictEqual(all.hits.map((h) => h.role), ['user', 'assistant', 'toolResult', 'edit', 'thinking']);
assert.ok(all.hits[0].snippet.includes('KLUVI'), all.hits[0].snippet);
assert.ok(all.hits[0].snippet.startsWith('please fix'), 'short text is kept whole');
assert.ok(all.hits[4].snippet.startsWith('…') && all.hits[4].snippet.endsWith('…'), `long text is windowed: ${all.hits[4].snippet}`);
assert.ok(all.hits[4].snippet.length < 250, 'snippet stays short');

// Role filter: the chat's tools toggle groups toolCall + toolResult
assert.deepStrictEqual(searchEntries(entries, 'kluvi', ['toolResult', 'toolCall']).hits.map((h) => h.role), ['toolResult']);
assert.strictEqual(searchEntries(entries, 'kluvi', ['thinking']).total, 1, 'role filter keeps only thinking hits');
assert.strictEqual(searchEntries(entries, 'kluvi', ['system']).total, 0, 'role filter excludes others');

// Too-short queries match nothing (avoids a scan on every keystroke)
assert.deepStrictEqual(searchEntries(entries, 'k', null), { hits: [], total: 0 });
assert.deepStrictEqual(searchEntries(entries, '  ', null), { hits: [], total: 0 });

// The cap keeps scanning: total still reports every match
const many = Array.from({ length: SEARCH_LIMIT + 25 }, (_, i) => ({ role: 'assistant', text: `hit ${i} needle`, timestamp: i }));
const capped = searchEntries(many, 'needle', null);
assert.strictEqual(capped.hits.length, SEARCH_LIMIT, 'hits must be capped');
assert.strictEqual(capped.total, SEARCH_LIMIT + 25, 'total counts past the cap');
assert.strictEqual(searchEntries(many, 'needle', null, 10).hits.length, 10, 'explicit limit respected');

// Every hit carries the whole message so the UI can expand it
assert.strictEqual(all.hits[0].text, entries[0].text, 'full text is returned');
assert.ok(!all.hits[0].truncated, 'short messages are not marked truncated');
const huge = searchEntries([{ role: 'toolResult', text: `${'x'.repeat(FULL_TEXT_LIMIT)} needle` }], 'needle', null).hits[0];
assert.strictEqual(huge.text.length, FULL_TEXT_LIMIT, 'huge messages are cut');
assert.strictEqual(huge.truncated, true, 'and flagged');

// Entries without text or with other shapes never throw
assert.deepStrictEqual(searchEntries([{ role: 'image' }, null, { role: 'user', text: undefined }] as any[], 'abc', null).total, 0);

console.log('session-search.check: OK');
