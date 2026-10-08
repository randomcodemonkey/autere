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

import { getUserRole } from './users.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, readdirSync, symlinkSync, rmSync, lstatSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { USER_SETTINGS_DIR, PI_DIR } from './constants.js';
import { getPiEnvDir, ensurePiEnv, materializeEnvExtensions } from './pi-env.js';
import { replaceMcpServers } from './mcp-config.js';
import { isPiImagesInstalled } from './image-models.js';
import { matchModelMap } from '../shared/format.js';
import { log } from './logger.js';

interface UserSettings {
  [key: string]: any;
}

// ── Settings schema types ──

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'toggle' | 'select' | 'list' | 'packages' | 'textarea' | 'perModel' | 'folderIgnores' | 'mcpServers';
  placeholder?: string;
  options?: { value: string; label: string }[];
  description?: string;
  listPlaceholder?: string;
  listAddLabel?: string;
  /** Renderer config for type 'perModel': one control per entry of enabledModels */
  perModel?: {
    control: 'select' | 'number';
    options?: { value: string; label: string }[];
    min?: number;
    max?: number;
  };
}

export interface SettingSection {
  id: string;
  label: string;
  fields: SettingField[];
}

// ── Cache ──

const settingsCache = new Map<string, { data: any; mtime: number }>();

export function readJsonCached(filePath: string): any | null {
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

export function invalidateCache(filePath: string) {
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
    // (ensurePiEnv has already synced master install state — this layer
    // applies the user's own choices on top).
    const piSettingsPath = join(envDir, 'settings.json');
    let piSettings: UserSettings = {};
    if (existsSync(piSettingsPath)) {
      try { piSettings = JSON.parse(readFileSync(piSettingsPath, 'utf-8')); } catch {}
    }
    let piSettingsChanged = false;
    if ('modelThinkingLevels' in settings) {
      // pi-native per-model startup/switch thinking levels, keyed
      // "provider/modelId". Sanitized: unknown levels would poison pi's
      // model switching, so they are dropped here.
      piSettings.modelThinkingLevels = sanitizeModelThinkingLevels(settings.modelThinkingLevels);
      piSettingsChanged = true;
    }
    if ('enabledModels' in settings) {
      piSettings.enabledModels = settings.enabledModels;
      piSettingsChanged = true;
      // Keep pi's session-start default in sync with the ordered list —
      // otherwise a stale settings.json defaultModel (e.g. mimo-v2.5-all)
      // wins in findInitialModel and new sessions ignore the user's order.
      const first = settings.enabledModels?.[0];
      if (first) {
        const slash = first.indexOf('/');
        if (slash > 0) {
          piSettings.defaultProvider = first.slice(0, slash);
          piSettings.defaultModel = first.slice(slash + 1);
        } else {
          piSettings.defaultModel = first;
        }
      }
    }
    if ('packages' in settings) {
      // Per-user UI saves the user's enabled set — respect it (it may
      // legitimately differ from the master list mid-merge); master's
      // fresh `pi install` state lands on the NEXT save/spawn.
      // 'local:<name>' entries are bundled extras (pi-ext-extra): they
      // install as env extensions/<name> symlinks, not packages entries,
      // so strip them from what pi sees and apply the link set.
      const incoming = Array.isArray(settings.packages) ? settings.packages : [];
      const extras = incoming.filter((p: unknown) => pkgSource(p).startsWith('local:')).map((p: unknown) => pkgSource(p).slice('local:'.length));
      piSettings.packages = incoming.map(pkgSource).filter((p: string) => !p.startsWith('local:'));
      piSettingsChanged = true;
      const envExts = join(envDir, 'extensions');
      const wanted = new Set(extras);
      for (const spec of getAvailableExtras()) {
        const name = spec.slice('local:'.length);
        try { lstatSync(join(envExts, name)); } catch { continue; } // not linked — nothing to do
        if (!wanted.has(name)) setExtraEnabled(user, name, false);
      }
      for (const name of extras) {
        let present = false;
        try { lstatSync(join(envExts, name)); present = true; } catch { /* absent */ }
        if (!present) setExtraEnabled(user, name, true);
      }
      // Persist the choice so it survives image upgrades / env reseed;
      // also removes extras that disappeared from the bundled set.
      writeSavedExtras(user, getAvailableExtras()
        .map((s) => s.slice('local:'.length))
        .filter((name) => wanted.has(name)));
    }
    if ('codemode' in settings) {
      // pi 1.0 codemode tool. Empirical note: the documented pure-plus form
      // ['+codemode'] does NOT activate the built-in on the user level
      // (built-ins load, codemode never registers); listing it plainly
      // next to the base tools works. So: keep non-codemode entries as
      // they are, and ensure a plain 'codemode' when enabled. Never write
      // an empty [] — pi treats that as "no tools".
      const rest = Array.isArray(piSettings.defaultTools)
        ? piSettings.defaultTools.filter((t: unknown) => t !== 'codemode' && t !== '+codemode' && t !== '-codemode')
        : ['read', 'bash', 'edit', 'write'];
      if (settings.codemode) {
        piSettings.defaultTools = [...rest, 'codemode'];
        piSettings.codemode = { mode: 'on' };
      } else if (rest.length > 0) {
        piSettings.defaultTools = rest;
        delete piSettings.codemode;
      } else {
        delete piSettings.defaultTools;
        delete piSettings.codemode;
      }
      piSettingsChanged = true;
    }
    if ('mcpServers' in settings) {
      // The env mcp.json is the pi-side source of truth; the settings
      // value (also persisted in the user settings file by the save
      // route) is validated and written through here.
      replaceMcpServers(user, settings.mcpServers);
    }
    if (piSettingsChanged) {
      const tmp = join(envDir, `.settings-tmp-${randomUUID()}`);
      writeFileSync(tmp, JSON.stringify(piSettings, null, 2), 'utf-8');
      renameSync(tmp, piSettingsPath);
      invalidateCache(piSettingsPath);
    }

    // Write 9router settings into the env's 9router-config.json
    // enableReasoning is deliberately NOT written: it defaults to false in
    // pi-9router-ext and is the "manual reasoning toggle" described in its
    // docs — leaving it unset keeps thinking levels hidden for 9router models.
    const nineRouterKeys = ['nineRouterBaseUrl', 'nineRouterApiKey', 'nineRouterPassword'];
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
      if ('imageExtraPrompt' in settings) config.imageExtraPrompt = settings.imageExtraPrompt || '';
      const tmp = join(envDir, `.9router-config-tmp-${randomUUID()}`);
      writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
      renameSync(tmp, configPath);
      invalidateCache(configPath);
    }
    // Force-image input overrides → envDir/models.json (pi modelOverrides)
    if ('visionByModel' in settings || 'enabledModels' in settings) {
      writeVisionOverrides(user, envDir);
    }
    // Reserve-context policy file for the pi-token-reserve extension
    if ('reserveTokensPercent' in settings || 'reserveTokensPercentByModel' in settings) {
      writeReserveTokensConfig(user);
    }
    // Sweep policy file for the pi-janitor extension (live-read, no restart)
    if ('janitorMinIdleSec' in settings || 'janitorKeepRecentTurns' in settings || 'janitorWarmGapMultiplier' in settings) {
      writeJanitorConfig(user);
    }
  } catch (err) {
    log.settings.error(`Failed to apply settings to pi env for user "${user}":`, err);
  }
}

