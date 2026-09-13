/**
 * pi-filetools — file plumbing between the user and the agent:
 *
 * 1. Attachment intake: saves images attached to user prompts to the
 *    pi-env's uploads/ directory and appends the saved paths to the prompt
 *    text (image blocks are kept, so vision models still see them).
 * 2. save_file tool: lets the agent hand a file to the user (downloadable
 *    file card in dashboards like autere) via a file_saved session entry.
 * 3. Bash edit detection: diffs files changed by bash commands (command
 *    write-targets + cwd sweep) into file_change entries, rendered as edit
 *    cards. Folders in EDIT_IGNORE_PATHS (colon-separated, default /tmp)
 *    are skipped; .git folders are always skipped at any depth. Chat cards
 *    cap at 10 per command with a summary line; the JSONL records all.
 * 4. Edit/write tracking: hooks edit and write tool results to compute
 *    diffs and write them to a per-session JSONL file in the pi-env
 *    (<env>/file-changes/<session-id>.jsonl) for the autere changes tab.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { basename as pathBasename, extname, join, relative } from "node:path";
import { Type } from "typebox";
import { createTwoFilesPatch } from "diff";

interface InputImage {
	type: "image";
	data: string; // base64, no data: prefix
	mimeType: string;
}

interface FileChangeEntry {
	ts: number;
	path: string;
	tool: string;
	change: string;
	diff: string;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

const MIME_BY_EXT: Record<string, string> = {
	".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain",
	".md": "text/markdown", ".json": "application/json", ".xml": "application/xml",
	".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
	".doc": "application/msword", ".xls": "application/vnd.ms-excel",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".mp3": "audio/mpeg", ".mp4": "video/mp4", ".wav": "audio/wav", ".svg": "image/svg+xml",
};

export default function (pi: any) {
	// ── File-changes tracking (per-session JSONL for autere) ──
	let fileChangesPath: string | null = null;
	let fileChangesCount = 0;
	const MAX_FILE_CHANGES = 10000;

	const ensureFileChangesDir = (envDir: string): string => {
		const dir = join(envDir, "file-changes");
		try { mkdirSync(dir, { recursive: true }); } catch {}
		return dir;
	};

	const writeChange = (entry: FileChangeEntry): void => {
		if (!fileChangesPath || fileChangesCount >= MAX_FILE_CHANGES) return;
		try {
			appendFileSync(fileChangesPath, JSON.stringify(entry) + "\n");
			fileChangesCount++;
		} catch {}
	};

	pi.on("session_start", (_event: any, ctx: any) => {
		try {
			const sf = ctx.sessionManager?.getSessionFile();
			if (sf) {
				const dir = ensureFileChangesDir(agentDir());
				fileChangesPath = join(dir, `${pathBasename(sf, ".jsonl")}.jsonl`);
				fileChangesCount = 0;
			}
		} catch {}
	});

	// Bash-driven file edits: snapshot the workspace (path -> mtime/size,
	// plus cached content) before/after each bash call and emit changed
	// files as unified-diff edit entries — so shell one-liner edits show up
	// as edit cards like pi's own edit tool. No git required.
	// ponytail: full-tree content cache capped at 64MB/20k files, skips
	// heavy dirs — upgrade to a watcher (chokidar) if trees outgrow it.
	const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", "uploads", "__pycache__", ".venv", "venv", ".cache", "target"]);
	const MAX_FILE_BYTES = 512 * 1024;
	const MAX_CACHE_BYTES = 64 * 1024 * 1024;
	const MAX_FILES = 20000;
	const MAX_CHANGED = 10;
	const MAX_DIFF_LINES = 400;
	const contentCache = new Map<string, { mtimeMs: number; size: number; content: string }>();
	let cacheBytes = 0;
	const bashSnapshots = new Map<string, { stats: Map<string, { mtimeMs: number; size: number }>; candidates: Map<string, string | null> }>();
	// Pre-content snapshots for edit/write: the cwd cache skips dot-dirs, so
	// without this every edit outside the tree (e.g. ~/.pi) misclassifies as
	// "created". Keyed by toolCallId, consumed in tool_result on success AND
	// failure; size-capped at insert so lost result events can't leak.
	const pendingToolSnapshots = new Map<string, { old: string | null; existed: boolean }>();
	const SNAPSHOT_CAP = 32;
	const putSnapshot = (map: Map<string, any>, id: string, value: any): void => {
		while (map.size >= SNAPSHOT_CAP) map.delete(map.keys().next().value);
		map.set(id, value);
	};

	// Extract explicit write targets from the command text (redirects, tee,
	// sed -i — heredoc bodies are part of the command, so writes like
	// `> /tmp/x` inside them are caught). Absolute paths only: relative
	// ones are covered by the cwd sweep.
	const candidatePaths = (cmd: string): string[] => {
		const out = new Set<string>();
		const add = (raw: string | undefined) => {
			if (!raw) return;
			const p = raw.replace(/^["']|["']$/g, "").replace(/\\/g, "");
			try {
				if (p.startsWith("/")) out.add(p);
				else if (p.startsWith("~/")) out.add(join(homedir(), p.slice(2)));
			} catch {}
		};
		for (const m of cmd.matchAll(/(?:>>?|2>|&>)\s*(\S+)/g)) add(m[1]);
		for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?(\S+)/g)) add(m[1]);
		for (const m of cmd.matchAll(/\bsed\b[^\n]*\s-i[^\n]*\s(\S+)/g)) add(m[1]);
		return [...out].filter((p) => { try { return statSync(p).isFile(); } catch { return true; } });
	};

	const looksBinary = (buf: Buffer): boolean => {
		const n = Math.min(buf.length, 8192);
		for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
		return false;
	};

	const walk = (dir: string, out: Map<string, { mtimeMs: number; size: number }>): void => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (out.size >= MAX_FILES) return;
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, out);
			} else if (e.isFile()) {
				try { const st = statSync(p); out.set(p, { mtimeMs: st.mtimeMs, size: st.size }); } catch {}
			}
		}
	};

	const readText = (path: string, size: number): string | null => {
		if (size > MAX_FILE_BYTES) return null;
		try {
			const buf = readFileSync(path);
			if (looksBinary(buf)) return null;
			return buf.toString("utf-8");
		} catch { return null; }
	};

	// Context-limited unified diff (like pi's edit tool: 2 lines around each
	// hunk) instead of a whole-file diff. Header (===/---/+++) stripped —
	// renderEditDiff renders its own.
	const diffToLines = (oldText: string, newText: string, limit: number = MAX_DIFF_LINES): string => {
		const patch = createTwoFilesPatch("a", "b", oldText, newText, "", "", { context: 2 });
		const idx = patch.indexOf("\n@@");
		if (idx < 0) return "";
		const lines = patch.slice(idx + 1).split("\n").filter((l) => l.trim() !== "\\ No newline at end of file");
		if (lines.length >= limit) return lines.slice(0, limit).join("\n") + "\n... (diff truncated)";
		return lines.join("\n");
	};

	const IGNORED = (process.env.EDIT_IGNORE_PATHS || "/tmp")
		.split(":").map((p) => p.trim().replace(/\/+$/, "")).filter(Boolean);
	// ponytail: segment matcher duplicated from src/shared/edit-ignore.ts —
	// this extension deploys STANDALONE (copied/symlinked into pi-env
	// extensions dirs) and must not import outside its package. Keep in sync;
	// add shared-import back only if deployment ever loads from the repo.
	// Semantics: .git always ignored at any depth; entries match path
	// segments — relative entries ('pgdata') at any depth, absolute entries
	// ('/home/slop/pgdata') anchored at the root, never substring matches.
	const isIgnored = (path: string): boolean => {
		const segs = path.split("/").filter(Boolean);
		if (segs.includes(".git")) return true;
		return IGNORED.some((dir) => {
			const parts = dir.split("/").filter(Boolean);
			if (parts.length === 0 || parts.length > segs.length) return false;
			const start = dir.startsWith("/") ? 0 : -1;
			const last = start === 0 ? 1 : segs.length - parts.length + 1;
			for (let i = start; i < last; i++) {
				let ok = true;
				for (let j = 0; j < parts.length; j++) {
					if (segs[i + j] !== parts[j]) { ok = false; break; }
				}
				if (ok) return true;
			}
			return false;
		});
	};

	const classify = (newContent: string | null, existed: boolean): string =>
		newContent === null ? "deleted" : !existed ? "created" : "modified";

	// Edit-card header verb: pure additions = Write, matching pi's write tool
	const diffHeader = (change: string, existed: boolean, body: string, rel: string): string => {
		const removals = /^-./m.test(body);
		return `${change === "deleted" ? "Delete" : !removals && existed ? "Write" : change === "created" ? "Create" : "Modified"} ${rel}`;
	};

	// Keep the content cache in sync after an emitted change
	const updateCache = (path: string, newContent: string | null): void => {
		if (newContent !== null) {
			if (!contentCache.has(path)) cacheBytes += newContent.length;
			else cacheBytes += newContent.length - (contentCache.get(path)?.content.length || 0);
			try {
				const st = statSync(path);
				contentCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, content: newContent });
			} catch {}
		} else {
			const c = contentCache.get(path);
			if (c) { cacheBytes -= c.content.length; contentCache.delete(path); }
		}
	};

	// Chat edit cards cap per bash command (a git pull can change hundreds of
	// files); the file-changes JSONL (autere edits tab) always records all
	const emitFileChanges = (snap: { stats: Map<string, { mtimeMs: number; size: number }>; candidates: Map<string, string | null> }): void => {
		// 1) Explicit write targets from the command text (anywhere on disk)
		let changed = 0;
		let chatShown = 0;
		const emit = (path: string, oldContent: string | undefined, newContent: string | null, existed: boolean, tool: string): void => {
			if (isIgnored(path)) return;
			const rel = path.startsWith(process.cwd()) ? relative(process.cwd(), path) : path;
			if (newContent === null && oldContent === undefined) return;
			if (newContent !== null && oldContent === newContent) return;
			const change = classify(newContent, existed);
			const fullBody = diffToLines(oldContent ?? "", newContent ?? "", Infinity);
			const header = diffHeader(change, existed, fullBody, rel);
			if (newContent !== null && oldContent !== undefined && fullBody.replace(/^[+\- ]/gm, "").trim() === "") return;
			changed++;
			writeChange({ ts: Date.now(), path: rel, tool, change, diff: `${header}\n\n${fullBody}` });
			if (chatShown < MAX_CHANGED) {
				// Session file gets truncated diff, file-changes JSONL gets full diff
				const sessionDiff = fullBody.length > MAX_DIFF_LINES * 60
					? fullBody.split("\n").slice(0, MAX_DIFF_LINES).join("\n") + "\n... (diff truncated)"
					: fullBody;
				pi.appendEntry("file_change", { path: rel, change, diff: `${header}\n\n${sessionDiff}` });
				chatShown++;
			}
			updateCache(path, newContent);
		};
		for (const [path, oldContent] of snap.candidates) {
			let newContent: string | null = null;
			try { newContent = readText(path, statSync(path).size); } catch {}
			emit(path, oldContent ?? contentCache.get(path)?.content, newContent, oldContent !== undefined || contentCache.has(path), "bash");
		}
		// 2) Sweep the cwd tree for changes the command text didn't reveal
		const before = snap.stats;
		const after = new Map<string, { mtimeMs: number; size: number }>();
		walk(process.cwd(), after);
		const paths = new Set<string>([...before.keys(), ...after.keys()]);
		for (const path of paths) {
			const b = before.get(path);
			const a = after.get(path);
			if (b && a && b.mtimeMs === a.mtimeMs && b.size === a.size) continue;
			let newContent: string | null = null;
			if (a) { newContent = readText(path, a.size); if (newContent === null) { contentCache.delete(path); continue; } }
			emit(path, contentCache.get(path)?.content, newContent, !!b, "bash");
		}
		if (changed > MAX_CHANGED) {
			pi.appendEntry("file_change", { path: "", change: "summary", diff: `${changed} files modified at once, omitting edit messages` });
		}
		// Cache pressure: drop contents wholesale (stat info stays useful)
		if (cacheBytes > MAX_CACHE_BYTES) {
			for (const [, v] of contentCache) { cacheBytes -= v.content.length; v.content = ""; }
		}
	};

	pi.on("tool_execution_start", (event: any) => {
		if ((event.toolName === "edit" || event.toolName === "write") && event.toolCallId) {
			const p = event.args?.path;
			if (p && typeof p === "string") {
				const abs = p.startsWith("/") ? p : join(process.cwd(), p);
				let old: string | null = null;
				let existed = false;
				try { statSync(abs); existed = true; old = readText(abs, statSync(abs).size); } catch {}
				putSnapshot(pendingToolSnapshots, event.toolCallId, { old, existed });
			}
		}
		if (event.toolName === "bash" && event.toolCallId) {
			// Seed the cache on the first call, then keep stats fresh per call
			const stats = new Map<string, { mtimeMs: number; size: number }>();
			walk(process.cwd(), stats);
			for (const [p, st] of stats) {
				const c = contentCache.get(p);
				if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
					const content = readText(p, st.size);
					if (content === null) { if (c) { cacheBytes -= c.content.length; contentCache.delete(p); } continue; }
					if (!c) cacheBytes += content.length;
					else cacheBytes += content.length - c.content.length;
					contentCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, content });
				}
			}
			// Content snapshot of the command's explicit write targets — the
			// only way to diff files OUTSIDE the cwd tree (e.g. /tmp)
			const candidates = new Map<string, string | null>();
			for (const p of candidatePaths(String(event.args?.command || ""))) {
				try { candidates.set(p, readText(p, statSync(p).size)); } catch { candidates.set(p, null); }
			}
			putSnapshot(bashSnapshots, event.toolCallId, { stats, candidates });
		}
	});
	pi.on("tool_execution_end", (event: any) => {
		if (event.toolName !== "bash") return;
		const snap = bashSnapshots.get(event.toolCallId);
		bashSnapshots.delete(event.toolCallId);
		if (snap) emitFileChanges(snap);
	});

	// ── Edit/write tool tracking: diff against cached content ──
	const trackToolChange = (toolName: string, input: any, snap?: { old: string | null; existed: boolean }): void => {
		if (!fileChangesPath || !input) return;
		try {
			const filePath = input.path;
			if (!filePath || typeof filePath !== "string") return;
			const abs = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
			if (isIgnored(abs)) return;
			const oldContent = snap ? snap.old : (contentCache.get(abs)?.content ?? null);
			let newContent: string | null = null;
			try {
				const st = statSync(abs);
				newContent = readText(abs, st.size);
			} catch {}
			if (newContent === null && oldContent === null) return;
			if (newContent === oldContent) return;
			const existed = snap ? snap.existed : oldContent !== null || contentCache.has(abs);
			const rel = abs.startsWith(process.cwd()) ? relative(process.cwd(), abs) : abs;
			const change = classify(newContent, existed);
			const body = diffToLines(oldContent ?? "", newContent ?? "", Infinity);
			if (!body.trim()) return;
			const header = diffHeader(change, existed, body, rel);
			writeChange({ ts: Date.now(), path: rel, tool: toolName, change, diff: `${header}\n\n${body}` });
			updateCache(abs, newContent);
		} catch {}
	};

	// Explicit file acquisition: the model writes a file anywhere on disk,
	// then calls save_file to hand it to the user. The file is copied into
	// the pi env's uploads/ dir under a content-hash name (no collisions,
	// no path tricks) and announced via a custom session entry, which the
	// autere backend forwards to the UI as a downloadable file card.
	pi.registerTool({
		name: "save_file",
		label: "Save File",
		description:
			"Give a file you created on disk to the user so they can download it " +
			"from the chat UI. Call this after writing a file the user asked for " +
			"(documents, spreadsheets, archives, data files, ...). Do not use it " +
			"for images — generated images are already shown in the chat.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute path of the file to share with the user" }),
		}),
		async execute(_toolCallId: string, params: { path: string }) {
			const MAX_BYTES = 100 * 1024 * 1024;
			try {
				const src = params.path;
				const size = statSync(src).size;
				if (size > MAX_BYTES) {
					return { content: [{ type: "text", text: `Error: ${pathBasename(src)} is ${(size / 1048576).toFixed(1)}MB, over the 100MB limit.` }], details: {} };
				}
				const dir = join(agentDir(), "uploads");
				mkdirSync(dir, { recursive: true });
				const buf = readFileSync(src);
				const hash = createHash("sha1").update(buf).digest("hex").slice(0, 16);
				const orig = pathBasename(src);
				const sanitized = orig.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
				const savedName = `file-${hash}-${sanitized}`;
				copyFileSync(src, join(dir, savedName));
				const mimeType = MIME_BY_EXT[extname(orig).toLowerCase()] || "application/octet-stream";
				pi.appendEntry("file_saved", { name: orig, savedName, size, mimeType });
				return {
					content: [{ type: "text", text: `Shared with user: ${orig} (${(size / 1024).toFixed(1)}KB). They can download it from the chat.` }],
					details: {},
				};
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error saving file: ${err?.message || err}` }], details: {} };
			}
		},
	});

	// Attachment/tool-result image policy from autere settings (spawn env).
	// IMAGE_SEND_PREVIEWS=0 → attachment base64 never reaches the model. Images
	// (attachments and tool-result blocks) get a downscaled preview
	// (quality = IMAGE_PREVIEW_QUALITY, 'full' or JSON preset); full-res
	// originals stay on disk.
	const sendPreviews = process.env.IMAGE_SEND_PREVIEWS !== '0';
	let preset: { maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number } | 'full' = { maxWidth: 1024, maxHeight: 1024, maxBytes: 300 * 1024, jpegQuality: 70 };
	try {
		const raw = process.env.IMAGE_PREVIEW_QUALITY;
		if (raw === 'full') preset = 'full';
		else if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') preset = parsed;
		}
	} catch {}

	pi.on("tool_result", async (event: any) => {
		// Consume edit/write snapshots on success AND failure — a failed or
		// aborted call must still release its pre-content snapshot. The cap in
		// putSnapshot bounds growth if a result event is lost entirely.
		if ((event.toolName === "edit" || event.toolName === "write") && event.toolCallId) {
			const snap = pendingToolSnapshots.get(event.toolCallId);
			pendingToolSnapshots.delete(event.toolCallId);
			if (!event.isError) trackToolChange(event.toolName, event.input, snap);
		}

		// Cap image blocks in tool results (e.g. built-in read returns up to
		// 2000px / 4.5MB base64 which balloons context). Resize to the user's
		// preview-quality preset; 'full' keeps originals.
		if (preset === 'full') return undefined;
		let changed = false;
		const content = await Promise.all((event.content || []).map(async (block: any) => {
			if (block?.type !== 'image' || !block.data) return block;
			try {
				const r = await resizeImage(Buffer.from(block.data, 'base64'), block.mimeType, preset);
				if (!r) return block;
				changed = true;
				return { ...block, data: r.data, mimeType: r.mimeType };
			} catch {
				return block;
			}
		}));
		return changed ? { content } : undefined;
	});

	pi.on("input", async (event: any) => {
		const images: InputImage[] | undefined = event.images;
		if (!images || images.length === 0 || event.source === "extension") {
			return { action: "continue" };
		}

		try {
			const dir = join(agentDir(), "uploads");
			mkdirSync(dir, { recursive: true });
			const stamp = Date.now();
			const paths: string[] = [];
			const previews: InputImage[] = [];
			for (const [i, img] of images.entries()) {
				const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
				const file = join(dir, `upload-${stamp}-${i + 1}.${ext}`);
				writeFileSync(file, Buffer.from(img.data, "base64"));
				paths.push(file);
				if (!sendPreviews || preset === 'full') { previews.push(img); continue; }
				try {
					const r = await resizeImage(Buffer.from(img.data, "base64"), img.mimeType, preset);
					previews.push(r ? { type: "image" as const, mimeType: r.mimeType, data: r.data } : img);
				} catch (err: any) {
					console.error("[pi-filetools] preview resize failed:", err?.message || err);
					previews.push(img);
				}
				// Publish under the hist-* name autere's /api/images route serves
				// and announce it, so the attachment renders in the dashboard even
				// though its base64 is stripped from the LLM context below.
				const name = `hist-${createHash("sha1").update(img.data).digest("hex").slice(0, 16)}.${ext}`;
				const histFile = join(dir, name);
				if (!existsSync(histFile)) writeFileSync(histFile, Buffer.from(img.data, "base64"));
				pi.appendEntry("image_saved", { name, mimeType: img.mimeType, path: file });
			}
			const note =
				`\n\n[Attached file${paths.length > 1 ? "s" : ""} saved to:\n` +
				paths.join("\n") +
				(sendPreviews
					? "\nFull-resolution originals are at these paths — use them with tools (read, bash, edit_image, …). The image(s) shown to you here are downscaled previews.]"
					: "\nUse these paths directly with tools (read, bash, edit_image, …) instead of searching for the attachment. Images are not shown inline.]");
			// Model sees only the downscaled previews (or nothing when previews
			// are disabled); full base64 must never enter the LLM context.
			return { action: "transform", text: (event.text || "") + note, images: sendPreviews ? previews : [] };
		} catch (err: any) {
			console.error("[pi-filetools] Failed to save attached images:", err?.message || err);
			return { action: "continue" };
		}
	});
}
