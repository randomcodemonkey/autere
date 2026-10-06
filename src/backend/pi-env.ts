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
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync, readlinkSync, rmSync, symlinkSync, lstatSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';
import { readJsonCached, invalidateCache } from './user-settings.js';
import { execFileSync } from 'node:child_process';
import { join } from 'path';
import { PI_DIR, AUTERE_DIR } from './constants.js';
import { log } from './logger.js';
import { sanitizeUserName } from '../shared/format.js';

/** Directories to share via symlink (heavy, read-mostly) */
const SHARED_DIRS = ['npm', 'extensions', 'skills', 'themes', 'bin', 'tmp'];

/** Files copied into each user environment on first use */
const SEED_FILES = ['settings.json', 'auth.json', 'models-store.json', 'models.json', 'mcp.json'];

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

/** Make envDir/extensions a real directory holding per-entry symlinks
 *  instead of one symlink to the shared master dir. Bundled extras are
 *  toggled per user by linking/unlinking entries in it — a shared symlink
 *  would leak those toggles into the master dir for every user.
 *  ponytail: master-loop/link copies are cheap; revisit only if master
 *  extensions ever hold per-entry state beyond symlinks. */
export function materializeEnvExtensions(user: string): void {
  const envDir = getPiEnvDir(user);
  const link = join(envDir, 'extensions');
  let src: string | null = null;
  try { src = readlinkSync(link); } catch { return; } // missing or already a real dir
  const target = src.startsWith('/') ? src : join(envDir, src);
  rmSync(link);
  mkdirSync(link, { recursive: true });
  let entries: string[] = [];
  try { entries = readdirSync(target); } catch { /* empty master dir */ }
  for (const name of entries) {
    try { symlinkSync(join(target, name), join(link, name), 'dir'); } catch { /* eexist */ }
  }
}

/**
 * Sync master ~/.pi/agent/settings.json install state into a seeded env's
 * settings.json. Runs on every ensurePiEnv so master-side `pi install`
 * (container bootstrap, manual installs) propagates to every user env at
 * next spawn. Only keys that cannot change per session are overwritten
 * from master: defaultProvider, defaultModel, enabledModels, defaultTools.
 * `packages` is deliberately excluded (see the sync loop below); everything
 * else in the env copy (per-user picks, model thinking levels) is preserved;
 * a key absent from master is never deleted.
 */
