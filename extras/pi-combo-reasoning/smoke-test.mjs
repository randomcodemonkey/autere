#!/usr/bin/env node
// Self-check for pi-combo-reasoning: drives the compiled extension's
// session_start handler with a fake registry and asserts
//   1. combo models (🔀  prefix) get an all-null thinkingLevelMap,
//   2. non-combo models pass through untouched,
//   3. the patch is idempotent (second session_start ⇒ no re-register).
//   node --experimental-strip-types smoke-test.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let factory;
try {
	({ default: factory } = await import(join(__dirname, "index.ts")));
} catch {
	// Node without --experimental-strip-types fallback: esbuild to a tmp file
	const esbuildOut = mkdtempSync(join(tmpdir(), "combo-"));
	const out = join(esbuildOut, "ext.mjs");
	const r = spawnSync("npx", ["esbuild", join(__dirname, "index.ts"), "--loader:.ts=ts", "--format=esm", `--outfile=${out}`]);
	if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
	({ default: factory } = await import(out));
}

const registrations = [];
let cfg = {
	baseUrl: "http://localhost:20128/v1",
	apiKey: "k",
	api: "openai-completions",
	models: [
		{ id: "auto", name: "auto", reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
		{ id: "glm-combo", name: "🔀 glm-combo", reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
		{ id: "plain", name: "plain", reasoning: false },
	],
};
const handlers = {};
factory({
	on(ev, handler) { handlers[ev] = handler; },
	registerProvider(name, config) { registrations.push([name, config]); },
});

const assert = (cond, msg) => { if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); } };

await handlers.session_start({ type: "session_start", reason: "startup" }, {
	modelRegistry: { getRegisteredProviderConfig: () => cfg },
});
assert(registrations.length === 1, "combo models must trigger one re-register");
const models = registrations[0][1].models;
const allNull = (o) => Object.values(o).every((v) => v === null);
assert(allNull(models[1].thinkingLevelMap), "combo thinkingLevelMap must be fully nulled");
assert(JSON.stringify(models[0]) === JSON.stringify(cfg.models[0]), "non-combo model must pass through untouched");
assert(JSON.stringify(models[2]) === JSON.stringify(cfg.models[2]), "non-reasoning model must pass through untouched");

// idempotence: a second session_start against the already-patched list is a no-op
cfg.models = models;
await handlers.session_start({ type: "session_start", reason: "resume" }, {
	modelRegistry: { getRegisteredProviderConfig: () => cfg },
});
assert(registrations.length === 1, "second pass must not re-register (idempotent)");

console.log("smoke-test OK: combo models nulled, non-combos untouched, idempotent");
