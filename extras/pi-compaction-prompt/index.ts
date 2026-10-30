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
 * Stream summaries through the model registry instead of handing compact() an
 * apiKey. Request-time auth also carries a token-specific baseUrl (Copilot
 * tokens encode their API host in `proxy-ep`), which compact() has no place
 * for — without it the summary is sent to the provider's default host and
 * rejected with "IDE authentication failed ... unknown stamp".
 */
function summaryStream(ctx: any) {
	return (model: any, context: any, options: any) => ctx.modelRegistry.streamSimple(model, context, options);
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
		try {
			const result = await defaultCompact(
				event.preparation,
				ctx.model,
				undefined,
				undefined,
				user,
				event.signal,
				undefined,
				summaryStream(ctx),
				undefined,
				undefined,
				undefined,
				uuidv7(),
			);
			return { compaction: result };
		} catch (error) {
			if (!event.signal.aborted) ctx.ui.notify(`pi-compaction-prompt: custom summary failed (${error instanceof Error ? error.message : String(error)}), using pi default`, "warning");
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
		const preparation = prepareCompaction(ctx.sessionManager.getBranch(), { ...DEFAULT_COMPACTION_SETTINGS });
		if (!preparation) return;
		try {
			const result = await defaultCompact(
				preparation,
				ctx.model,
				undefined,
				undefined,
				combined(undefined, prompt),
				undefined,
				undefined,
				summaryStream(ctx),
				undefined,
				undefined,
				undefined,
				uuidv7(),
			);
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
