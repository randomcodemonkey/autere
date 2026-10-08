// Run: npx tsx smoke-test.mjs  (from extras/pi-autere)
// Spins up a stub autere backend, has the backend-side helpers mint the agent
// token + write autere-agent.json, then drives all five tools against it.
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const root = mkdtempSync(join(tmpdir(), "pi-autere-test-"));
const envDir = join(root, "pi-envs", "alice");
mkdirSync(envDir, { recursive: true });
process.env.AUTERE_DIR = join(root, "autere");
process.env.AUTERE_PI_ENVS_DIR = join(root, "pi-envs");
process.env.PI_CODING_AGENT_DIR = envDir;

// ── Stub autere backend ──
const state = { tasks: [], runs: [], sessions: [], sent: [], busy: false, auth: new Set() };
let taskSeq = 0;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const data = (res, body) => json(res, 200, { success: true, data: body });

const server = createServer((req, res) => {
  if (req.headers.authorization) state.auth.add(req.headers.authorization);
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url.replace("/api/v1", "").split("?")[0];
    if (req.method === "POST" && path === "/scheduler/tasks") {
      const task = { id: `task-${++taskSeq}`, enabled: true, createdAt: 1, updatedAt: 1, ...body };
      state.tasks.push(task);
      return json(res, 201, { success: true, data: task });
    }
    const putTask = path.match(/^\/scheduler\/tasks\/(task-\d+)$/);
    if (req.method === "PUT" && putTask) {
      const i = state.tasks.findIndex((t) => t.id === putTask[1]);
      if (i < 0) return json(res, 404, { success: false, error: "Task not found" });
      state.tasks[i] = { ...state.tasks[i], ...body, id: putTask[1] };
      return data(res, state.tasks[i]);
    }
    if (req.method === "GET" && path === "/scheduler/tasks") {
      return data(res, { tasks: state.tasks, runs: state.runs });
    }
    if (req.method === "GET" && path === "/sessions") return data(res, state.sessions);
    if (req.method === "GET" && path === "/sessions/search") {
      const q = new URL(req.url, baseUrl).searchParams.get("q").toLowerCase();
      return data(res, state.sessions.filter((s) =>
        s.id.toLowerCase().includes(q) || String(s.sessionName).toLowerCase().includes(q)));
    }
    const hist = path.match(/^\/sessions\/(s\d+)\/history$/);
    if (req.method === "GET" && hist) {
      return data(res, hist[1] === "s1"
        ? [{ role: "user", text: "hello there" }, { role: "assistant", text: "hi, what can I do" }]
        : [{ role: "user", text: "other session" }]);
    }
    if (req.method === "POST" && path === "/session/messages") {
      if (state.busy) return json(res, 500, { success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
      state.sent.push(body);
      return data(res, {});
    }
    return json(res, 404, { success: false, error: `stub: no route ${req.method} ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
process.env.AUTERE_BACKEND_URL = baseUrl;
state.sessions = [
  { id: "s1", sessionName: "Alpha", sessionFile: `${envDir}/sessions/s1.jsonl`, lastActivity: 1700000000000, active: true, streaming: false },
  { id: "s2", sessionName: "Beta", sessionFile: `${envDir}/sessions/s2.jsonl`, lastActivity: 1700000100000, active: true, streaming: true },
];
state.runs = [{ runId: "r1", taskId: "task-1", taskName: "Alpha task", trigger: "schedule", startedAt: 1700000200000, status: "success", agentResult: "condition not met yet" }];

const finish = (code) => {
  server.close();
  rmSync(root, { recursive: true, force: true });
  if (code) console.error("pi-autere smoke test FAILED");
  process.exit(code);
};

try {
  // ── Backend helpers: mint the token, write the agent's access file ──
  const auth = await import("../../src/backend/auth.ts");
  const token = auth.ensureAgentToken("alice");
  assert.strictEqual(auth.ensureAgentToken("alice"), token, "agent token is stable across spawns");
  assert.ok(readFileSync(join(process.env.AUTERE_DIR, "autere-auth-tokens.json"), "utf-8").includes(token), "token persisted");
  auth.writeAgentAccess("alice");
  const access = JSON.parse(readFileSync(join(envDir, "autere-agent.json"), "utf-8"));
  assert.strictEqual(access.baseUrl, baseUrl, "agent access points at the backend");
  assert.strictEqual(access.token, token, "agent access carries the minted token");
  assert.strictEqual(access.user, "alice");

  // ── Register the tools ──
  const tools = {};
  const { default: factory } = await import("./index.ts");
  factory({ registerTool: (t) => (tools[t.name] = t) });
  for (const name of ["autere_schedule_task", "autere_list_tasks", "autere_set_task_enabled", "autere_find_sessions", "autere_send_to_session"]) {
    assert.ok(tools[name], `${name} registered`);
  }
  const run = (name, params, ctx) => tools[name].execute("call-1", params, undefined, undefined, ctx);
  const text = (r) => r.content.map((c) => c.text).join("\n");
  const ctx = { sessionManager: { getSessionId: () => "s1" } };

  // 1. schedule with a report target → footer carries ids + both closing steps
  const created = await run("autere_schedule_task", {
    name: "Alpha task", schedule: "0 * * * *", prompt: "Check the condition. Conclude only when certain.", reportTo: "current",
  }, ctx);
  assert.ok(text(created).includes("task-1"), "result reports the task id");
  const p1 = state.tasks[0].prompt;
  assert.ok(p1.startsWith("Check the condition."), "original prompt kept");
  assert.ok(p1.includes(`[autere] Background run of scheduled task "Alpha task" (task id: task-1)`), "footer names the task");
  assert.ok(p1.includes(`autere_send_to_session(sessionId: "s1"`), "footer names the report session");
  assert.ok(p1.includes(`autere_set_task_enabled(taskId: "task-1", enabled: false)`), "footer carries the disable step");
  assert.ok(/not available here/i.test(p1), "footer warns runs have no scheduling context");

  // 2. reportTo none → no reporting steps in the footer
  await run("autere_schedule_task", { name: "Beta task", schedule: "*/15 * * * *", prompt: "Do the thing.", reportTo: "none" }, ctx);
  const p2 = state.tasks[1].prompt;
  assert.ok(p2.includes("no report target"), "footer says there is no report target");
  assert.ok(!p2.includes("autere_send_to_session("), "no delivery step without a report target");

  // 3. reportTo current without a session context is a clear error
  await assert.rejects(
    run("autere_schedule_task", { name: "x", schedule: "0 * * * *", prompt: "p", reportTo: "current" }, undefined),
    /no session context/,
  );

  // 4. list tasks — state, cron and the latest run outcome
  const list = text(await run("autere_list_tasks", {}, ctx));
  assert.ok(list.includes("2 scheduled task(s)"), "both tasks listed");
  assert.ok(list.includes("cron: 0 * * * *"), "schedule shown");
  assert.ok(list.includes("last run: success") && list.includes("condition not met yet"), "latest run outcome shown");

  // 5. disable a task: only `enabled` changes, everything else survives the PUT
  const disabled = await run("autere_set_task_enabled", { taskId: "task-1", enabled: false }, ctx);
  assert.ok(text(disabled).includes("now disabled"), "disable reported");
  assert.strictEqual(state.tasks[0].enabled, false, "task disabled server-side");
  assert.strictEqual(state.tasks[0].prompt, p1, "prompt untouched by the toggle");
  assert.ok(text(await run("autere_list_tasks", {}, ctx)).includes("[DISABLED]"), "list shows it disabled");
  await assert.rejects(run("autere_set_task_enabled", { taskId: "nope", enabled: false }, ctx), /not found/);

  // 6. find sessions — ids, busy state, latest messages
  const found = text(await run("autere_find_sessions", {}, ctx));
  assert.ok(found.includes("id: s1") && found.includes("id: s2"), "sessions listed");
  assert.ok(found.includes("running, idle") && found.includes("streaming (busy)"), "busy state shown");
  assert.ok(found.includes("[user] hello there"), "latest messages included");
  const byName = text(await run("autere_find_sessions", { query: "Beta" }, ctx));
  assert.ok(byName.includes("id: s2") && !byName.includes("id: s1"), "content search works");

  // 7. send_to_session — missing / busy / delivered
  const missing = await run("autere_send_to_session", { sessionId: "ghost", message: "hi" }, ctx);
  assert.deepStrictEqual(missing.details, { delivered: false, reason: "not_found" }, "deleted session reported, not delivered");
  const busy = await run("autere_send_to_session", { sessionId: "s2", message: "hi" }, ctx);
  assert.strictEqual(busy.details.reason, "busy", "mid-turn session not disturbed");
  assert.strictEqual(state.sent.length, 0, "nothing delivered yet");
  const delivered = await run("autere_send_to_session", { sessionId: "current", message: "outcome: still waiting" }, ctx);
  assert.strictEqual(delivered.details.delivered, true, "delivered to the idle session");
  assert.deepStrictEqual(state.sent[0], { sessionId: "s1", message: "outcome: still waiting", type: "prompt" }, "sent as a user prompt");
  state.busy = true;
  const race = await run("autere_send_to_session", { sessionId: "s1", message: "hi" }, ctx);
  assert.strictEqual(race.details.reason, "busy", "turn started mid-flight → busy, not an error");
  state.busy = false;

  // 8. every call authenticated with the minted token
  assert.deepStrictEqual([...state.auth], [`Bearer ${token}`], "backend saw exactly the agent token");

  // 9. without the access file the tools fail loudly instead of silently
  renameSync(join(envDir, "autere-agent.json"), join(envDir, "autere-agent.json.bak"));
  await assert.rejects(run("autere_find_sessions", {}, ctx), /not reachable/);
  renameSync(join(envDir, "autere-agent.json.bak"), join(envDir, "autere-agent.json"));

  console.log("pi-autere smoke test: all assertions passed");
  finish(0);
} catch (err) {
  console.error(err);
  finish(1);
}
