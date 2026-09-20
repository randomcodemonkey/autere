// Run: npx tsx smoke-test.mjs  (from extras/pi-janitor)
// Asserts idle-gated sweeping, cache-stable replay, retention learning and
// stats recording with a fake pi/ctx and an injectable clock.
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const agentDir = mkdtempSync(join(tmpdir(), "pi-janitor-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: factory, clock } = await import("./index.ts");

function makePi() {
	const handlers = {};
	return {
		on: (ev, fn) => { handlers[ev] = fn; },
		context: (event, ctx) => handlers.context(event, ctx),
		compact: (ctx) => handlers.session_compact({}, ctx),
	};
}

const S = 1000;
let T = 0;
clock.now = () => T;

const usage = (input, cacheRead = 0, cacheWrite = 0) => ({ input, output: 5, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 5 });
const U = (t, blocks) => ({ role: "user", content: blocks ?? [{ type: "text", text: "turn" }], timestamp: t });
const IMG = (data) => ({ type: "image", data, mimeType: "image/png" });
const A = (t, u, model = "m", stopReason = "stop") => ({ role: "assistant", content: [], model, provider: "p", api: "x", usage: u, stopReason, timestamp: t });
const TR = (id, name, chars, t) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "x".repeat(chars) }], isError: false, timestamp: t });

const ext = makePi();
factory(ext);

// ── s1: main lifecycle ──
const ctx1 = { sessionManager: { getSessionFile: () => "/env/sessions/s1.jsonl" } };
const sent = [];

// Message layout (indexes): U0(0,+img) TR0(1,read,1000) A0(2) TRmid(3,ls,100)
// TRtiny(4,bash,15) U1(5) TR1(6,edit,800) A1(7) U2(8) TR2(9,read,500) A2(10)
// U3(11,+img recent) TR3(12) A3(13) U4(14) TR4(15) A4(16). Old zone (i<8):
// TR0, TRmid, TRtiny, TR1, U0 img.
sent.push(U(0, [{ type: "text", text: "old turn" }, IMG("AAAA")]));
sent.push(TR("c0", "read", 1000, 1));
sent.push(A(2, usage(10, 0, 500)));
sent.push(TR("c0m", "ls", 100, 3));
sent.push(TR("c0b", "bash", 15, 4));
sent.push(U(300 * S), TR("c1", "edit", 800, 300 * S + 1), A(300 * S + 2, usage(10, 400)));
sent.push(U(600 * S), TR("c2", "read", 500, 600 * S + 1), A(600 * S + 2, usage(10, 400)));
sent.push(U(900 * S, [{ type: "text", text: "recent" }, IMG("BBBB")]), TR("c3", "read", 500, 900 * S + 1), A(900 * S + 2, usage(10, 400)));
sent.push(U(1200 * S), TR("c4", "read", 500, 1200 * S + 1), A(1200 * S + 2, usage(10, 400)));

let lastSentAt = 0;
// Fresh deep copy per call, like pi provides; returns the transformed copy.
const ev = (t) => { T = t; lastSentAt = t; return ext.context({ messages: structuredClone(sent) }, ctx1)?.messages; };
// Push the LLM response to the previous request (classified at the next ev).
const respond = (u, model = "m", stopReason = "stop") => sent.push(A(lastSentAt + 1000, usage(...u), model, stopReason));
const stats = () => JSON.parse(readFileSync(join(agentDir, "janitor-stats.json"), "utf-8"));
const assertT = (label, expect) => {
	const st = stats()["s1.jsonl"];
	for (const [k, v] of Object.entries(expect)) assert.strictEqual(st[k], v, `${label}: ${k} === ${v} (got ${st[k]})`);
};

// 1. First event ever → no classification, no sweep (even though idle "huge")
let msgs = ev(0);
assert.strictEqual(msgs[1].content[0].text.length, 1000, "no sweep on first event");
assert.strictEqual(msgs[0].content[1].type, "image", "no image stub on first event");

