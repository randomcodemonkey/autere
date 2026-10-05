/**
 * docker.sock permission guards (users.ts) + sandbox argv (rpc-client).
 * Run: npx tsx cypress/component/support/docker-socket.check.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(new URL('..', import.meta.url).pathname, '..', '..');

// Isolation self-check: check scripts touching users/auth/registry may
// NEVER fall through to the real ~/.autere/autere-users.json — assert the
// override BEFORE any backend import (constants.js captures envs at load). Refuse otherwise.
process.env.AUTERE_USERS_FILE ||= '';
if (!process.env.AUTERE_USERS_FILE.startsWith('/tmp/')) {
  process.env.AUTERE_USERS_FILE = '/tmp/sock-guard-users.json';
  writeFileSync(process.env.AUTERE_USERS_FILE, JSON.stringify({}));
}
process.env.AUTERE_PI_ENVS_DIR ||= '';
if (!process.env.AUTERE_PI_ENVS_DIR.startsWith('/tmp/')) {
  process.env.AUTERE_PI_ENVS_DIR = mkdtempSync(join(tmpdir(), 'sockenv-'));
}
writeFileSync(process.env.AUTERE_USERS_FILE, JSON.stringify({}));
const users = await import(join(REPO, 'src/backend/users.ts'));

let pass = 0, fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'OK ' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
};

// admin with flag → granted; non-admin → never
check('create admin+sock', users.createUser({ username: 'rooty', password: 'password1', role: 'admin', allowedDirs: [], mountDockerSocket: true }) === null);
check('create admin2', users.createUser({ username: 'rooty2', password: 'password1', role: 'admin', allowedDirs: [], mountDockerSocket: false }) === null);
check('admin granted', users.getUserMountDockerSocket('rooty') === true);
check('publicUser flag', users.listUsers().find((u: any) => u.username === 'rooty').mountDockerSocket === true);

check('create chat+sock', users.createUser({ username: 'chatty', password: 'password1', role: 'chat', allowedDirs: [], mountDockerSocket: true }) === null);
check('chat denied', users.getUserMountDockerSocket('chatty') === false);

// grant then demote → cleared; demote with no explicit flag → also cleared
check('demote clears sock', users.updateUser('rooty', 'rooty', { role: 'chat' }) === null && users.getUserMountDockerSocket('rooty') === false);
users.updateUser('rooty', 'rooty', { role: 'admin' });
(users as any).setMountDockerSocket?.('rooty', true);
users.updateUser('rooty', 'rooty', { mountDockerSocket: true });
check('re-grant admin ok', users.getUserMountDockerSocket('rooty') === true);
users.updateUser('rooty', 'rooty', { role: 'chat' });
check('role-patch-only clears', users.getUserMountDockerSocket('rooty') === false);

// persisted registry roundtrip
const raw = JSON.parse(readFileSync(process.env.AUTERE_USERS_FILE as string, 'utf-8'));
check('persisted flag', typeof raw.chatty.mountDockerSocket === 'boolean' && raw.chatty.mountDockerSocket === false);

// sandbox argv: socket bind + supplementary gid present iff flag
const master = JSON.parse(readFileSync(process.env.HOME + '/.pi/agent/settings.json', 'utf-8'));
void master;
const { MonitorRpcClient: RpcClient } = await import(join(REPO, 'src/backend/rpc-client.ts'));
const argvFor = (flag: boolean) => {
  const rc = new RpcClient({ sandboxImage: 'test-image', sandboxMounts: [{ volume: 'somevol', dst: '/home/x' }], sandboxDockerSocket: flag, agentDir: '/nonexistent', rpc: { url: '', sessionId: '', historyLimit: 10, model: null } } as any);
  void rc;
  // buildSandboxCommand is private — exercise via the exported helper if any, else reflect
  return (rc as any).buildSandboxCommand(['--help']);
};
const withSock = argvFor(true).join(' ');
const withoutSock = argvFor(false).join(' ');
check('argv mounts sock', withSock.includes('/var/run/docker.sock') && withSock.includes('--group-add'));
check('argv clean without', !withoutSock.includes('docker.sock'));

// sandboxSharedEnv: XDG vars always; GIT_CONFIG_GLOBAL only when the
// gitconfig file exists. Run in a subprocess so HOME can be simulated.
const { execFileSync } = await import('node:child_process');
const envScript = (tmpHome: string) => `
  process.env.HOME = ${JSON.stringify(tmpHome)};
  const m = await import(${JSON.stringify(join(REPO, 'src/backend/pi-env.ts'))});
  console.log(JSON.stringify(m.sandboxSharedEnv()));
`;
const runEnvCheck = async (withGit: boolean) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'fakeshared-'));
  mkdirSync(join(tmpHome, '.config'), { recursive: true });
  mkdirSync(join(tmpHome, '.cache'), { recursive: true });
  if (withGit) writeFileSync(join(tmpHome, '.config/gitconfig'), '[user]\n');
  const probe = join(tmpdir(), `envprobe-${Date.now()}.mts`);
  writeFileSync(probe, envScript(tmpHome));
  try {
    const out = execFileSync('npx', ['tsx', probe], { encoding: 'utf-8', env: { ...process.env, AUTERE_USERS_FILE: '/tmp/sock-guard-users.json', AUTERE_PI_ENVS_DIR: process.env.AUTERE_PI_ENVS_DIR }, timeout: 60000 });
    return JSON.parse(out);
  } catch (e) { return { __error: String(e) }; }
};
check('sharedEnv xdg', JSON.stringify((await runEnvCheck(true)).XDG_CONFIG_HOME).includes('.config'));
check('sharedEnv git with file', !!(await runEnvCheck(true)).GIT_CONFIG_GLOBAL);
check('sharedEnv git without file', !(await runEnvCheck(false)).GIT_CONFIG_GLOBAL);

if (fail) { console.log(`\n${fail} failure(s)`); process.exit(1); }
console.log('\nAll docker-socket checks passed');
