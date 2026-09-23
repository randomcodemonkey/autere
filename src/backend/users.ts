/**
 * File-backed user registry for autere.
 *
 * Stores accounts (username, scrypt password hash, role, forced password
 * change flag, allowed directories) in a single JSON file so the admin UI
 * can manage users. Deliberately the same shape a future sqlite table would
 * have — the CRUD surface here is the only thing that needs to change when
 * users move to a database.
 *
 * The registry is SEEDED ONCE from the environment (AUTERE_ADMIN_* / monitor
 * password) when the file does not exist. After that the file is
 * authoritative: env password changes no longer reset stored accounts
 * (delete the file to re-seed).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { USERS_FILE } from './constants.js';
import { log } from './logger.js';
import { sanitizeUserName } from '../shared/format.js';

export type Role = 'chat' | 'control' | 'admin';
export const ROLES: Role[] = ['chat', 'control', 'admin'];
export type DirAccess = 'read' | 'rw';

export interface AllowedDir {
  path: string;
  access: DirAccess;
}

interface StoredUser {
  passwordHash: string;
  role: Role;
  mustChangePassword: boolean;
  allowedDirs: AllowedDir[];
}

export interface PublicUser {
  username: string;
  role: Role;
  mustChangePassword: boolean;
  allowedDirs: AllowedDir[];
}

const registry: Record<string, StoredUser> = {};

// ── Password hashing (node stdlib scrypt) ──

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `s2:${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 's2') return false;
  const [, salt, hash] = parts;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ── Persistence ──

function saveRegistry() {
  try {
    const dir = dirname(USERS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.users-tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf-8');
    renameSync(tmp, USERS_FILE);
  } catch (err) {
    log.auth.error('Failed to save users registry:', err);
  }
}

export interface UserRegistrySeed {
  adminName: string;
  adminPassword: string;
  monitorPassword: string;
}

export function initUserRegistry(seed: UserRegistrySeed) {
  try {
    if (existsSync(USERS_FILE)) {
      const raw = JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
      for (const [name, entry] of Object.entries(raw)) {
        const u = entry as any;
        if (u && typeof u.passwordHash === 'string') {
          registry[name] = {
            passwordHash: u.passwordHash,
            role: ROLES.includes(u.role) ? u.role : 'chat',
            mustChangePassword: !!u.mustChangePassword,
            allowedDirs: Array.isArray(u.allowedDirs) ? u.allowedDirs : [],
          };
        }
      }
      return;
    }
  } catch (err) {
    log.auth.error('Failed to load users registry, starting from env seed:', err);
  }
  // First start: seed from env (plaintext passwords → hashed)
  registry[seed.adminName] = {
    passwordHash: hashPassword(seed.adminPassword),
    role: 'admin',
    mustChangePassword: false,
    allowedDirs: [],
  };
  if (seed.monitorPassword && !registry['user']) {
    registry['user'] = {
      passwordHash: hashPassword(seed.monitorPassword),
      role: 'control',
      mustChangePassword: false,
      allowedDirs: [],
    };
  }
  saveRegistry();
}

// ── Lookups (used by auth.ts) ──

export function isRegisteredUser(user: string): boolean {
  return user in registry;
}

export function getUserRole(user: string): Role {
  return registry[user]?.role ?? 'chat';
}

export function verifyUser(user: string, password: string): boolean {
  const entry = registry[user];
  return !!entry && verifyPassword(password, entry.passwordHash);
}

export function getMustChangePassword(user: string): boolean {
  return !!registry[user]?.mustChangePassword;
}

/** The user's admin-managed allowed directories (file browser roots) */
export function getUserAllowedDirs(user: string): AllowedDir[] {
  return (registry[user]?.allowedDirs ?? []).map((d) => ({ ...d }));
}

// ── Validation ──

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string' || !USERNAME_RE.test(username) || sanitizeUserName(username) !== username) {
    return 'Username must be 2-32 chars: letters, digits, . _ - (must start alphanumeric)';
  }
  return null;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  return null;
}

export function validateAllowedDirs(input: unknown): { error?: string; dirs?: AllowedDir[] } {
  if (input === undefined || input === null) return { dirs: [] };
  if (!Array.isArray(input)) return { error: 'allowedDirs must be an array' };
  if (input.length > 50) return { error: 'Too many directories (max 50)' };
  const seen = new Set<string>();
  const dirs: AllowedDir[] = [];
  for (const d of input) {
    const path = typeof d?.path === 'string' ? d.path.trim().replace(/\/+$/, '') : '';
    if (!path || !path.startsWith('/')) {
      return { error: 'Directory paths must be absolute' };
    }
    if (path.length > 4096 || path.includes('\0')) {
      return { error: 'Invalid directory path' };
    }
    const access: DirAccess = d.access === 'rw' ? 'rw' : 'read';
    if (seen.has(path)) continue;
    seen.add(path);
    dirs.push({ path, access });
  }
  return { dirs };
}

