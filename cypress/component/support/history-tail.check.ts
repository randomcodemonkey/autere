/**
 * Tail history reader (perf: a 50 MB session log must not be read whole just
 * to render the last 30 entries):
 * 1. a small file (shorter than the window) reads completely
 * 2. a large file yields the tail entries without reading the head
 * 3. readSessionHistory still returns exactly `limit` rendered entries
 * 4. the window grows when entries are sparse (huge tool results)
 *
 * Run: npx tsx cypress/component/support/history-tail.check.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'hist-tail-'));
process.env.AUTERE_DIR = join(dir, 'state');
process.env.AUTERE_PI_ENVS_DIR = join(dir, 'pi-envs');

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

const { readTailMessageEntries, readAllMessageEntries } = await import(join(REPO, 'src/backend/stream-history.ts'));
const { readSessionHistory } = await import(join(REPO, 'src/backend/utils.ts'));

const header = JSON.stringify({ type: 'session', id: 'sess-1', timestamp: '2026-01-01T00:00:00Z' });
const msg = (n: number, pad = 0) => JSON.stringify({
  type: 'message',
  timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  message: { role: n % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `message ${n}` + (pad ? 'x'.repeat(pad) : '') }] },
});

// 1. small file
const small = join(dir, 'small.jsonl');
writeFileSync(small, [header, ...[1, 2, 3].map((n) => msg(n))].join('\n') + '\n');
check('small file: all entries read', readAllMessageEntries(small).length === 3);
check('small file: tail read matches', readTailMessageEntries(small, 30).length === 3);

// 2. large file: 400 messages x 4 KB ≈ 1.6 MB, last 30 must come from the tail
const big = join(dir, 'big.jsonl');
writeFileSync(big, [header, ...Array.from({ length: 400 }, (_, i) => msg(i + 1, 4000))].join('\n') + '\n');
const tail = readTailMessageEntries(big, 30);
check('big file: at least 2x limit entries', tail.length >= 60);
check('big file: no partial first line', tail[0]?.type === 'message');
check('big file: newest entry is last', tail[tail.length - 1]?.message.content[0].text.startsWith('message 400'));

// 3. rendered history keeps the contract
const rendered = readSessionHistory(big, 30);
check('readSessionHistory: exactly limit entries', rendered.length === 30);
check('readSessionHistory: newest at the end', rendered[rendered.length - 1].text.includes('message 400'));
check('readSessionHistory: no partial leading entry', rendered[0].text.length > 0);

// 4. sparse entries (few lines, huge payloads) grow the window
const sparse = join(dir, 'sparse.jsonl');
writeFileSync(sparse, [header, ...Array.from({ length: 40 }, (_, i) => msg(i + 1, 100_000))].join('\n') + '\n');
check('sparse file: window grows to reach the limit', readTailMessageEntries(sparse, 30).length >= 40);

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll history tail checks passed');
process.exit(0);
