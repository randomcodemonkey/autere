import { getUserSetting } from './user-settings.js';
import { filterScopedModels } from './utils.js';
import { log } from './logger.js';

interface CatalogEntry { models: any[]; fetchedAt: number }
const catalogCache = new Map<string, CatalogEntry>();
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * Scoped model list that does NOT require a running pi session.
 *
 * Lazy spawn means an idle session has no process — and no pi RPC to ask for
 * its model catalog. This fetches the router's /v1/models directly (the same
 * source pi discovers from) and filters by the user's enabled-models
 * patterns. Cached per user; on failure the last good list is served.
 */
export async function getScopedModelCatalog(user: string, provider?: string): Promise<any[]> {
  const cached = catalogCache.get(user);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.models;
  const baseUrl = String(getUserSetting(user, 'nineRouterBaseUrl', '') || '').replace(/\/$/, '');
  const apiKey = String(getUserSetting(user, 'nineRouterApiKey', '') || '');
  if (!baseUrl) return [];
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const body: any = await res.json();
    const ids: string[] = (body?.data || []).map((m: any) => m.id).filter(Boolean);
    const scoped = filterScopedModels(ids.map((id) => ({ provider: provider || '', id, name: id })))
      .map((m: any) => ({ provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevel: undefined }));
    catalogCache.set(user, { models: scoped, fetchedAt: Date.now() });
    return scoped;
  } catch (err) {
    log.http.error(`Failed to fetch model catalog for ${user}:`, err);
    return cached?.models ?? [];
  }
}