// 2. First classify (cold, gap 0 → no miss); then warm gap 300s → threshold 600
respond([10, 0, 500]);
ev(300 * S);
assertT("first classify observed", { requestsObserved: 1, naturalMisses: 0 });
respond([10, 400]);
ev(600 * S);
assertT("warm gap learned", { requestsObserved: 2, naturalMisses: 0, warmGapSec: 300, thresholdSec: 600 });

// 3. Idle 800s ≥ threshold → sweep: old tool results + images stubbed, recent kept
respond([10, 400]);
msgs = ev(1400 * S);
assert.ok(msgs[1].content[0].text.includes("elided"), "old read result stubbed");
assert.strictEqual(msgs[1].content[0].text, "[read result elided; re-run if needed]", "short deterministic marker");
assert.ok(msgs[6].content[0].text.includes("edit"), "old edit diff stubbed");
assert.ok(msgs[3].content[0].text.includes("elided"), "mid-size (100 chars) old result stubbed");
assert.strictEqual(msgs[4].content[0].text.length, 15, "sub-floor result not stubbed");
assert.strictEqual(msgs[2].role, "assistant", "assistant messages untouched");
assert.strictEqual(msgs[0].content[0].text, "old turn", "user text untouched");
assert.strictEqual(msgs[0].content[1].type, "text", "old user image stubbed");
assert.ok(msgs[0].content[1].text.includes("image elided"), "image stub marker");
assert.strictEqual(msgs[11].content[1].type, "image", "recent user image kept");
assertT("sweep recorded", { sweeps: 1, stubbedToolResults: 3, stubbedImages: 1, textCharsSaved: 1900, imageBytesSaved: 4 });
const stubAfterSweep = msgs[1].content[0].text;

// 4. Warm replay right after the sweep → byte-identical stubs, nothing new
respond([8, 0, 300]);
msgs = ev(1420 * S);
assert.strictEqual(msgs[1].content[0].text, stubAfterSweep, "replay is byte-identical (cache-stable)");
assertT("replay adds nothing", { sweeps: 1, stubbedToolResults: 3 });

// 5. Post-sweep request counts as postSweep, never as a natural miss;
//    the NEXT classify (natural cold, gap 20) is the one that counts a miss
respond([9, 0, 30]);
msgs = ev(1450 * S);
assertT("post-sweep separated + natural miss", { postSweepRequests: 1, naturalMisses: 1, missedTokens: 39 });

// 6. Warm classify leaves miss stats untouched
respond([10, 400]);
ev(1500 * S);
assertT("warm classify no change", { naturalMisses: 1, missedTokens: 39 });

// 7. Retention fluctuates upward → threshold rises, sweep held back
respond([10, 400]);
ev(2200 * S); // classifies warm gap 50 (no change); THIS request's gap is 700
respond([10, 400]);
msgs = ev(2400 * S); // classifies warm gap 700 → maxWarmGap 700 → threshold 1400; idle 200 → no sweep
assertT("threshold adapts upward", { warmGapSec: 700, thresholdSec: 1400, sweeps: 1 });
assert.strictEqual(msgs[1].content[0].text, stubAfterSweep, "stub unchanged between sweeps");

// 8. Compaction resets decisions (but keeps counters + retention learning)
respond([10, 400]);
ext.compact(ctx1);
msgs = ev(2700 * S);
assert.strictEqual(msgs[1].content[0].text.length, 1000, "decisions reset on compaction");
assert.strictEqual(msgs[0].content[1].type, "image", "image decisions reset too");
assertT("counters survive compaction", { sweeps: 1, naturalMisses: 1, warmGapSec: 700 });

// 9. Second cold window re-sweeps from scratch (cold gap 1600 ≥ 1400)
respond([10, 0, 0]); // cold response → natural miss at next classify
msgs = ev(4300 * S);
assert.ok(msgs[1].content[0].text.includes("elided"), "re-swept after compaction");
assertT("second sweep counted", { sweeps: 2, stubbedToolResults: 6, stubbedImages: 2, naturalMisses: 2, missedTokens: 49 });