function toPublic(name: string): PublicUser {
  const u = registry[name];
  return {
    username: name,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    allowedDirs: u.allowedDirs.map((d) => ({ ...d })),
  };
}

export function listUsers(): PublicUser[] {
  return Object.keys(registry).sort().map(toPublic);
}

/** Admin guards: last-admin and self protections shared by update/delete */
function guardAdminRemoval(actor: string, name: string, removingAdmin: boolean): string | null {
  const admins = Object.keys(registry).filter((u) => registry[u].role === 'admin');
  if (removingAdmin && admins.length <= 1 && admins.includes(name)) {
    return 'Cannot remove the last admin account';
  }
  return null;
}

/** Create a user. Returns an error message, or null on success. */
export function createUser(input: {
  username: unknown; password: unknown; role: unknown; allowedDirs: unknown;
  mustChangePassword?: unknown;
}): string | null {
  const err = validateUsername(input.username);
  if (err) return err;
  const name = input.username as string;
  if (registry[name]) return 'User already exists';
  const pwErr = validatePassword(input.password);
  if (pwErr) return pwErr;
  const role: Role = ROLES.includes(input.role as Role) ? (input.role as Role) : 'chat';
  const dirs = validateAllowedDirs(input.allowedDirs);
  if (dirs.error) return dirs.error;
  registry[name] = {
    passwordHash: hashPassword(input.password as string),
    role,
    mustChangePassword: input.mustChangePassword !== false,
    allowedDirs: dirs.dirs!,
  };
  saveRegistry();
  return null;
}

/**
 * Update a user (role / allowedDirs / optional new password). The actor
 * (requesting admin) enables self-protection rules. Returns error or null.
 */
export function updateUser(actor: string, username: string, patch: {
  role?: unknown; allowedDirs?: unknown; password?: unknown; mustChangePassword?: unknown;
}): string | null {
  const entry = registry[username];
  if (!entry) return 'User not found';

  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role as Role)) return 'Invalid role';
    // Last-admin guard: demoting the last admin would lock everyone out.
    const demotingAdmin = entry.role === 'admin' && patch.role !== 'admin';
    if (demotingAdmin) {
      const gErr = guardAdminRemoval(actor, username, true);
      if (gErr) return gErr;
    }
  }
  if (patch.password !== undefined) {
    const pwErr = validatePassword(patch.password);
    if (pwErr) return pwErr;
  }
  let dirs: AllowedDir[] | undefined;
  if (patch.allowedDirs !== undefined) {
    const d = validateAllowedDirs(patch.allowedDirs);
    if (d.error) return d.error;
    dirs = d.dirs;
  }

  if (patch.role !== undefined) entry.role = patch.role as Role;
  if (dirs !== undefined) entry.allowedDirs = dirs;
  if (patch.password !== undefined) {
    entry.passwordHash = hashPassword(patch.password as string);
    // Admin-set passwords force a change on next login, unless explicitly off.
    entry.mustChangePassword = patch.mustChangePassword !== false;
  } else if (patch.mustChangePassword !== undefined) {
    entry.mustChangePassword = !!patch.mustChangePassword;
  }
  saveRegistry();
  return null;
}

/** Delete a user. Returns error or null. */
export function deleteUser(actor: string, username: string): string | null {
  const entry = registry[username];
  if (!entry) return 'User not found';
  if (actor === username) return 'Cannot delete your own account';
  const gErr = guardAdminRemoval(actor, username, entry.role === 'admin');
  if (gErr) return gErr;
  delete registry[username];
  saveRegistry();
  return null;
}

/** Change own password (also satisfies the forced-change-on-first-login flag). */
export function changeOwnPassword(username: string, oldPassword: string, newPassword: string): string | null {
  const entry = registry[username];
  if (!entry) return 'User not found';
  if (!verifyUser(username, oldPassword)) return 'Current password is incorrect';
  const pwErr = validatePassword(newPassword);
  if (pwErr) return pwErr;
  entry.passwordHash = hashPassword(newPassword);
  entry.mustChangePassword = false;
  saveRegistry();
  return null;
}