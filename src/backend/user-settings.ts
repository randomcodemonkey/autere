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
import { getPiEnvDir, ensurePiEnv } from './pi-env.js';
import { isPiImagesInstalled } from './image-models.js';
import { log } from './logger.js';

interface UserSettings {
  [key: string]: any;
}

// ── Settings schema types ──

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'toggle' | 'select' | 'list' | 'packages';
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
    log.settings.error(`readJsonCached(${filePath}) failed:`, err);
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
  applySettingsToPiEnv(user, settings);
}

/**
 * Merge a single key into the user's settings file without overwriting
 * the rest (unlike saveUserSettings, which replaces the whole file).
 */
export function setUserSetting(user: string, key: string, value: any): void {
  const current = readUserSettingsFile(user);
  writeUserSettingsFile(user, { ...current, [key]: value });
}

/**
 * Write user settings through to the per-user pi environment so the
 * user's pi process picks them up. The env dir is seeded from the global
 * ~/.pi/agent on first use; this overrides the seeded defaults per user.
 */
function applySettingsToPiEnv(user: string, settings: UserSettings): void {
  const envDir = ensurePiEnv(user);

  try {
    // Merge model/package settings into the env's settings.json
    const piSettingsPath = join(envDir, 'settings.json');
    let piSettings: UserSettings = {};
    if (existsSync(piSettingsPath)) {
      try { piSettings = JSON.parse(readFileSync(piSettingsPath, 'utf-8')); } catch {}
    }
    let piSettingsChanged = false;
    if ('enabledModels' in settings) {
      piSettings.enabledModels = settings.enabledModels;
      piSettingsChanged = true;
    }
    if ('packages' in settings) {
      piSettings.packages = settings.packages;
      piSettingsChanged = true;
    }
    if (piSettingsChanged) {
      const tmp = join(envDir, `.settings-tmp-${randomUUID()}`);
      writeFileSync(tmp, JSON.stringify(piSettings, null, 2), 'utf-8');
      renameSync(tmp, piSettingsPath);
      invalidateCache(piSettingsPath);
    }

    // Write 9router settings into the env's 9router-config.json
    const nineRouterKeys = ['nineRouterBaseUrl', 'nineRouterApiKey', 'nineRouterPassword', 'nineRouterEnableReasoning'];
    const present = nineRouterKeys.filter(k => k in settings);
    if (present.length > 0) {
      const configPath = join(envDir, '9router-config.json');
      let config: UserSettings = {};
      if (existsSync(configPath)) {
        try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
      }
      if ('nineRouterBaseUrl' in settings) config.baseUrl = settings.nineRouterBaseUrl;
      if ('nineRouterApiKey' in settings) config.apiKey = settings.nineRouterApiKey;
      if ('nineRouterPassword' in settings) config.password = settings.nineRouterPassword;
      if ('nineRouterEnableReasoning' in settings) config.enableReasoning = settings.nineRouterEnableReasoning;
      const tmp = join(envDir, `.9router-config-tmp-${randomUUID()}`);
      writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
      renameSync(tmp, configPath);
      invalidateCache(configPath);
    }
    // Write pi-images image model selection into the env's 9router-config.json
    if ('imageModel' in settings) {
      const configPath = join(envDir, '9router-config.json');
      let config: UserSettings = {};
      if (existsSync(configPath)) {
        try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
      }
      config.imageModel = settings.imageModel || '';
      const tmp = join(envDir, `.9router-config-tmp-${randomUUID()}`);
      writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
      renameSync(tmp, configPath);
      invalidateCache(configPath);
    }
  } catch (err) {
    log.settings.error(`Failed to apply settings to pi env for user "${user}":`, err);
  }
}

/**
 * Chat history limit (messages kept in the buffer and shown in the chat).
 * Stored as the user setting 'historyLimit'; clamped to 10-500, default 50.
 * Snapshot per UserSession construction — settings saves restart the pi
 * process, so a new session picks up the new value.
 */
export function getHistoryLimit(user: string): number {
  const raw = getUserSetting(user, 'historyLimit', 50);
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(500, Math.max(10, Math.floor(n)));
}

/**
 * Extensions ("packages") installed in the master pi environment — from
 * ~/.pi/agent/settings.json. Installing a new extension with pi adds it here;
 * these are offered in the Settings view as available to enable.
 */
export function getAvailablePackages(): string[] {
  return readJsonCached(join(PI_DIR, 'settings.json'))?.packages || [];
}

/**
 * Extensions enabled for a user — the per-user pi env's settings.json
 * 'packages' (e.g. ~/.autere/pi-envs/admin/settings.json). Falls back to the
 * master list when the env file has no packages key.
 */
export function getEnabledPackages(user: string): string[] {
  const envSettings = readJsonCached(join(getPiEnvDir(user), 'settings.json'));
  if (envSettings && Array.isArray(envSettings.packages)) return envSettings.packages;
  return getAvailablePackages();
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

  // pi-images: selected image model (stored in 9router-config.json)
  defaults.imageModel = nineRouterConfig?.imageModel || '';

  // Pi settings defaults
  defaults.enabledModels = readJsonCached(join(PI_DIR, 'settings.json'))?.enabledModels || [];
  defaults.packages = getEnabledPackages(user);

  return defaults;
}

/**
 * Get the settings schema for a user, based on their enabled extensions.
 * The backend decides what settings are relevant; the frontend just renders them.
 * Async because the image-model select options are discovered from 9router.
 */
export async function getUserSettingsSchema(user: string): Promise<SettingSection[]> {
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

  // Image generation settings — when the pi-images extension is installed
  if (isPiImagesInstalled()) {
    const { getRouterConfig, fetchImageModels } = await import('./image-models.js');
    let imageModelOptions: { value: string; label: string }[] = [];
    try {
      const models = await fetchImageModels(getRouterConfig());
      imageModelOptions = models.map((m) => ({ value: m.id, label: m.id }));
    } catch (err) {
      log.settings.error('Failed to fetch image models for settings schema:', err);
    }
    sections.push({
      id: 'images',
      label: 'Images',
      fields: [
        {
          key: 'imageModel',
          label: 'Image Model',
          type: 'select',
          options: imageModelOptions,
          description: imageModelOptions.length > 0
            ? 'Model used to generate images (e.g. "draw me a panda"). Empty = auto-select the first available.'
            : 'No image-capable models found on 9router. Add an upstream with image output support, then reload settings.',
        },
      ],
    });
  }

  // Extensions (always available)
  sections.push({
    id: 'extensions',
    label: 'Extensions',
    fields: [
      {
        key: 'packages',
        label: 'Enabled Extensions',
        type: 'packages',
        description: 'Tick to enable an installed extension for your pi environment. Saving restarts the agent.',
      },
    ],
  });

  // Model settings (always available)
  sections.push({
    id: 'chat',
    label: 'Chat',
    fields: [
      {
        key: 'historyLimit',
        label: 'Chat history length',
        type: 'number',
        description: 'Messages kept in the chat view and replayed on connect (10-500). Applies after a backend restart.',
      },
    ],
  });

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
