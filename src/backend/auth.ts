/**
 * Auth module — manages tokens, users, passwords, and role-based access.
 *
 * Roles form a hierarchy: chat < control < admin.
 * - chat: converse and view (send/abort/compact/switch sessions, read state)
 * - control: everything except restarting autere itself (settings, personas
 *   library, scheduled tasks, session deletion)
 * - admin: everything, including /api/restart-backend
 *
 * The admin account is bootstrapped from AUTERE_ADMIN_USER /
 * AUTERE_ADMIN_PASSWORD (defaults "admin"/"admin"); the legacy shared
 * "user" account (monitor password) maps to "control" and only exists when
 * a monitor password is configured.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { AUTH_TOKENS_FILE, AUTH_TOKEN_EXPIRY_MS } from './constants.js';
import { log } from './logger.js';
import { getPiEnvDir } from './pi-env.js';
import { parseCookies } from '../shared/format.js';
import {
  initUserRegistry,
  isRegisteredUser as registryHasUser,
  getUserRole as registryUserRole,
  verifyUser,
  getMustChangePassword,
  type Role,
} from './users.js';

export { parseCookies };
export type { Role } from './users.js';

// ── Auth state ──

interface TokenEntry {
  expiry: number;
  user: string;
}

const ROLE_LEVEL: Record<Role, number> = { chat: 1, control: 2, admin: 3 };

let authTokens: Map<string, TokenEntry> = new Map();
let authEnabled = true;
let authPassword = '';

// ── Token management ──

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto !== 'undefined') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function loadAuthTokens() {
  try {
    if (existsSync(AUTH_TOKENS_FILE)) {
      const raw = JSON.parse(readFileSync(AUTH_TOKENS_FILE, 'utf-8'));
      authTokens = new Map();
      for (const [token, entry] of Object.entries(raw)) {
        const e = entry as any;
        // Support old format (number) by migrating to new format
        if (typeof e === 'number') {
          authTokens.set(token, { expiry: e, user: 'admin' });
        } else if (e && typeof e === 'object' && typeof e.expiry === 'number') {
          authTokens.set(token, { expiry: e.expiry, user: e.user || 'admin' });
        }
      }
      // Prune expired tokens
      const now = Date.now();
      for (const [token, entry] of authTokens) {
        if (entry.expiry < now) authTokens.delete(token);
      }
      saveAuthTokens();
    }
  } catch (err) {
    log.auth.error('Failed to load auth tokens:', err);
    authTokens = new Map();
  }
}

export function saveAuthTokens() {
  try {
    const dir = dirname(AUTH_TOKENS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = Object.fromEntries(
      [...authTokens.entries()].map(([token, entry]) => [token, { expiry: entry.expiry, user: entry.user }])
    );
    const tmp = join(dir, `.auth-tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    renameSync(tmp, AUTH_TOKENS_FILE);
  } catch (err) {
    log.auth.error('Failed to save auth tokens:', err);
  }
}

// ── Token lookup ──

function findValidToken(req: IncomingMessage): TokenEntry | null {
  const now = Date.now();
  // Check cookie
  const cookies = parseCookies(req.headers.cookie || '');
  const cookieToken = cookies['autere-token'];
  if (cookieToken) {
    const entry = authTokens.get(cookieToken);
    if (entry && entry.expiry > now) return entry;
  }
  // Check Authorization header
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const entry = authTokens.get(token);
    if (entry && entry.expiry > now) return entry;
  }
  return null;
}

// ── Auth checking ──

export function checkAuth(req: IncomingMessage): boolean {
  if (!authEnabled) return true;
  return findValidToken(req) !== null;
}

/** Get the auth token from the request, or null */
export function getTokenFromRequest(req: IncomingMessage): string | null {
  if (!authEnabled) return 'noauth'; // single session when auth is disabled
  const cookies = parseCookies(req.headers.cookie || '');
  const cookieToken = cookies['autere-token'];
  if (cookieToken && findValidToken(req)) return cookieToken;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && findValidToken(req)) return auth.slice(7);
  return null;
}

/** Get the authenticated user from the request, or null */
export function getUser(req: IncomingMessage): string | null {
  if (!authEnabled) return 'admin'; // default user when auth is disabled
  const entry = findValidToken(req);
  return entry?.user || null;
}

/** Whether the user exists in the user registry (file-backed, see users.ts) */
export function isRegisteredUser(user: string): boolean {
  return registryHasUser(user);
}

/** Get the role for a user */
export function getUserRole(user: string): Role {
  return registryUserRole(user);
}

/** Whether the user must change their password before using the dashboard */
export function userMustChangePassword(user: string): boolean {
  return getMustChangePassword(user);
}

/** Whether the user's role satisfies the required level (chat < control < admin) */
export function hasRole(user: string, role: Role): boolean {
  return (ROLE_LEVEL[getUserRole(user)] ?? 0) >= (ROLE_LEVEL[role] ?? 99);
}

/** Verify a login attempt against the user registry */
export function verifyCredentials(user: string, password: string): boolean {
  return verifyUser(user, password);
}

