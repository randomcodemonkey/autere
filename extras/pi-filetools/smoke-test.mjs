// Smoke test for bash edit detection: run with
//   node --experimental-strip-types smoke-test.mjs
// Verifies: chat cards cap at 10 + summary line, JSONL records all,
// .git paths ignored everywhere.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, appendFileSync } from "node:fs";
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
// (pg/pgdata exercise the segment matcher; neither appears in the tmpdir name)
process.env.EDIT_IGNORE_PATHS = join(agentDir, "nothing") + ":pg:pgdata:/home/autere/pgdata";
process.chdir(work);

// Import the extension (TypeScript); fall back to esbuild when this node
// lacks --experimental-strip-types support
let ext;
try {
  ({ default: ext } = await import(join(__dirname, "index.ts")));
} catch (err) {
  if (err.code !== "ERR_NO_TYPESCRIPT" && err.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw err;
  const out = join(__dirname, ".index.compiled.mjs");
  const typebox = join(__dirname, "..", "..", "node_modules", "typebox");
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
  // f1 was recorded in case 1; bump its mtime 5s ahead so the change is
  // newer than the case-1 ledger entry (a real second edit is seconds
  // apart, the guard window is ±2s)
  const st = statSync(join(work, "f1.txt"));
  utimesSync(join(work, "f1.txt"), st.atime, new Date(Date.now() + 5000));
});
const cards2 = entries.filter((e) => e.type === "file_change");
assert(cards2.length === 2, `expected 2 cards, got ${cards2.length}`);
assert(!cards2.some((c) => c.data.change === "summary"), "no summary for small batch");
const jsonl2 = readFileSync(join(agentDir, "file-changes", "session-test.jsonl"), "utf-8").trim().split("\n");
assert(jsonl2.length === 17, `expected 17 JSONL lines total, got ${jsonl2.length}`);

console.log("smoke-test OK: 15-change batch → 10 chat cards + summary, 15 JSONL rows; .git ignored; small batch uncapped");

// ── Case 3: ignore entries match path segments anywhere in the path ──
entries.length = 0;
fireBash("c3", "write into ignored folders", () => {
  mkdirSync(join(work, "pg", "lib"), { recursive: true });
  writeFileSync(join(work, "pg", "lib", "x.ts"), "a\n");            // 'pg' bare segment
  mkdirSync(join(work, "deep", "pgdata", "y"), { recursive: true });
  writeFileSync(join(work, "deep", "pgdata", "y", "b.ts"), "b\n");   // 'pgdata' at depth
  mkdirSync(join(work, "keep", "pgdatav2"), { recursive: true });
  writeFileSync(join(work, "keep", "pgdatav2", "c.ts"), "c\n");      // pgdatav2 ≠ pgdata → kept
});
const jsonl3 = readFileSync(join(agentDir, "file-changes", "session-test.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
assert(!jsonl3.some((e) => e.path.split("/").includes("pg")), "'pg' segment not ignored");
assert(!jsonl3.some((e) => e.path.split("/").includes("pgdata")), "'pgdata' segment not ignored");
assert(jsonl3.some((e) => e.path.endsWith(join("keep", "pgdatav2", "c.ts"))), "pgdatav2 wrongly ignored (substring match)");
console.log("smoke-test OK: segment-based ignore matching (bare name at depth, no substring matches)");

// ── Case 4: concurrent session — cross-session suppression ––
// A second filetools instance (the user's other session, same env/cwd) must
// NOT claim a change another instance already emitted via its ledger.
entries.length = 0;
const handlers2 = {};
const entries2 = [];
const pi2 = {
  on: (name, fn) => { (handlers2[name] = handlers2[name] || []).push(fn); },
  appendEntry: (type, data) => entries2.push({ type, data }),
  registerTool: () => {},
};
ext(pi2);
const fire2 = (name, event, ctx) => (handlers2[name] || []).forEach((fn) => fn(event, ctx));
fire2("session_start", {}, { sessionManager: { getSessionFile: () => join(work, "session-test-2.jsonl") } });

// Session 1 edits f-own.txt mid-command (emitted + ledgered)
fireBash("x1", "echo one > f-own.txt", () => { writeFileSync(join(work, "f-own.txt"), "one\n"); });
assert(entries.some((e) => e.type === "file_change" && e.data.path.endsWith("f-own.txt")), "session 1 should emit its own change");

// Session 2 runs a command: sweep sees f-own.txt as changed but must NOT
// claim it — only a file of its own.
fire2("tool_execution_start", { toolName: "bash", toolCallId: "x2", args: { command: "echo two > f-own2.txt" } }, {});
writeFileSync(join(work, "f-own2.txt"), "two\n");
fire2("tool_execution_end", { toolName: "bash", toolCallId: "x2" }, {});
const case4Cards = entries2.filter((e) => e.type === "file_change" && e.data.change !== "summary");
assert(case4Cards.some((c) => c.data.path.endsWith("f-own2.txt")), "own change missing in session 2");
assert(!case4Cards.some((c) => c.data.path.endsWith("f-own.txt")), "OTHER session's change leaked into session 2 chat");
console.log("smoke-test OK: cross-session change suppression (no leaked cards)");

// ── Case 5: cross-session DELETION suppression ──
// Same as case 4 but the other session DELETED the file: no stat is left,
// so the guard must compare the snapshot's baseline mtime against the ledger.
// (Regression: statSync(path) threw on deleted files → guard never fired.)
// Setup: f-del.txt exists and is wiped so instance 2's baseline snapshot
// stats it; the OTHER instance already recorded the deletion in the ledger
// at a ts within the ±2s window.
writeFileSync(join(work, "f-del.txt"), "del\n");
// give it an mtime clearly after the current ledger entries
utimesSync(join(work, "f-del.txt"), new Date(), new Date(Date.now() + 10000));
fire2("tool_execution_start", { toolName: "bash", toolCallId: "x3", args: { command: "sleep" } }, {});
// other instance's claim: deleted at (baseline mtime + 100ms) — inside window
const stDel = statSync(join(work, "f-del.txt"));
appendFileSync(join(agentDir, "file-changes", ".changes-ledger.jsonl"),
  JSON.stringify({ ts: stDel.mtimeMs + 100, path: join(work, "f-del.txt") }) + "\n");
// force ledger reload next loadLedger()
utimesSync(join(agentDir, "file-changes", ".changes-ledger.jsonl"), new Date(), new Date());
rmSync(join(work, "f-del.txt"));
fire2("tool_execution_end", { toolName: "bash", toolCallId: "x3" }, {});
assert(!entries2.some((e) => e.type === "file_change" && e.data.path.endsWith("f-del.txt")),
  "OTHER session's deletion leaked into session 2 chat");
console.log("smoke-test OK: cross-session deletion suppression (deleted-file ledger guard)");
