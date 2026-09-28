/**
 * Per-user pi environments.
 *
 * Each autere user gets an isolated pi agent directory under
 * ~/.autere/pi-envs/{user}/, set via PI_CODING_AGENT_DIR when spawning
 * that user's pi process. This prevents users from sharing session
 * state, settings and extension state through the global ~/.pi/agent.
 *
 * The environment is seeded from the global ~/.pi/agent folder:
 * - Small config files (settings.json, auth.json, *-config.json,
 *   models-store.json) are copied once if missing — the global folder
 *   provides the defaults, and pi (or autere's settings page) can then
 *   override them per user.
 * - Heavy/shared directories (npm packages, extensions, skills, themes,
 *   bin, tmp) are symlinked so all users share one installed copy.
 * - sessions/ is created fresh per user (never shared, never copied,
 *   never symlinked).
 *
 * BOUNDARY RULE: ~/.pi/agent is the seeding source and the location of
 * the shared read-only install assets (the symlinked dirs) — nothing
 * else. Session data never crosses this boundary in either direction:
 * autere never reads global sessions, and per-user "last session"
 * pointers live INSIDE the user's env (see auth.ts getLastSession),
 * which also validates that a resumed session file belongs to the env.
 */

import { getUserAllowedDirs, getUserRole, isRegisteredUser } from './users.js';
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync, readlinkSync, rmSync, symlinkSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { join } from 'path';
import { PI_DIR, AUTERE_DIR } from './constants.js';
import { log } from './logger.js';
import { sanitizeUserName } from '../shared/format.js';

/** Directories to share via symlink (heavy, read-mostly) */
const SHARED_DIRS = ['npm', 'extensions', 'skills', 'themes', 'bin', 'tmp'];

/** Files copied into each user environment on first use */
const SEED_FILES = ['settings.json', 'auth.json', 'models-store.json', 'models.json'];

/** Neutralize pi-9router-ext in the env's settings.json packages list:
 *  rewrite its entry to object form with empty resource lists, which pi
 *  treats as a fully filtered-out package (nothing loads). */
export function disable9routerExt(envDir: string): void {
  const settingsPath = join(envDir, 'settings.json');
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!Array.isArray(raw.packages)) return;
    const packages = raw.packages.map((p: any) =>
      (typeof p === 'string' ? p.includes('pi-9router-ext') : p.source?.includes?.('pi-9router-ext'))
        ? { source: 'npm:pi-9router-ext', extensions: [], skills: [], promptTemplates: [] }
        : p);
    if (JSON.stringify(packages) !== JSON.stringify(raw.packages)) {
      raw.packages = packages;
      writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
      log.piEnv.info(`Provider is not 9router — pi-9router-ext disabled in ${settingsPath}`);
    }
  } catch { /* no/invalid settings.json - nothing to disable */ }
}

/** Directory of per-user pi environments.
 *  AUTERE_PI_ENVS_DIR overrides the location — used by the e2e suite to
 *  fully isolate test pi processes (sessions, settings, auth) from real
 *  user environments. */
export const PI_ENVS_DIR = process.env.AUTERE_PI_ENVS_DIR
  ? (existsSync(process.env.AUTERE_PI_ENVS_DIR) || mkdirSync(process.env.AUTERE_PI_ENVS_DIR, { recursive: true }), process.env.AUTERE_PI_ENVS_DIR)
  : join(AUTERE_DIR, 'pi-envs');

/** Get the pi agent dir for a user (may not exist yet) */
export function getPiEnvDir(user: string): string {
  return join(PI_ENVS_DIR, sanitizeUserName(user));
}

/** True if path exists (including broken symlinks) */
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/**
 * Ensure the per-user pi environment exists and is seeded.
 * Idempotent — safe to call on every pi spawn.
 * Returns the environment directory to pass as PI_CODING_AGENT_DIR.
 */
