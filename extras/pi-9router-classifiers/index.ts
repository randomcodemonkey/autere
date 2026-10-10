/**
 * pi-9router-classifiers — exposes System One classifier models that 9router
 * proxies (e.g. openrouter/typesafe/jev-*) to codemode and extensions.
 *
 * pi-9router-ext registers every discovered /v1/models entry as a CHAT model;
 * pi only enumerates classifiers for BUILT-IN providers, so 9router's proxied
 * jev models can't be reached with classifier requests and codemode's
 * classify() has zero classifiers to use.
 *
 * This extension re-registers the "9router" provider on session_start (after
 * pi-9router-ext has registered — npm packages load after local dirs):
 *   - adds classifier entries for upstream ids that look like System One
 *     classifier routes (typesafe|jev),
 *   - supplies the built-in pi-ai `typesafe-system-one` implementation so
 *     classification (POST {baseUrl}/systemone) works through the proxy.
 * Harmless alongside pi-combo-reasoning: this only ADDS entries; chat model
 * metadata is untouched and that extension's session_start listener already
 * fixed the combos by the time this merge sees the models list.
 */
import { classify as systemOneClassify } from "@earendil-works/pi-ai/api/typesafe-system-one";

const SYSTEM_ONE_IDS = /(^|\/)(typesafe|jev)/i;

const isClassifierCandidate = (id: string): boolean => SYSTEM_ONE_IDS.test(id);

export default function (pi: any) {
	// For a resumed session, session_start can fire BEFORE pi-9router-ext's
	// async /v1/models discovery finishes registering (empty/nonexistent
	// provider config ⇒ nothing to patch) — so also retry on each agent
	// start; patching is idempotent (classifiers impl already set = no-op).
	const patch = async (_event: unknown, ctx: any) => {
		try {
			const registry = ctx?.modelRegistry;
			const cfg = registry?.getRegisteredProviderConfig?.("9router");
			if (!cfg || !Array.isArray(cfg.models) || !cfg.baseUrl) return;
			if (cfg.classifiers?.["typesafe-system-one"]) return; // already registered
			const baseUrl = String(cfg.baseUrl).replace(/\/+$/, "");
			const defs = cfg.models
				.filter((m: any) => m?.id && isClassifierCandidate(m.id))
				.filter((m: any) => !cfg.models.some((o: any) => o.id === m.id && o.type === "classifier"))
				.map((m: any) => ({
					type: "classifier",
					id: m.id,
					name: `${m.id.replace(/^.*\/typesafe\//, "")} (systemone)`,
					api: "typesafe-system-one",
					baseUrl,
					contextWindow: 8192,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}));
			if (defs.length === 0) return;
			pi.registerProvider("9router", {
				api: "openai-completions",
				baseUrl: cfg.baseUrl,
				apiKey: cfg.apiKey,
				classifiers: { "typesafe-system-one": { classify: systemOneClassify } },
				models: [...cfg.models, ...defs],
			});
		} catch (err) {
			console.warn(`[pi-9router-classifiers] ${err instanceof Error ? err.message : err}`);
		}
	};
	pi.on("session_start", patch);
	pi.on("before_agent_start", patch);
}
