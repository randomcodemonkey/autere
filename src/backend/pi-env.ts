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

import { existsSync, mkdirSync, readdirSync, copyFileSync, symlinkSync, lstatSync } from 'fs';
import { join } from 'path';
import { PI_DIR, AUTERE_DIR } from './constants.js';
import { log } from './logger.js';
import { sanitizeUserName } from '../shared/format.js';

/** Directories to share via symlink (heavy, read-mostly) */
const SHARED_DIRS = ['npm', 'extensions', 'skills', 'themes', 'bin', 'tmp'];

/** Files copied into each user environment on first use */
const SEED_FILES = ['settings.json', 'auth.json', 'models-store.json'];

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