/**
 * Minimum role required for an API call. Everything not listed is chat-level
 * (conversing and viewing); global/config mutations need control, restarting
 * autere itself needs admin.
 */
const CONTROL_ROUTES = new Set([
  'POST /api/settings',
  'POST /api/personas',
  'POST /api/personas/delete',
  'POST /api/personas/generate',
  'POST /api/scheduler/tasks',
  'DELETE /api/scheduler/tasks', // prefix: task ids follow in the path
  'POST /api/sessions/delete',
  'POST /api/extensions/packages',
]);

const ADMIN_ROUTES = new Set([
  'POST /api/restart-backend',
  'GET /api/users',
  'POST /api/users',
]);

export function requiredRole(method: string, pathname: string): Role {
  const key = `${method} ${pathname}`;
  if (ADMIN_ROUTES.has(key)) return 'admin';
  if (CONTROL_ROUTES.has(key)) return 'control';
  if (pathname.startsWith('/api/scheduler/tasks/') && method === 'DELETE') return 'control';
  // File browser mutations — paths are additionally restricted to the
  // user's allowedDirs inside the handlers (files.ts)
  if (pathname.startsWith('/api/browse/') && method === 'POST') return 'control';
  // /api/users/<name> update (POST) and delete (DELETE) — admin
  if (pathname.startsWith('/api/users/')) return 'admin';
  return 'chat';
}

export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (checkAuth(req)) return false;
  const data = JSON.stringify({ success: false, error: 'Unauthorized' });
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(data);
  return true;
}

// ── Auth init ──

export function resolveAuth(pi: { getFlag: (name: string) => any }) {
  authEnabled = pi.getFlag('monitor-auth') as boolean;
  authPassword = (pi.getFlag('monitor-password') as string) || process.env.PI_MONITOR_PASSWORD || '';

  // Admin account: AUTERE_ADMIN_* overrides, then the monitor password for
  // back-compat with existing deployments, then the documented default.
  const adminName = process.env.AUTERE_ADMIN_USER || 'admin';
  const adminPassword = process.env.AUTERE_ADMIN_PASSWORD || authPassword || 'admin';
  // File-backed registry seeds from env on FIRST start; afterwards the file
  // is authoritative (env password changes do not reset stored accounts).
  initUserRegistry({ adminName, adminPassword, monitorPassword: authPassword });
  if (authEnabled) {
    if (!process.env.AUTERE_ADMIN_PASSWORD && !authPassword) {
      log.auth.warn('No AUTERE_ADMIN_PASSWORD / monitor password configured — admin password defaults to "admin"');
    }
  }
  loadAuthTokens();
  if (!authEnabled) {
    log.auth.info('Authentication disabled (--monitor-auth false)');
  }
}

// ── Auth status ──

export function getAuthEnabled(): boolean {
  return authEnabled;
}

/** Remove and return all tokens belonging to a user (invalidates their sessions) */
export function removeUserTokens(user: string): string[] {
  const removed: string[] = [];
  for (const [token, entry] of authTokens) {
    if (entry.user === user) {
      authTokens.delete(token);
      removed.push(token);
    }
  }
  if (removed.length > 0) saveAuthTokens();
  return removed;
}

/** Add auth token for a user */
export function addAuthToken(token: string, user: string) {
  authTokens.set(token, { expiry: Date.now() + AUTH_TOKEN_EXPIRY_MS, user });
}

export function removeAuthToken(token: string) {
  authTokens.delete(token);
}

export function getAuthTokenExpiry(): number {
  return AUTH_TOKEN_EXPIRY_MS;
}

export function getAuthPassword(): string {
  return authPassword;
}
// ── Last session per user+token (each login session tracks its own) ──
// Stored INSIDE the user's pi environment so it is automatically scoped:
// another user (or an isolated e2e env) can never see, resume, or corrupt
// another environment's last-session pointer. The previous global
// ~/.autere/monitor-last-session.json leaked exactly that way — an e2e
// backend resolved the real admin's last session and resumed it.

function lastSessionFile(user: string): string {
  return join(getPiEnvDir(user), 'last-session.json');
}

export function getLastSession(user: string, token: string): string | null {
  try {
    const file = lastSessionFile(user);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const entry = data[token] || null;
      if (typeof entry !== 'string') return null;
      // Defense in depth: only ever resume sessions that live in THIS
      // user's env — a stale/corrupted/global pointer is ignored.
      const envSessions = join(getPiEnvDir(user), 'sessions');
      if (!entry.startsWith(envSessions)) return null;
      return entry;
    }
  } catch {}
  return null;
}

export function setLastSession(user: string, token: string, sessionFile: string): void {
  try {
    const file = lastSessionFile(user);
    let data: Record<string, string> = {};
    if (existsSync(file)) {
      data = JSON.parse(readFileSync(file, 'utf-8'));
    }
    data[token] = sessionFile;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.last-session-tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    log.auth.error('Failed to save last session:', err);
  }
}
