// Run: npx tsx smoke-test.mjs  (from extras/pi-compaction-prompt)
// Asserts the mid-run guard: which token limit it uses, and that it actually
// runs at a turn boundary with queued work (event.continue is NOT the signal).
import assert from "node:assert";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "compact-guard-test-"));
const dir = process.env.PI_CODING_AGENT_DIR;
const reserveCfg = join(dir, "pi-token-reserve-config.json");

const { default: factory, forceCompactAt, compactWithFallbacks } = await import("./index.ts");

let mt = 0;
const write = (path, obj) => {
	writeFileSync(path, JSON.stringify(obj));
	utimesSync(path, new Date(), new Date(Date.now() + (mt += 1000)));
};

// 1. No policy, no override -> inert
assert.strictEqual(forceCompactAt({ contextWindow: 1_000_000, id: "m" }, undefined), undefined, "no config must stay inert");
// 2. Reserve-% policy: threshold = window - reserve (the 480k/200k report)
write(reserveCfg, { percent: 80 });
assert.strictEqual(forceCompactAt({ contextWindow: 1_000_000, id: "m" }, undefined), 200_000);
// 3. Per-model override wins over the fallback percent
write(reserveCfg, { percent: 80, perModel: { "p/m": 20 } });
assert.strictEqual(forceCompactAt({ contextWindow: 1_000_000, id: "m", provider: "p" }, undefined), 800_000);
// 4. Explicit compactAtTokens wins over the policy
assert.strictEqual(forceCompactAt({ contextWindow: 1_000_000, id: "m" }, 500_000), 500_000);
// 5. No usable window -> inert, and the percent is clamped to 90
assert.strictEqual(forceCompactAt({ contextWindow: 0, id: "m" }, undefined), undefined);
write(reserveCfg, { percent: 500 });
assert.strictEqual(forceCompactAt({ contextWindow: 1_000_000, id: "m" }, undefined), 100_000);

// 6. Turn boundary: queued work + event.continue === false must still check
write(reserveCfg, { percent: 80 });
const handlers = {};
factory({ on: (ev, fn) => { handlers[ev] = fn; } });
let usageCalls = 0;
const notifies = [];
const ctx = (tokens) => ({
	model: { contextWindow: 1_000_000, id: "m", provider: "p" },
	getContextUsage: () => { usageCalls++; return { tokens, contextWindow: 1_000_000 }; },
	getSettings: () => ({}),
	sessionManager: { getBranch: () => [] },
	ui: { notify: (...a) => notifies.push(a) },
});
const boundary = (canContinue, pending) => ({
	continue: false,   // pi only reports handlers' verdicts; always false here
	context: { canContinue, pendingMessages: pending },
	entries: [],
});
await handlers.turn_end(boundary(true, [{ role: "user" }]), ctx(10));
assert.strictEqual(usageCalls, 1, "guard skipped a continuing run (event.continue is not the signal)");

usageCalls = 0;
await handlers.turn_end(boundary(false, [{ role: "user" }]), ctx(10));
assert.strictEqual(usageCalls, 0, "guard must not run when the run is ending");

usageCalls = 0;
await handlers.turn_end(boundary(true, []), ctx(10));
assert.strictEqual(usageCalls, 0, "guard must not run without queued messages");

// Over the limit: preparation needs a real branch, an empty one yields no
// compaction and the guard must not notify a success.
usageCalls = 0;
const over = await handlers.turn_end(boundary(true, [{ role: "user" }]), ctx(900_000));
assert.strictEqual(usageCalls, 1);
assert.strictEqual(over, undefined);
assert.deepStrictEqual(notifies, []);

// 7. The session thinking level must reach the summarization request: without
// it pi-ai sends `thinking: {type: "disabled"}`, which Copilot's Claude
// rejects ("send between_tools instead") - the reported compaction failure.
const prep = {
	firstKeptEntryId: "keep-1",
	messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore: 1000,
	fileOps: { read: new Set(), written: new Set(), edited: new Set() },
	settings: { reserveTokens: 16384, keepRecentTokens: 20000, enabled: true },
};
const model = { id: "claude-sonnet-5-5", provider: "github-copilot", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 };
const ok = () => ({ result: async () => ({ content: [{ type: "text", text: "Summary." }], stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0.001 } } }) });
const calls = [];
const capture = async (_m, _ctx, options) => { calls.push(options); return ok(); };
const res = await compactWithFallbacks(prep, [], model, "key", {}, "instructions", undefined, undefined, "medium", capture);
assert.strictEqual(calls.length, 1);
assert.strictEqual(calls[0].reasoning, "medium", "session thinking level never reached the request");
assert.ok(res.summary.includes("Summary."), "compaction result missing the summary");

// 8. A between_tools rejection retries once with thinking on.
calls.length = 0;
let first = true;
const rejecting = async (_m, _ctx, options) => {
	calls.push(options);
	if (first) { first = false; throw new Error('Summarization failed: 400 To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.'); }
	return ok();
};
const res2 = await compactWithFallbacks(prep, [], model, "key", {}, "instructions", undefined, undefined, undefined, rejecting);
assert.strictEqual(calls.length, 2, "no retry on the between_tools rejection");
assert.strictEqual(calls[1].reasoning, "low", "retry must not repeat the rejected disabled marker");
assert.ok(res2.summary.includes("Summary."), "retry result missing the summary");

console.log("pi-compaction-prompt smoke-test: OK");