// ── s2: model switch skips observation ──
const ctx2 = { sessionManager: { getSessionFile: () => "/env/sessions/s2.jsonl" } };
const sent2 = [U(0), TR("d0", "read", 1000, 1), A(2, usage(50))];
const assertT2 = (label, expect) => {
	const st = stats()["s2.jsonl"];
	for (const [k, v] of Object.entries(expect)) assert.strictEqual(st[k], v, `${label}: ${k} === ${v} (got ${st[k]})`);
};
T = 700 * S; ext.context({ messages: structuredClone(sent2) }, ctx2); // no pending yet
sent2.push(A(701 * S, usage(50), "m")); // response to call 1 (model m, no cache fields)
T = 1400 * S; ext.context({ messages: structuredClone(sent2) }, ctx2); // classifies: model 'm', telemetry none
assertT2("s2 first classify", { requestsObserved: 1, naturalMisses: 0 });
sent2.push(A(1401 * S, usage(50), "m2")); // model CHANGED
T = 2100 * S; ext.context({ messages: structuredClone(sent2) }, ctx2);
assertT2("model switch skips observation", { requestsObserved: 1, naturalMisses: 0 });

// ── s3: provider without cache telemetry → no miss counting, floor threshold ──
const ctx3 = { sessionManager: { getSessionFile: () => "/env/sessions/s3.jsonl" } };
const sent3 = [];
for (const [i, t] of [[0, 0], [1, 60 * S], [2, 90 * S], [3, 150 * S]]) {
	sent3.push(U(t), TR(`e${i}`, "read", 1000, t + 1), A(t + 2, usage(50)));
}
T = 60 * S; ext.context({ messages: structuredClone(sent3) }, ctx3); // no pending yet
sent3.push(A(61 * S, usage(50)));
T = 120 * S; ext.context({ messages: structuredClone(sent3) }, ctx3); // classifies, no cache fields ever
sent3.push(A(121 * S, usage(50)));
T = 2000 * S;
const msgs3 = ext.context({ messages: structuredClone(sent3) }, ctx3)?.messages; // idle 1880 ≥ 600 floor → sweeps
const assertT3 = (label, expect) => {
	const st = stats()["s3.jsonl"];
	for (const [k, v] of Object.entries(expect)) assert.strictEqual(st[k], v, `${label}: ${k} === ${v} (got ${st[k]})`);
};
assertT3("no telemetry → no misses", { requestsObserved: 2, naturalMisses: 0, telemetry: "" });
assert.ok(msgs3[1].content[0].text.includes("elided"), "floor threshold still sweeps");
assert.strictEqual(msgs3[4].content[0].text.length, 1000, "recent-window result kept");

// ── s4: config file (autere settings save) — floor, margin, keep turns ──
const ctx4 = { sessionManager: { getSessionFile: () => "/env/sessions/s4.jsonl" } };
let cfgSeq = 0;
const writeCfg = (obj) => {
	const p = join(agentDir, "janitor-config.json");
	writeFileSync(p, JSON.stringify(obj));
	utimesSync(p, 1e6 + cfgSeq, 1e6 + cfgSeq); // distinct mtime → invalidate the module's cache
	cfgSeq++;
};
writeCfg({ minIdleSec: 300, keepRecentTurns: 2, warmGapMultiplier: 1 });

const sent4 = [];
for (const [i, t] of [[0, 0], [1, 100 * S], [2, 200 * S], [3, 300 * S]]) {
	sent4.push(U(t), TR(`f${i}`, "read", 500, t + 1), A(t + 2, usage(10, 400)));
}
let lastSent4 = 0;
const ev4x = (t) => { T = t; lastSent4 = t; return ext.context({ messages: structuredClone(sent4) }, ctx4)?.messages; };
const respond4 = (u) => sent4.push(A(lastSent4 + 1000, usage(...u)));
const assertT4 = (label, expect) => {
	const st = stats()["s4.jsonl"];
	for (const [k, v] of Object.entries(expect)) assert.strictEqual(st[k], v, `${label}: ${k} === ${v} (got ${st[k]})`);
};

