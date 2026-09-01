/**
 * Auth module — manages tokens, users, and passwords.
 *
 * Each token maps to a user. For now only "admin" is supported.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { AUTH_TOKENS_FILE, AUTH_TOKEN_EXPIRY_MS } from './constants.js';
import { log } from './logger.js';
import { parseCookies } from '../shared/format.js';

export { parseCookies };

// ── Auth state ──

interface TokenEntry {
  expiry: number;
  user: string;
}

interface UserEntry {
  password: string;
  role: string;
}

// User registry — for now only admin is supported
const users: Record<string, UserEntry> = {
  admin: { password: '', role: 'admin' }, // password set at init
  user: { password: '', role: 'user' },   // normal (non-admin) user, same password
};

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

/** Whether the user exists in the user registry */
export function isRegisteredUser(user: string): boolean {
  return user in users;
}

/** Get the role for a user */
export function getUserRole(user: string): string {
  return users[user]?.role || 'user';
}

/** Check if a user has a specific role */
export function hasRole(user: string, role: string): boolean {
  return getUserRole(user) === role;
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
  if (authEnabled && !authPassword) {
    throw new Error('[autere] Authentication is enabled but no password was provided. Set --monitor-password or PI_MONITOR_PASSWORD environment variable, or disable with --monitor-auth false');
  }
  // Set passwords (all accounts share the configured password for now)
  for (const u of Object.values(users)) u.password = authPassword;
  loadAuthTokens();
  if (!authEnabled) {
    log.auth.info('Authentication disabled (--monitor-auth false)');
  }
}

// ── Auth status ──

export function getAuthEnabled(): boolean {
  return authEnabled;
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

// ── Last session per token (each login session tracks its own) ──

const LAST_SESSION_FILE = join(homedir(), '.autere', 'monitor-last-session.json');

export function getLastSession(token: string): string | null {
  try {
    if (existsSync(LAST_SESSION_FILE)) {
      const data = JSON.parse(readFileSync(LAST_SESSION_FILE, 'utf-8'));
      return data[token] || null;
    }
  } catch {}
  return null;
}

export function setLastSession(token: string, sessionFile: string): void {
  try {
    let data: Record<string, string> = {};
    if (existsSync(LAST_SESSION_FILE)) {
      data = JSON.parse(readFileSync(LAST_SESSION_FILE, 'utf-8'));
    }
    data[token] = sessionFile;
    const dir = dirname(LAST_SESSION_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.last-session-tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, LAST_SESSION_FILE);
  } catch (err) {
    log.auth.error('Failed to save last session:', err);
  }
}