/**
 * Rebuild the env's models.json modelOverrides from the vision per-model setting.
 * Entries marked 'on' get input:['text','image'] forced; everything else falls
 * back to whatever pi's metadata resolution decides. Preserves the rest of an
 * existing models.json (other providers, custom models); stale overrides (model
 * removed from enabledModels or turned off) are pruned. Called from
 * applySettingsToPiEnv when visionByModel or enabledModels changes; pi reads
 * models.json at process start, so the settings-save restart keeps them live.
 */
function writeVisionOverrides(user: string, envDir: string): void {
  const modelsPath = join(envDir, 'models.json');
  let current: any = {};
  if (existsSync(modelsPath)) {
    try { current = JSON.parse(readFileSync(modelsPath, 'utf-8')); } catch {}
  }
  const settings = getAllUserSettings(user);
  const vision = settings.visionByModel && typeof settings.visionByModel === 'object' && !Array.isArray(settings.visionByModel)
    ? settings.visionByModel : {};
  const models = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  const piSettings = readJsonCached(join(envDir, 'settings.json')) || {};
  const next = mergeVisionOverrides(current, models, vision, piSettings.defaultProvider);
  const tmp = join(envDir, `.models-tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmp, modelsPath);
  invalidateCache(modelsPath);
}

/**
 * Pure merge (tested): recomputes overrides for enabledModels only, keyed by
 * provider under models.json's providers map ("provider/model" entries; bare
 * ids go under defaultProvider). Old entries not re-derived are dropped.
 */
export function mergeVisionOverrides(
  existing: Record<string, any>,
  enabledModels: string[],
  vision: Record<string, unknown>,
  defaultProvider?: string,
): Record<string, any> {
  const providers: Record<string, any> = { ...existing.providers };
  // Preserve existing override fields from BEFORE pruning so the rebuild
  // below can re-attach them (pruning only drops our forced-input entries).
  const priorOverrides: Record<string, Record<string, any>> = {};
  for (const [pKey, prov] of Object.entries(providers)) {
    if (prov && typeof prov === 'object' && prov.modelOverrides) {
      priorOverrides[pKey] = { ...prov.modelOverrides };
      for (const [id, ovRaw] of Object.entries(prov.modelOverrides)) {
        const ov = ovRaw as Record<string, any> | null;
        if (ov && typeof ov === 'object' && typeof ov.input === 'object' && (ov.input as string[]).length === 2 && (ov.input as string[]).includes('image')) {
          delete prov.modelOverrides[id];
        }
      }
      if (Object.keys(prov.modelOverrides).length === 0) delete prov.modelOverrides;
    }
  }
  for (const entry of enabledModels) {
    if (vision[entry] !== 'on') continue;
    const slash = entry.indexOf('/');
    const provider = slash > 0 ? entry.slice(0, slash) : (defaultProvider || '');
    const id = slash > 0 ? entry.slice(slash + 1) : entry;
    if (!provider || !id) continue;
    const prov = providers[provider] = providers[provider] || {};
    const ov = priorOverrides[provider]?.[id] || {};
    prov.modelOverrides = { ...(prov.modelOverrides || {}), [id]: { ...ov, input: ['text', 'image'] } };
  }
  for (const [k, v] of Object.entries(providers)) {
    if (v && typeof v === 'object' && Object.keys(v).length === 0) delete providers[k];
  }
  return { ...existing, providers };
}

/**
 * Chat history limit (messages kept in the buffer and shown in the chat).
 * Stored as the user setting 'historyLimit'; clamped to 10-500, default 50.
 * Snapshot per UserSession construction — settings saves restart the pi
 * process, so a new session picks up the new value.
 */
export interface FolderIgnore { path: string; edits: boolean; files: boolean }

// Defaults per spec: /tmp is edits-only; the dev-artifact folders are
// hidden from both the Files browser and the edit/changes pipelines.
const DEFAULT_FOLDER_IGNORES: FolderIgnore[] = [
  { path: '/tmp', edits: true, files: false },
  { path: 'node_modules', edits: true, files: true },
  { path: '.git', edits: true, files: true },
  { path: '.cache', edits: true, files: true },
];

export function getFolderIgnores(user: string): FolderIgnore[] {
  // Migration from the retired Chat → "Ignored folders for edit cards"
  // (editIgnorePaths): every legacy entry was an unconditional edit ignore.
  const raw = readUserSettingsFile(user)['folderIgnores'];
  let entries = Array.isArray(raw) ? raw : null;
  if (!entries) {
    const legacy = readUserSettingsFile(user)['editIgnorePaths'];
    entries = Array.isArray(legacy) && legacy.length > 0
      ? legacy.map((p: any) => ({ path: p, edits: true, files: false }))
      : DEFAULT_FOLDER_IGNORES;
  }
  const seen = new Set<string>();
  const out: FolderIgnore[] = [];
  for (const e of entries) {
    const path = typeof e?.path === 'string' ? e.path.trim().replace(/\/+$/, '') : '';
    if (!path || seen.has(path) || (!e?.edits && !e?.files)) continue;
    seen.add(path);
    out.push({ path, edits: !!e.edits, files: !!e.files });
  }
  return out;
}

export function getEditIgnorePaths(user: string): string[] {
  return getFolderIgnores(user).filter((e) => e.edits).map((e) => e.path);
}

// ── Git repositories (Repositories view) ──

export function getGitRepos(user: string): string[] {
  const raw = readUserSettingsFile(user)['gitRepos'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    const path = typeof p === 'string' ? p.trim().replace(/\/+$/, '') : '';
    if (path && !seen.has(path)) { seen.add(path); out.push(path); }
  }
  return out;
}

/**
 * Minimum turn length (minutes) before a turn-end notification is sent —
 * 0 = every turn. Stored as a number or a settings-form string.
 */
export function getTurnEndNotifyMinMinutes(user: string): number {
  const raw = getUserSetting(user, 'notifyTurnEndAfterMinutes', 0);
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1440, Math.max(0, Math.floor(n)));
}

export function getHistoryLimit(user: string): number {
  // 200 (not 50): a single agent turn can easily emit 50+ tool/thinking/
  // edit entries — at 50 the trailing window could not even hold one turn
  // plus the user message that triggered it.
  const raw = getUserSetting(user, 'historyLimit', 200);
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isFinite(n)) return 200;
  return Math.min(500, Math.max(10, Math.floor(n)));
}

// ── Reserve context (compaction reserveTokens as % of the model's context
//    window, consumed by the generic pi-token-reserve pi extension — see
//    extras/pi-token-reserve. 0 = pi default of 16384 tokens.) ──

export function getReserveTokensPercent(user: string): number {
  const raw = getUserSetting(user, 'reserveTokensPercent', 0);
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(90, Math.max(0, Math.floor(n)));
}

/** Per-model reserve-% overrides, keyed like enabledModels entries. */
export function getReservePercentByModel(user: string): Record<string, number> {
  const raw = getUserSetting(user, 'reserveTokensPercentByModel', {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(raw)) {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n)) out[key] = Math.min(90, Math.max(0, Math.floor(n)));
  }
  return out;
}

/** Reserve % for one model: per-model override, else the default scalar. */
export function getReservePercentForModel(user: string, provider?: string | null, id?: string | null): number {
  const pct = matchModelMap(getReservePercentByModel(user), provider, id);
  return pct ?? getReserveTokensPercent(user);
}

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Keep only non-empty keys with a known pi thinking level. */
function sanitizeModelThinkingLevels(raw: any): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (key.trim() && typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v)) out[key] = v;
  }
  return out;
}

/**
 * pi contextUsage annotated with the effective context window (total minus
 * the reserve-% policy applied by the pi-token-reserve extension), so the
 * UI can show usage against the usable context: "330K / 200K (1.0M)".
 * Shared by every path that copies pi stats to the frontend (user-session
 * fetch/broadcast sites + the routes.ts session-switch path).
 */
export function annotateContextUsage(
  user: string,
  cu: { tokens: number; contextWindow: number; percent: number },
  model?: { provider?: string; id?: string } | null,
) {
  const pct = getReservePercentForModel(user, model?.provider, model?.id);
  const effectiveWindow = cu.contextWindow > 0 && pct > 0
    ? cu.contextWindow - Math.floor((cu.contextWindow * pct) / 100)
    : cu.contextWindow;
  return { ...cu, effectiveWindow };
}

/**
 * Write the reserve percent into the user's pi env for the pi-token-reserve
 * extension to read. Called on every pi spawn and settings save; the
 * extension mtime-caches the file, so rewriting it updates running pi
 * processes without a restart.
 */
export function writeReserveTokensConfig(user: string): void {
  try {
    const envDir = ensurePiEnv(user);
    const tmp = join(envDir, `.pi-token-reserve-config-tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify({
      percent: getReserveTokensPercent(user),
      perModel: getReservePercentByModel(user),
    }), 'utf-8');
    renameSync(tmp, join(envDir, 'pi-token-reserve-config.json'));
  } catch (err) {
    log.settings.error(`Failed to write pi-token-reserve-config.json for user "${user}":`, err);
  }
}

