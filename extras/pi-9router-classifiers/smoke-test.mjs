#!/usr/bin/env node
// Self-check: session_start against a fake registry registers extra classifier
// model entries + the System One implementation on the merged provider config.
//   node --experimental-strip-types smoke-test.mjs
import assert from "node:assert/strict";
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
	const dir = mkdtempSync(join(tmpdir(), "prc-"));
	const out = join(dir, "ext.mjs");
	const r = spawnSync("npx", ["esbuild", join(__dirname, "index.ts"), "--loader:.ts=ts", "--format=esm", "--bundle", "--platform=node", `--outfile=${out}`], { cwd: join(__dirname, "..", "..") });
	if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
	({ default: factory } = await import(out));
}


const cfg = {
	baseUrl: "http://localhost:20128/v1",
	apiKey: "k",
	api: "openai-completions",
	models: [
		{ id: "glm-5.3-flash-combo", name: "🔀 glm-5.3-flash-combo", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null } },
		{ id: "auto", name: "auto", reasoning: true },
		{ id: "openrouter/typesafe/jev-1.13", name: "openrouter/typesafe/jev-1.13", reasoning: false },
		{ id: "openrouter/mimo-v2.5", name: "openrouter/mimo-v2.5", reasoning: false },
	],
};
let registered = null;
let handler = null;
factory({
	on(ev, h) { if (ev === "session_start") handler = h; },
	registerProvider(name, config) { registered = { name, config }; },
});
handler?.({ type: "session_start", reason: "startup" }, {
	modelRegistry: { getRegisteredProviderConfig: () => cfg },
});

assert(registered, "session_start must register the patch");
assert.equal(registered.name, "9router", "targets the 9router provider");
assert(registered.config.classifiers?.["typesafe-system-one"], "System One classifier impl present");
const ids = registered.config.models.map((m) => `${m.type ?? "chat"}:${m.id}`);
assert(ids.includes("chat:glm-5.3-flash-combo"), "chat entries survive the merge");
assert(ids.includes("chat:openrouter/mimo-v2.5"), "unrelated chat entries survive");
assert(ids.includes("classifier:openrouter/typesafe/jev-1.13"), "classifier entry added");
assert(!registered.config.models.some((m) => m.type === "classifier" && m.id !== "openrouter/typesafe/jev-1.13"), "only System One-ish ids became classifiers");
console.log("smoke-test OK: classifier entry + System One impl added, chat metadata preserved");
