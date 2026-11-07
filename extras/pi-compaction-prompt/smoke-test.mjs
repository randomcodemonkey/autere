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

const { default: factory, forceCompactAt } = await import("./index.ts");

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

console.log("pi-compaction-prompt smoke-test: OK");