function syncMasterSettings(envDir: string): void {
  const master = readJsonCached(join(PI_DIR, 'settings.json'));
  if (!master || typeof master !== 'object') return;
  const envSettingsPath = join(envDir, 'settings.json');
  let envSettings: any = {};
  try { envSettings = JSON.parse(readFileSync(envSettingsPath, 'utf-8')); } catch { /* missing/corrupt env copy — start from master's subset */ }
  const before = JSON.stringify([envSettings.defaultProvider, envSettings.defaultModel, envSettings.enabledModels, envSettings.defaultTools]);
  for (const key of ['defaultProvider', 'defaultModel', 'enabledModels', 'defaultTools'] as const) {
    if (master[key] !== undefined) envSettings[key] = master[key];
  }
  // `packages` deliberately NOT synced: the env's packages ARE the user's
  // enabled set (the UI's extensions toggle writes it). Stomping it from
  // master would resurrect packages the user has disabled on the next
  // ensurePiEnv; master installs surface as available via
  // getAvailablePackages and activate through the settings UI.
  if (JSON.stringify([envSettings.packages, envSettings.defaultProvider, envSettings.defaultModel, envSettings.enabledModels, envSettings.defaultTools]) === before) return;
  try {
    const tmp = join(envDir, `.settings-tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(envSettings, null, 2), 'utf-8');
    renameSync(tmp, envSettingsPath);
    invalidateCache(envSettingsPath);
  } catch (err) {
    log.piEnv.error(`Failed to sync master settings into ${envSettingsPath}:`, err);
  }
}

/** E2E harness only: probeTestModels (start-backend.ts) provisioned working
 *  models via AUTERE_TEST_MODELS — the test env has no user model settings,
 *  so pi would otherwise fall back to its builtin (unroutable) default.
 *  Runs after syncMasterSettings, which would otherwise overwrite it with
 *  the master's list. */
function applyTestModels(envDir: string): void {
  const raw = process.env.AUTERE_TEST_MODELS;
  if (!raw) return;
  const models = raw.split(',').map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) return;
  const envSettingsPath = join(envDir, 'settings.json');
  let envSettings: any = {};
  try { envSettings = JSON.parse(readFileSync(envSettingsPath, 'utf-8')); } catch { /* start fresh */ }
  const first = models[0];
  const slash = first.indexOf('/');
  envSettings.enabledModels = models;
  envSettings.defaultProvider = slash > 0 ? first.slice(0, slash) : '9router';
  envSettings.defaultModel = slash > 0 ? first.slice(slash + 1) : first;
  try {
    const tmp = join(envDir, `.settings-tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(envSettings, null, 2), 'utf-8');
    renameSync(tmp, envSettingsPath);
    invalidateCache(envSettingsPath);
  } catch (err) {
    log.piEnv.error(`Failed to apply e2e test models to ${envSettingsPath}:`, err);
  }
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

    // Master settings drift (new `pi install`s, default model changes)
    // reaches env copies only here — pi instances read the env settings.
    syncMasterSettings(envDir);
    applyTestModels(envDir);

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

/** Every docker-volume-backed mount of this container (shallow → deep, so
 *  children can shadow parents): [{ volume, target }]. Container paths must
 *  be mounted by VOLUME NAME — plain -v paths resolve on the HOST, not here.
 *  The sandbox mounts the subset it needs (see planSandboxMounts). */
/** Validate that an image can actually run pi (binary present on PATH).
 *  Returns null when OK, else an error message. Pulls the image if missing —
 *  ponytail: a first pull can take minutes; the honest outcome either way. */
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

export const DEFAULT_SANDBOX_IMAGE = 'randomcodemonkey.org/autere:latest';
const OFF = /^(off|none|disabled)$/i;

/** Resolve pi sandbox image */
export function resolveSandboxImage(user: string, setting?: string, env?: string): string {
  const admin = isRegisteredUser(user) && getUserRole(user) === 'admin';
  let set = String(setting ?? '').trim();
  const envv = String(env ?? '').trim();

  // The off/none/disabled setting is an admin-only escape hatch; a
  // server-level AUTERE_SANDBOX_IMAGE=off is the operator kill switch (e2e).
  if (OFF.test(set)) { if (!admin) set = ''; else return ''; }
  if (OFF.test(envv)) return '';
  return set || envv || DEFAULT_SANDBOX_IMAGE;
}

// ── Sandbox workspace planning ───────────────────

// Shared config/cache dirs: the example docker-compose mounts these into
// the autere container (volume behind ~/.config etc.) and sets matching
// env variables; the sandbox mirrors the same set so sandboxed and
// non-sandboxed sessions see identical $HOME config/cache (git identity,
// xdg state, npm/maven/ivy caches).
export const SANDBOX_SHARED_DIRS = ['.config', '.cache', '.npm', '.m2', '.ivy'];

/** Env vars forwarded to sandboxed pi reflecting the compose contract.
 *  GIT_CONFIG_GLOBAL only when the gitconfig actually exists at that path. */
export function sandboxSharedEnv(): Record<string, string> {
  const home = process.env.HOME || '/home/autere';
  const env: Record<string, string> = {
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_CONFIG_HOME: `${home}/.config`,
  };
  if (existsSync(`${home}/.config/gitconfig`)) env.GIT_CONFIG_GLOBAL = `${home}/.config/gitconfig`;
  return env;
}

// Container layout: $HOME stays the image's home. The pi env dir mounts
// path-identical. Work areas mount under $HOME/work/:
//   - users with allowedDirs: each allowed dir at $HOME/work/<basename>
//   - admins without allowedDirs: the whole autere home at $HOME/work/autere
//   - per-session workdirs: like allowedDirs, skipped when already covered
// A session cwd inside a root maps to that root's work path + relative part.

export interface SandboxMount {
  volume: string;
  /** Mount destination INSIDE the sandbox container. */
  dst: string;
  /** Path (relative to the volume root) that dst shows. Omitted = whole volume. */
  subpath?: string;
}

export interface SandboxPlan {
  mounts: SandboxMount[];
  /** Container cwd for the -w flag; undefined = spawn falls back to $HOME. */
  cwd?: string;
}

/** Copy the master agent dir's shared pieces into the user env dir so they
 *  cross the sandbox boundary without mounting ~/.pi (extensions may point
 *  at repo source dirs; dereferenced copies keep that private). npm stays a
 *  SYMLINK: resolves in-container via the master-npm subpath mount below —
 *  npm holds no secrets, just pi's package install. Refreshed every
 *  sandbox spawn to pick up changes. */
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

/** Persistent per-user sandbox home volume (created lazily): the sandbox's
 *  $HOME is a named docker volume so HOME files survive spawns without
 *  exposing the master ~/.pi. Contents stay empty — autere seeds nothing
 *  (no gitconfig/ssh/tokens). */
export function ensureSandboxHomeVolume(user: string, image: string): string {
  const vol = `autere-home-${user}`;
  try {
    execFileSync('docker', ['volume', 'inspect', vol], { stdio: 'ignore' });
    return vol; // exists
  } catch { /* not found — create + chown below */ }
  try {
    execFileSync('docker', ['volume', 'create', vol], { stdio: 'ignore' });
    // entrypoint override: the image default is supervisord — bootstrap
    // only needs a shell.
    execFileSync('docker', ['run', '--rm', '-u', '0', '--entrypoint', 'sh', '-v', `${vol}:/h`, image, '-c',
      'chown -R 1001:1001 /h'], { stdio: 'ignore' });
  } catch (e: any) {
    // Best effort: empty/root-owned home — spawns still work or fail loudly
    // in pi; a broken exec shouldn't block turn start.
    log.rpc.warn?.(`sandbox home volume bootstrap failed: ${String(e && e.message || e)}`);
  }
  return vol;
}

/** Copy the host ~/.gitconfig into the sandbox home volume's $HOME (git
 *  identity, aliases) when it exists. Best effort — git works without it.
 *  ponytail: copies at every sandboxed spawn (tiny file); a hash-compare
 *  via `docker run cmp` would trade one wasted copy for one extra container. */
export function ensureSandboxGitconfig(volume: string, image: string): void {
  const home = process.env.HOME || '/home/autere';
  const src = join(home, '.gitconfig');
  if (!existsSync(src)) return;
  const uid = process.getuid?.() ?? 1001;
  const gid = process.getgid?.() ?? uid;
  const script = 'cp "/srchome/.gitconfig" "/h/.gitconfig.tmp"'
    + ` && chown ${uid}:${gid} "/h/.gitconfig.tmp"`
    + ' && mv "/h/.gitconfig.tmp" "/h/.gitconfig"';
  try {
    execFileSync('docker', ['run', '--rm', '--entrypoint', 'sh', '-u', '0',
      // Read-only bind of the backend's own $HOME so the copy crosses
      // docker-volume/binds transparently (same mechanisms as work roots).
      '-v', `${home}:/srchome:ro`, '-v', `${volume}:/h`, image, '-c', script],
      { stdio: 'ignore', timeout: 30000 });
  } catch (e: any) {
    log.piEnv.warn?.(`sandbox gitconfig copy failed: ${String(e && e.message || e)}`);
  }
}

/** Docker's volume-subpath mount fails container creation when the
 *  subpath doesn't exist inside the volume (moby#47842) — the daemon never
 *  creates it. Pre-create every missing subpath dir in its volume, using
 *  the sandbox image itself, and match the backend's uid so the mounted
 *  dirs stay writable. Idempotent; best effort (errors surface later at
 *  spawn with the real docker message). */
export function ensureVolumeSubpaths(mounts: SandboxMount[], image: string): void {
  const byVolume = new Map<string, string[]>();
  for (const m of mounts) {
    if (m.volume.startsWith('/') || !m.subpath) continue; // binds: host path must exist by nature
    (byVolume.get(m.volume) ?? byVolume.set(m.volume, []).get(m.volume)!).push(m.subpath);
  }
  const uid = process.getuid?.() ?? 1001;
  const gid = process.getgid?.() ?? uid;
  for (const [vol, subs] of byVolume) {
    // One container per volume: test each subpath, mkdir+chown only the
    // missing ones. mkdir -p is a no-op for existing dirs — never destructive.
    const script = subs.map((s) =>
      `test -d "/v/${s}" || { mkdir -p "/v/${s}" && chown ${uid}:${gid} "/v/${s}" $(dirname "/v/${s}") || true; }`
    ).join('; ');
    try {
      execFileSync('docker', ['run', '--rm', '-u', '0', '--entrypoint', 'sh', '-v', `${vol}:/v`, image, '-c', script], { stdio: 'ignore', timeout: 30000 });
    } catch (e: any) {
      log.rpc?.warn?.(`volume subpath prep failed for ${vol}: ${String(e && e.message || e)}`);
    }
  }
}

/** Compute the mount set + translated cwd for one sandboxed spawn. */
export function planSandboxMounts(user: string, cwd: string | undefined, agentDir: string, homeVolume?: string, extraRoots: string[] = []): SandboxPlan {
  const mounts = discoverVolumeMounts();
  const home = process.env.HOME || '/home/autere';
  // HOME itself need not be volume-backed (e.g. the autere container mounts
  // only ~/.autere, ~/.pi, ~/.9router) — each dir the sandbox uses is
  // resolved against its own mount. homeM only anchors subpath math.
  const homeM = mounts.find((m) => m.target === home);
  const workBase = `${home}/work`;
  const out: SandboxMount[] = [];
  if (homeVolume) out.push({ volume: homeVolume, dst: home }); // parent; children below shadow it

  // Shared config/cache dirs at path-identical destinations (compose
  // contract): only the ones that are actually volume-backed here. Each
  // mounts by its own volume as a WHOLE (no subpath — these volumes are
  // dedicated to exactly these dirs, same as the compose example).
  for (const dir of SANDBOX_SHARED_DIRS) {
    if (out.some((m) => m.dst === `${home}/${dir}`)) continue; // already covered by the home volume
    const m = mounts.find((mm) => mm.target === `${home}/${dir}`);
    if (m) out.push({ volume: m.volume, dst: m.target });
  }
  const inside = (p: string, base: string) => p === base || p.startsWith(base.endsWith('/') ? base : base + '/');
  const rel = (p: string, base: string) => p.slice(base.replace(/\/$/, '').length + 1);

  // pi env dir (non-negotiable) + master npm (the env symlink target).
  // subpath is relative to the VOLUME ROOT, and the volume root maps to the
  // mount's own destination on the autere host — NOT to $HOME (e.g. the
  // image mounts autere-data at ~/.autere, so envDir's subpath is
  // 'pi-envs/admin', not '.autere/pi-envs/admin').
  const subOf = (p: string, m: { target: string }) => rel(p, m.target);
  const envM = mounts.find((m) => inside(agentDir, m.target));
  if (envM) {
    out.push({ volume: envM.volume, dst: agentDir, subpath: subOf(agentDir, envM) });
  } else {
    throw new Error(`pi sandbox not possible: the pi env dir (${agentDir}) is not inside a docker volume`);
  }
  const masterNpm = join(home, '.pi/agent/npm');
  if (existsSync(masterNpm)) {
    const npmM = mounts.find((m) => inside(masterNpm, m.target));
    if (npmM) out.push({ volume: npmM.volume, dst: masterNpm, subpath: subOf(masterNpm, npmM) });
  }
  // The 9router extension resolves its config via homedir() (no
  // PI_CODING_AGENT_DIR fallback), so the user's per-env 9router key rides
  // in at ~/.pi/agent/9router-config.json — a file, volume-subpath'd.
  const routerCfg = join(home, '.pi/agent/9router-config.json');
  if (existsSync(routerCfg)) {
    const cfgMount = mounts.find((m) => inside(routerCfg, m.target));
    if (cfgMount) out.push({ volume: cfgMount.volume, dst: routerCfg, subpath: subOf(routerCfg, cfgMount) });
  }

  // Work area: user's allowedDirs (or admin whole-home fallback).
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
  } else if (homeM && getUserRole(user) === 'admin') {
    // whole-home work area needs HOME to be volume-backed
    workRoots.push({ host: homeM.target, dst: `${workBase}/autere`, mount: { volume: homeM.volume, subpath: '' } });
  }
  // Per-session workdirs (New Session modal): mounted next to the std roots.
  for (const extra of extraRoots) {
    if (workRoots.some((w) => extra === w.host || extra.startsWith(w.host.endsWith('/') ? w.host : w.host + '/'))) continue;
    const b = mounts.find((m) => inside(extra, m.target));
    if (!b) continue;
    const name = extra.slice(extra.replace(/\/$/, '').lastIndexOf('/') + 1);
    workRoots.push({ host: extra.replace(/\/+$/, ''), dst: `${workBase}/${name}`, mount: { volume: b.volume, subpath: extra === b.target ? undefined : extra.slice(b.target.replace(/\/$/, '').length + 1) } });
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

/** Reverse of planSandboxMounts' cwd translation: map a sandbox work path
 *  (what sandboxed pi records as the session header cwd, e.g.
 *  $HOME/work/<name>) back to the host directory the root was mounted
 *  from. Returns null outside the work base or for unknown root names. */
export function sandboxWorkPathToHost(user: string, containerPath: string): string | null {
  const home = process.env.HOME || '/home/autere';
  const workBase = `${home}/work/`;
  if (!containerPath.startsWith(workBase)) return null;
  const rest = containerPath.slice(workBase.length);
  if (!rest || rest.includes('/')) return null; // root itself / deeper layout
  const name = rest;
  const dirs = getUserAllowedDirs(user).map((d) => d.path).filter((p): p is string => !!p);
  if (dirs.length) return dirs.find((d) => d.slice(d.replace(/\/$/, '').lastIndexOf('/') + 1) === name) || null;
  return getUserRole(user) === 'admin' ? home : null; // whole-home fallback
}

export function discoverVolumeMounts(): { volume: string; target: string }[] {
  // Prefer docker inspect: it gives both named volumes AND bind mounts with
  // the HOST source path (binds are invisible as host paths in
  // /proc/self/mountinfo — it only shows the source device). The sandbox
  // re-mounts entries by name (volume) or host source path (bind).
  try {
    const raw = execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', process.env.HOSTNAME || 'self'], { encoding: 'utf-8', timeout: 5000 });
    const parsed = JSON.parse(raw) as { Type: string; Name?: string; Source?: string; Destination: string }[];
    const out = parsed
      .filter((m) => m.Destination && (m.Type === 'volume' ? !!m.Name : m.Type === 'bind' ? !!m.Source : false))
      .map((m) => ({ volume: (m.Type === 'volume' ? m.Name : m.Source)!, target: m.Destination }));
    if (out.length) return out.sort((a, b) => a.target.length - b.target.length);
  } catch { /* docker unreachable — fall back to mountinfo */ }
  // Fallback: named volumes only (no docker API available — sandbox cannot
  // see bind mounts in this mode).
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
