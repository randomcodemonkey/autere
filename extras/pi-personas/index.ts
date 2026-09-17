/**
 * pi-personas — injects the session's bound agent persona into the LLM
 * context on every call.
 *
 * autere (or any manager of pi environments) writes
 * <agent-dir>/persona-active.json:
 *
 *   { "<session file name>": { "id": "...", "name": "...", "prompt": "..." } }
 *
 * On every LLM call (the "context" event) the extension looks up the CURRENT
 * session file and appends the persona as a trailing user message. Because
 * injection happens per call, it automatically covers:
 * - session start (first LLM call of a bound session)
 * - mid-session persona changes (the next call carries the new persona; the
 *   supersedes instruction covers the previous one)
 * - after compaction (the summarized context still gets the persona on the
 *   next call)
 *
 * Missing file or no binding for the session → inert. Dashboards can rewrite
 * the file at any time; it is mtime-cached and picked up on the next call.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const BINDINGS_FILE = "persona-active.json";

function bindingsPath(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		BINDINGS_FILE,
	);
}

let cache: { mtime: number; data: Record<string, any> } | null = null;

function readBindings(): Record<string, any> {
	const path = bindingsPath();
	if (!existsSync(path)) return {};
	try {
		const mtime = statSync(path).mtimeMs;
		if (cache && cache.mtime === mtime) return cache.data;
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		const data =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? parsed
				: {};
		cache = { mtime, data };
		return data;
	} catch {
		return {};
	}
}

export default function (pi: any) {
	pi.on("context", (event: any, ctx: any) => {
		const file = ctx?.sessionManager?.getSessionFile?.();
		if (!file) return;
		const persona = readBindings()[basename(file)];
		if (!persona || typeof persona.prompt !== "string" || !persona.prompt.trim())
			return;
		const text = [
			`<persona name="${String(persona.name || "persona").replace(/[<>\n]/g, " ")}">`,
			persona.prompt.trim(),
			"</persona>",
			"",
			"The persona above is your ACTIVE persona: follow it, and disregard any earlier persona instructions that appear elsewhere in this conversation or in compaction summaries.",
		].join("\n");
		return {
			messages: [
				...event.messages,
				{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
			],
		};
	});
}