ev4x(0);
respond4([10, 400]);
ev4x(100 * S); // classify gap 0; threshold floor from config
respond4([10, 400]);
ev4x(350 * S); // classify warm gap 100 → threshold = max(300, 1×100) = 300
assertT4("config floor + margin", { warmGapSec: 100, thresholdSec: 300, sweeps: 0 });
respond4([10, 400]);
let msgs4 = ev4x(650 * S); // idle 300 ≥ 300 (old floor 600 / margin 2 would both block) → sweep
assertT4("eager config sweeps at 300", { sweeps: 1, stubbedToolResults: 2, thresholdSec: 300, warmGapSec: 250 });
assert.ok(msgs4[1].content[0].text.includes("elided"), "stubbed per keepRecentTurns=2 (boundary at U2)");
assert.strictEqual(msgs4[7].content[0].text.length, 500, "recent window wider with K=2: TR2 kept");

// Invalid values clamp (5→60 floor dominated by margin, 99→20 turns, 10→4 margin)
writeCfg({ minIdleSec: 5, keepRecentTurns: 99, warmGapMultiplier: 10 });
respond4([10, 400]);
ev4x(700 * S); // classify gap 50 warm → threshold = max(60, 250×4) = 1000
assertT4("invalid config clamps", { thresholdSec: 1000, sweeps: 1 });
respond4([10, 0, 0]);
ev4x(1700 * S); // idle 1000 ≥ 1000, but keepRecentTurns 99 → clamped 20 → nothing stubbable
assertT4("clamped turns block sweep", { sweeps: 1, naturalMisses: 1 });

// ── s5: respawn — a fresh process hydrates from the stats file ──
// Real trigger: autere idle-respawns pi. The idle that killed the previous
// process must still cause a sweep-on-awaken, counters must survive, and the
// giant respawn gap must not pollute retention learning.
writeCfg({ minIdleSec: 300, keepRecentTurns: 2, warmGapMultiplier: 1 });
const ctx5 = { sessionManager: { getSessionFile: () => "/env/sessions/s5.jsonl" } };
const sent5 = [];
for (const [i, t] of [[0, 0], [1, 60 * S], [2, 90 * S]]) {
	sent5.push(U(t), TR(`g${i}`, "read", 1000, t + 1), A(t + 2, usage(10, 400)));
}
let lastSent5 = 0;
const ev5 = (t) => { T = t; lastSent5 = t; return ext.context({ messages: structuredClone(sent5) }, ctx5)?.messages; };
const ev5b = (t) => { T = t; return extB.context({ messages: structuredClone(sent5) }, ctx5)?.messages; };
const respond5 = (u) => sent5.push(A(lastSent5 + 1000, usage(...u)));
const assertT5 = (label, expect) => {
	const st = stats()["s5.jsonl"];
	for (const [k, v] of Object.entries(expect)) assert.strictEqual(st[k], v, `${label}: ${k} === ${v} (got ${st[k]})`);
};
ev5(0);
respond5([10, 400]);
ev5(60 * S); // classify gap 60 → warmGap 60, threshold = max(300, 60) = 300
assertT5("s5 pre-respawn", { sweeps: 0, requestsObserved: 1, thresholdSec: 300, lastCtxAt: 60 * S });

// Process B: fresh factory = fresh in-memory state, same stats dir
const extB = makePi();
factory(extB);
T = 460 * S;
const msgs5 = extB.context({ messages: structuredClone(sent5) }, ctx5)?.messages; // idle 400 ≥ 300 → sweep on awaken
assert.ok(msgs5[1].content[0].text.includes("elided"), "sweep on awaken after respawn");
assertT5("respawn sweep + counters carried", { sweeps: 1, requestsObserved: 1, stubbedToolResults: 1 });
sent5.push(A(461 * S, usage(8, 0, 300))); // response to the awaken request
ev5b(470 * S); // classifies it: swept → postSweep, giant gap NOT learned
assertT5("respawn gap isolated", { postSweepRequests: 1, requestsObserved: 2, naturalMisses: 0, warmGapSec: 0 });