export function ensurePiEnv(user: string): string {
  const envDir = getPiEnvDir(user);
  try {
    if (!existsSync(envDir)) mkdirSync(envDir, { recursive: true });

    // Copy small config files if missing (global folder = defaults)
    for (const file of SEED_FILES) {
      const src = join(PI_DIR, file);
      const dest = join(envDir, file);
      if (existsSync(src) && !pathExists(dest)) {
        try { copyFileSync(src, dest); } catch (err) {
          log.piEnv.error(`Failed to seed ${file} for user "${user}":`, err);
        }
      }
    }

    // When pi runs against a non-9router provider, neutralize
    // pi-9router-ext in the env's settings.json (object form with empty
    // resource lists = package loads nothing; pi 'packages filter').
    if (process.env.AUTERE_PROVIDER && process.env.AUTERE_PROVIDER !== '9router') {
      disable9routerExt(envDir);
    }

    // Copy any extension config files (e.g. 9router-config.json)
    try {
      const entries = readdirSync(PI_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('-config.json')) {
          const dest = join(envDir, entry.name);
          if (!pathExists(dest)) {
            try { copyFileSync(join(PI_DIR, entry.name), dest); } catch (err) {
              log.piEnv.error(`Failed to seed ${entry.name} for user "${user}":`, err);
            }
          }
        }
      }
    } catch (err) {
      log.piEnv.error('Failed to list pi dir for seeding:', err);
    }

    // Symlink heavy shared directories if missing
    for (const dir of SHARED_DIRS) {
      const src = join(PI_DIR, dir);
      const dest = join(envDir, dir);
      if (existsSync(src) && !pathExists(dest)) {
        try { symlinkSync(src, dest, 'dir'); } catch (err: any) {
          if (err?.code !== 'EEXIST') {
            log.piEnv.error(`Failed to symlink ${dir} for user "${user}":`, err);
          }
        }
      }
    }

    // Sessions dir — per-user, never shared
    const sessionsDir = join(envDir, 'sessions');
    if (!existsSync(sessionsDir)) {
      try { mkdirSync(sessionsDir, { recursive: true }); } catch {}
    }
  } catch (err) {
    log.piEnv.error(`Failed to ensure pi env for user "${user}":`, err);
  }
  return envDir;
}

/** Docker sandbox support: container paths must be mounted by VOLUME NAME —
 *  the docker daemon resolves plain -v paths on the HOST, not inside this
 *  container. Returns EVERY docker-volume-backed mount of this container
 *  (shallow → deep mount order, so children can shadow parents):
 *  [{ volume, target }] e.g. [{ volume: 'slopbox_home', target: '/home/slop' },
 *  { volume: 'code', target: '/home/slop/code' }, ...]. The sandbox mounts
 *  the subset needed for home + pi env dir + session cwd. */
/** Validate that an image can actually run pi (bash + binary present).
 *  Returns null when OK, else an error message. Pulls the image if missing —
 *  ponytail: a 3.6 GB first pull can eat the whole timeout, but that's the
 *  honest outcome either way. */
export async function validateSandboxImage(image: string): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile('docker', ['run', '--rm', '--entrypoint', 'bash', image, '-c', 'command -v pi'],
        { timeout: 120_000, encoding: 'utf-8' }, (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout))));
    return out.includes('/pi') || /(^|\/)pi$|\bpi\b/.test(out.trim()) ? null : 'pi binary not found on PATH in this image';
  } catch (e: any) {
    const detail = String(e.stderr || e.message || e).split('\n').slice(-2).join(' ').slice(0, 200);
    return `image cannot run pi: ${detail}`;
  }
}

export const DEFAULT_SANDBOX_IMAGE = 'randomcodemonkey.org/slopbox:latest';
const OFF = /^(off|none|disabled)$/i;

/** Sandbox disable (off/none/disabled) is an ADMIN escape hatch only —
 *  every other role always sandboxes. */
export function resolveSandboxImage(user: string, setting?: string, env?: string): string {
  const admin = isRegisteredUser(user) && getUserRole(user) === 'admin';
  let set = String(setting ?? '').trim();
  let envv = String(env ?? '').trim();
  // The off/none/disabled setting is an admin-only escape hatch; a
  // server-level PI_SANDBOX_IMAGE=off is the operator kill switch (e2e).
  if (OFF.test(set)) { if (!admin) set = ''; else return ''; }
  if (OFF.test(envv)) return '';
  return set || envv || DEFAULT_SANDBOX_IMAGE;
}

