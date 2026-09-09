// Smoke test for bash edit detection: run with
//   node --experimental-strip-types smoke-test.mjs
// Verifies: chat cards cap at 10 + summary line, JSONL records all,
// .git paths ignored everywhere.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

const work = mkdtempSync(join(tmpdir(), "filetools-test-"));
const agentDir = join(work, "agent");
mkdirSync(join(agentDir, "file-changes"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
// workdir lives under /tmp — override the default ignore so test files count
process.env.EDIT_IGNORE_PATHS = join(agentDir, "nothing");
process.chdir(work);

// Import the extension (TypeScript); fall back to esbuild when this node
// lacks --experimental-strip-types support
let ext;
try {
  ({ default: ext } = await import(join(__dirname, "index.ts")));
} catch (err) {
  if (err.code !== "ERR_NO_TYPESCRIPT" && err.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw err;
  const out = join(__dirname, ".index.compiled.mjs");
  const typebox = join(__dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "typebox");
  const r = spawnSync("npx", ["esbuild", join(__dirname, "index.ts"), "--format=esm", "--bundle", "--packages=external", `--alias:typebox=${typebox}`, `--outfile=${out}`], { cwd: join(__dirname, "..", "..") });
  if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
  ({ default: ext } = await import(out));
  rmSync(out, { force: true });
}

const entries = [];
const handlers = {};
const pi = {
  on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
  appendEntry: (type, data) => entries.push({ type, data }),
  registerTool: () => {},
};

ext(pi);

const fire = (name, event, ctx) => (handlers[name] || []).forEach((fn) => fn(event, ctx));

// session_start wires the JSONL path
fire("session_start", {}, { sessionManager: { getSessionFile: () => join(work, "session-test.jsonl") } });

const fireBash = (id, command, mutate) => {
  fire("tool_execution_start", { toolName: "bash", toolCallId: id, args: { command } }, {});
  mutate();
  fire("tool_execution_end", { toolName: "bash", toolCallId: id }, {});
};

// ── Case 1: 15 files at once + a write into .git ──
entries.length = 0;
fireBash("c1", "for i in $(seq 1 15); do echo x > /tmp/out-$i; done; echo git > " + join(work, ".git/config"), () => {
  mkdirSync(join(work, ".git"), { recursive: true });
  writeFileSync(join(work, ".git", "config"), "gitstuff");
  for (let i = 1; i <= 15; i++) writeFileSync(join(work, `f${i}.txt`), `content ${i}\n`);
});

const cards = entries.filter((e) => e.type === "file_change");
assert(cards.length === 11, `expected 10 cards + 1 summary, got ${cards.length}`);
const summaries = cards.filter((c) => c.data.change === "summary");
assert(summaries.length === 1, "expected exactly 1 summary");
assert(summaries[0].data.diff === "15 files modified at once, omitting edit messages", `bad summary text: ${summaries[0].data.diff}`);
assert(cards.filter((c) => c.data.change !== "summary").length === 10, "expected 10 chat cards");
const jsonl = readFileSync(join(agentDir, "file-changes", "session-test.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
assert(jsonl.length === 15, `expected 15 JSONL entries, got ${jsonl.length}`);
assert(!jsonl.some((e) => e.path.includes(".git")), ".git write leaked into JSONL");
assert(!entries.some((e) => JSON.stringify(e).includes(".git")), ".git write leaked into chat");

// ── Case 2: small batch — no summary ──
entries.length = 0;
fireBash("c2", "echo more", () => {
  writeFileSync(join(work, "f1.txt"), "changed\n");
  writeFileSync(join(work, "small.txt"), "hi\n");
});
const cards2 = entries.filter((e) => e.type === "file_change");
assert(cards2.length === 2, `expected 2 cards, got ${cards2.length}`);
assert(!cards2.some((c) => c.data.change === "summary"), "no summary for small batch");
const jsonl2 = readFileSync(join(agentDir, "file-changes", "session-test.jsonl"), "utf-8").trim().split("\n");
assert(jsonl2.length === 17, `expected 17 JSONL lines total, got ${jsonl2.length}`);

console.log("smoke-test OK: 15-change batch → 10 chat cards + summary, 15 JSONL rows; .git ignored; small batch uncapped");
