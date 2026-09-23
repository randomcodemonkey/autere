/**
 * pi-dedup — elides exact-duplicate tool results to shrink the context sent
 * to the LLM, and records the approximate savings for the dashboard.
 *
 * On `tool_result`: hash the tool call (name + input arguments) and the
 * result's text. If an identical call+result appeared earlier in the same
 * session (and is still in context — see below), replace this occurrence with
 * a short pointer to that first occurrence. Same output from a different
 * command (e.g. piping to different files) is NOT a duplicate. Only the
 * NEW occurrence is ever modified: history before the newest message stays
 * byte-stable, so provider prompt caching keeps working. The pointer resolves
 * to the in-context first occurrence and advises a re-run; an immediate re-run
 * (same fingerprint as the previous tool result) passes through with real
 * content. Only non-consecutive duplicates are elided.
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
const MIN_SAVED_CHARS = 20; // elide only when the block beats the pointer by this margin
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
	// Session basename → fingerprint of the last hashed tool result (rerun detection)
	const lastHash = new Map<string, string>();

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
		if (text.length < MIN_SAVED_CHARS) return;

		let set = seen.get(key);
		if (!set) {
			set = new Set();
			seen.set(key, set);
		}
		const hash = createHash("sha1")
			.update(JSON.stringify([event.toolName, event.input ?? null, text]))
			.digest("hex");
		const consecutive = lastHash.get(key) === hash;
		lastHash.set(key, hash);
		if (!set.has(hash)) {
			set.add(hash);
			return;
		}
		// Immediate re-run (same call twice in a row) → real content. The
		// pointer advises re-running, so the re-run must show the actual bytes.
		// ponytail: only the immediately-previous hashed result counts as "in a
		// row"; small/error/mixed results in between don't break the streak.
		if (consecutive) return;

		// Non-consecutive duplicate → pointer to the in-context first occurrence.
		// Elide only when the block is big enough to actually pay for the pointer.
		const pointer =
			`⟪pi-dedup: identical ${event.toolName} call+result earlier — re-run the tool to see it⟫`;
		const saved = text.length - pointer.length;
		if (saved < MIN_SAVED_CHARS) return;
		const approxTokens = Math.round(saved / CHARS_PER_TOKEN);
		recordElision(key, saved);

		return { content: [{ type: "text", text: pointer }] };
	});

	pi.on("session_compact", (_event: any, ctx: any) => {
		const key = sessionKey(ctx);
		if (key) {
			seen.delete(key);
			lastHash.delete(key);
		}
	});
}
