/**
 * Image-model discovery against a 9router instance.
 *
 * Shared by the pi-images extension handler (status enrichment) and the
 * settings schema (image model select options). Kept dependency-free of
 * user-settings/extension-handlers to avoid circular imports.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PI_DIR } from './constants.js';

export interface RouterConfig {
	baseUrl: string;
	apiKey: string;
}

export function getRouterConfig(): RouterConfig {
	const configPath = join(PI_DIR, '9router-config.json');
	if (existsSync(configPath)) {
		try {
			const data = JSON.parse(readFileSync(configPath, 'utf-8'));
			if (data.baseUrl) {
				return { baseUrl: String(data.baseUrl).replace(/\/+$/, ''), apiKey: String(data.apiKey || '') };
			}
		} catch {
			// fall through to not-configured
		}
	}
	// ponytail: no hardcoded router URL — 9router is optional; callers treat
	// empty baseUrl as "not configured". Add defaults if a fixed target is wanted.
	return { baseUrl: '', apiKey: process.env.NINE_ROUTER_API_KEY || '' };
}

export interface ImageModelInfo {
	id: string;
	name?: string;
}

/** Fetch the list of image-output models from 9router (capabilities.imageOutput). */
export async function fetchImageModels(config: RouterConfig): Promise<ImageModelInfo[]> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(`${config.baseUrl}/v1/models`, { headers, signal: controller.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as {
			data?: { id: string; capabilities?: { imageOutput?: boolean } }[];
		};
		return (data.data || [])
			.filter((m) => m.capabilities?.imageOutput)
			.map((m) => ({ id: m.id, name: m.id }));
	} finally {
		clearTimeout(timeout);
	}
}

/** True if the pi-images extension is installed in the master pi environment. */
export function isPiImagesInstalled(): boolean {
	try {
		return existsSync(join(PI_DIR, 'extensions', 'pi-images'));
	} catch {
		return false;
	}
}
