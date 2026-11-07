/**
 * pi-compaction-prompt - user-configurable extension of pi's default compaction
 * summary prompt, managed by the autere dashboard (Settings card).
 *
 * pi's compaction summarizer appends "custom instructions" to its default
 * summary prompt as "\n\nAdditional focus: <text>" (fresh compaction and the
 * iterative "update" variant alike). This extension applies the prompt the
 * user stores in autere settings to EVERY compaction pi performs:
 *
 * - session_before_compact: runs pi's own default compaction (the exported
 *   `compact()` of @earendil-works/pi-coding-agent) with the stored prompt,
 *   keeping summary format, file lists, split-turn handling and persistence
 *   identical to vanilla pi - only the prompt gains the extra focus block.
 *   Falls back to the vanilla flow on error. Manual /compact instructions
 *   are combined with the stored prompt.
 * - turn_end: overrun guard. When the run still has queued work (a next turn
 *   is coming), a compaction is chained at this turn boundary and the turn
 *   continues afterwards - instead of pi compacting only after the run ends.
 *   pi cannot do this itself: its thresholds use the STATIC reserveTokens and
 *   pi-token-reserve's agent_end hook bails while messages are pending, so a
 *   queued chain let the context grow to the model window. The trigger is
 *   compactAtTokens when set, else the reserve-% policy of pi-token-reserve
 *   (window - reserve), so one policy knob rules both. Compaction drafts
 *   bypass session_before_compact, so the prompt is passed explicitly here.
 *
 * Config: <agent-dir>/pi-compaction-prompt-config.json (mtime-cached, live-read)
 *   {"summaryPromptExtra": "...", "compactAtTokens": 123456}
 * (agent dir = PI_CODING_AGENT_DIR, defaulting to ~/.pi/agent; autere writes
 * the file from Settings on every settings save and pi spawn). Missing file,
 * empty prompt or no compactAtTokens -> inert (pi default behavior).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact as defaultCompact, DEFAULT_COMPACTION_SETTINGS, getPackageDir } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_NAME = "pi-compaction-prompt-config.json";
const RESERVE_CONFIG_NAME = "pi-token-reserve-config.json";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function configPath(): string {
	return join(agentDir(), CONFIG_NAME);
}

/**
 * Summaries are one bounded generation, but pi's static reserveTokens (16k, of
 * which a split turn's prefix step may use half) truncates long histories on
 * large-context models. Widen the budget to a tenth of the context window,
 * clamped by the model's own output cap; the preparation is already computed at
 * this point, so reserveTokens only sets maxTokens here.
 */
function widenBudget(preparation: any, model: any): any {
	const configured = preparation?.settings?.reserveTokens ?? 16384;
	const contextWindow = model?.contextWindow > 0 ? model.contextWindow : 0;
	const modelCap = model?.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	const target = Math.max(configured, Math.min(contextWindow ? Math.floor(contextWindow * 0.1) : configured, modelCap));
	if (target <= configured) return preparation;
	return { ...preparation, settings: { ...preparation.settings, reserveTokens: target } };
}

/**
 * Run compact() with at most ONE fallback for the failure mode that is about
 * budget rather than content ("generation hit the token cap"). Each attempt is
 * a full summarization, so the fallback is chosen by what can actually change:
 *
 * - the cap is `min(floor(0.5 * reserveTokens), model.maxTokens)` for a split
 *   turn. If the model is the binding limit, a bigger reserveTokens cannot
 *   help — rebuild the preparation keeping nothing recent instead, which
 *   removes the split turn and gives the single remaining summary the full
 *   budget.
 * - otherwise raise reserveTokens for the same preparation (already computed,
 *   so it only widens the output budget).
 */
async function compactWithFallbacks(
	preparation: any,
	branchEntries: any[] | undefined,
	model: any,
	apiKey: any,
	headers: any,
	instructions: string,
	signal: any,
	env: any,
): Promise<any> {
	const run = (prep: any) =>
		defaultCompact(prep, model, apiKey, headers, instructions, signal, undefined, undefined, env, undefined, undefined, uuidv7());
	preparation = widenBudget(preparation, model);
	const reserveTokens = preparation?.settings?.reserveTokens ?? 16384;
	const modelCap = model?.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	const isTokenCapFailure = (error: unknown) => /token cap/i.test(error instanceof Error ? error.message : String(error));
	try {
		return await run(preparation);
	} catch (error) {
		if (!isTokenCapFailure(error)) throw error;
		const modelIsTheLimit = Math.floor(0.5 * reserveTokens) >= modelCap;
		let fallback: any;
		if (modelIsTheLimit) {
			try {
				const { prepareCompaction } = await loadCompactionModule();
				fallback = branchEntries?.length
					? prepareCompaction(branchEntries, { ...preparation.settings, keepRecentTokens: 0 })
					: undefined;
			} catch {
				throw error; // no internals, no rebuild - report the primary failure
			}
		} else {
			fallback = {
				...preparation,
				settings: { ...preparation.settings, reserveTokens: Math.max(32768, reserveTokens * 2) },
			};
		}
		if (!fallback || fallback === preparation) throw error;
		try {
			return await run(fallback);
		} catch {
			throw error; // report the primary failure, not the fallback's
		}
	}
}

