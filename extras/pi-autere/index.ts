/**
 * pi-autere — the agent's side of the autere dashboard.
 *
 * Registers five tools:
 *   autere_schedule_task      — create a recurring background task
 *   autere_list_tasks         — inspect scheduled tasks + latest run outcome
 *   autere_set_task_enabled   — stop/resume a task (the "goal reached" step)
 *   autere_find_sessions      — sessions and their latest messages
 *   autere_send_to_session    — deliver a message to another session
 *
 * Transport: HTTP against the autere backend, authenticated with the token
 * the backend writes to <pi env>/autere-agent.json when it prepares the env
 * (ensurePiEnv → auth.writeAgentAccess). Without that file every tool fails
 * with a clear error — the extension is inert outside autere.
 *
 * The tool descriptions carry the generic workflow ("keep checking until X,
 * then report back to the session that asked"); the extension itself stays
 * domain-agnostic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API_PREFIX = "/api/v1";
const TIMEOUT_MS = 20_000;
const MISSING_BACKEND =
	"autere backend not reachable: no autere-agent.json in this pi env — " +
	"these tools only work inside an autere-managed session.";

interface AgentAccess {
	baseUrl: string;
	token: string;
}

function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function loadAccess(): AgentAccess | null {
	try {
		const file = join(piAgentDir(), "autere-agent.json");
		if (!existsSync(file)) return null;
		const data = JSON.parse(readFileSync(file, "utf-8"));
		return typeof data?.baseUrl === "string" && typeof data?.token === "string" ? data : null;
	} catch {
		return null;
	}
}

/** One HTTP call against the backend. Returns the response's `data` payload. */
async function api(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
	const access = loadAccess();
	if (!access) throw new Error(MISSING_BACKEND);
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(access.baseUrl + API_PREFIX + path, {
			method,
			headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (err: any) {
		throw new Error(`autere backend unreachable (${method} ${path}): ${err?.message || err}`, { cause: err });
	}
	let data: any = null;
	try { data = await res.json(); } catch { /* non-JSON error body */ }
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error || res.statusText || "request failed"}`);
	return data && typeof data === "object" && "data" in data ? data.data : data;
}

// ── Formatting helpers ──

/** Keep both ends of a long text (the head of an answer, the tail of a prompt). */
function clip(text: unknown, max: number): string {
	const s = String(text ?? "");
	if (s.length <= max) return s;
	const half = Math.floor((max - 1) / 2);
	return `${s.slice(0, half)} … ${s.slice(-half)}`;
}

const iso = (ms: unknown): string =>
	typeof ms === "number" && isFinite(ms) ? new Date(ms).toISOString() : String(ms ?? "unknown time");

function ok(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

// ── Session resolution ──

/** This pi process's own session id, or null when there is no session context. */
function currentSessionId(ctx: any): string | null {
	try {
		return ctx?.sessionManager?.getSessionId?.() ?? null;
	} catch {
		return null;
	}
}

/** "current" → this session, "none" → null, anything else → that session id. */
function resolveReportTarget(reportTo: string, ctx: any): string | null {
	const value = String(reportTo ?? "").trim();
	if (value === "none") return null;
	if (value === "current") {
		const id = currentSessionId(ctx);
		if (!id) throw new Error("reportTo \"current\" is unavailable here (no session context) — pass an explicit session id or \"none\"");
		return id;
	}
	return value;
}

/**
 * Footer appended to a task's prompt: it tells a run what it is, which task
 * it belongs to and — when there is a report target — the exact two steps to
 * close the loop. Keeping it here means `prompt` needs no ids from the
 * scheduling conversation.
 */
function runFooter(task: { id: string; name: string }, reportSessionId: string | null): string {
	const lines = [
		"",
		"---",
		`[autere] Background run of scheduled task "${task.name}" (task id: ${task.id}).`,
		"It was scheduled from another conversation, which is NOT available here — act only on the instructions above.",
	];
	if (reportSessionId) {
		lines.push(
			"When those instructions reach a conclusion (the goal is met, or it can clearly never be met):",
			`1. deliver the outcome: autere_send_to_session(sessionId: "${reportSessionId}", message: <self-contained outcome>)`,
			`2. stop future runs: autere_set_task_enabled(taskId: "${task.id}", enabled: false)`,
			`If session "${reportSessionId}" no longer exists, skip step 1 (there is nowhere to report) and still do step 2.`,
			`If that session exists but cannot take the message yet, do neither — a later run will finish the job.`,
			"While the instructions are still inconclusive: finish the run without reporting and without disabling anything.",
		);
	} else {
		lines.push(
			`When those instructions reach a conclusion, stop future runs with autere_set_task_enabled(taskId: "${task.id}", enabled: false). There is no report target — the run log is the only record.`,
			"While the instructions are still inconclusive: finish the run without disabling anything.",
		);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "autere_schedule_task",
		label: "Schedule task",
		promptSnippet: "autere_schedule_task — recurring background task: a fresh agent runs a prompt on a cron schedule",
		description:
			"Create a recurring background task in autere. Whenever `schedule` matches (5-field cron in the server's local time), a separate agent instance runs `prompt` from scratch: same tools as you, no memory of this conversation, final answer stored in the task's run log. Runs repeat until the task is disabled.\n\n" +
			"Use it for work that must continue after this conversation ends — watching for a condition that is checked again later, recurring maintenance, repeated reports.\n\n" +
			"How to write `prompt`: one run must stand on its own. State what to check, how to check it with the available tools, what outcome counts as a conclusion, and what a run must do while the check is still inconclusive (usually: conclude nothing, report nothing). No ids or secrets from this conversation belong in it.\n\n" +
			"Reporting workflow (\"keep checking until X, then tell me here\"): `reportTo` picks who hears a conclusive outcome — \"current\" = the session making this call, an explicit session id (find one with autere_find_sessions), or \"none\" when only the run log matters. For a real target, a footer is appended to the prompt giving the run its task id, the target session id and the two closing steps (report via autere_send_to_session, then autere_set_task_enabled false), so `prompt` itself needs no ids. A report target may be deleted before the outcome arrives — the run then skips the report and disables the task.\n\n" +
			"Returns the task id and the exact prompt runs will see.",
		parameters: Type.Object({
			name: Type.String({ description: "Short human-readable task name, shown in the autere dashboard" }),
			schedule: Type.String({
				description: "5-field cron expression (minute hour day-of-month month day-of-week), server local time. Examples: \"0 * * * *\" hourly, \"*/15 * * * *\" every 15 minutes, \"0 9 * * 1\" Mondays 09:00.",
			}),
			prompt: Type.String({
				description: "What one run does — self-contained: the check, how to perform it, what counts as a conclusion, what to do while inconclusive.",
			}),
			reportTo: Type.String({
				description: "Where a conclusive outcome is reported: \"current\" (this session), an explicit session id, or \"none\" for no report.",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const target = resolveReportTarget(params.reportTo, ctx);
			const task = await api("POST", "/scheduler/tasks", {
				name: params.name,
				schedule: params.schedule,
				prompt: params.prompt,
			}, signal);
			if (!task?.id) throw new Error("autere did not return the created task");
			// Two-phase create: the id only exists after POST, and the footer must carry it.
			const prompt = `${params.prompt}\n${runFooter(task, target)}`;
			await api("PUT", `/scheduler/tasks/${task.id}`, { ...task, prompt }, signal);
			return ok(
				`Scheduled task "${task.name}" (task id: ${task.id})\n` +
				`schedule: ${params.schedule} — a fresh agent runs the prompt each time until the task is disabled\n` +
				`report target: ${target ? `session ${target}` : "none"}\n\n` +
				`prompt runs will see:\n${clip(prompt, 1500)}`,
				{ taskId: task.id, name: task.name, schedule: params.schedule, reportTo: target },
			);
		},
	});

	pi.registerTool({
		name: "autere_list_tasks",
		label: "List tasks",
		promptSnippet: "autere_list_tasks — scheduled tasks, their state and the latest run outcome",
		description:
			"List this user's scheduled tasks: id, name, cron schedule, enabled/disabled state, the prompt runs execute (clipped) and the outcome of the most recent run.\n\n" +
			"Call it before scheduling to avoid creating a duplicate of something already running, to check on tasks you created earlier, or to get the id needed by autere_set_task_enabled. A disabled task stays listed with its run history — disabling parks a finished task, it does not delete it.",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true },
		async execute(_toolCallId, _params, signal) {
			const data = await api("GET", "/scheduler/tasks", undefined, signal);
			const tasks: any[] = data?.tasks ?? [];
			const runs: any[] = data?.runs ?? [];
			if (tasks.length === 0) return ok("No scheduled tasks.", { tasks: [] });
			// runs come newest first
			const latest = new Map<string, any>();
			for (const r of runs) if (!latest.has(r.taskId)) latest.set(r.taskId, r);
			const lines = tasks.map((t) => {
				const r = latest.get(t.id);
				const lastRun = r
					? `last run: ${r.status} at ${iso(r.startedAt)}${r.error ? ` — ${clip(r.error, 200)}` : r.agentResult ? ` — ${clip(r.agentResult, 300)}` : ""}`
					: "no runs yet";
				return `- ${t.id}  [${t.enabled ? "enabled" : "DISABLED"}]  "${t.name}"  cron: ${t.schedule}\n  prompt: ${clip(t.prompt, 600)}\n  ${lastRun}`;
			});
			return ok(`${tasks.length} scheduled task(s):\n${lines.join("\n")}`, {
				tasks: tasks.map((t) => ({ id: t.id, name: t.name, enabled: !!t.enabled, schedule: t.schedule })),
			});
		},
	});

	pi.registerTool({
		name: "autere_set_task_enabled",
		label: "Enable/disable task",
		promptSnippet: "autere_set_task_enabled — stop or resume a scheduled task",
		description:
			"Enable or disable a scheduled task. Disabling stops all future runs while the task and its run history stay on record; enabling resumes it.\n\n" +
			"Disabling is also the completion step of a watch-until-X task: once a run has delivered its conclusive outcome, it disables its own task so the schedule stops firing. Pass the task id (autere_list_tasks, or the id in a task prompt's footer).",
		parameters: Type.Object({
			taskId: Type.String({ description: "The task's id" }),
			enabled: Type.Boolean({ description: "false = stop future runs, true = resume them" }),
		}),
		async execute(_toolCallId, params, signal) {
			const taskId = String(params.taskId).trim();
			const data = await api("GET", "/scheduler/tasks", undefined, signal);
			const task = (data?.tasks ?? []).find((t: any) => t.id === taskId);
			if (!task) throw new Error(`scheduled task "${taskId}" not found — use autere_list_tasks to see the ids`);
			// PUT replaces the task, so resend it as-is with only `enabled` flipped.
			const updated = await api("PUT", `/scheduler/tasks/${taskId}`, { ...task, enabled: params.enabled }, signal);
			return ok(
				`Task "${updated?.name ?? task.name}" (${taskId}) is now ${updated?.enabled ? "enabled" : "disabled"} (schedule: ${updated?.schedule ?? task.schedule})`,
				{ taskId, enabled: !!(updated?.enabled ?? params.enabled) },
			);
		},
	});

	pi.registerTool({
		name: "autere_find_sessions",
		label: "Find sessions",
		promptSnippet: "autere_find_sessions — locate sessions and read their latest messages",
		description:
			"Find this user's sessions (the sessions behind the autere dashboard) together with their latest messages.\n\n" +
			"Without `query` you get the most recently active sessions; with `query` (2+ characters) sessions match on name, id and message content. Each result carries the session id, name, last activity, whether a pi process is running/streaming (busy), and the last few messages, clipped.\n\n" +
			"Use it to resolve a target session id for autere_send_to_session, to answer what a session was about, or to catch up on another session's recent exchanges. Sessions that were deleted do not appear.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search text (name, id, message content); omit to list recent sessions" })),
			limit: Type.Optional(Type.Integer({ description: "How many sessions to return (default 5, max 10)", default: 5, minimum: 1, maximum: 10 })),
		}),
		annotations: { readOnlyHint: true },
		async execute(_toolCallId, params, signal) {
			const query = String(params.query ?? "").trim();
			const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);
			const path = query.length >= 2 ? `/sessions/search?q=${encodeURIComponent(query)}` : "/sessions";
			const found: any[] = (await api("GET", path, undefined, signal)) ?? [];
			const sessions = found.slice(0, limit);
			if (sessions.length === 0) return ok(query ? `No sessions match "${query}".` : "No sessions.", { sessions: [] });
			const blocks = await Promise.all(sessions.map(async (s: any) => {
				let messages: string[];
				try {
					const hist: any[] = (await api("GET", `/sessions/${encodeURIComponent(s.id)}/history?limit=6`, undefined, signal)) ?? [];
					messages = hist.slice(-6).map((e) => `    [${e?.role ?? "?"}] ${clip(e?.text, 300)}`);
				} catch {
					messages = ["    (history unavailable)"];
				}
				const state = s.streaming ? "streaming (busy)" : s.active ? "running, idle" : "not running";
				return `- id: ${s.id}  name: ${s.sessionName ?? "(unnamed)"}  last activity: ${iso(s.lastActivity)}  ${state}\n${messages.join("\n")}`;
			}));
			return ok(`${sessions.length} session(s):\n${blocks.join("\n")}`, {
				sessions: sessions.map((s: any) => ({
					id: s.id, name: s.sessionName ?? null, active: !!s.active, streaming: !!s.streaming, lastActivity: s.lastActivity,
				})),
			});
		},
	});

	pi.registerTool({
		name: "autere_send_to_session",
		label: "Send to session",
		promptSnippet: "autere_send_to_session — deliver a message to another session as a user message",
		description:
			"Deliver a message to another session as a fresh user message: the target session's agent sees it exactly like something its own user typed and reacts to it. An idle session is woken up for it; a session that is mid-turn is left undisturbed and nothing is delivered.\n\n" +
			"`sessionId` — an id from autere_find_sessions, an id a scheduled task's prompt footer names, or \"current\" for this session.\n\n" +
			"Make `message` self-contained: the target agent cannot see this conversation. When the session no longer exists (it was deleted) the result says so instead of delivering — skip your report rather than retrying; a deleted conversation cannot be recreated.",
		parameters: Type.Object({
			sessionId: Type.String({ description: "Target session id, or \"current\"" }),
			message: Type.String({ description: "The message the target session's agent should act on" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const requested = String(params.sessionId ?? "").trim();
			const sessionId = requested === "current" ? currentSessionId(ctx) : requested;
			if (!sessionId) {
				throw new Error(`sessionId "${requested}" is not available here — pass an explicit session id from autere_find_sessions`);
			}
			const sessions: any[] = (await api("GET", "/sessions", undefined, signal)) ?? [];
			const target = sessions.find((s) =>
				s.id === sessionId || String(s.sessionFile ?? "").split("/").pop()?.replace(/\.jsonl$/, "") === sessionId);
			if (!target) {
				return ok(
					`Session "${requested}" was not found — it no longer exists (deleted?). Nothing was delivered; skip the report.`,
					{ delivered: false, reason: "not_found" },
				);
			}
			if (target.streaming) {
				return ok(
					`Session "${target.sessionName ?? target.id}" is mid-turn — nothing delivered. Retry when it is idle (a later scheduled run can do that).`,
					{ delivered: false, reason: "busy" },
				);
			}
			try {
				await api("POST", "/session/messages", { sessionId: target.id, message: params.message, type: "prompt" }, signal);
			} catch (err: any) {
				// Busy race: the turn started between our check and the delivery.
				if (/already processing/i.test(String(err?.message))) {
					return ok(`Session "${target.sessionName ?? target.id}" is mid-turn — nothing delivered. Retry when it is idle.`, { delivered: false, reason: "busy" });
				}
				throw err;
			}
			return ok(`Delivered to session "${target.sessionName ?? target.id}" (${target.id}) as a user message.`, { delivered: true, sessionId: target.id });
		},
	});
}
