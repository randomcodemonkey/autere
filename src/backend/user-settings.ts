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
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { USER_SETTINGS_DIR, PI_DIR } from './constants.js';
import { getPiEnvDir, ensurePiEnv } from './pi-env.js';
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
  type: 'text' | 'password' | 'number' | 'toggle' | 'select' | 'list' | 'packages' | 'textarea' | 'perModel' | 'folderIgnores';
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
        placeholder: 'randomcodemonkey.org/slopbox:latest',
                        description: `Run every pi agent session inside this docker container instead of on the host. The image must provide pi, bash and a user with uid 1001, and is validated on save. Empty = the default slopbox image.${getUserRole(user) === 'admin' ? ' off/none/disabled = run pi on the host (no isolation) — admin exit hatch for when something breaks.' : ''}`,      },
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
        key: 'enabledModels',
        label: 'Enabled Models',
        type: 'list',
        description: 'Models available for selection (provider/model). Drag to reorder priority.',
        listPlaceholder: 'e.g. anthropic/claude-sonnet-4-20250514',
        listAddLabel: 'Add Model',
      },
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

  // Frontend-rendered sections whose ordering the backend still owns — the
  // sort below places them alphabetically; the frontend renders their
  // specialized UI when it sees these section ids.
  sections.push({ id: 'personas', label: 'Personas', fields: [] });
  sections.push({ id: 'apiTokens', label: 'API Tokens', fields: [] });

  // Canonical display order is decided here — the frontend renders sections
  // in the given order without re-sorting.
  return sections.sort((a, b) => a.label.localeCompare(b.label));
}