let cache: { mtime: number; prompt?: string; compactAtTokens?: number } | null = null;

function readConfig(): { prompt?: string; compactAtTokens?: number } {
	try {
		if (!existsSync(configPath())) return {};
		const mtime = statSync(configPath()).mtimeMs;
		if (cache && cache.mtime === mtime) return cache;
		const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
		const prompt = typeof raw?.summaryPromptExtra === "string" && raw.summaryPromptExtra.trim()
			? raw.summaryPromptExtra.trim()
			: undefined;
		const tokensNum = typeof raw?.compactAtTokens === "number" ? raw.compactAtTokens : parseInt(String(raw?.compactAtTokens ?? ""), 10);
		const compactAtTokens = Number.isFinite(tokensNum) && tokensNum > 0 ? Math.floor(tokensNum) : undefined;
		cache = { mtime, prompt, compactAtTokens };
		return cache;
	} catch {
		return {};
	}
}

/**
 * pi's root entry point does NOT export prepareCompaction (internal function),
 * yet a compaction draft needs exactly the preparation pi's own flow builds.
 * Load the compiled module from pi's package dir, resolved through its public
 * getPackageDir() - reimplementing the cut-point logic here would drift from
 * pi on every upgrade. Works under pi's extension loader (verified);
 * unavailable -> the guard is skipped and pi's own threshold still applies.
 */
let internalCompaction: Promise<any> | null = null;

function loadCompactionModule(): Promise<any> {
	internalCompaction ??= import(pathToFileURL(join(getPackageDir(), "dist", "core", "compaction", "compaction.js")).href);
	return internalCompaction;
}

/**
 * Reserve-% policy (pi-token-reserve's config, same agent dir). Standalone
 * copy of its reader: extras are installed per directory, so importing across
 * the two packages would break when only one of them is enabled.
 */
const MAX_PERCENT = 90;
let reserveCache: { mtime: number; percent: number; perModel: Record<string, unknown> } | null = null;

function clampPercent(n: unknown): number {
	const num = typeof n === "number" ? n : parseInt(String(n), 10);
	return Number.isFinite(num) ? Math.min(MAX_PERCENT, Math.max(0, Math.floor(num))) : 0;
}

/** Keys match `provider/id`, bare `id`, or any key whose id suffix is the id. */
function matchPercent(perModel: Record<string, unknown>, model: any): number | undefined {
	const id: string | undefined = model?.id;
	if (typeof id !== "string" || !id) return undefined;
	const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
	for (const key of model?.provider ? [`${model.provider}/${id}`, id] : [id]) {
		if (key in perModel) return clampPercent(perModel[key]);
	}
	for (const [key, value] of Object.entries(perModel)) {
		const slash = key.indexOf("/");
		if (slash > 0 && key.slice(slash + 1) === bare) return clampPercent(value);
	}
	return undefined;
}

function reserveConfig(): { percent: number; perModel: Record<string, unknown> } {
	const path = join(agentDir(), RESERVE_CONFIG_NAME);
	if (!existsSync(path)) return { percent: 0, perModel: {} };
	try {
		const mtime = statSync(path).mtimeMs;
		if (reserveCache && reserveCache.mtime === mtime) return reserveCache;
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const perModel = raw?.perModel && typeof raw.perModel === "object" && !Array.isArray(raw.perModel) ? raw.perModel : {};
		const cfg = { percent: clampPercent(raw?.percent), perModel };
		reserveCache = { mtime, ...cfg };
		return cfg;
	} catch {
		return { percent: 0, perModel: {} };
	}
}

/**
 * Context size at which the mid-run guard compacts. compactAtTokens wins; else
 * the reserve-% policy (window - reserve), which has no other mid-run trigger.
 * Exported for the smoke test.
 */
