/**
 * pi-token-reserve — percentage-based compaction context reserve for pi.
 *
 * pi's compaction.reserveTokens is a fixed token count (default 16384), but
 * the right reserve depends on the model's context window. This extension
 * lets you configure it as a PERCENTAGE of the current model's context
 * window instead — per model — and applies it to a RUNNING pi process, no
 * restart:
 *
 * - session_before_compact: rewrites preparation.settings.reserveTokens to
 *   pct of the current model's context window. pi reads settings from the
 *   preparation object by reference when it runs the compaction, so the
 *   mutated value governs both the summary token budget and the trigger
 *   threshold of any compaction pi started itself.
 * - agent_end: pi's built-in threshold check uses the STATIC settings value,
 *   which would fire too late when pct-derived reserve > 16384. If context
 *   usage crossed the pct threshold and no messages are queued, trigger
 *   compaction directly (safe: ctx.compact() aborts a settled/idle agent;
 *   with queued messages we skip and let pi's own threshold/overflow
 *   recovery handle it).
 *
 * Model changes are covered automatically: the reserve is always computed
 * from the live ctx.model.contextWindow, never cached.
 *
 * Config: <agent-dir>/pi-token-reserve-config.json
 *   {"percent": N, "perModel": {"provider/modelId": M, "bare-id": M}}
 * (agent dir = PI_CODING_AGENT_DIR, defaulting to ~/.pi/agent). `perModel`
 * wins for the current model — keys match `provider/id`, bare `id`, or any
 * key whose id suffix equals the model id (tolerates key-format drift).
 * Models without an entry use `percent`. Missing file / percent=0 / no
 * match → inert (pi default behavior). Dashboards that manage pi
 * environments (e.g. autere) can rewrite the file at any time; it is
 * picked up on the next compaction-relevant event.
 *
 * ponytail: branchSummary.reserveTokens (separate pi setting) is left at
 * its default — only compaction reserve is policy-managed. Add on request.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_NAME = "pi-token-reserve-config.json";
const MAX_PERCENT = 90;

function configPath(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		CONFIG_NAME,
	);
}

function clampPercent(n: unknown): number {
	const num = typeof n === "number" ? n : parseInt(String(n), 10);
	return Number.isFinite(num) ? Math.min(MAX_PERCENT, Math.max(0, Math.floor(num))) : 0;
}

// Mirrors src/shared/format.ts matchModelMap (the extension is standalone).
function matchPercent(perModel: Record<string, unknown>, model: any): number | undefined {
	const id: string | undefined = model?.id;
	if (!perModel || typeof id !== "string" || !id) return undefined;
	const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
	for (const key of typeof model?.provider === "string" && model.provider ? [`${model.provider}/${id}`, id] : [id]) {
		if (key in perModel) return clampPercent(perModel[key]);
	}
	for (const [key, value] of Object.entries(perModel)) {
		const slash = key.indexOf("/");
		if (slash > 0 && key.slice(slash + 1) === bare) return clampPercent(value);
	}
	return undefined;
}

let cache: { mtime: number; percent: number; perModel: Record<string, unknown> } | null = null;

function readConfig(): { percent: number; perModel: Record<string, unknown> } {
	const path = configPath();
	if (!existsSync(path)) return { percent: 0, perModel: {} };
	try {
		const mtime = statSync(path).mtimeMs;
		if (cache && cache.mtime === mtime) return cache;
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const perModel = raw?.perModel && typeof raw.perModel === "object" && !Array.isArray(raw.perModel) ? raw.perModel : {};
		const cfg = { percent: clampPercent(raw?.percent), perModel };
		cache = { mtime, ...cfg };
		return cfg;
	} catch {
		return { percent: 0, perModel: {} };
	}
}

/** Effective reserve % for a model: perModel match, else the `percent` fallback. */
function readPercent(model?: any): number {
	const { percent, perModel } = readConfig();
	return matchPercent(perModel, model) ?? percent;
}

export default function (pi: any) {
	pi.on("session_before_compact", (event: any, ctx: any) => {
		const percent = readPercent(ctx.model);
		const window = ctx.model?.contextWindow ?? 0;
		if (percent <= 0 || window <= 0) return;
		event.preparation.settings.reserveTokens = Math.floor((window * percent) / 100);
	});

	pi.on("agent_end", (_event: any, ctx: any) => {
		const percent = readPercent(ctx.model);
		if (percent <= 0) return;
		if (ctx.hasPendingMessages?.()) return;
		const usage = ctx.getContextUsage?.();
		if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return;
		const reserve = Math.floor((usage.contextWindow * percent) / 100);
		if (reserve > 0 && usage.tokens > usage.contextWindow - reserve) ctx.compact();
	});
}
