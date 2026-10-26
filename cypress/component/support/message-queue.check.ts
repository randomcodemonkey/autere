/**
 * Message-type mapping for POST /session/messages:
 * 1. idle + prompt -> prompt (delivered immediately)
 * 2. idle + steer/followUp -> prompt (pi would queue it forever otherwise)
 * 3. mid-turn + prompt -> steer, queued (cross-session delivery to a busy
 *    target must not fail with "already processing")
 * 4. mid-turn + steer/followUp -> unchanged, queued
 *
 * Run: npx tsx cypress/component/support/message-queue.check.ts
 */
import { join } from 'node:path';

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

const { effectiveMessageType } = await import(join(REPO, 'src/shared/messages.ts'));

check('idle prompt is immediate', JSON.stringify(effectiveMessageType('prompt', false)) === JSON.stringify({ type: 'prompt', queued: false }));
check('idle steer degrades to prompt', JSON.stringify(effectiveMessageType('steer', false)) === JSON.stringify({ type: 'prompt', queued: false }));
check('idle followUp degrades to prompt', JSON.stringify(effectiveMessageType('followUp', false)) === JSON.stringify({ type: 'prompt', queued: false }));
check('mid-turn prompt is queued as steer', JSON.stringify(effectiveMessageType('prompt', true)) === JSON.stringify({ type: 'steer', queued: true }));
check('mid-turn steer stays steer', JSON.stringify(effectiveMessageType('steer', true)) === JSON.stringify({ type: 'steer', queued: true }));
check('mid-turn followUp stays followUp', JSON.stringify(effectiveMessageType('followUp', true)) === JSON.stringify({ type: 'followUp', queued: true }));

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll message-queue checks passed');
process.exit(0);
