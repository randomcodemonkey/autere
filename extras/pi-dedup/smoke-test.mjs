// Run: npx tsx smoke-test.mjs  (from extras/pi-dedup)
// Asserts duplicate elision (call+result fingerprint) + savings recording with a fake pi/ctx.
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const agentDir = mkdtempSync(join(tmpdir(), "pi-dedup-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: factory } = await import("./index.ts");

function makePi() {
	const handlers = {};
	return {
		on: (ev, fn) => { handlers[ev] = fn; },
		toolResult: (event, ctx) => handlers.tool_result(event, ctx),
		compact: (ctx) => handlers.session_compact({}, ctx),
	};
}
const ctx = { sessionManager: { getSessionFile: () => "/env/sessions/s1.jsonl" } };
const big = "x".repeat(500);
const text = (t) => ({ toolName: "read", content: [{ type: "text", text: t }] });

const t = makePi();
factory(t);

// 1. First occurrence → untouched
assert.strictEqual(t.toolResult(text(big), ctx), undefined, "first occurrence kept");
// 2. Same call twice in a row → passes through (organic duplicate or re-run)
assert.strictEqual(t.toolResult(text(big), ctx), undefined, "consecutive duplicate passes through");
// 3. Non-consecutive duplicate (different result in between) → elided with pointer
assert.strictEqual(t.toolResult(text("y".repeat(500)), ctx), undefined, "different content kept");
const out = t.toolResult(text(big), ctx);
assert.ok(out.content[0].text.includes("pi-dedup"), "pointer text");
assert.ok(out.content[0].text.includes("re-run"), "advises re-run");
// 3b. Immediate re-run after the pointer → real content this time
assert.strictEqual(t.toolResult(text(big), ctx), undefined, "re-run after pointer shows real content");

// 4c. Same output, different command → kept (fingerprint = toolName + input + result)
const cmd = (c) => ({ toolName: "bash", input: { command: c }, content: [{ type: "text", text: big }] });
assert.strictEqual(t.toolResult(cmd("echo x > a"), ctx), undefined, "same output, different command kept");
assert.strictEqual(t.toolResult(cmd("echo x > b"), ctx), undefined, "second distinct command kept");
assert.ok(t.toolResult(cmd("echo x > a"), ctx).content[0].text.includes("pi-dedup"), "same command+output elided");

// 4b. Mid-size duplicate → elided (floor tracks pointer length, not a fixed 400)
const mid = text("m".repeat(150));
assert.strictEqual(t.toolResult(mid, ctx), undefined, "mid-size first occurrence kept");
assert.strictEqual(t.toolResult(mid, ctx), undefined, "mid-size consecutive repeat passes through");
assert.strictEqual(t.toolResult(text("z".repeat(500)), ctx), undefined, "intervening result kept");
assert.ok(t.toolResult(mid, ctx).content[0].text.includes("pi-dedup"), "mid-size non-consecutive duplicate elided");

// 5. Small results → never elided even if identical
assert.strictEqual(t.toolResult(text("small"), ctx), undefined, "small kept");
assert.strictEqual(t.toolResult(text("small"), ctx), undefined, "small duplicate kept");

// 6. Error results → never elided
const err = { toolName: "bash", isError: true, content: [{ type: "text", text: big }] };
assert.strictEqual(t.toolResult(err, ctx), undefined, "error result kept");

// 7. Mixed (image) content → untouched
const mixed = { toolName: "img", content: [{ type: "text", text: big }, { type: "image", data: "..." }] };
assert.strictEqual(t.toolResult(mixed, ctx), undefined, "mixed content kept");

// 8. Stats recorded (big + mid-size + cmd non-consecutive dups = 3 elisions)
const stats = JSON.parse(readFileSync(join(agentDir, "dedup-stats.json"), "utf-8"));
assert.strictEqual(stats["s1.jsonl"].elidedBlocks, 3, "three elisions recorded");
assert.ok(stats["s1.jsonl"].charsSaved > 0, "chars saved > 0");
assert.ok(stats["s1.jsonl"].tokensSaved > 0, "tokens saved > 0");

// 9. Compaction resets anchors → same content seeds again (kept)
t.compact(ctx);
assert.strictEqual(t.toolResult(text(big), ctx), undefined, "post-compaction occurrence kept");
assert.strictEqual(t.toolResult(text(big), ctx), undefined, "consecutive repeat passes through after compaction");
assert.strictEqual(t.toolResult(text("y".repeat(500)), ctx), undefined, "intervening result after compaction kept");
assert.ok(t.toolResult(text(big), ctx).content[0].text.includes("pi-dedup"), "non-consecutive duplicate elides again");

// 10. Other session → independent anchors
const ctx2 = { sessionManager: { getSessionFile: () => "/env/sessions/s2.jsonl" } };
assert.strictEqual(t.toolResult(text(big), ctx2), undefined, "other session keeps its first occurrence");

// 11. Stats accumulate across sessions without clobbering
assert.strictEqual(JSON.parse(readFileSync(join(agentDir, "dedup-stats.json"), "utf-8"))["s1.jsonl"].elidedBlocks, 4, "s1 stats preserved");

// 12. Corrupt stats file → elision still works
rmSync(join(agentDir, "dedup-stats.json"));
writeFileSync(join(agentDir, "dedup-stats.json"), "{corrupt");
t.toolResult(text("q".repeat(500)), ctx2); // break the consecutive streak
assert.ok(t.toolResult(text(big), ctx2).content[0].text.includes("pi-dedup"), "elision survives corrupt stats");

console.log("pi-dedup smoke test: all assertions passed");
