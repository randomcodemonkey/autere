/**
 * 9router image-model discovery + "resolve image model" fallback used by the
 * Images settings section. Direct HTTP because image models are a 9router
 * concept (capabilities.imageOutput); when 9router is unavailable we fall
 * back to the current session model (the caller passes it in).
 */
import { readFileSync, existsSync } from 'fs';

import { join } from 'path';
import { EXTENSIONS_DIR } from './constants.js';
import { getPiEnvDir } from './pi-env.js';

const PI_DIR = join(EXTENSIONS_DIR, '..');
/** Master pi env's 9router config (fallback when the user env has none). */
const NINE_ROUTER_CONFIG_PATH = join(PI_DIR, '9router-config.json');

/** Whether the pi-images extension is installed in the master pi environment. */
export function isPiImagesInstalled(): boolean {
	try {
		return existsSync(join(PI_DIR, 'extensions', 'pi-images'));
	} catch {
		return false;
	}
}

/** 9router config for the given user env, falling back to the master config. */
export function getRouterConfig(user?: string): { baseUrl: string; apiKey: string } {
	try {
		if (user) {
			const envRaw = readFileSync(join(getPiEnvDir(user), '9router-config.json'), 'utf-8');
			const envConfig = JSON.parse(envRaw);
			if (envConfig?.baseUrl) {
				return { baseUrl: String(envConfig.baseUrl).replace(/\/+$/, ''), apiKey: String(envConfig.apiKey || '') };
			}
		}
	} catch { /* fall through to master config */ }
	try {
		const config = JSON.parse(readFileSync(NINE_ROUTER_CONFIG_PATH, 'utf-8'));
		return { baseUrl: String(config.baseUrl || '').replace(/\/+$/, ''), apiKey: String(config.apiKey || '') };
	} catch {
		return { baseUrl: '', apiKey: '' };
	}
}

export interface ImageModelOption {
	id: string;
	label: string;
}

/**
 * Image-capable models from 9router. Direct provider discovery — this is
 * what pi-images itself keys off (capabilities.imageOutput). Returns
 * [] when 9router isn't configured/reachable; the caller falls back to the
 * session's chat model.
 */
export async function fetchImageModels(config: { baseUrl: string; apiKey: string }): Promise<ImageModelOption[]> {
	if (!config.baseUrl) return [];
	const res = await fetch(`${config.baseUrl}/v1/models`, {
		headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json();
	return (data.data || [])
		.filter((m: any) => m.capabilities?.imageOutput)
		.map((m: any) => ({ id: m.id, label: m.display_name || m.id }));
}

/**
 * Fallback image-model option when 9router is unavailable: the viewed
 * session's current chat model (pi-images resolves `imageModel` against
 * whatever's configured; a session model at least matches the UX context).
 */
export function fallbackImageModelOption(sessionModel?: { id?: string; name?: string }): ImageModelOption[] {
	if (!sessionModel?.id) return [];
	return [{ id: sessionModel.id, label: `${sessionModel.name || sessionModel.id} (session model)` }];
}
