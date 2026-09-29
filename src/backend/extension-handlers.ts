/**
 * Named extension handlers.
 *
 * Each handler provides custom enrichment logic for a specific extension.
 * Handlers are registered by name and matched against discovered extensions.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { ExtensionHandler, ExtensionInfo, ExtensionSection } from './types.js';
import { PI_DIR } from './constants.js';
import { PI_ENVS_DIR } from './pi-env.js';
import { sanitizeUserName } from '../shared/format.js';
import { getUserSetting } from './user-settings.js';
import { log } from './logger.js';
import { readSessions } from './sessions.js';
import { addUsage, emptyTotals, finalize, usageFromMessage, type CopilotTotals } from './copilot-totals.js';

// ── 9router handler ──

const NINE_ROUTER_CONFIG_PATH = join(PI_DIR, '9router-config.json');

/** fetch with a hard abort timeout (default 5s) — shared by all 9router calls */
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkNineRouterStatus(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: 'GET', headers });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
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
    const res = await fetchWithTimeout(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return null;
    // Extract auth_token from set-cookie header
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/auth_token=([^;]+)/);
    return match ? match[1] : null;
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

    const res = await fetchWithTimeout(`${baseUrl}/api/usage/stats?period=today`, {
      method: 'GET',
      headers: { Accept: 'application/json', Cookie: `auth_token=${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.recentRequests) ? data.recentRequests : [];
  } catch (err: any) {
    log.extHandlers.warn('9router: fetchRecentRequests failed:', err?.message || err);
    return [];
  }
}

function formatRecentRequests(requests: NineRouterRecentRequest[]): ExtensionSection {
  const items = requests.slice(0, 20).map((req) => {
    const row: Record<string, any> = {};
    if (req.timestamp) {
      // UTC epoch millis — clients render timestamps themselves (locale/timezone)
      row['Time'] = new Date(req.timestamp).getTime();
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
    const config = getRouterConfig('admin');
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

// ── pi-dedup handler ──

/**
 * Basename → display name (user-set session name, else file stem) and last
 * activity (file mtime) for the requesting user's sessions. Shared by the
 * dedup/janitor modals so per-session rows can sort and label by activity.
 */
function sessionMetaFor(user: string): Map<string, { name: string; lastActivity: number }> {
	const map = new Map<string, { name: string; lastActivity: number }>();
	try {
		for (const s of readSessions(user)) {
			const file = s.sessionFile.split('/').pop() || s.sessionFile;
			map.set(file, { name: s.sessionName || file.replace(/\.jsonl$/, ''), lastActivity: s.lastActivity });
		}
	} catch {
		// names/activity are decoration — stats still render without them
	}
	return map;
}

interface DedupSessionStat {
	name: string;
	displayName: string;
	lastActivity: number;
	blocks: number;
	chars: number;
	tokens: number;
	last: string;
}

/**
 * Per-session dedup savings for ONE user's pi env. Each pi process writes
 * dedup-stats.json into its OWN env (PI_CODING_AGENT_DIR); this reads only
 * the requesting user's file — never another env's.
 */
function dedupStatsFor(user: string): DedupSessionStat[] {
	let data: any;
	try {
		data = JSON.parse(readFileSync(join(PI_ENVS_DIR, sanitizeUserName(user), 'dedup-stats.json'), 'utf-8'));
	} catch {
		return [];
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
	const meta = sessionMetaFor(user);
	return Object.entries<any>(data)
		.map(([file, s]) => {
			const m = meta.get(file);
			return {
				name: file.replace(/\.jsonl$/, ''),
				displayName: m?.name ?? file.replace(/\.jsonl$/, ''),
				lastActivity: m?.lastActivity ?? 0,
				blocks: s?.elidedBlocks || 0,
				chars: s?.charsSaved || 0,
				tokens: s?.tokensSaved || 0,
				last: String(s?.lastElision ?? ''),
			};
		})
		.filter((s) => s.blocks > 0)
		.sort((a, b) => b.lastActivity - a.lastActivity || b.last.localeCompare(a.last));
}

/**
 * Zero-placeholder sections for the shared global state — no user data.
 * Keeps the extension row clickable; real numbers are injected per request
 * by withDedupSections().
 */
const DEDUP_PLACEHOLDER: ExtensionSection[] = [{
	header: 'Savings',
	items: [{
		'Blocks elided': 0,
		'Chars saved': 0,
		'Approx tokens saved': 0,
	}],
}];

/**
 * Returns a copy of the extension info with the GIVEN USER's own dedup
 * stats as sections. Called per /api/extensions request; the shared global
 * state is never mutated.
 */
export function withDedupSections(info: ExtensionInfo, user: string): ExtensionInfo {
	const sessions = dedupStatsFor(user);
	const blocks = sessions.reduce((n, s) => n + s.blocks, 0);
	const chars = sessions.reduce((n, s) => n + s.chars, 0);
	const tokens = sessions.reduce((n, s) => n + s.tokens, 0);
	const sections: ExtensionSection[] = [{
		header: 'Savings',
		items: [
			{ 'Blocks elided': blocks, 'Chars saved': chars, 'Approx tokens saved': tokens },
			...sessions.map((s) => ({
				'Session': s.displayName,
				'Blocks': s.blocks,
				'Chars': s.chars,
				'Tokens': s.tokens,
				'Last active': s.lastActivity,
			})),
		],
	}];
	return {
		...info,
		sections,
		status: blocks > 0 ? 'ok' : info.status,
		statusText: blocks > 0 ? 'Active' : info.statusText,
	};
}

const piDedupHandler: ExtensionHandler = {
	name: 'pi-dedup',
	displayName: 'Dedup',

	enrich(info: ExtensionInfo): ExtensionInfo {
		// Intentionally user-agnostic: enrichment happens at poll time without
		// a request context, so no per-user stats may be attached here. The
		// zero placeholder keeps the row clickable; /api/extensions swaps in
		// the requesting user's own numbers.
		info.sections = DEDUP_PLACEHOLDER.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) }));
		return info;
	},
};

register(piDedupHandler);

// ── pi-janitor handler ──

interface JanitorSessionStat {
	name: string;
	displayName: string;
	lastActivity: number;
	sweeps: number;
	toolResults: number;
	images: number;
	tokens: number;
	requestsObserved: number;
	naturalMisses: number;
	missedTokens: number;
	postSweepRequests: number;
	warmGap: number;
	threshold: number;
	telemetry: string;
	last: string;
}

/**
 * Per-session janitor stats for ONE user's pi env. Each pi process writes
 * janitor-stats.json into its OWN env (PI_CODING_AGENT_DIR); this reads only
 * the requesting user's file — never another env's.
 */
function janitorStatsFor(user: string): JanitorSessionStat[] {
	let data: any;
	try {
		data = JSON.parse(readFileSync(join(PI_ENVS_DIR, sanitizeUserName(user), 'janitor-stats.json'), 'utf-8'));
	} catch {
		return [];
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
	const meta = sessionMetaFor(user);
	return Object.entries<any>(data)
		.map(([file, s]) => {
			const m = meta.get(file);
			return {
				name: file.replace(/\.jsonl$/, ''),
				displayName: m?.name ?? file.replace(/\.jsonl$/, ''),
				lastActivity: m?.lastActivity ?? 0,
				sweeps: s?.sweeps || 0,
			toolResults: s?.stubbedToolResults || 0,
			images: s?.stubbedImages || 0,
			tokens: Math.round((s?.textCharsSaved || 0) / 4),
			requestsObserved: s?.requestsObserved || 0,
			naturalMisses: s?.naturalMisses || 0,
			missedTokens: s?.missedTokens || 0,
			postSweepRequests: s?.postSweepRequests || 0,
			warmGap: s?.warmGapSec || 0,
			threshold: s?.thresholdSec || 0,
			telemetry: s?.telemetry === 'observed' ? 'observed' : 'none',
			last: String(s?.lastSweep ?? ''),
		};
		})
		// Observation-only sessions are worth showing (cache stats), silent ones are not.
		.filter((s) => s.sweeps > 0 || s.requestsObserved > 0)
		.sort((a, b) => b.lastActivity - a.lastActivity || b.last.localeCompare(a.last));
}

/**
 * Zero-placeholder sections for the shared global state — no user data.
 * Real numbers are injected per request by withJanitorSections().
 */
const JANITOR_PLACEHOLDER: ExtensionSection[] = [
	{
		header: 'Cache observations',
		items: [{
			'Requests observed': 0,
			'Cache misses': 0,
			'Missed tokens': 0,
			'Post-sweep requests': 0,
			'Observed cache TTL (s)': 0,
			'Sweep threshold (s)': 0,
		}],
	},
	{
		header: 'Cleanups',
		items: [{
			'Sweeps': 0,
			'Tool results stubbed': 0,
			'Images stubbed': 0,
			'Approx tokens saved': 0,
		}],
	},
];

/**
 * Returns a copy of the extension info with the GIVEN USER's own janitor
 * stats as sections. Called per /api/extensions request; the shared global
 * state is never mutated.
 */
export function withJanitorSections(info: ExtensionInfo, user: string): ExtensionInfo {
	const sessions = janitorStatsFor(user);
	const sum = (f: (s: JanitorSessionStat) => number) => sessions.reduce((n, s) => n + f(s), 0);
	const maxOr0 = (f: (s: JanitorSessionStat) => number) => (sessions.length ? Math.max(...sessions.map(f)) : 0);
	const sections: ExtensionSection[] = [
		{
			header: 'Cache observations',
			items: [
				{
					'Requests observed': sum((s) => s.requestsObserved),
					'Cache misses': sum((s) => s.naturalMisses),
					'Missed tokens': sum((s) => s.missedTokens),
					'Post-sweep requests': sum((s) => s.postSweepRequests),
					'Observed cache TTL (s)': maxOr0((s) => s.warmGap),
					'Sweep threshold (s)': maxOr0((s) => s.threshold),
				},
				...sessions.map((s) => ({
					'Session': s.displayName,
					'Requests': s.requestsObserved,
					'Misses': s.naturalMisses,
					'Missed tokens': s.missedTokens,
					'Cache TTL (s)': s.warmGap,
					'Threshold (s)': s.threshold,
					'Last active': s.lastActivity,
				})),
			],
		},
		{
			header: 'Cleanups',
			items: [
				{
					'Sweeps': sum((s) => s.sweeps),
					'Tool results stubbed': sum((s) => s.toolResults),
					'Images stubbed': sum((s) => s.images),
					'Approx tokens saved': sum((s) => s.tokens),
				},
				...sessions.filter((s) => s.sweeps > 0).map((s) => ({
					'Session': s.displayName,
					'Sweeps': s.sweeps,
					'Tool results': s.toolResults,
					'Images': s.images,
					'Tokens saved': s.tokens,
					'Last sweep': s.last,
					'Last active': s.lastActivity,
				})),
			],
		},
	];
	const active = sum((s) => s.sweeps) > 0;
	return {
		...info,
		sections,
		status: active ? 'ok' : info.status,
		statusText: active ? 'Active' : info.statusText,
	};
}

const piJanitorHandler: ExtensionHandler = {
	name: 'pi-janitor',
	displayName: 'Janitor',
	enrich(info: ExtensionInfo): ExtensionInfo {
		// Intentionally user-agnostic: enrichment happens at poll time without
		// a request context, so no per-user stats may be attached here. The
		// zero placeholder keeps the row clickable; /api/extensions swaps in
		// the requesting user's own numbers.
		info.sections = JANITOR_PLACEHOLDER.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) }));
		return info;
	},
};

register(piJanitorHandler);

// ── copilot-credit-usage handler ──

/**
 * Copilot AI-credit usage per user, computed from THEIR session files
 * (copilot-credit-usage stores nothing on disk — the numbers derive from
 * pi session data, so compute server-side from the requesting user's env).
 * Exported for the /api/extensions injection point in routes.ts.
 */
export function copilotStatsFor(user: string): { session: CopilotTotals; month: CopilotTotals } {
	const monthKey = new Date().toISOString().slice(0, 7);
	const session = emptyTotals();
	const month = emptyTotals();
	for (const s of readSessions(user)) {
		if (!existsSync(s.sessionFile)) continue;
		let lines: string[];
		try { lines = readFileSync(s.sessionFile, 'utf-8').split('\n'); } catch { continue; }
		for (const line of lines) {
			if (!line.trim()) continue;
			let e: any;
			try { e = JSON.parse(line); } catch { continue; }
			if (e.type !== 'message') continue;
			const u = usageFromMessage(e.message);
			if (!u) continue;
			addUsage(session, u);
			const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 7) : '';
			if (!ts || ts === monthKey) addUsage(month, u);
		}
	}
	return { session: finalize(session), month: finalize(month) };
}

const piCopilotHandler: ExtensionHandler = {
	name: 'copilot-credit-usage',
	displayName: 'Copilot Credit Usage',
	async enrich(info: ExtensionInfo): Promise<ExtensionInfo> {
		// User-agnostic enrichment — real per-user numbers swap in per request
		// (same pattern as pi-dedup/pi-janitor).
		info.sections = [
			{ header: 'AI credit usage (this env)', items: [{ 'Copilot turns': 0, 'Input tokens': 0, 'Output tokens': 0, 'Session usage': '0 AIC', 'This month': '0 AIC' }] },
		];
		return info;
	},
};

register(piCopilotHandler);

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