// ── Sandbox workspace planning ───────────────────────────────────────────
// Container layout: $HOME stays the image's home (/home/slop). The pi env
// dir is always mounted path-identical. Work areas mount under $HOME/work/:
//   - users with allowedDirs: each allowed dir at $HOME/work/<basename>
//   - admins without allowedDirs: the whole autere home at $HOME/work/autere
// A session cwd inside a root maps to $HOME/work/<root>/<relative path>.

export interface SandboxMount {
  volume: string;
  /** Mount destination INSIDE the sandbox container. */
  dst: string;
  /** Path (relative to the volume root) that dst shows. Omitted = whole volume. */
  subpath?: string;
}

export interface SandboxPlan {
  mounts: SandboxMount[];
  /** Container cwd for the -w flag; undefined = fallback (/home/slop). */
  cwd?: string;
}

// work base is resolved per HOME inside planSandboxMounts (const moved there)

/** Copy the master agent dir's shared pieces into the user env dir so they
 *  cross the sandbox boundary without mounting ~/.pi (extensions may point
 *  at code/autere/extras sources; dereferenced copies keep that private).
 *  npm stays a SYMLINK: it resolves in-container via the master-npm subpath
 *  mount planned below — the master npm dir holds no secrets, only pi's
 *  package project. Refreshed every sandbox spawn to pick up changes. */
export function prepareSandboxEnvDir(agentDir: string): void {
  for (const name of ['extensions', 'skills', 'bin', 'tmp']) {
    const link = join(agentDir, name);
    let src: string | null = null;
    try { src = readlinkSync(link); } catch { /* not a symlink — leave */ }
    if (!src) continue;
    const target = src.startsWith('/') ? src : join(agentDir, src);
    try { rmSync(link); } catch { /* already replaced */ }
    try { cpSync(target, link, { recursive: true, dereference: true, force: true }); }
    catch { /* missing master dir — pi tolerates absent optional pieces */ }
  }
}

/** Persistent per-user sandbox home volume (created lazily): the container's
 *  $HOME is a NAMED docker volume so ~/.cache/.gitconfig/... survive spawns
 *  without exposing the master ~/.pi (no gitconfig/ssh/tokens are ever
 *  seeded by autere; users get an empty home owned by the sandbox uid). */
export function ensureSandboxHomeVolume(user: string, image: string): string {
  const vol = `autere-home-${user}`;
  try {
    execFileSync('docker', ['volume', 'inspect', vol], { stdio: 'ignore' });
    return vol; // exists
  } catch { /* create + bootstrap */ }
  try {
    execFileSync('docker', ['volume', 'create', vol], { stdio: 'ignore' });
    // entrypoint override: the image default is supervisord (+ full extension
    // install) — a bootstrap helper only needs a shell.
    execFileSync('docker', ['run', '--rm', '-u', '0', '--entrypoint', 'sh', '-v', `${vol}:/h`, image, '-c',
      'chown -R 1001:1001 /h'], { stdio: 'ignore' });
  } catch (e: any) {
    // Best effort: the home stays empty/root-owned — spawns still work or fail
    // loudly in pi; a broken exec shouldn't block per turn.
    log.rpc.warn?.(`sandbox home volume bootstrap failed: ${String(e && e.message || e)}`);
  }
  return vol;
}

