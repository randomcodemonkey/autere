/**
 * Named extension handlers.
 *
 * Each handler provides custom enrichment logic for a specific extension.
 * Handlers are registered by name and matched against discovered extensions.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ExtensionHandler, ExtensionInfo } from './types.js';
import { PI_DIR } from './constants.js';

// ── 9router handler ──

const NINE_ROUTER_CONFIG_PATH = join(PI_DIR, '9router-config.json');

async function checkNineRouterStatus(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${baseUrl}/v1/models`, { method: 'GET', headers, signal: controller.signal });
      if (res.ok) return { ok: true };
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: any) {
    return { ok: false, error: err?.name === 'AbortError' ? 'Connection timeout' : (err?.message || String(err)) };
  }
}

const nineRouterHandler: ExtensionHandler = {
  name: 'pi-9router-ext',
  displayName: '9Router',
  configPaths: [NINE_ROUTER_CONFIG_PATH],

  async enrich(info: ExtensionInfo): Promise<ExtensionInfo> {
    // Read config
    if (existsSync(NINE_ROUTER_CONFIG_PATH)) {
      try {
        const raw = readFileSync(NINE_ROUTER_CONFIG_PATH, 'utf-8');
        const config = JSON.parse(raw);
        info.details = { ...info.details, ...config };
        info.hasConfig = true;
        info.configPath = NINE_ROUTER_CONFIG_PATH;
      } catch (err) {
        console.error('[autere] Failed to read 9router config:', err);
      }
    }

    // Check connection status
    const baseUrl = info.details.baseUrl || process.env.NINE_ROUTER_BASE_URL;
    if (baseUrl) {
      const apiKey = info.details.apiKey || process.env.NINE_ROUTER_API_KEY;
      const result = await checkNineRouterStatus(baseUrl, apiKey);
      info.status = result.ok ? 'connected' : 'error';
      if (!result.ok) {
        info.details.connectionError = result.error;
      } else {
        delete info.details.connectionError;
      }
    } else {
      info.status = 'not configured';
    }

    return info;
  },
};

// ── Registry ──

const handlers = new Map<string, ExtensionHandler>();

function register(handler: ExtensionHandler) {
  handlers.set(handler.name, handler);
}

// Register built-in handlers
register(nineRouterHandler);

/**
 * Get a handler for the given extension name, if one exists.
 */
export function getExtensionHandler(name: string): ExtensionHandler | undefined {
  return handlers.get(name);
}

/**
 * Register a new extension handler at runtime.
 */
export function registerExtensionHandler(handler: ExtensionHandler): void {
  handlers.set(handler.name, handler);
}