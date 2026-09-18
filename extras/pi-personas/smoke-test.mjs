// Run: npx tsx smoke-test.mjs  (from extras/pi-personas)
// Asserts system-prompt injection + transition markers persisted to the
// sidecar file — including across extension factory re-runs (pi reloads
// extensions without a process restart).
import assert from "node:assert";
import { mkdtempSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const agentDir = mkdtempSync(join(tmpdir(), "personas-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const bindingsFile = join(agentDir, "persona-active.json");

const { default: factory } = await import("./index.ts");

function makePi() {
	const handlers = {};
	return {
		on: (ev, fn) => { handlers[ev] = fn; },
		compact: (ctx) => handlers.session_compact({}, ctx),
		turn: (ctx, systemPrompt = "BASE") => handlers.before_agent_start({ systemPrompt }, ctx),
	};
}
const ctx = { sessionManager: { getSessionFile: () => "/env/sessions/s1.jsonl" } };
const setBinding = (persona) => {
	writeFileSync(bindingsFile, JSON.stringify({ "s1.jsonl": persona }));
	utimesSync(bindingsFile, new Date(), new Date(Date.now() + (mt += 1000)));
};
let mt = 0;

// 1. No binding → inert
let t = makePi();
factory(t);
assert.strictEqual(t.turn(ctx), undefined, "no binding = no-op");

// 2. Bound → persona in system prompt + "new session" marker
setBinding({ id: "p1", name: "Reviewer", prompt: "You review code." });
let out = t.turn(ctx);
assert.ok(out.systemPrompt.startsWith("BASE") && out.systemPrompt.includes("You review code."), "persona appended to system prompt");
assert.strictEqual(out.message.content, 'Persona "Reviewer" active (new session).');

// 3. Steady state → persona delivered, NO marker
out = t.turn(ctx);
assert.ok(out.systemPrompt.includes("You review code."), "persona every turn");
assert.strictEqual(out.message, undefined, "no marker in steady state");

// 4. Extension factory RE-RUNS (pi reloads extensions) → still NO marker
let t2 = makePi();
factory(t2);
out = t2.turn(ctx);
assert.ok(out.systemPrompt.includes("You review code."), "persona after reload");
assert.strictEqual(out.message, undefined, "reload must NOT re-mark new session");

// 5. Persona changed → "changed from" marker (and survives a reload too)
setBinding({ id: "p2", name: "Pirate", prompt: "Arr." });
out = t.turn(ctx);
assert.ok(out.systemPrompt.includes("Arr."), "new prompt delivered");
assert.strictEqual(out.message.content, 'Persona "Pirate" active (changed from "Reviewer").');
out = t2.turn(ctx);
assert.strictEqual(out.message, undefined, "changed-marker sent once");

// 6. Compaction → tombstone → "re-applied after compaction" on next turn,
//    including across an extension reload
t.compact(ctx);
out = t.turn(ctx);
assert.ok(out.systemPrompt.includes("Arr."), "persona after compaction");
assert.strictEqual(out.message.content, 'Persona "Pirate" re-applied after compaction.');
assert.strictEqual(t2.turn(ctx).message, undefined, "compaction-marker sent once");

// 7. Unbinding → removal marker, clean system prompt
setBinding({ id: "p3", name: "X", prompt: "   " });
out = t.turn(ctx);
assert.strictEqual(out.systemPrompt, "BASE", "no persona when unbound");
assert.strictEqual(out.message.content, 'Persona "Pirate" removed — no persona is active anymore.');
assert.strictEqual(t2.turn(ctx), undefined, "steady unbound = no-op, no marker after reload");

// 8. Other session / no session file → inert
const ctx2 = { sessionManager: { getSessionFile: () => "/env/sessions/s2.jsonl" } };
setBinding({ id: "p1", name: "Reviewer", prompt: "Be terse." });
assert.strictEqual(t.turn(ctx2), undefined, "other session binding = no-op");
const noFileCtx = { sessionManager: { getSessionFile: () => null } };
assert.strictEqual(t.turn(noFileCtx), undefined, "no session file = no-op");

// 9. Markers sidecar persists transition state (re-bind after removal → new marker)
out = t.turn(ctx);
assert.strictEqual(out.message.content, 'Persona "Reviewer" active (new session).');
const markers = JSON.parse(readFileSync(join(agentDir, "persona-markers.json"), "utf-8"));
assert.ok(markers["s1.jsonl"] && markers["s1.jsonl"].key.startsWith("p1:"), "marker state persisted");

console.log("pi-personas smoke test: all assertions passed");
