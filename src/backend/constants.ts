import { join, resolve } from 'path';
import { homedir } from 'os';

export const PI_DIR = join(homedir(), '.pi', 'agent');

// Root for all autere state (auth tokens, users, per-user settings,
// deleted sessions). Overridable so isolated test/sandbox runs never touch
// the shared ~/.autere.
export const AUTERE_DIR = process.env.AUTERE_DIR
  ? resolve(process.env.AUTERE_DIR)
  : join(homedir(), '.autere');
export const AUTH_TOKENS_FILE = join(AUTERE_DIR, 'autere-auth-tokens.json');
export const AUTH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Admin-managed user registry (overridable for e2e isolation)
export const USERS_FILE = process.env.AUTERE_USERS_FILE || join(AUTERE_DIR, 'autere-users.json');

// Paths used for extension discovery
export const SETTINGS_FILE = join(PI_DIR, 'settings.json');
export const NPM_EXTENSIONS_DIR = join(PI_DIR, 'npm', 'node_modules');
export const EXTENSIONS_DIR = join(PI_DIR, 'extensions');
export const USER_SETTINGS_DIR = join(AUTERE_DIR, 'users');