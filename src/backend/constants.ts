import { join } from 'path';
import { homedir } from 'os';

export const PI_DIR = join(homedir(), '.pi', 'agent');
export const AUTERE_DIR = join(homedir(), '.autere');
export const AUTH_TOKENS_FILE = join(AUTERE_DIR, 'monitor-auth-tokens.json');
export const AUTH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Admin-managed user registry (overridable for e2e isolation)
export const USERS_FILE = process.env.AUTERE_USERS_FILE || join(AUTERE_DIR, 'monitor-users.json');

// Paths used for extension discovery
export const SETTINGS_FILE = join(PI_DIR, 'settings.json');
export const NPM_EXTENSIONS_DIR = join(PI_DIR, 'npm', 'node_modules');
export const EXTENSIONS_DIR = join(PI_DIR, 'extensions');
export const USER_SETTINGS_DIR = join(AUTERE_DIR, 'users');