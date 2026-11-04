// Self-check: extension handler enrichment must read the CALLING user's
// settings/env — the old admin-scoped version leaked the admin's 9router
// baseUrl/apiKey/password into every other user's Extensions card.
// Run: npx tsx src/backend/extension-enrich.check.ts
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'autere-enrich-check-'));
process.env.AUTERE_DIR = join(dir, 'state');
process.env.AUTERE_PI_ENVS_DIR = join(dir, 'envs');

// The 9router handler probes /v1/models — answer locally and record the URL.
const probed: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  probed.push(String(url));
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}) as any;

process.env.INITIAL_PASSWORD = 'admin-initial-secret';
const { initUserRegistry, createUser } = await import('./users.js');
const { setUserSetting, getAllUserSettings } = await import('./user-settings.js');
const { getExtensionHandler } = await import('./extension-handlers.js');

initUserRegistry({ adminPassword: 'admin-password' });
assert.equal(createUser({ username: 'guest', password: 'guest-password', role: 'chat', allowedDirs: [] }), null);

setUserSetting('admin', 'nineRouter', {
  baseUrl: 'https://admin-router.test', apiKey: 'sk-admin-secret', password: 'admin-dashboard-pw',
});
setUserSetting('guest', 'nineRouter', { baseUrl: 'https://guest-router.test' });

const nineRouter = getExtensionHandler('pi-9router-ext');
assert.ok(nineRouter, 'nineRouter handler missing');
const info = (details: any) => ({ name: 'pi-9router-ext', details } as any);

const guestInfo = await nineRouter.enrich(info({}), 'guest');
const guestJson = JSON.stringify(guestInfo);
assert.equal(guestInfo.details.baseUrl, 'https://guest-router.test', 'guest did not get its own config');
assert.ok(!guestJson.includes('admin-router.test'), 'guest saw the admin baseUrl');
assert.ok(!guestJson.includes('sk-admin-secret'), 'guest saw the admin apiKey');
assert.ok(!guestJson.includes('admin-dashboard-pw'), 'guest saw the admin password');
assert.deepEqual(probed, ['https://guest-router.test/v1/models'], `guest probed ${probed.join(', ')}`);

const adminInfo = await nineRouter.enrich(info({}), 'admin');
assert.equal(adminInfo.details.baseUrl, 'https://admin-router.test', 'admin lost its own config');
assert.ok(probed.slice(1).every((u) => u.startsWith('https://admin-router.test/')), `admin probed ${probed.slice(1).join(', ')}`);

// GET /settings is chat-role: the initial admin password must not ride along
// as the nineRouter dashboard password for other users.
assert.equal(getAllUserSettings('admin').nineRouterPassword, 'admin-initial-secret', 'admin lost its bootstrap password');
assert.equal(getAllUserSettings('guest').nineRouterPassword, '', 'guest inherited the admin password');

globalThis.fetch = realFetch;
console.log('extension-enrich.check: OK');
