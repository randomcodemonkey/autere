import { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { AUTH_TOKENS_FILE, AUTH_TOKEN_EXPIRY_MS } from './constants.js';

// ── Auth state ──

let authTokens: Map<string, number> = new Map();
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
      const data = JSON.parse(readFileSync(AUTH_TOKENS_FILE, 'utf-8'));
      authTokens = new Map(Object.entries(data).map(([k, v]) => [k, v as number]));
      // Prune expired tokens
      const now = Date.now();
      for (const [token, expiry] of authTokens) {
        if (expiry < now) authTokens.delete(token);
      }
      saveAuthTokens();
    }
  } catch (err) {
    console.error('[autere] Failed to load auth tokens:', err);
    authTokens = new Map();
  }
}

export function saveAuthTokens() {
  try {
    const dir = dirname(AUTH_TOKENS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(Object.fromEntries(authTokens)), 'utf-8');
  } catch (err) {
    console.error('[autere] Failed to save auth tokens:', err);
  }
}

// ── Cookie parsing ──

export function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [key, ...val] = part.split('=');
    if (key) cookies[key.trim()] = val.join('=').trim();
  }
  return cookies;
}

// ── Auth checking ──

export function checkAuth(req: IncomingMessage): boolean {
  if (!authEnabled) return true;
  const now = Date.now();
  // Check cookie
  const cookies = parseCookies(req.headers.cookie || '');
  const cookieToken = cookies['autere-token'];
  if (cookieToken && authTokens.has(cookieToken) && (authTokens.get(cookieToken) || 0) > now) return true;
  // Check Authorization header
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (authTokens.has(token) && (authTokens.get(token) || 0) > now) return true;
  }
  return false;
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
  loadAuthTokens();
  if (!authEnabled) {
    console.log('[autere] Authentication disabled (--monitor-auth false)');
  }
}

// ── Auth status ──

export function getAuthEnabled(): boolean {
  return authEnabled;
}

export function addAuthToken(token: string) {
  authTokens.set(token, Date.now() + AUTH_TOKEN_EXPIRY_MS);
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
