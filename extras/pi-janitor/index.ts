/**
 * pi-janitor — idle-window context cleanup for pi.
 *
 * Providers keep the prompt prefix in a server-side cache with a TTL
 * (Anthropic ~5 min sliding, others vary). A history rewrite busts the cache
 * only if the cache is still warm — after a long idle gap the next request
 * re-bills the whole prefix at full price regardless, so rewriting history
 * during that gap is free. The janitor turns that window into context
 * savings: when a request is about to go out after a long enough idle
 * period, stale tool results, edit diffs and images (everything older than
 * the last KEEP_RECENT_TURNS user turns) are replaced with short stubs.
 * The session file itself is never touched — this is a per-call transform.
 *
 * Cache observation: every `context` event reads the previous request's
 * usage from the history's last assistant message (cacheRead/cacheWrite
 * tokens) and records (idle gap, hit/miss). The longest gap that still saw
 * a cache read sets the effective retention; the sweep threshold is 2× that
 * (floored at MIN_IDLE_SEC), so a provider whose TTL fluctuates upward
 * raises the threshold instead of getting its warm cache busted. Sweeps
 * reset the pending observation — the request right after a sweep is a
 * definitionally-cold rewrite and must not pollute retention learning.
 *
 * Cache stability between sweeps: the decision set (which toolCallIds /
 * image positions are stubbed) only ever grows, and only during cold
 * windows. Warm requests replay exactly the previously decided stubs, so
 * the transformed prefix stays byte-identical and provider caching keeps
 * working. Determinism: stub texts are pure functions of stable keys —
 * no timestamps.
 *
 * Stats (per session, janitor-stats.json in PI_CODING_AGENT_DIR, same
 * conventions as pi-dedup) are shown in the autere extension details modal.
 * The idle anchor (lastCtxAt) and counters are persisted per session: when
 * autere idle-respawns pi, the fresh process hydrates from the file so the
 * idle that killed the previous process still triggers a sweep-on-awaken
 * and the session's counters survive the restart.
 */
import { readFileSync, renameSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const STATS_FILE = "janitor-stats.json";
const CONFIG_FILE = "janitor-config.json"; // written by autere's settings save (user-settings.ts)
const MIN_IDLE_SEC = 600; // default floor (2× Anthropic's nominal 5 min)
const MAX_IDLE_SEC = 7200; // cap — beyond this, sweeping is pointless risk-averse no-op
const KEEP_RECENT_TURNS = 3; // default user turns kept fully intact
const WARM_GAP_MULTIPLIER = 2; // default safety margin on the learned retention
const MIN_STUB_MARGIN = 10; // elide only when content beats the marker by this margin
// ponytail: margin instead of a fixed floor — tracks marker length automatically
// (the ~40-char marker means ~50-char effective floor; below that the bounded
// few-token loss is the price of covering the long tail of small results)
const MAX_SESSIONS = 100; // stats-file keys kept (oldest lastSweep pruned)

/** Injectable clock for the smoke test. */
export const clock = { now: () => Date.now() };

interface JanitorConfig {
	minIdleSec: number;
	keepRecentTurns: number;
	warmGapMultiplier: number;
}

const DEFAULT_CONFIG: JanitorConfig = {
	minIdleSec: MIN_IDLE_SEC,
	keepRecentTurns: KEEP_RECENT_TURNS,
	warmGapMultiplier: WARM_GAP_MULTIPLIER,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

let configCache: { mtime: number; cfg: JanitorConfig } | null = null;

/** mtime-cached live read of the user's janitor-config.json (autere settings save). */
function readConfig(): JanitorConfig {
	const path = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), CONFIG_FILE);
	try {
		const mtime = statSync(path).mtimeMs;
		if (configCache && configCache.mtime === mtime) return configCache.cfg;
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const num = (v: any, def: number, lo: number, hi: number) =>
			(typeof v === "number" && Number.isFinite(v) ? clamp(Math.floor(v), lo, hi) : def);
		const cfg: JanitorConfig = {
			minIdleSec: num(raw?.minIdleSec, DEFAULT_CONFIG.minIdleSec, 60, MAX_IDLE_SEC),
			keepRecentTurns: num(raw?.keepRecentTurns, DEFAULT_CONFIG.keepRecentTurns, 1, 20),
			warmGapMultiplier: num(raw?.warmGapMultiplier, DEFAULT_CONFIG.warmGapMultiplier, 1, 4),
		};
		configCache = { mtime, cfg };
		return cfg;
	} catch {
		return DEFAULT_CONFIG;
	}
}

