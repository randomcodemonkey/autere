/**
 * User-scoped settings.
 *
 * Reads settings per user, falling back to env variables.
 * Structure is ready for per-user settings files in ~/.pi/agent/users/{user}/settings.json.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { USER_SETTINGS_DIR } from './constants.js';

interface UserSettings {
  [key: string]: any;
}

/**
 * Read a user-scoped setting.
 *
 * Resolution order:
 * 1. ~/.autere/users/{user}/settings.json (per-user file, when implemented)
 * 2. Environment variable (uppercase, underscores): e.g. key "nineRouterPassword" → NINE_ROUTER_PASSWORD
 * 3. INITIAL_PASSWORD env var (fallback for9router dashboard password)
 * 4. Default value
 */
export function getUserSetting(user: string, key: string, defaultValue?: any): any {
  // 1. Check per-user settings file (future)
  const userSettingsFile = join(USER_SETTINGS_DIR, user, 'settings.json');
  if (existsSync(userSettingsFile)) {
    try {
      const settings: UserSettings = JSON.parse(readFileSync(userSettingsFile, 'utf-8'));
      if (key in settings) return settings[key];
    } catch {}
  }

  // 2. Check env var with conventional naming: camelCase → UPPER_SNAKE_CASE
  const envKey = key.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');
  if (process.env[envKey] !== undefined) return process.env[envKey];

  // 3. INITIAL_PASSWORD fallback (for9router dashboard password)
  if (key === 'nineRouterPassword' && process.env.INITIAL_PASSWORD) {
    return process.env.INITIAL_PASSWORD;
  }

  return defaultValue;
}
