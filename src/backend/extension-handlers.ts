/**
 * Named extension handlers.
 *
 * Each handler provides custom enrichment logic for a specific extension.
 * Handlers are registered by name and matched against discovered extensions.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ExtensionHandler, ExtensionInfo, ExtensionSection } from './types.js';
import { PI_DIR } from './constants.js';
import { PI_ENVS_DIR } from './pi-env.js';
import { sanitizeUserName } from '../shared/format.js';
import { getUserSetting } from './user-settings.js';
import { log } from './logger.js';

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

/**
 * Login to 9router dashboard to get an auth_token cookie.
 * The /api/ routes require cookie-based session auth, not Bearer tokens.
 */
async function loginNineRouter(baseUrl: string, password: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      // Extract auth_token from set-cookie header
      const setCookie = res.headers.get('set-cookie') || '';
      const match = setCookie.match(/auth_token=([^;]+)/);
      return match ? match[1] : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: any) {
    log.extHandlers.error('9router: failed to login:', err?.message || err);
    return null;
  }
}

interface NineRouterRecentRequest {
  timestamp?: string;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cost?: number;
  latencyMs?: number;
  status?: string;
  error?: string;
  [key: string]: any;
}

async function fetchRecentRequests(baseUrl: string, password: string): Promise<NineRouterRecentRequest[]> {
  try {
    // Login to get session cookie
    const token = await loginNineRouter(baseUrl, password);
    if (!token) {
      log.extHandlers.warn('9router: failed to login for stats');
      return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${baseUrl}/api/usage/stats?period=today`, {
        method: 'GET',
        headers: { Accept: 'application/json', Cookie: `auth_token=${token}` },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.recentRequests) ? data.recentRequests : [];
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: any) {
    log.extHandlers.warn('9router: fetchRecentRequests failed:', err?.message || err);
    return [];
  }
}

function formatRecentRequests(requests: NineRouterRecentRequest[]): ExtensionSection {
  const items = requests.slice(0, 20).map((req) => {
    const row: Record<string, any> = {};
    if (req.timestamp) {
      const d = new Date(req.timestamp);
      row['Time'] = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    if (req.model) row['Model'] = req.model;
    if (req.provider) row['Provider'] = req.provider;
    const prompt = req.promptTokens ?? 0;
    const completion = req.completionTokens ?? 0;
    if (prompt || completion) row['Tokens'] = `${prompt} → ${completion}`;
    if (req.cost != null) row['Cost'] = `$${req.cost.toFixed(6)}`;
    if (req.status) row['Status'] = req.status;
    if (req.error) row['Error'] = req.error;
    return row;
  });
  return { header: 'Recent Requests', items };
}

const nineRouterHandler: ExtensionHandler = {
  name: 'pi-9router-ext',
  displayName: '9Router',
  configPaths: [NINE_ROUTER_CONFIG_PATH],

  async enrich(info: ExtensionInfo): Promise<ExtensionInfo> {
    // Read config via user settings (falls back to 9router-config.json)
    const config = getUserSetting('admin', 'nineRouter', {});
    if (config && typeof config === 'object') {
      info.details = { ...info.details, ...config };
      info.hasConfig = Object.keys(config).length > 0;
    }
    if (existsSync(NINE_ROUTER_CONFIG_PATH)) {
      info.configPath = NINE_ROUTER_CONFIG_PATH;
    }

    // Check connection status
    const baseUrl = info.details.baseUrl || getUserSetting('admin', 'nineRouterBaseUrl', '');
    if (baseUrl) {
      const apiKey = info.details.apiKey || getUserSetting('admin', 'nineRouterApiKey', '');
      const result = await checkNineRouterStatus(baseUrl, apiKey);
      info.status = result.ok ? 'ok' : 'error';
      info.statusText = result.ok ? 'Connected' : 'Error';
      if (!result.ok) {
        info.details.connectionError = result.error;
      } else {
        delete info.details.connectionError;
      }

      // Fetch recent requests for the details modal
      if (result.ok) {
        // Password from user-scored settings (reads INITIAL_PASSWORD env var for now)
        const password = getUserSetting('admin', 'nineRouterPassword', '');
        if (password) {
          const requests = await fetchRecentRequests(baseUrl, password);
          if (requests.length > 0) {
            info.sections = [formatRecentRequests(requests)];
          }
        }
      }
    } else {
      info.status = 'neutral';
      info.statusText = 'Not configured';
    }

    return info;
  },
};

// ── pi-memory handler ──

// pi-memory storage: $HOME/.pi/agent/memory by default; per-user pi envs get
// PI_MEMORY_DIR=<env>/memory at spawn, so the admin env's memory lives there.
// (Handler enrichment follows the 9router handler's admin-scoped pattern.)
const MEMORY_DIR_CANDIDATES = [
  join(PI_ENVS_DIR, sanitizeUserName('admin'), 'memory'), // per-user env (via PI_MEMORY_DIR)
  join(PI_DIR, 'memory'), // master pi agent dir
];

function memoryDir(): string | null {
  for (const dir of MEMORY_DIR_CANDIDATES) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const memoryHandler: ExtensionHandler = {
  name: 'pi-memory',
  displayName: 'Memory',

  async enrich(info: ExtensionInfo): Promise<ExtensionInfo> {
    // pi-memory is config-less: its state is the memory directory
    // (MEMORY.md + daily/ logs + recovery/ records). Surface that as
    // generic sections for the details modal.
    const dir = memoryDir();
    if (!dir) {
      info.status = 'neutral';
      info.statusText = 'Not configured';
      return info;
    }
    info.status = 'ok';
    info.statusText = 'Available';

    const memoryMd = join(dir, 'MEMORY.md');
    const dailyDir = join(dir, 'daily');
    const recoveryDir = join(dir, 'recovery');

    const statFile = (path: string): { size?: number; modified?: Date } => {
      try {
        const st = statSync(path);
        return { size: st.size, modified: st.mtime };
      } catch {
        return {};
      }
    };

    const overview: Record<string, any> = {};
    try {
      const st = statSync(memoryMd);
      overview['Memory file'] = `${formatBytes(st.size)}, modified ${st.mtime.toLocaleString()}`;
    } catch {
      overview['Memory file'] = 'not created yet';
    }
    try {
      overview['Daily logs'] = readdirSync(dailyDir).filter((f) => f.endsWith('.md')).length;
    } catch {
      overview['Daily logs'] = 0;
    }
    try {
      overview['Recovery records'] = readdirSync(recoveryDir).length;
    } catch {
      overview['Recovery records'] = 0;
    }

    const sections: ExtensionSection[] = [{ header: 'Overview', items: [overview] }];

    // Recent daily logs (newest first, max 10)
    try {
      const logs = readdirSync(dailyDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 10);
      if (logs.length > 0) {
        sections.push({
          header: 'Recent Daily Logs',
          items: logs.map((f) => {
            const { size, modified } = statFile(join(dailyDir, f));
            return {
              'Date': f.replace(/\.md$/, ''),
              'Size': size != null ? formatBytes(size) : '-',
              'Modified': modified ? modified.toLocaleString() : '-',
            };
          }),
        });
      }
    } catch {
      // no daily dir yet
    }

    info.sections = sections;
    return info;
  },
};

// ── pi-images handler ──

const piImagesHandler: ExtensionHandler = {
  name: 'pi-images',
  displayName: 'Images',
  configPaths: [NINE_ROUTER_CONFIG_PATH],

  async enrich(info: ExtensionInfo): Promise<ExtensionInfo> {
    const { getRouterConfig, fetchImageModels } = await import('./image-models.js');
    const config = getRouterConfig();
    info.configPath = NINE_ROUTER_CONFIG_PATH;
    info.hasConfig = existsSync(NINE_ROUTER_CONFIG_PATH);

    const selectedModel = getUserSetting('admin', 'imageModel', '');
    if (selectedModel) info.details.selectedModel = selectedModel;

    if (!config.baseUrl) {
      info.status = 'neutral';
      info.statusText = 'Not configured';
      return info;
    }

    try {
      const models = await fetchImageModels(config);
      info.details.imageModelCount = models.length;
      if (models.length === 0) {
        info.status = 'error';
        info.statusText = 'Error';
        info.details.connectionError = 'No image-capable models (capabilities.imageOutput) found on 9router';
        return info;
      }
      info.status = 'ok';
      info.statusText = 'Available';
      info.sections = [
        {
          header: 'Available Image Models',
          items: models.map((m) => ({
            'Model': m.id,
            'Selected': selectedModel === m.id ? 'yes' : '',
          })),
        },
      ];
      return info;
    } catch (err: any) {
      info.status = 'error';
      info.statusText = 'Error';
      info.details.connectionError = err?.name === 'AbortError' ? 'Connection timeout' : (err?.message || String(err));
      return info;
    }
  },
};

// ── Registry ──

const handlers = new Map<string, ExtensionHandler>();

function register(handler: ExtensionHandler) {
  handlers.set(handler.name, handler);
}

// Register built-in handlers
register(nineRouterHandler);
register(memoryHandler);
register(piImagesHandler);

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
