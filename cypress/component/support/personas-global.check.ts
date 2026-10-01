/**
 * pi-personas global system prompt — inject-order + marker state machine.
 * Port of the throwaway /tmp smoke; runs with plain tsx (assert-based, no
 * cypress/canvas). Run: npx tsx cypress/component/support/personas-global.check.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(new URL('..', import.meta.url).pathname, '..', '..');
const mod = await import(join(REPO_ROOT, 'extras/pi-personas/index.ts'));

let pass = 0, fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'OK ' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
};

/** sleep synchronously — statSync().mtimeMs granularity vs same-ms writes */
const busy = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) {} };

function freshEnv() {
  const env = mkdtempSync(join(tmpdir(), 'personas-global-'));
  process.env.PI_CODING_AGENT_DIR = env;
  let handler: (e: any, ctx: any) => any = () => undefined;
  mod.default({ on: (ev: string, fn: any) => { if (ev === 'before_agent_start') handler = fn; } });
  const ctx = { sessionManager: { getSessionFile: () => '/x/sess.jsonl' } };
  const w = (n: string, v: any) => { writeFileSync(join(env, n), JSON.stringify(v)); busy(3); };
  return { env, ctx, handler, w };
}

{
  const { env, ctx, handler, w } = freshEnv() as any;

  // 1: no global, no persona -> inert
  check('inert', handler({ systemPrompt: 'BASE' }, ctx) === undefined);

  // 2: global only
  w('persona-global.json', { prompt: 'GLOBAL RULES' });
  let r = handler({ systemPrompt: 'BASE' }, ctx);
  check('global-only', r && r.systemPrompt.includes('<global-system-prompt>') && !r.systemPrompt.includes('<persona'));

  // 3: global + persona -> single <persona> block, global prompt at its end
  w('persona-active.json', { 'sess.jsonl': { id: 'p1', name: 'Derp', prompt: 'PERSONA RULES' } });
  busy(3);
  r = handler({ systemPrompt: 'BASE' }, ctx);
  const pp = r.systemPrompt.indexOf('PERSONA RULES');
  const gi = r.systemPrompt.indexOf('GLOBAL RULES', pp);
  check('global-within-persona', pp >= 0 && gi > pp && !r.systemPrompt.includes('<global-system-prompt>'));

  // 4: unchanged on second turn -> no new marker, same shape
  r = handler({ systemPrompt: 'BASE' }, ctx);
  check('stable', r && r.systemPrompt.includes('PERSONA RULES') && r.systemPrompt.includes('GLOBAL RULES') && r.message === undefined);

  // 5: global removed
  w('persona-global.json', { prompt: '' });
  busy(3);
  r = handler({ systemPrompt: 'BASE' }, ctx);
  check('global-removed', !r.systemPrompt.includes('GLOBAL') && r.message.content === 'Global system prompt removed; persona "Derp" stays active.');
}

{
  // Persona-marker semantics with a global prompt present
  const { ctx, handler, w } = freshEnv() as any;
  const busy = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) {} };
  const setg = (g: string) => { busy(3); w('persona-global.json', { prompt: g }); busy(3); };
  const setb = (b: boolean) => { busy(3); w('persona-active.json', { 'sess.jsonl': b ? { id: 'p1', name: 'Derp', prompt: 'PERSONA RULES' } : {} }); busy(3); };

  // persona active first (original behavior), THEN global added;
  // injection is now a single <persona> block with the global prompt
  // concatenated to the END of the persona prompt (no separate tag)
  setb(true);
  let r = handler({ systemPrompt: 'BASE' }, ctx);
  check('t1 persona marker', r.message?.content === 'Persona "Derp" active (new session).');
  setg('GLOBAL RULES');
  r = handler({ systemPrompt: 'BASE' }, ctx);
  check('t2 global marker after persona', r.message?.content === 'Persona "Derp" active; global system prompt added.');
  check('t2 single injection', r.systemPrompt.includes('<persona') && !r.systemPrompt.includes('<global-system-prompt>'));
  const pp = r.systemPrompt.indexOf('PERSONA RULES');
  const gp = r.systemPrompt.indexOf('GLOBAL RULES', pp);
  check('t2 global after persona text', pp >= 0 && gp > pp);
  setg('GLOBAL RULES2');
  r = handler({ systemPrompt: 'BASE' }, ctx);
  check('t3 changed marker', r.message?.content === 'Global system prompt and persona "Derp" both active (changed).');
  check('t3 new global inside block', r.systemPrompt.includes('GLOBAL RULES2') && r.systemPrompt.includes('<persona'));

  // persona removed while global active: prompt keeps global, marker reflects it
  setb(false);
  r = handler({ systemPrompt: 'BASE' }, ctx);
  check('t4 persona removed marker', r.message?.content === 'Global system prompt changed.');
  check('t4 keeps global', r.systemPrompt.includes('<global-system-prompt>'));
  r = handler({ systemPrompt: 'BASE' }, ctx);
  check('t5 stable after removal', r && !r.message);
}

if (fail) { console.log(`\n${fail} failure(s)`); process.exit(1); }
console.log('\nAll personas-global checks passed');
