// Run: npx tsx smoke-test.mjs  (from extras/pi-personas)
// Asserts binding lookup + context injection behavior with a fake pi/ctx.
import assert from "node:assert";
import { mkdtempSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "personas-test-"));
const bindingsFile = join(process.env.PI_CODING_AGENT_DIR, "persona-active.json");

const { default: factory } = await import("./index.ts");

function makePi() {
	const handlers = {};
	return {
		on: (ev, fn) => { handlers[ev] = fn; },
		context: (ctx) => handlers.context({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, ctx),
	};
}
const setBinding = (sessionFile, persona) => {
	writeFileSync(bindingsFile, JSON.stringify({ [sessionFile.split("/").pop()]: persona }));
	utimesSync(bindingsFile, new Date(), new Date(Date.now() + (mt += 1000)));
};
let mt = 0;

// 1. No bindings file → inert (handler returns undefined → context untouched)
let t = makePi();
factory(t);
const ctx = { sessionManager: { getSessionFile: () => "/env/sessions/2026_a.jsonl" } };
let out = t.context(ctx);
assert.strictEqual(out, undefined, "no file = no injection");

// 2. Binding for another session → inert
setBinding("/env/sessions/other.jsonl", { id: "p1", name: "P", prompt: "Be terse." });
out = t.context(ctx);
assert.strictEqual(out, undefined, "other session = no injection");

// 3. Binding for the CURRENT session → persona appended as a user message
setBinding("/env/sessions/2026_a.jsonl", { id: "p1", name: "Reviewer", prompt: "You review code." });
out = t.context(ctx);
assert.strictEqual(out.messages.length, 2, "persona appended");
assert.strictEqual(out.messages[1].role, "user");
assert.ok(out.messages[1].content[0].text.includes("You review code."), "prompt present");
assert.ok(out.messages[1].content[0].text.includes("Reviewer"), "name present");
assert.ok(out.messages[1].content[0].text.includes("disregard any earlier persona"), "supersedes instruction present");

// 4. Persona change mid-session → next call carries the NEW prompt
setBinding("/env/sessions/2026_a.jsonl", { id: "p2", name: "Pirate", prompt: "Arr, talk like a pirate." });
out = t.context(ctx);
assert.ok(out.messages[1].content[0].text.includes("pirate"), "updated prompt injected");
assert.ok(!out.messages[1].content[0].text.includes("You review code."), "old prompt gone");

// 5. Empty prompt binding / no session file → inert
setBinding("/env/sessions/2026_a.jsonl", { id: "p3", name: "X", prompt: "   " });
out = t.context(ctx);
assert.strictEqual(out, undefined, "blank prompt = no injection");
const noFileCtx = { sessionManager: { getSessionFile: () => null } };
out = t.context(noFileCtx);
assert.strictEqual(out, undefined, "no session file = no-op");

// 6. Injected array is a fresh copy — the caller's array is never mutated
setBinding("/env/sessions/s.jsonl", { id: "p1", name: "P", prompt: "Be terse." });
const original = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
out = t.context({ sessionManager: { getSessionFile: () => "/x/s.jsonl" } });
assert.notStrictEqual(out.messages, original);
assert.strictEqual(original.length, 1);

console.log("pi-personas smoke test: all assertions passed");
