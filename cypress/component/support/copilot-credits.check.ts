/**
 * Copilot credit math (copilot-totals) + extension handler sections.
 * Run: npx tsx cypress/component/support/copilot-credits.check.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');
// NOTE: AUTERE_PI_ENVS_DIR must be set BEFORE importing any backend module
// (pi-env.ts captures it at module load).
process.env.AUTERE_PI_ENVS_DIR = mkdtempSync(join(tmpdir(), 'copilot-envs-'));
const { usageFromMessage, addUsage, emptyTotals, finalize, CREDIT_USD } = await import(join(REPO, 'src/backend/copilot-totals.ts'));

let pass = 0, fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'OK ' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
};

const copilotMsg = (over: any = {}) => ({
  role: 'assistant', provider: 'github-copilot', model: 'claude-sonnet-4-5',
  usage: { input: 1000, output: 100, cacheRead: 2000, ...(over.usage || {}) },
  ...over,
});

// 1: copilot assistant with usage → counted, recorded cost wins when > 0
let u = usageFromMessage(copilotMsg({ usage: { input: 1000, output: 100, cacheRead: 2000, cost: { total: 0.5 } } }))!;
check('recorded cost wins', u && u.costUsd === 0.5);

// 2: no recorded cost → estimated from the pricing table (sonnet 3/0.3/15)
u = usageFromMessage(copilotMsg())!;
const est = (1000 * 3 + 2000 * 0.3 + 100 * 15) / 1e6;
check('estimated when cost 0', Math.abs(u.costUsd - est) < 1e-9);

// 3: non-copilot provider → skipped
check('non-copilot skipped', usageFromMessage({ role: 'assistant', provider: '9router', usage: { input: 1 } }) === null);

// 4: totals + credit conversion (1 credit = $0.01)
const t = emptyTotals();
addUsage(t, u); addUsage(t, u);
finalize(t);
check('totals + AIC', t.turns === 2 && Math.abs(t.credits - (2 * est) / CREDIT_USD) < 1e-9);

// 5: full pipeline — write a session file, run copilotStatsFor over an env
mkdirSync(join(process.env.AUTERE_PI_ENVS_DIR as string, 'tester', 'sessions', '--home--'), { recursive: true });
const sesFile = join(process.env.AUTERE_PI_ENVS_DIR as string, 'tester', 'sessions', '--home--', 's1.jsonl');
const now = new Date().toISOString();
writeFileSync(sesFile, [
  JSON.stringify({ type: 'session', id: 'sid-1', cwd: process.env.HOME || '/home/slop' }),
  JSON.stringify({ type: 'message', timestamp: now, message: { role: 'assistant', provider: 'github-copilot', model: 'claude-sonnet-4-5', usage: { input: 1000, output: 100, cacheRead: 2000, cost: { total: 0.5 } } } }),
  JSON.stringify({ type: 'message', timestamp: now, message: { role: 'assistant', provider: 'other', usage: { input: 99999, cost: { total: 9 } } } }),
].join('\n'));


process.env.AUTERE_USERS_FILE = join(process.env.AUTERE_PI_ENVS_DIR as string, 'users.json');
writeFileSync(process.env.AUTERE_USERS_FILE, JSON.stringify({ tester: { passwordHash: 's2:aa:bb', role: 'control', allowedDirs: [] } }));
const users = await import(join(REPO, 'src/backend/users.ts'));
(users as any).initUserRegistry({ adminPassword: 'x' });

const handlers = await import(join(REPO, 'src/backend/extension-handlers.js'));
const { copilotStatsFor } = handlers as any;
const { session, month } = copilotStatsFor('tester');
check('statsFor session totals', session.turns === 1 && Math.abs(session.credits - 50) < 1e-6);
check('statsFor month totals', month.turns === 1 && Math.abs(month.credits - 50) < 1e-6);

// 6: handler enrich returns the zero placeholder section
const handler = (handlers as any).getExtensionHandler('copilot-credit-usage');
const info = await handler.enrich({ sections: [] });
check('handler placeholder', info.sections?.[0]?.header === 'AI credit usage (this env)');

if (fail) { console.log(`\n${fail} failure(s)`); process.exit(1); }
console.log('\nAll copilot-credit checks passed');
