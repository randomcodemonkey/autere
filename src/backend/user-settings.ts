/**
 * User-scoped settings.
 *
 * Reads/writes settings per user in ~/.autere/users/{user}/settings.json.
 * Falls back to global pi settings and env variables.
 *
 * Resolution order for reads:
 * 1. ~/.autere/users/{user}/settings.json
 * 2. Environment variable (UPPER_SNAKE_CASE)
 * 3. INITIAL_PASSWORD env var (for9router dashboard password)
 * 4. ~/.pi/agent/settings.json (global pi settings)
 * 5. ~/.pi/agent/{extensionId}-config.json (extension configs)
 * 6. Default value
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { USER_SETTINGS_DIR, PI_DIR } from './constants.js';

interface UserSettings {
  [key: string]: any;
}

// ── Settings schema types ──

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'toggle' | 'select' | 'list';
  placeholder?: string;
  options?: { value: string; label: string }[];
  description?: string;
  listPlaceholder?: string;
  listAddLabel?: string;
}

export interface SettingSection {
  id: string;
  label: string;
  fields: SettingField[];
}

// ── Cache ──

const settingsCache = new Map<string, { data: any; mtime: number }>();

function readJsonCached(filePath: string): any | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    const cached = settingsCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    settingsCache.set(filePath, { data, mtime: stat.mtimeMs });
    return data;
  } catch (err) {
    console.error(`[autere] readJsonCached(${filePath}) failed:`, err);
    return null;
  }
}

function invalidateCache(filePath: string) {
  settingsCache.delete(filePath);
}

// ── User settings file paths ──

function getUserSettingsPath(user: string): string {
  return join(USER_SETTINGS_DIR, user, 'settings.json');
}

function readUserSettingsFile(user: string): UserSettings {
  const filePath = getUserSettingsPath(user);
  return readJsonCached(filePath) || {};
}

function writeUserSettingsFile(user: string, settings: UserSettings): void {
  const filePath = getUserSettingsPath(user);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.settings-tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
  renameSync(tmp, filePath);
  invalidateCache(filePath);
}

// ── Get a user-scoped setting ──

export function getUserSetting(user: string, key: string, defaultValue?: any): any {
  // 1. Per-user settings file
  const userSettings = readUserSettingsFile(user);
  if (key in userSettings) return userSettings[key];

  // 2. Env var (camelCase → UPPER_SNAKE_CASE)
  const envKey = key.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');
  if (process.env[envKey] !== undefined) return process.env[envKey];

  // 3. INITIAL_PASSWORD fallback
  if (key === 'nineRouterPassword' && process.env.INITIAL_PASSWORD) {
    return process.env.INITIAL_PASSWORD;
  }

  // 4. Global pi settings.json
  const piSettingsPath = join(PI_DIR, 'settings.json');
  const piSettings = readJsonCached(piSettingsPath);
  if (piSettings && key in piSettings) return piSettings[key];

  // 5. Extension config files
  const extConfigPath = join(PI_DIR, `${key.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')}-config.json`);
  const extConfig = readJsonCached(extConfigPath);
  if (extConfig) return extConfig;

  return defaultValue;
}

// ── Get all user settings (merged with defaults) ──

export function getAllUserSettings(user: string): UserSettings {
  const userSettings = readUserSettingsFile(user);
  const defaults = getUserSettingsDefaults(user);
  return { ...defaults, ...userSettings };
}

// ── Save user settings ──

export function saveUserSettings(user: string, settings: UserSettings): void {
  writeUserSettingsFile(user, settings);
}

// ── Settings schema (based on enabled extensions) ──

function getPiConfig(filename: string): Record<string, any> | null {
  return readJsonCached(join(PI_DIR, filename));
}

function getUserSettingsDefaults(user: string): UserSettings {
  const defaults: UserSettings = {};

  // 9router settings (always available)
  const nineRouterConfig = getPiConfig('9router-config.json');
  defaults.nineRouterBaseUrl = nineRouterConfig?.baseUrl || '';
  defaults.nineRouterApiKey = nineRouterConfig?.apiKey || '';
  defaults.nineRouterPassword = process.env.INITIAL_PASSWORD || '';
  defaults.nineRouterEnableReasoning = nineRouterConfig?.enableReasoning ?? false;

  // Pi settings defaults
  defaults.enabledModels = readJsonCached(join(PI_DIR, 'settings.json'))?.enabledModels || [];
  defaults.packages = readJsonCached(join(PI_DIR, 'settings.json'))?.packages || [];

  return defaults;
}

/**
 * Get the settings schema for a user, based on their enabled extensions.
 * The backend decides what settings are relevant; the frontend just renders them.
 */
export function getUserSettingsSchema(user: string): SettingSection[] {
  const sections: SettingSection[] = [];

  // Always include 9router settings if the extension is enabled
  const packages = getUserSetting(user, 'packages', []) as string[];
  const has9Router = packages.some((p: string) => p.includes('9router'));

  if (has9Router) {
    sections.push({
      id: 'nineRouter',
      label: '9Router',
      fields: [
        {
          key: 'nineRouterBaseUrl',
          label: 'Base URL',
          type: 'text',
          placeholder: 'http://localhost:20128',
          description: 'The URL of your 9router instance',
        },
        {
          key: 'nineRouterApiKey',
          label: 'API Key',
          type: 'password',
          placeholder: 'sk-...',
          description: 'API key for authenticating with 9router',
        },
        {
          key: 'nineRouterPassword',
          label: 'Dashboard Password',
          type: 'password',
          placeholder: '••••••••',
          description: 'Password for the 9router web dashboard',
        },
        {
          key: 'nineRouterEnableReasoning',
          label: 'Enable Reasoning',
          type: 'toggle',
          description: 'Enable reasoning/thinking mode for supported models',
        },
      ],
    });
  }

  // Model settings (always available)
  sections.push({
    id: 'models',
    label: 'Models',
    fields: [
      {
        key: 'enabledModels',
        label: 'Enabled Models',
        type: 'list',
        description: 'Models available for selection (provider/model). Drag to reorder priority.',
        listPlaceholder: 'e.g. anthropic/claude-sonnet-4-20250514',
        listAddLabel: 'Add Model',
      },
    ],
  });

  return sections;
}