/** Compute the mount set + translated cwd for one sandboxed spawn. */
export function planSandboxMounts(user: string, cwd: string | undefined, agentDir: string, homeVolume?: string): SandboxPlan {
  const mounts = discoverVolumeMounts();
  const home = process.env.HOME || '/home/slop';
  const homeM = mounts.find((m) => m.target === home);
  if (!homeM) throw new Error(`pi sandbox not possible: ${home} is not backed by a docker volume`);
  const workBase = `${home}/work`;
  const out: SandboxMount[] = [];
  if (homeVolume) out.push({ volume: homeVolume, dst: home }); // parent; children below shadow it
  const subOf = (p: string) => p.slice(homeM.target.replace(/\/$/, '').length + 1);

  // pi env dir (non-negotiable) + master npm (the env symlink target)
  if (agentDir.startsWith(homeM.target.endsWith('/') ? homeM.target : homeM.target + '/')) {
    out.push({ volume: homeM.volume, dst: agentDir, subpath: subOf(agentDir) });
  } else {
    throw new Error(`pi sandbox not possible: the pi env dir (${agentDir}) is not inside a docker volume`);
  }
  const masterNpm = join(home, '.pi/agent/npm');
  if (existsSync(masterNpm)) {
    out.push({ volume: homeM.volume, dst: join(home, '.pi/agent/npm'), subpath: subOf(masterNpm) });
  }
  // The 9router extension resolves its config via homedir() (no
  // PI_CODING_AGENT_DIR fallback), so the user's per-env 9router key rides
  // in at ~/.pi/agent/9router-config.json — a file, volume-subpath'd.
  const routerCfg = join(agentDir, '9router-config.json');
  if (existsSync(routerCfg) && agentDir.startsWith(homeM.target.endsWith('/') ? homeM.target : homeM.target + '/')) {
    out.push({ volume: homeM.volume, dst: join(home, '.pi/agent/9router-config.json'), subpath: subOf(routerCfg) });
  }

  // Work area: user's allowedDirs, or (admin without any) the whole home.
  const dirs = getUserAllowedDirs(user).map((d) => d.path).filter((p): p is string => !!p);
  const backed = (p: string) => mounts.find((m) => p === m.target || p.startsWith(m.target.endsWith('/') ? m.target : m.target + '/'))
    ?? null;
  const workRoots: { host: string; dst: string; mount: { volume: string; subpath?: string } }[] = [];
  if (dirs.length) {
    for (const d of dirs) {
      const b = backed(d);
      if (!b) continue;
      const name = d.slice(d.replace(/\/$/, '').lastIndexOf('/') + 1);
      const dst = `${workBase}/${name}`;
      workRoots.push({ host: d, dst, mount: { volume: b.volume, subpath: d === b.target ? undefined : d.slice(b.target.replace(/\/$/, '').length + 1) } });
    }
  } else if (getUserRole(user) === 'admin') {
    // admin without allowedDirs sees the home workspace
    workRoots.push({ host: homeM.target, dst: `${workBase}/autere`, mount: { volume: homeM.volume, subpath: '' } });
  }
  for (const w of workRoots) out.push({ volume: w.mount.volume, dst: w.dst, subpath: w.mount.subpath || undefined });

  // Translate the session cwd into its container work path.
  let containerCwd: string | undefined;
  if (cwd) {
    // longest matching root wins
    const hit = [...workRoots].sort((a, b) => b.host.length - a.host.length)
      .find((w) => cwd === w.host || cwd.startsWith(w.host.endsWith('/') ? w.host : w.host + '/'));
    if (hit) containerCwd = hit.dst + (cwd === hit.host ? '' : cwd.slice(hit.host.replace(/\/$/, '').length));
  }
  return { mounts: out, cwd: containerCwd };
}

export function discoverVolumeMounts(): { volume: string; target: string }[] {
  try {
    const out: { volume: string; target: string }[] = [];
    for (const line of readFileSync('/proc/self/mountinfo', 'utf-8').split('\n')) {
      // mountinfo: id parent major:minor root mountpoint opts... — the
      // container fs-root for docker volumes is /var/lib/docker/volumes/<name>/_data
      const volMatch = /\/var\/lib\/docker\/volumes\/([^/\s]+)\/_data /.exec(line);
      if (!volMatch) continue;
      const target = line.split(' ')[4];
      if (!target) continue;
      out.push({ volume: volMatch[1], target });
    }
    // shallow first so a sandbox can append deeper overrides in order
    return out.sort((a, b) => a.target.length - b.target.length);
  } catch { /* not on linux / no mountinfo */ }
  return [];
}