interface State {
	// Frozen transform decisions — grow only during cold windows
	tools: Set<string>; // stubbed toolCallIds
	userImages: Set<string>; // "<msgIdx>:<blockIdx>" of stubbed user-message images
	// Request bookkeeping
	lastCtxAt: number; // clock time of the previous provider request (-1 = none)
	pending: { sentAt: number; gapSec: number; swept: boolean } | null; // request awaiting usage classification
	lastModel: string;
	// Cache-behavior learning
	maxWarmGapSec: number; // longest idle gap that still saw a cache read
	telemetry: "" | "observed" | "none"; // does the provider report cache tokens at all
	// Counters (persisted)
	sweeps: number;
	stubbedToolResults: number;
	stubbedImages: number;
	textCharsSaved: number;
	imageBytesSaved: number;
	requestsObserved: number;
	naturalMisses: number;
	missedTokens: number;
	postSweepRequests: number;
	lastSweep: string;
}

function newState(): State {
	return {
		tools: new Set(), userImages: new Set(),
		lastCtxAt: -1, pending: null, lastModel: "",
		maxWarmGapSec: 0, telemetry: "",
		sweeps: 0, stubbedToolResults: 0, stubbedImages: 0,
		textCharsSaved: 0, imageBytesSaved: 0,
		requestsObserved: 0, naturalMisses: 0, missedTokens: 0, postSweepRequests: 0,
		lastSweep: "",
	};
}

// ── stats file ──

function statsPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), STATS_FILE);
}

