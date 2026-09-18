/**
 * pi-dedup — elides exact-duplicate tool results to shrink the context sent
 * to the LLM, and records the approximate savings for the dashboard.
 *
 * On `tool_result`: hash the result's text. If an identical result appeared
 * earlier in the same session (and is still in context — see below), replace
 * this occurrence with a short pointer to that first occurrence. Only the
 * NEW occurrence is ever modified: history before the newest message stays
 * byte-stable, so provider prompt caching keeps working. The pointer resolves
 * to real in-context text; if the model needs the exact bytes it just re-runs
 * the tool.
 *
 * `session_compact` resets the seen-set: compaction may summarize away the
 * first occurrences, which would leave pointers dangling.
 *
 * Savings (chars/tokens approximated at 4 chars/token) are written to
 * <agent-dir>/dedup-stats.json keyed by session file name — read by the
 * autere backend's pi-dedup extension handler and shown in the dashboard's
 * extension details. Stats are read-modify-written per elision because many
 * pi processes (one per session) share the file.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const STATS_FILE = "dedup-stats.json";
const MIN_CHARS = 400; // pointer must cost far less than the block it replaces
const MAX_SESSIONS = 100; // stats-file keys kept (oldest lastElision pruned)
const CHARS_PER_TOKEN = 4;

function statsPath(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		STATS_FILE,
	);
}

function readStats(): Record<string, any> {
	try {
		const parsed = JSON.parse(readFileSync(statsPath(), "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: {};
	} catch {
		return {};
	}
}

function recordElision(key: string, savedChars: number): void {
	// ponytail: key cap instead of TTL — one small object per session; raise
	// MAX_SESSIONS or prune by age if sessions outgrow this.
	const stats = readStats();
	const s = stats[key] ?? (stats[key] = { elidedBlocks: 0, charsSaved: 0, tokensSaved: 0, lastElision: "" });
	s.elidedBlocks += 1;
	s.charsSaved += savedChars;
	s.tokensSaved += Math.round(savedChars / CHARS_PER_TOKEN);
	s.lastElision = new Date().toISOString();
	const keys = Object.keys(stats);
	if (keys.length > MAX_SESSIONS) {
		keys
			.sort((a, b) => String(stats[a]?.lastElision ?? "").localeCompare(String(stats[b]?.lastElision ?? "")))
			.slice(0, keys.length - MAX_SESSIONS)
			.forEach((k) => delete stats[k]);
	}
	try {
		const tmp = statsPath() + ".tmp";
		writeFileSync(tmp, JSON.stringify(stats, null, "\t"));
		renameSync(tmp, statsPath());
	} catch {
		// stats are best-effort; elision must not fail because of I/O
	}
}

export default function (pi: any) {
	// Session basename → hashes of first occurrences still anchored in context.
	const seen = new Map<string, Set<string>>();

	const sessionKey = (ctx: any): string | null => {
		const file = ctx?.sessionManager?.getSessionFile?.();
		return file ? basename(file) : null;
	};

	pi.on("tool_result", (event: any, ctx: any) => {
		const key = sessionKey(ctx);
		if (!key || event.isError) return;
		const blocks = Array.isArray(event.content) ? event.content : [];
		if (blocks.length === 0 || !blocks.every((b: any) => b?.type === "text")) return;
		const text = blocks.map((b: any) => b.text ?? "").join("\n");
		if (text.length < MIN_CHARS) return;

		let set = seen.get(key);
		if (!set) {
			set = new Set();
			seen.set(key, set);
		}
		const hash = createHash("sha1").update(text).digest("hex");
		if (!set.has(hash)) {
			set.add(hash);
			return;
		}

		// Duplicate → pointer to the in-context first occurrence
		const approxTokens = Math.round(text.length / CHARS_PER_TOKEN);
		const pointer =
			`⟪pi-dedup: this ${event.toolName} result is identical to an earlier result in this conversation (elided). ` +
			`Re-run the tool if you need the exact text. Original: ${text.length} chars ≈ ${approxTokens} tokens.⟫`;
		const saved = Math.max(0, text.length - pointer.length);
		recordElision(key, saved);

		return { content: [{ type: "text", text: pointer }] };
	});

	pi.on("session_compact", (_event: any, ctx: any) => {
		const key = sessionKey(ctx);
		if (key) seen.delete(key);
	});
}