// ── s6: anchor fallback — a pre-fix entry (no lastCtxAt) seeds the anchor
// from the session file's mtime (last pi append ≈ last activity) ──
writeCfg({ minIdleSec: 300, keepRecentTurns: 2, warmGapMultiplier: 1 });
const s6File = join(agentDir, "s6.jsonl");
writeFileSync(s6File, "{}");
utimesSync(s6File, 500, 500); // last activity at clock-time 500s
const statsPre = JSON.parse(readFileSync(join(agentDir, "janitor-stats.json"), "utf-8"));
statsPre["s6.jsonl"] = { sweeps: 3, requestsObserved: 9 }; // pre-fix shape: no anchor field
writeFileSync(join(agentDir, "janitor-stats.json"), JSON.stringify(statsPre));

const ctx6 = { sessionManager: { getSessionFile: () => s6File } };
const sent6 = [];
for (const [i, t] of [[0, 0], [1, 100 * S], [2, 200 * S]]) {
	sent6.push(U(t), TR(`h${i}`, "read", 1000, t + 1), A(t + 2, usage(10, 400)));
}
const extC = makePi();
factory(extC);
T = 900 * S; // idle vs mtime anchor: 400s ≥ 300 → sweep on the fresh process's first request
const msgs6 = extC.context({ messages: structuredClone(sent6) }, ctx6)?.messages;
assert.ok(msgs6[1].content[0].text.includes("elided"), "mtime fallback anchor → sweep on awaken");
const assertT6 = (label, expect) => {
	const st = stats()["s6.jsonl"];
	for (const [k, v] of Object.entries(expect)) assert.strictEqual(st[k], v, `${label}: ${k} === ${v} (got ${st[k]})`);
};
assertT6("pre-fix counters carried + sweep", { sweeps: 4, requestsObserved: 9, stubbedToolResults: 1 });

// ── s7: compaction-imminent guard — near-full context skips the sweep ──
const ctx7 = (window) => ({ sessionManager: { getSessionFile: () => "/env/sessions/s7.jsonl" }, model: { contextWindow: window } });
const sent7 = [];
for (const [i, t] of [[0, 0], [1, 100 * S], [2, 200 * S]]) {
	sent7.push(U(t), TR(`k${i}`, "read", 1000, t + 1), A(t + 2, usage(10, 400)));
}
sent7.push(A(300 * S, usage(950, 0, 50))); // previous request filled 1000 tokens
const extD = makePi();
factory(extD);
T = 300 * S;
extD.context({ messages: structuredClone(sent7) }, ctx7(1000)); // request 1 → anchor
T = 800 * S; // idle 500 ≥ 300, but prevTokens 1000 > 0.8 × 1000 → skip
let msgs7 = extD.context({ messages: structuredClone(sent7) }, ctx7(1000))?.messages;
assert.strictEqual(msgs7[1].content[0].text.length, 1000, "near-full window → sweep skipped");
assert.strictEqual(stats()["s7.jsonl"].sweeps, 0, "no sweep counted near-full");
T = 1300 * S; // roomy window: 1000 ≤ 0.8 × 5000 → sweep
msgs7 = extD.context({ messages: structuredClone(sent7) }, ctx7(5000))?.messages;
assert.ok(msgs7[1].content[0].text.includes("elided"), "roomy window still sweeps");
assert.strictEqual(stats()["s7.jsonl"].sweeps, 1, "sweep counted with roomy window");

// ── stats file: per-session keys, corrupt-file survival ──
const all = stats();
assert.ok(all["s1.jsonl"].sweeps === 2, "s1 stats preserved");
assert.ok(all["s2.jsonl"], "s2 key present");
rmSync(join(agentDir, "janitor-stats.json"));
writeFileSync(join(agentDir, "janitor-stats.json"), "{corrupt");
T = 4500 * S;
assert.ok(ext.context({ messages: structuredClone(sent) }, ctx1)?.messages?.[1].content[0].text.includes("elided"), "survives corrupt stats");

console.log("pi-janitor smoke test: all assertions passed");
