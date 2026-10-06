/**
 * Extension discovery and monitoring.
 *
 * Discovers enabled extensions by reading:
 * 1. settings.json → packages array (npm extension packages)
 * 2. CLI -e args passed to the pi process (local extensions)
 *
 * For each discovered extension, reads its config and applies
 * any registered extension handler for custom status enrichment.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { ExtensionInfo } from './types.js';
import { PI_DIR, NPM_EXTENSIONS_DIR, EXTENSIONS_DIR } from './constants.js';
import { extensionsState } from './state.js';
import { PI_ENVS_DIR } from './pi-env.js';
import { getExtensionHandler } from './extension-handlers.js';
import { getUserSetting, getEnabledPackages } from './user-settings.js';
import { log } from './logger.js';

// ── Extension discovery ──

interface DiscoveredExtension {
  id: string;
  displayName: string;
  source: 'npm' | 'local';
  /** For npm: the directory name under node_modules. For local: the file path. */
  moduleDir?: string;
  filePath?: string;
}

/**
 * Parse a package specifier from settings.json packages array.
 * Examples: "npm:pi-9router-ext" → { source: 'npm', id: 'pi-9router-ext' }
 */
function parsePackageSpec(spec: string): { source: 'npm' | 'local'; id: string } | null {
  if (spec.startsWith('npm:')) {
    return { source: 'npm', id: spec.slice(4) };
  }
  // Local extensions could be specified as paths
  if (spec.startsWith('/') || spec.startsWith('./')) {
    return { source: 'local', id: spec };
  }
  return null;
}

/**
 * Discover npm extension packages from settings.json.
 */
function discoverNpmExtensions(): DiscoveredExtension[] {
  // Union per-user enabled packages with the global ~/.pi/agent list:
  // `pi install` writes to the global settings.json, but a stale per-user
  // `packages` array shadows it in getUserSetting's fallback chain and
  // would hide newly installed extensions.
  const globalPackages = (() => {
    try { return JSON.parse(readFileSync(join(PI_DIR, 'settings.json'), 'utf-8'))?.packages || []; } catch { return []; }
  })();
  const userPackages = getUserSetting('admin', 'packages', []) as (string | { source?: string })[];
  const pkgSource = (p: string | { source?: string }): string => typeof p === 'string' ? p : p?.source || '';
  const packages = new Set([...userPackages.map(pkgSource), ...globalPackages.map(pkgSource)].filter(Boolean));
  const discovered: DiscoveredExtension[] = [];

  for (const spec of packages) {
    const parsed = parsePackageSpec(spec);
    if (!parsed) continue;

    if (parsed.source === 'npm') {
      const moduleDir = join(NPM_EXTENSIONS_DIR, parsed.id);
      if (existsSync(moduleDir)) {
        discovered.push({
          id: parsed.id,
          displayName: formatDisplayName(parsed.id),
          source: 'npm',
          moduleDir,
        });
      }
    } else if (parsed.source === 'local' && parsed.id) {
      const filePath = parsed.id.startsWith('/') ? parsed.id : join(PI_DIR, parsed.id);
      if (existsSync(filePath)) {
        discovered.push({
          id: parsed.id,
          displayName: formatDisplayName(parsed.id),
          source: 'local',
          filePath,
        });
      }
    }
  }

  return discovered;
}


/**
 * Discover local extensions from the extensions directories: the master
 * extensions/ dir plus every per-user env dir (pi loads extensions from the
 * ENV dir it's spawned with — envs carry symlinks into the repo's extras/).
 * Union, deduped by name, so one wiped master dir can't blank the card.
 */
function discoverLocalExtensions(): DiscoveredExtension[] {
  const discovered = new Map<string, DiscoveredExtension>();

  const scan = (dir: string) => {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Follow symlinks — extensions may be installed as links to a source dir
        const isDir = entry.isDirectory() ||
          (entry.isSymbolicLink() && (() => { try { return statSync(join(dir, entry.name)).isDirectory(); } catch { return false; } })());
        if (!isDir || discovered.has(entry.name)) continue;
        const extDir = join(dir, entry.name);
        // Check for common extension entry points
        const entryPoints = ['index.ts', 'index.js', `${entry.name}.ts`, `${entry.name}.js`];
        for (const ep of entryPoints) {
          if (existsSync(join(extDir, ep))) {
            discovered.set(entry.name, {
              id: entry.name,
              displayName: formatDisplayName(entry.name),
              source: 'local',
              filePath: join(extDir, ep),
            });
            break;
          }
        }
      }
    } catch (err) {
      log.extensions.error(`Failed to read extensions directory ${dir}:`, err);
    }
  };

  scan(EXTENSIONS_DIR);
  // Per-user env dirs reflect what pi actually loads
  try { for (const e of readdirSync(PI_ENVS_DIR, { withFileTypes: true })) if (e.isDirectory()) scan(join(PI_ENVS_DIR, e.name, 'extensions')); } catch {}
  return [...discovered.values()];
}

