// Run: npx tsx smoke-test.mjs  (from extras/pi-token-reserve)
// Asserts the reserve policy math + hook behavior with a fake pi/ctx.
import assert from "node:assert";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "reserve-test-"));
const cfg = join(process.env.PI_CODING_AGENT_DIR, "pi-token-reserve-config.json");

const { default: factory } = await import("./index.ts");

function makePi() {
	const handlers = {};
	return {
		pi: { on: (ev, fn) => { handlers[ev] = fn; }, handlers },
		session_before_compact: (ctx, prep) =>
			handlers.session_before_compact({ preparation: prep }, ctx),
		agent_end: (ctx) => {
			let compactCalled = false;
			const ctx2 = { ...ctx, compact: () => { compactCalled = true; } };
			handlers.agent_end({}, ctx2);
			return compactCalled;
		},
	};
}
const setPercent = (p) => {
	writeFileSync(cfg, JSON.stringify({ percent: p }));
	utimesSync(cfg, new Date(), new Date(Date.now() + (mt += 1000)));
};
let mt = 0;

// 1. No config file → inert
let t = makePi();
factory(t.pi);
let prep = { settings: { reserveTokens: 16384 } };
t.session_before_compact({ model: { contextWindow: 200000 } }, prep);
assert.strictEqual(prep.settings.reserveTokens, 16384, "no config = untouched");

// 2. percent set → floor(window * pct / 100)
setPercent(25);
t = makePi();
factory(t.pi);
prep = { settings: { reserveTokens: 16384 } };
t.session_before_compact({ model: { contextWindow: 200000 } }, prep);
assert.strictEqual(prep.settings.reserveTokens, 50000, "25% of 200k = 50k");

// 3. Clamping: 0 and out-of-range
prep = { settings: { reserveTokens: 16384 } };
t.session_before_compact({ model: { contextWindow: 200000 } }, prep);
assert.strictEqual(prep.settings.reserveTokens, 50000, "mtime cache: same file untouched");

setPercent(95); // over max → clamped to 90
prep = { settings: { reserveTokens: 16384 } };
t.session_before_compact({ model: { contextWindow: 1000 } }, prep);
assert.strictEqual(prep.settings.reserveTokens, 900, "95 clamped to 90%");

// 4. agent_end threshold: 25% of 200k; usage 151k > 150k → compact
setPercent(25);
t = makePi();
factory(t.pi);
assert.strictEqual(
	t.agent_end({ model: { contextWindow: 200000 }, getContextUsage: () => ({ tokens: 151000, contextWindow: 200000 }), hasPendingMessages: () => false }),
	true, "over pct threshold compacts"
);
// below threshold
assert.strictEqual(
	t.agent_end({ model: { contextWindow: 200000 }, getContextUsage: () => ({ tokens: 140000, contextWindow: 200000 }), hasPendingMessages: () => false }),
	false, "under threshold no compact"
);
// pending messages → skip (pi's own recovery handles it)
assert.strictEqual(
	t.agent_end({ model: { contextWindow: 200000 }, getContextUsage: () => ({ tokens: 190000, contextWindow: 200000 }), hasPendingMessages: () => true }),
	false, "pending messages skip"
);
// no usage data → no crash, no compact
assert.strictEqual(
	t.agent_end({ model: { contextWindow: 200000 }, getContextUsage: () => ({ tokens: null, contextWindow: 200000 }), hasPendingMessages: () => false }),
	false, "null tokens skip"
);

// 5. percent=0 → fully inert
setPercent(0);
t = makePi();
factory(t.pi);
prep = { settings: { reserveTokens: 16384 } };
t.session_before_compact({ model: { contextWindow: 200000 } }, prep);
assert.strictEqual(prep.settings.reserveTokens, 16384, "0% = pi default");
assert.strictEqual(
	t.agent_end({ model: { contextWindow: 200000 }, getContextUsage: () => ({ tokens: 199000, contextWindow: 200000 }), hasPendingMessages: () => false }),
	false, "0% never compacts"
);

console.log("all pi-token-reserve smoke tests passed");
