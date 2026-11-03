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
 * - turn_end: optional overrun guard. When context tokens reach
 *   compactAtTokens while the run still has queued work (a next turn is
 *   coming), a compaction is chained at this turn boundary and the turn
 *   continues afterwards - instead of pi compacting only after the run ends.
 *   Compaction drafts bypass session_before_compact, so the prompt is passed
 *   explicitly here.
 *
 * Config: <agent-dir>/pi-compaction-prompt-config.json (mtime-cached, live-read)
 *   {"summaryPromptExtra": "...", "compactAtTokens": 123456}
 * (agent dir = PI_CODING_AGENT_DIR, defaulting to ~/.pi/agent; autere writes
 * the file from Settings on every settings save and pi spawn). Missing file,
 * empty prompt or no compactAtTokens -> inert (pi default behavior).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact as defaultCompact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_NAME = "pi-compaction-prompt-config.json";

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), CONFIG_NAME);
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
			fallback = branchEntries?.length
				? prepareCompaction(branchEntries, { ...preparation.settings, keepRecentTokens: 0 })
				: undefined;
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

function combined(user: string | undefined, extra: string): string {
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
		const { prompt, compactAtTokens } = readConfig();
		if (!prompt || !compactAtTokens) return;
		// Run is ending or no next turn queued -> pi's post-run threshold flow
		// handles compaction; only force it mid-flight.
		if (!event.continue || !event.context.canContinue || event.context.pendingMessages.length === 0) return;
		if (event.entries.some((draft: any) => draft.type === "compaction")) return;
		if (ctx.model === undefined) return;
		const usage = ctx.getContextUsage?.();
		if (!usage || (usage.tokens ?? 0) < compactAtTokens) return;
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...(ctx.getSettings?.()?.compaction ?? {}) };
		if (!settings.enabled) return; // pi would not compact either
		const preparation = prepareCompaction(ctx.sessionManager.getBranch(), settings);
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