export function forceCompactAt(model: any, compactAtTokens: number | undefined): number | undefined {
	if (compactAtTokens) return compactAtTokens;
	const window = model?.contextWindow > 0 ? model.contextWindow : 0;
	if (window <= 0) return undefined;
	const { percent, perModel } = reserveConfig();
	const pct = matchPercent(perModel, model) ?? percent;
	if (pct <= 0) return undefined;
	return window - Math.floor((window * pct) / 100);
}

/**
 * Resolve request-time auth exactly like pi does for its own summaries
 * (AgentSession._getSummarizationRequestAuth): the credential may pin a
 * provider host (Copilot mints tokens for a specific `proxy-ep`), and compact()
 * has no baseUrl parameter — so the host must travel on the model itself.
 * Missing registry (older pi) -> pi's env credentials apply unchanged.
 */
async function summaryRequest(ctx: any): Promise<{ model: any; apiKey?: string; headers?: any; env?: Record<string, string> }> {
	try {
		const auth = await ctx.modelRegistry?.getApiKeyAndHeaders(ctx.model);
		if (auth?.ok) {
			return {
				model: auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model,
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
			};
		}
	} catch {
		// Registry unavailable — let pi resolve its own credentials
	}
	return { model: ctx.model };
}

function combined(user: string | undefined, extra: string | undefined): string {
	const parts = [user?.trim(), extra].filter((p) => p !== undefined && p.length > 0);
	return parts.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		const { prompt } = readConfig();
		if (!prompt || ctx.model === undefined) return;
		const user = combined(event.customInstructions, prompt);
		// Without the stored prompt this handler would not run; if somehow the
		// user text alone survives, pi's default path already appends it.
		if (user === event.customInstructions?.trim()) return;
		const req = await summaryRequest(ctx);
		try {
			const result = await compactWithFallbacks(event.preparation, event.branchEntries, req.model, req.apiKey, req.headers, user, event.signal, req.env);
			return { compaction: result };
		} catch (error) {
			// The request host is the usual culprit for auth failures; show it.
			const detail = req.model.baseUrl && req.model.baseUrl !== ctx.model.baseUrl ? `, host ${req.model.baseUrl}` : '';
			if (!event.signal.aborted) ctx.ui.notify(`pi-compaction-prompt: custom summary failed (${error instanceof Error ? error.message : String(error)}${detail}), using pi default`, "warning");
			return;
		}
	});

	pi.on("turn_end", async (event: any, ctx: any) => {
		if (ctx.model === undefined) return;
		// Only mid-flight: with no next turn queued the run ends and pi's
		// post-run flow handles compaction. event.continue is the value
		// accumulated from EARLIER handlers (always false for the first one),
		// not pi's decision to continue; context.canContinue is the signal.
		if (!event.context?.canContinue || event.context.pendingMessages.length === 0) return;
		if (event.entries.some((draft: any) => draft.type === "compaction")) return;
		const { prompt, compactAtTokens } = readConfig();
		const limit = forceCompactAt(ctx.model, compactAtTokens);
		if (limit === undefined) return;
		const usage = ctx.getContextUsage?.();
		if (!usage || (usage.tokens ?? 0) < limit) return;
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...(ctx.getSettings?.()?.compaction ?? {}) };
		if (!settings.enabled) return; // pi would not compact either
		let preparation: any;
		try {
			const { prepareCompaction } = await loadCompactionModule();
			preparation = prepareCompaction(ctx.sessionManager.getBranch(), settings);
		} catch (error) {
			ctx.ui.notify(`pi-compaction-prompt: guard unavailable (${error instanceof Error ? error.message : String(error)})`, "warning");
			return;
		}
		if (!preparation) return;
		const req = await summaryRequest(ctx);
		try {
			const result = await compactWithFallbacks(preparation, ctx.sessionManager.getBranch(), req.model, req.apiKey, req.headers, combined(undefined, prompt), undefined, req.env);
			ctx.ui.notify("Compaction forced mid-run (context over the configured token limit), continuing", "info");
			return {
				entries: [
					{
						type: "compaction",
						summary: result.summary,
						firstKeptEntryId: result.firstKeptEntryId,
						usage: result.usage,
						details: result.details,
					},
				],
				continue: true,
			};
		} catch (error) {
			ctx.ui.notify(`pi-compaction-prompt: guard compaction failed (${error instanceof Error ? error.message : String(error)})`, "warning");
			return;
		}
	});
}
