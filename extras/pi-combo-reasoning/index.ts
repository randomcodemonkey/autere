/**
 * pi-combo-reasoning — keeps reasoning (thinking) streaming as thinking blocks
 * on 9router COMBO routes.
 *
 * 9router's combo translator inlines the reasoning stream into plain
 * `content` when a request carries `reasoning_effort` (the field
 * pi-9router-ext sends for pi thinking levels). pi-ai then has nothing to
 * map into thinking blocks, so chain-of-thought shows up as regular
 * assistant text.
 *
 * This extension runs AFTER pi-9router-ext's registration (session_start:
 * npm packages load last, so a load-time patch would be stomped by their
 * later registration) and re-registers the "9router" provider with every
 * combo model's thinkingLevelMap nulled out. pi-ai then drops every
 * thinking level for combos, pi sends NO reasoning_effort field, and the
 * upstream default reasoning streams back correctly as `reasoning_content`.
 *
 * Combo detection: pi-9router-ext prefixes combo model names with "🔀".
 */
const COMBO_PREFIX = '🔀 ';

const COMBO_LEVEL_MAP: Record<string, null> = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
};

const isComboModel = (m: any): boolean =>
	m?.name?.startsWith(COMBO_PREFIX); // pi-9router-ext's combo marker

/** Patch combo models in the "9router" provider registration (if present). */
function patchComboProvider(pi: any, modelRegistry: any): boolean {
	try {
		const cfg = modelRegistry.getRegisteredProviderConfig('9router');
		if (!cfg || !Array.isArray(cfg.models)) return false;
		let changed = false;
		const models = cfg.models.map((m: any) => {
			if (!isComboModel(m)) return m;
			if (m.thinkingLevelMap && Object.values(m.thinkingLevelMap).every((v) => v === null)) return m; // already patched
			changed = true;
			return { ...m, thinkingLevelMap: { ...COMBO_LEVEL_MAP } };
		});
		if (!changed) return false;
		// Re-register only `models` — everything else merges from the previous
		// registration (baseUrl/apiKey/api stay pi-9router-ext's).
		pi.registerProvider('9router', { models });
		return true;
	} catch {
		return false; // provider not registered — nothing to do
	}
}

export default function (pi: any) {
	pi.on('session_start', async (_event: unknown, ctx: any) => {
		patchComboProvider(pi, ctx?.modelRegistry);
	});
}