function readStats(): Record<string, any> {
	try {
		const parsed = JSON.parse(readFileSync(statsPath(), "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function flushStats(key: string, st: State, cfg: JanitorConfig): void {
	// ponytail: read-modify-write per request — small file, low request rate;
	// switch to dirty-flag + periodic flush if request rates ever hurt.
	const stats = readStats();
	stats[key] = {
		sweeps: st.sweeps,
		stubbedToolResults: st.stubbedToolResults,
		stubbedImages: st.stubbedImages,
		textCharsSaved: st.textCharsSaved,
		imageBytesSaved: st.imageBytesSaved,
		requestsObserved: st.requestsObserved,
		naturalMisses: st.naturalMisses,
		missedTokens: st.missedTokens,
		postSweepRequests: st.postSweepRequests,
		warmGapSec: Math.round(st.maxWarmGapSec),
		thresholdSec: sweepThresholdSec(st, cfg),
		lastCtxAt: st.lastCtxAt,
		telemetry: st.telemetry,
		lastSweep: st.lastSweep,
	};
	const keys = Object.keys(stats);
	if (keys.length > MAX_SESSIONS) {
		keys
			.sort((a, b) => String(stats[a]?.lastSweep ?? "").localeCompare(String(stats[b]?.lastSweep ?? "")))
			.slice(0, keys.length - MAX_SESSIONS)
			.forEach((k) => delete stats[k]);
	}
	try {
		const tmp = statsPath() + ".tmp";
		writeFileSync(tmp, JSON.stringify(stats, null, "\t"));
		renameSync(tmp, statsPath());
	} catch {
		// stats are best-effort; cleanup must not fail because of I/O
	}
}

// ── sweep policy ──

/**
 * Hydrate a fresh process's state for `key` from its persisted stats entry.
 * A respawned pi must (a) sweep on awaken — the idle that killed the previous
 * process is exactly the janitor's window, so lastCtxAt is the anchor — and
 * (b) not reset the session's counters. Transform decisions are deliberately
 * NOT restored: the context is rebuilt from the session file and positions
 * may have shifted; a later cold window re-decides from scratch.
 */
function seedFromStats(key: string, st: State, sessionFile: string | null): void {
	const e = readStats()[key];
	if (!e || typeof e !== "object") return;
	st.sweeps = e.sweeps || 0;
	st.stubbedToolResults = e.stubbedToolResults || 0;
	st.stubbedImages = e.stubbedImages || 0;
	st.textCharsSaved = e.textCharsSaved || 0;
	st.imageBytesSaved = e.imageBytesSaved || 0;
	st.requestsObserved = e.requestsObserved || 0;
	st.naturalMisses = e.naturalMisses || 0;
	st.missedTokens = e.missedTokens || 0;
	st.postSweepRequests = e.postSweepRequests || 0;
	st.lastSweep = typeof e.lastSweep === "string" ? e.lastSweep : "";
	st.telemetry = e.telemetry === "observed" || e.telemetry === "none" ? e.telemetry : "";
	st.maxWarmGapSec = typeof e.warmGapSec === "number" && e.warmGapSec > 0 ? e.warmGapSec : 0;
	if (typeof e.lastCtxAt === "number" && Number.isFinite(e.lastCtxAt) && e.lastCtxAt >= 0) st.lastCtxAt = e.lastCtxAt;
	else if (sessionFile) {
		// Entries written before the anchor existed: the session file's mtime is
		// the last pi append ≈ last activity — good enough as an idle anchor.
		try { st.lastCtxAt = statSync(sessionFile).mtimeMs; } catch { /* no file, no anchor */ }
	}
}

function sweepThresholdSec(st: State, cfg: JanitorConfig): number {
	// Observed retention × margin, floored at the configured minimum. No
	// telemetry → trust nothing, use the floor.
	return Math.min(MAX_IDLE_SEC, Math.max(cfg.minIdleSec, Math.round(st.maxWarmGapSec * cfg.warmGapMultiplier)));
}

function contentChars(content: any): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((n: number, b: any) => {
		if (b?.type === "text") return n + (b.text?.length ?? 0);
		if (b?.type === "image") return n + (b.data?.length ?? 0);
		return n;
	}, 0);
}

function stubText(toolName: string, isError: boolean | undefined): string {
	return `[${toolName} result elided${isError ? " (error)" : ""}; re-run if needed]`;
}

const IMAGE_STUB = "[image elided; re-run if needed]";

/**
 * Extend the frozen decision set to cover everything older than the
 * keep-recent-turns boundary. Returns chars/bytes newly decided, or null
 * when the idle gap was below threshold / nothing was stubbable.
 */
function extendDecisions(st: State, messages: any[], cfg: JanitorConfig): { chars: number; imgBytes: number; tools: number; images: number } | null {
	const idleSec = st.lastCtxAt >= 0 ? (clock.now() - st.lastCtxAt) / 1000 : 0;
	if (st.lastCtxAt < 0 || idleSec < sweepThresholdSec(st, cfg)) return null;

	const userIdx: number[] = [];
	messages.forEach((m, i) => { if (m?.role === "user") userIdx.push(i); });
	if (userIdx.length <= cfg.keepRecentTurns) return null;
	const boundary = userIdx[userIdx.length - cfg.keepRecentTurns];

	let chars = 0, imgBytes = 0, tools = 0, images = 0;
	messages.forEach((m, i) => {
		if (i >= boundary || !m) return;
		if (m.role === "toolResult" && m.toolCallId && !st.tools.has(m.toolCallId)) {
			const c = contentChars(m.content);
			if (c < stubText(m.toolName, m.isError).length + MIN_STUB_MARGIN) return;
			st.tools.add(m.toolCallId);
			tools++; chars += c;
		}
		if (m.role === "user" && Array.isArray(m.content)) {
			m.content.forEach((b: any, bi: number) => {
				if (b?.type !== "image") return;
				const k = `${i}:${bi}`;
				if (st.userImages.has(k)) return;
				st.userImages.add(k);
				images++; imgBytes += b.data?.length ?? 0;
			});
		}
	});
	if (tools === 0 && images === 0) return null;
	return { chars, imgBytes, tools, images };
}

/** Replay the frozen decision set onto the (deep-copied) messages. Deterministic. */
function applyDecisions(st: State, messages: any[]): void {
	if (st.tools.size === 0 && st.userImages.size === 0) return;
	messages.forEach((m, i) => {
		if (!m) return;
		if (m.role === "toolResult" && m.toolCallId && st.tools.has(m.toolCallId)) {
			m.content = [{ type: "text", text: stubText(m.toolName ?? "tool", m.isError) }];
		} else if (m.role === "user" && Array.isArray(m.content) && st.userImages.size > 0) {
			m.content = m.content.map((b: any, bi: number) =>
				b?.type === "image" && st.userImages.has(`${i}:${bi}`)
					? { type: "text", text: IMAGE_STUB }
					: b,
			);
		}
	});
}

/**
 * Classify the previous request from the history's last assistant message:
 * warm-gap learning + miss counting. Skips on model switch, aborted/errored
 * responses, timestamp desync and the request right after a sweep.
 */
function observePreviousRequest(st: State, messages: any[]): void {
	const pending = st.pending;
	st.pending = null;
	if (!pending) return;

	let last: any;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") { last = messages[i]; break; }
	}
	if (!last) return;
	const u = last.usage;
	if (!u || u.input <= 0 || last.stopReason === "error" || last.stopReason === "aborted") return;
	// The response must belong to the request we timed — otherwise (retry,
	// compaction call, desync) the gap attribution would be wrong.
	if (!last.timestamp || last.timestamp < pending.sentAt - 50) return;
	if (st.lastModel && st.lastModel !== last.model) { st.lastModel = last.model; return; }
	st.lastModel = last.model;

	if (u.cacheRead > 0 || u.cacheWrite > 0) st.telemetry = "observed";
	st.requestsObserved++;

	if (pending.swept) {
		// Definitionally cold — never pollutes retention learning.
		st.postSweepRequests++;
		return;
	}
	if (st.telemetry !== "observed") return; // provider reports no cache fields
	if (u.cacheRead > 0) {
		if (pending.gapSec > st.maxWarmGapSec) st.maxWarmGapSec = pending.gapSec;
	} else if (pending.gapSec > 0) {
		st.naturalMisses++;
		st.missedTokens += (u.input ?? 0) + (u.cacheWrite ?? 0);
	}
}

export default function (pi: any) {
	// Session basename → janitor state
	const states = new Map<string, State>();

	const sessionKey = (ctx: any): string | null => {
		const file = ctx?.sessionManager?.getSessionFile?.();
		return file ? basename(file) : null;
	};

	pi.on("context", (event: any, ctx: any) => {
		try {
			const file = ctx?.sessionManager?.getSessionFile?.();
			const key = file ? basename(file) : null;
			if (!key) return;
			let st = states.get(key);
			if (!st) { st = newState(); seedFromStats(key, st, file); states.set(key, st); }
			const now = clock.now();
			const messages = event.messages;
			const cfg = readConfig();

			observePreviousRequest(st, messages);

			// Compaction-imminent guard: when the previous request already
			// filled most of the context window, pi is about to auto-compact —
			// compaction rewrites the context anyway, so a sweep now would be
			// discarded work. Warm replay of existing decisions continues.
			// ponytail: 0.8 fixed — pi's compact reserve varies; tune only if
			// sweeps still land right before compactions.
			const win = ctx?.model?.contextWindow ?? 0;
			let prevTokens = 0;
			if (win > 0) {
				for (let i = messages.length - 1; i >= 0; i--) {
					const m = messages[i];
					if (m?.role === "assistant") {
						const u = m.usage;
						if (u && m.stopReason !== "error" && m.stopReason !== "aborted") {
							prevTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
						}
						break;
					}
				}
			}

			const sweep = win > 0 && prevTokens > win * 0.8 ? null : extendDecisions(st, messages, cfg);
			if (sweep) {
				st.sweeps++;
				st.stubbedToolResults += sweep.tools;
				st.stubbedImages += sweep.images;
				st.textCharsSaved += sweep.chars;
				st.imageBytesSaved += sweep.imgBytes;
				st.lastSweep = new Date().toISOString();
			}
			applyDecisions(st, messages);

			st.pending = {
				sentAt: now,
				gapSec: st.lastCtxAt >= 0 ? Math.max(0, (now - st.lastCtxAt) / 1000) : 0,
				swept: !!sweep,
			};
			st.lastCtxAt = now;
			flushStats(key, st, cfg);
			return { messages };
		} catch {
			// Never break the request over a janitor bug — fall back to no transform.
			return;
		}
	});

	// Transform decisions are position- and epoch-bound: compaction rebuilds
	// the context, tree switches reorder it → drop them (a later cold window
	// re-decides from scratch). Everything else — counters, retention learning
	// (maxWarmGapSec, telemetry), model, request bookkeeping — is provider- or
	// session-level fact that outlives the epoch and is carried across.
	const resetTransforms = (ctx: any) => {
		const key = sessionKey(ctx);
		if (!key) return;
		const old = states.get(key);
		if (old) { old.tools = new Set(); old.userImages = new Set(); }
	};
	pi.on("session_compact", (_event: any, ctx: any) => resetTransforms(ctx));
	pi.on("session_tree", (_event: any, ctx: any) => resetTransforms(ctx));
}