/**
 * Format a package name into a display name.
 * e.g. "pi-9router-ext" → "9router", "whatsapp-pi" → "WhatsApp"
 */
function formatDisplayName(id: string): string {
  // Remove common prefixes
  const name = id
    .replace(/^pi-/, '')
    .replace(/-ext$/, '')
    .replace(/-pi$/, '');

  // Handle special cases
  if (name === '9router') return '9Router';

  // Capitalize words and handle hyphens
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Look for config files for an npm extension package.
 * Checks common config locations based on package conventions.
 */
function findExtensionConfig(ext: DiscoveredExtension): { configPath: string | null; config: Record<string, any> } {
  const configCandidates: string[] = [];

  if (ext.source === 'npm' && ext.moduleDir) {
    // Check package.json for config hints
    const pkgJsonPath = join(ext.moduleDir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        // Some packages define config paths in their package.json
        if (pkg.pi?.configPath) {
          configCandidates.push(join(ext.moduleDir, pkg.pi.configPath));
        }
      } catch {}
    }

    // Common config locations relative to the module
    configCandidates.push(
      join(ext.moduleDir, 'config.json'),
      join(ext.moduleDir, '.config.json'),
    );
  }

  // Check agent-level config directories
  const agentConfigPaths = [
    join(PI_DIR, `${ext.id}-config.json`),
    join(PI_DIR, `${ext.id.replace(/^pi-/, '').replace(/-ext$/, '')}-config.json`),
    join(PI_DIR, 'config', `${ext.id}.json`),
  ];
  configCandidates.push(...agentConfigPaths);

  // Also check the handler's known config paths
  const handler = getExtensionHandler(ext.id);
  if (handler?.configPaths) {
    configCandidates.push(...handler.configPaths);
  }

  for (const path of configCandidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        return { configPath: path, config: JSON.parse(raw) };
      } catch {
        return { configPath: path, config: {} };
      }
    }
  }

  return { configPath: null, config: {} };
}

// ── Main extension reading ──

/** Names found by directory discovery in the master extensions/ dir —
 *  refilled on every readExtensions, used by enabledExtensionsFor. */
const localExtensionNames = new Set<string>();

export async function readExtensions(): Promise<void> {
  const extensions: ExtensionInfo[] = [];

  // Discover all enabled extensions
  const npmExts = discoverNpmExtensions();
  const localExts = discoverLocalExtensions();
  localExtensionNames.clear();
  for (const e of localExts) localExtensionNames.add(e.id);
  const allDiscovered = [...npmExts, ...localExts];

  for (const ext of allDiscovered) {
    const { configPath, config } = findExtensionConfig(ext);

    let info: ExtensionInfo = {
      name: ext.id,
      displayName: ext.displayName,
      configPath,
      hasConfig: configPath !== null,
      // 'no config' = the extension has no config file (perfectly normal —
      // some extensions keep data in a directory or need nothing at all).
      // Not an error state; handlers may still override status/statusText.
      status: configPath ? 'ok' : 'neutral',
      statusText: 'Loaded',
      details: config,
    };

    // Apply handler enrichment if one exists
    const handler = getExtensionHandler(ext.id);
    if (handler) {
      try {
        info = await handler.enrich(info);
      } catch (err) {
        log.extensions.error(`Extension handler error for ${ext.id}:`, err);
        info.status = 'error';
        info.statusText = 'Error';
      }
    }

    extensions.push(info);
  }

  // Update the shared state array in place
  extensionsState.length = 0;
  extensionsState.push(...extensions);
}

/**
 * The caller-visible extension subset: what their pi env actually loads
 * (env settings.json packages). Global extensionsState holds every
 * package the MASTER environment has installed — a user who has not
 * enabled one (e.g. unchecked it in Settings → Extensions) must not see
 * it as active on their Agent card.
 */
export function enabledExtensionsFor(user: string): ExtensionInfo[] {
  // Strip both package-source schemes ('npm:x' from settings packages,
  // 'local:x' bundled extras) — the set must hold bare extension names.
  const enabled = new Set(getEnabledPackages(user).map((p) => p.replace(/^npm:/, '').replace(/^local:/, '')));
  // Bundled extras (pi-ext-extra) show as active iff in the user's saved
  // choice set — desiredExtras merges the autere-extensions.json file with
  // the bundled availability. Note: pi also loads whatever is linked in the
  // env extensions dir, so applySettingsToPiEnv keeps links = choices.
  return extensionsState.filter((e) => enabled.has(e.name));
}