// ── Janitor sweep policy (consumed live by extras/pi-janitor — same pattern
// as pi-token-reserve: settings save materializes a config file into the
// user's env; the extension mtime-caches and applies it per LLM call) ──

export function getJanitorSettings(user: string): { minIdleSec: number; keepRecentTurns: number; warmGapMultiplier: number } {
  const num = (key: string, def: number, lo: number, hi: number) => {
    const raw = getUserSetting(user, key, def);
    const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : def;
  };
  return {
    minIdleSec: num('janitorMinIdleSec', 600, 60, 7200),
    keepRecentTurns: num('janitorKeepRecentTurns', 3, 1, 20),
    warmGapMultiplier: num('janitorWarmGapMultiplier', 2, 1, 4),
  };
}

export function writeJanitorConfig(user: string): void {
  try {
    const envDir = ensurePiEnv(user);
    const tmp = join(envDir, `.janitor-config-tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(getJanitorSettings(user)), 'utf-8');
    renameSync(tmp, join(envDir, 'janitor-config.json'));
  } catch (err) {
    log.settings.error(`Failed to write janitor-config.json for user "${user}":`, err);
  }
}

// ── Image preview (what the chat model sees for attached images) ──

export function getSendImagesToChatModel(user: string): boolean {
  const raw = getUserSetting(user, 'sendImagesToChatModel', true);
  return raw !== false && raw !== 'false';
}

/** Show images from 'read' tool results as first-class chat images. Default on. */
export function getShowReadImages(user: string): boolean {
  const raw = getUserSetting(user, 'showReadImages', true);
  return raw !== false && raw !== 'false';
}

/** streamfix (pi-images): non-streamed upstream requests for image-bearing chats. Default on. */
export function getImageStreamFix(user: string): boolean {
  const raw = getUserSetting(user, 'imageStreamFix', true);
  return raw !== false && raw !== 'false';
}

export interface ImagePreviewQuality {
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
  jpegQuality: number;
}

/**
 * Named preview qualities. 'full' means the original bytes are sent to the
 * chat model; null return value is never used — use getSendImagesToChatModel
 * for the on/off decision.
 */
export function getImagePreviewQuality(user: string): ImagePreviewQuality | 'full' {
  const raw = getUserSetting(user, 'imagePreviewQuality', 'medium');
  switch (raw) {
    case 'low': return { maxWidth: 512, maxHeight: 512, maxBytes: 100 * 1024, jpegQuality: 60 };
    case 'high': return { maxWidth: 2048, maxHeight: 2048, maxBytes: 1024 * 1024, jpegQuality: 80 };
    case 'full': return 'full';
    default: return { maxWidth: 1024, maxHeight: 1024, maxBytes: 300 * 1024, jpegQuality: 70 }; // medium
  }
}

/**
 * Extensions ("packages") installed in the master pi environment — from
 * ~/.pi/agent/settings.json. Installing a new extension with pi adds it here;
 * these are offered in the Settings view as available to enable.
 */
function pkgSource(p: unknown): string {
  return typeof p === 'string' ? p : (p as { source?: string })?.source || String(p);
}

export function getAvailablePackages(): string[] {
  return [
    ...(readJsonCached(join(PI_DIR, 'settings.json'))?.packages || []).map(pkgSource),
    ...getAvailableExtras(),
  ];
}

/** Bundled custom pi extensions (repo extras/, shipped in the image at
 *  ~/pi-ext-extra). AUTERE_PI_EXT_EXTRA points dev runs at the repo.
 *  ponytail: name reads/writes are path-validated; no users/auth touched. */
const EXTRAS_DIR = process.env.AUTERE_PI_EXT_EXTRA
  || join(process.env.HOME || '/home/autere', 'pi-ext-extra');

/** Extras enabled at first use, before the user has saved a choice.
 *  pi-dedup is off by default (elides tool results — niche). */
export const DEFAULT_ENABLED_EXTRAS: Record<string, boolean> = {
  'pi-dedup': false,
};

/** Extras the user has NOT saved a choice for = defaults apply. The saved
 *  file (env autere-extensions.json) persists choices across upgrades/reseeds. */
export function savedExtras(user: string): { local: string[] } | null {
  try {
    const raw = JSON.parse(readFileSync(join(getPiEnvDir(user), 'autere-extensions.json'), 'utf-8'));
    return Array.isArray(raw?.enabled) ? { local: raw.enabled } : null;
  } catch { return null; }
}

export function writeSavedExtras(user: string, names: string[]): void {
  const path = join(getPiEnvDir(user), 'autere-extensions.json');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ enabled: names }, null, 2), 'utf-8');
  } catch (err) {
    log.settings.error(`Failed to save bundled-extension choices for "${user}":`, err);
  }
}

/** Bundled custom extensions (pi-ext-extra) as toggle ids: 'local:pi-X'.
 *  These install into a user's env as extensions/<name> symlinks on save. */
export function getAvailableExtras(): string[] {
  try {
    return readdirSync(EXTRAS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .filter((name) => existsSync(join(EXTRAS_DIR, name, 'index.ts')) || existsSync(join(EXTRAS_DIR, name, 'index.js')))
      .sort()
      .map((name) => `local:${name}`);
  } catch { return []; }
}

/** Extras currently linked into the user's env extensions dir. */
export function getEnabledExtras(user: string): string[] {
  const dir = join(getPiEnvDir(user), 'extensions');
  const available = new Set(getAvailableExtras().map((s) => s.slice('local:'.length)));
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => available.has(e.name))
      .map((e) => `local:${e.name}`);
  } catch { return []; }
}

/** extras toggle state = saved choices (env autere-extensions.json, names
 *  intersected with the currently bundled set), falling back to
 *  DEFAULT_ENABLED_EXTRAS before the user saved anything. */
export function desiredExtras(user: string): string[] {
  const available = getAvailableExtras();
  const saved = savedExtras(user);
  if (saved) {
    const have = new Set(saved.local);
    return available.filter((s) => have.has(s.slice('local:'.length)));
  }
  return available.filter((s) => DEFAULT_ENABLED_EXTRAS[s.slice('local:'.length)] !== false);
}

/** Link (enabled) or unlink (disabled) one bundled extra into the user's env. */
export function setExtraEnabled(user: string, name: string, enabled: boolean): void {
  if (!/^[-\w.]+$/.test(name)) throw new Error(`bad extension name "${name}"`);
  // The env extensions dir may still be a shared master symlink —
  // materialize it first so toggles stay per-user.
  materializeEnvExtensions(user);
  const link = join(getPiEnvDir(user), 'extensions', name);
  try { lstatSync(link); rmSync(link, { recursive: true }); } catch { /* not there */ }
  if (!enabled) return;
  const src = join(EXTRAS_DIR, name);
  if (!existsSync(src)) throw new Error(`Extension "${name}" is not installed on this server`);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(src, link, 'dir');
}

/**
 * Extensions enabled for a user — the per-user pi env's settings.json
 * 'packages' (e.g. ~/.autere/pi-envs/admin/settings.json). Falls back to the
 * master list when the env file has no packages key.
 */
export function getEnabledPackages(user: string): string[] {
  const envSettings = readJsonCached(join(getPiEnvDir(user), 'settings.json'));
  const npm = envSettings && Array.isArray(envSettings.packages)
    ? envSettings.packages.map(pkgSource)
    : getAvailablePackages();
  return [...npm.filter((p: string) => !p.startsWith('local:')), ...desiredExtras(user)];
}

// ── Token pricing ──
// pi computes message cost from its baked-in model catalog; models it does
// not know (e.g. 9router fallback models like mimo-v2.5-all) report $0.
// This optional user setting provides per-model rates to price usage
// ourselves. Value: JSON in USD per million tokens:
//   {
//     "default": {"input":0.075,"output":0.25,"cacheRead":0.015,"cacheWrite":0},
//     "mimo-v2.5-all": {"input":0,"output":0,"cacheRead":0},
//     "image": 0.03
//   }
// "default" applies to models without an exact entry; a legacy flat object
// ({"input":...} at the top level) is accepted as the default rates.
// "image" is a flat USD cost added per completed image tool call
// (generate_image / edit_image). Empty/unset = disabled (pi's cost used as-is).

export interface TokenRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface TokenPricingConfig {
  default?: TokenRates;
  models: Record<string, TokenRates>;
  /** Flat USD cost per completed image tool call */
  image?: number;
}

function parseRates(v: any): TokenRates | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const rates: TokenRates = {};
  let any = false;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const n = Number(v[k]);
    if (Number.isFinite(n) && n >= 0) { rates[k] = n; any = true; }
  }
  return any ? rates : null;
}

/** pi's catalog lists these rates for z-ai/glm-5.3-flash — the usual autere
 *  model. Used when the user has not configured tokenPricing (pi itself
 *  reports $0 because the runtime model id carries a provider prefix that
 *  misses its catalog). */
const BUILTIN_DEFAULT_RATES: TokenRates = { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 };

export function getTokenPricing(user: string): TokenPricingConfig | null {
  const raw = getUserSetting(user, 'tokenPricing', '');
  if (!raw || typeof raw !== 'string') {
    return { default: { ...BUILTIN_DEFAULT_RATES }, models: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    // Legacy flat format: top-level rates = default
    if (parsed.input !== undefined || parsed.output !== undefined) {
      const d = parseRates(parsed);
      return d ? { default: d, models: {} } : null;
    }
    const config: TokenPricingConfig = { models: {} };
    const d = parseRates(parsed.default);
    if (d) config.default = d;
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'default') continue;
      if (k === 'image') {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) config.image = n;
        continue;
      }
      const r = parseRates(v);
      if (r) config.models[k] = r;
    }
    return (config.default || config.image !== undefined || Object.keys(config.models).length > 0) ? config : null;
  } catch {
    return null;
  }
}

/** Rates for a model id: exact entry, else default */
export function getRatesForModel(config: TokenPricingConfig, modelId: string | null | undefined): TokenRates | null {
  if (modelId && config.models[modelId]) return config.models[modelId];
  return config.default || null;
}

/** Cost in USD for a usage object at rates in $/M tokens */
export function computeTokenCost(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }, rates: TokenRates): number {
  return (
    ((usage.input || 0) * (rates.input || 0) +
      (usage.output || 0) * (rates.output || 0) +
      (usage.cacheRead || 0) * (rates.cacheRead || 0) +
      (usage.cacheWrite || 0) * (rates.cacheWrite || 0)) / 1e6
  );
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
  defaults.nineRouterPassword = process.env.INITIAL_PASSWORD || '';

  // pi-images: selected image model (stored in 9router-config.json)
  defaults.imageModel = nineRouterConfig?.imageModel || '';
  defaults.imageExtraPrompt = nineRouterConfig?.imageExtraPrompt ?? undefined;

  // Image pipeline toggles default to enabled — must be explicit so the
  // settings UI shows them as on when unset (undefined renders as off).
  defaults.sendImagesToChatModel = true;
  defaults.imageStreamFix = true;
  defaults.showReadImages = true;

  defaults.reserveTokensPercent = 0;
  defaults.reserveTokensPercentByModel = {};
  defaults.modelThinkingLevels = {};

  // Notifications (Settings → Notifications) — per-kind toggles, read live
  // by the backend, default on so a fresh subscription delivers right away.
  // All-done (idle, nothing queued) is opt-in; turn-end's minimum length is
  // 0 = notify on every turn end.
  defaults.notifyExplicit = true;
  defaults.notifyTaskStart = true;
  defaults.notifyTurnEnd = true;
  defaults.notifyAllDone = false;
  defaults.notifyTurnEndAfterMinutes = 0;
  defaults.janitorMinIdleSec = 600;
  defaults.janitorKeepRecentTurns = 3;
  defaults.janitorWarmGapMultiplier = 2;

  // Files view + edit-cards ignore folders (default seeded into the UI;
  // runtime getters migrate this from the retired editIgnorePaths entry)
  defaults.folderIgnores = getFolderIgnores(user);
  defaults.gitRepos = getGitRepos(user);

  // Pi settings defaults
  defaults.enabledModels = readJsonCached(join(PI_DIR, 'settings.json'))?.enabledModels || [];
  defaults.packages = getEnabledPackages(user);
  defaults.codemode = false;
  // MCP servers live in the env's mcp.json (seeded from master); the
  // settings UI edits that file through the mcp CRUD routes — the value
  // here is only what the schema renderer reads on load.
  try {
    const mcpRaw = readJsonCached(join(getPiEnvDir(user), 'mcp.json'));
    defaults.mcpServers = mcpRaw?.mcpServers ?? {};
  } catch { defaults.mcpServers = {}; }

  return defaults;
}

/**
 * Get the settings schema for a user, based on their enabled extensions.
 * The backend decides what settings are relevant; the frontend just renders them.
 * Async because the image-model select options are discovered from 9router.
 */
export async function getUserSettingsSchema(user: string, imageModelOptions: { value: string; label: string }[] = []): Promise<SettingSection[]> {
  const sections: SettingSection[] = [];

  // Docker sandbox — backend-level, always shown
  sections.push({
    id: 'sandbox',
    label: 'Sandbox',
    fields: [
      {
        key: 'piSandboxImage',
        label: 'Docker Image',
        type: 'text',
        placeholder: 'ghcr.io/randomcodemonkey/autere:latest',
                        description: `Run every pi agent session inside this docker container instead of on the host. The image must provide pi, bash and a user with uid 1001, and is validated on save. Empty = the default autere sandbox image.${getUserRole(user) === 'admin' ? ' off/none/disabled = run pi on the host (no isolation) — admin exit hatch for when something breaks.' : ''}`,      },
    ],
  });

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
      ],
    });
  }

  // Image generation settings — when the pi-images extension is installed.
  // Options are resolved by the caller (routes.ts) from the viewed session's
  // pi rpc — the same get_available_models that backs chat model selection.
  if (isPiImagesInstalled()) {
    // 9router is discoverable (capabilities.imageOutput over /v1/models);
    // any other provider is not — the user types the model id instead.
    const provider = process.env.AUTERE_PROVIDER || '9router';
    const is9router = provider === '9router';
    sections.push({
      id: 'images',
      label: 'Images',
      fields: [
        is9router ? {
          key: 'imageModel',
          label: 'Image Model',
          type: 'select' as const,
          options: imageModelOptions,
          description: imageModelOptions.length > 0
            ? 'Model used to generate images (e.g. "draw me a panda"). Empty = auto-select the first available.'
            : 'No image-capable models found on 9router. Add an upstream with image output support, then reload settings.',
        } : {
          key: 'imageModel',
          label: 'Image Model',
          type: 'text' as const,
          description: `Model id used for image generation (provider "${provider}" — no discovery available). Must match a model the provider offers; image generation fails without it.`,
        },
        {
          key: 'imageExtraPrompt',
          label: 'Extra Image Prompt',
          type: 'text',
          description: 'Appended to image-edit requests. Default: instruct the model to change the original as little as possible and only apply the requested edit. Empty = use default.',
        },
      ],
    });
  }

  // Usage
  sections.push({
    id: 'usage',
    label: 'Usage',
    fields: [
      {
        key: 'tokenPricing',
        label: 'Token Pricing ($/M tokens, JSON)',
        type: 'textarea',
        description: 'Per-model cost rates in $/M tokens, used when pi cannot price a model (9router fallback/report ids miss its catalog). JSON: {"default":{"input":0.075,"output":0.25,"cacheRead":0.015},"MODEL_ID":{...},"image":0.03}. "image" = flat cost per image tool call. Empty = built-in default (GLM 5.3 Flash list price). Set {} to disable cost estimation.',
      },
    ],
  });

  // Extensions (always available)
  sections.push({
    id: 'extensions',
    label: 'Extensions',
    fields: [
      {
        key: 'packages',
        label: 'Enabled Extensions',
        type: 'packages',
        description: 'Tick to enable an installed extension for your pi environment. Saving restarts the agent. “pi-” entries marked local come from the server’s bundled set (admin can toggle them).',
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
      {
        key: 'reserveTokensPercent',
        label: 'Reserved context — default (%)',
        type: 'number',
        description: "Fallback reserve for models without a per-model value (see Models). This percentage of the model's context window cannot be used (0-90; 0 = pi default of 16384 tokens) — usable context shrinks accordingly, so automatic compaction triggers earlier. Applies to the running session without a pi restart.",
      },
      {
        key: 'sendImagesToChatModel',
        label: 'Send images to chat model',
        type: 'toggle',
        description: 'Attached images are downscaled and shown to the chat model. When off, the model only gets the saved file paths. Applies after a pi restart.',
      },
      {
        key: 'imageStreamFix',
        label: 'Non-streamed image requests',
        type: 'toggle',
        description: 'Send image-bearing chat requests non-streamed and relay the response as a stream. Works around upstream stream-usage accounting inflating image token counts ~4x. Applies after a pi restart.',
      },
      {
        key: 'showReadImages',
        label: 'Show read images',
        type: 'toggle',
        description: "Images read by the model (e.g. 'Read image file ...' tool results) render as first-class chat images. When off, only text of tool results is shown. Applies to new tool results and on session reload.",
      },
      {
        key: 'imagePreviewQuality',
        label: 'Image preview quality',
        type: 'select',
        options: [
          { value: 'low', label: 'Low (512px, ~100 KB)' },
          { value: 'medium', label: 'Medium (1024px, ~300 KB)' },
          { value: 'high', label: 'High (2048px, ~1 MB)' },
          { value: 'full', label: 'Full (original file)' },
        ],
        description: 'Downscale applied to attached images before the chat model sees them. Full-resolution originals are always saved to disk for tools. Applies after a pi restart.',
      },
      {
        key: 'codemode',
        label: 'Codemode scripting',
        type: 'toggle',
        description: "Give the model pi's codemode tool: it writes sandboxed JavaScript that calls other tools in parallel and runs classifier/image models, with only the script's output reaching the model. Applies after a pi restart.",
      },
    ],
  });

  sections.push({
    id: 'janitor',
    label: 'Janitor',
    fields: [
      {
        key: 'janitorMinIdleSec',
        label: 'Sweep minimum idle (s)',
        type: 'number',
        description: 'Never sweep before this much idle time (60-7200). The real threshold is this or the observed cache TTL × margin, whichever is larger — after a longer idle the cache is cold, so rewriting history is free. Applies to the running session without a pi restart.',
      },
      {
        key: 'janitorWarmGapMultiplier',
        label: 'Cache margin (×)',
        type: 'number',
        description: 'Safety margin on the observed cache TTL — the longest idle gap that still saw a cache hit (1-4; default 2). Lower = more eager, higher risk of busting a still-warm cache when provider TTLs fluctuate. Applies without a pi restart.',
      },
      {
        key: 'janitorKeepRecentTurns',
        label: 'Keep recent turns',
        type: 'number',
        description: 'User turns the janitor always leaves intact (1-20; default 3) — everything older (tool results, edit diffs, images over ~50 chars) gets stubbed. Applies without a pi restart.',
      },
    ],
  });

  sections.push({
    id: 'models',
    label: 'Models',
    fields: [
      {
        key: 'modelThinkingLevels',
        label: 'Thinking level per model',
        type: 'perModel',
        perModel: {
          control: 'select',
          options: [
            { value: '', label: 'pi default' },
            ...THINKING_LEVELS.map((l) => ({ value: l, label: l })),
          ],
        },
        description: 'Reasoning/thinking level per enabled model. pi applies it on session start and on every model switch (xhigh/max are honored only by models that support them). Saving restarts the agent.',
      },
      {
        key: 'reserveTokensPercentByModel',
        label: 'Reserved context per model (%)',
        type: 'perModel',
        perModel: { control: 'number', min: 0, max: 90 },
      },
      {
        key: 'visionByModel',
        label: 'Image input per model',
        type: 'perModel',
        perModel: {
          control: 'select',
          options: [
            { value: '', label: 'metadata' },
            { value: 'on', label: 'image' },
          ],
        },
        description: 'Force image input on, bypassing what the provider metadata reports (writes pi models.json modelOverrides.input). Use for models whose registry entry wrongly lacks image support — e.g. 9router combo ids, which currently resolve to a text-only metadata entry. Saving restarts the agent.',
      },
    ],
  });

  // Files section — ignore folders for the Files browser + edit/changes pipelines
  sections.push({
    id: 'files',
    label: 'Files',
    fields: [
      {
        key: 'folderIgnores',
        label: 'Ignored folders',
        type: 'folderIgnores',
        description: 'Folders hidden from the Files browser and/or the edit cards + Changes list. Path segments: relative entries (node_modules) match at any depth, absolute entries (/tmp) anchor at the root.',
      },
      {
        key: 'gitRepos',
        label: 'Repositories',
        type: 'list',
        description: 'Folders treated as git repositories in the Repositories view — absolute paths, or paths relative to $HOME. Must be inside your file roots.',
        listPlaceholder: '/home/user/code/project',
        listAddLabel: 'Add Repository',
      },
    ],
  });

  // MCP servers — the per-user pi mcp.json, edited as a server table
  sections.push({
    id: 'mcp',
    label: 'MCP Servers',
    fields: [
      {
        key: 'mcpServers',
        label: 'MCP servers',
        type: 'mcpServers',
        description: 'Model Context Protocol servers for your pi sessions (pi reads the env mcp.json). Tools are callable from codemode scripts by default; exposure controls whether the model also sees them directly. Applies after a pi restart.',
      },
    ],
  });

  // Frontend-rendered sections whose ordering the backend still owns — the
  // sort below places them alphabetically; the frontend renders their
  // specialized UI when it sees these section ids.
  sections.push({ id: 'personas', label: 'Personas', fields: [] });
  sections.push({ id: 'apiTokens', label: 'API Tokens', fields: [] });
  sections.push({
    id: 'notifications',
    label: 'Notifications',
    fields: [
      {
        key: 'notifyExplicit',
        label: 'Messages from the agent',
        type: 'toggle',
        description: 'Notifications the agent sends on purpose with its send_notification tool. Content is limited to 256 characters.',
      },
      {
        key: 'notifyTaskStart',
        label: 'Scheduled task start',
        type: 'toggle',
        description: 'When a scheduled task starts a run — opens the run session.',
      },
      {
        key: 'notifyTurnEnd',
        label: 'Turn end',
        type: 'toggle',
        description: 'When the agent finishes a turn: the first 256 characters of its last message. Opens that session.',
      },
      {
        key: 'notifyAllDone',
        label: 'All tasks completed',
        type: 'toggle',
        description: 'When the session goes idle with no pending messages (every queued message processed) — unlike Turn end, which fires per message. Suppressed when a Turn end notification just fired for the same moment, so enabling both never doubles a notification.',
      },
      {
        key: 'notifyTurnEndAfterMinutes',
        label: 'Minimum turn length (minutes)',
        type: 'number',
        description: 'Gates Turn end AND All tasks completed: notify only when the agent kept working at least this long — a long turn finishing is worth knowing about. 0 = every turn end.',
      },
    ],
  });

  // Canonical display order is decided here — the frontend renders sections
  // in the given order without re-sorting.
  return sections.sort((a, b) => a.label.localeCompare(b.label));
}
