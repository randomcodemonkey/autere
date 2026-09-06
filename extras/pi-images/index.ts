/**
 * pi-images — image generation for pi via a 9router instance.
 *
 * Registers a `generate_image` tool the LLM can call when the user asks
 * for a picture. Images are returned as ImageContent blocks in the tool
 * result, so they land in the session JSONL, round-trip back to
 * multimodal models, and are renderable by dashboards (e.g. autere).
 *
 * Configuration (same source of truth as pi-9router-ext):
 *   - {PI_CODING_AGENT_DIR}/9router-config.json  → { baseUrl, apiKey, imageModel? }
 *   - NINE_ROUTER_BASE_URL / NINE_ROUTER_API_KEY env overrides
 *   - Model selection precedence: PI_IMAGES_MODEL env > imageModel from
 *     9router-config.json > first capabilities.imageOutput model discovered
 *     from GET /v1/models (configured model falls back to discovery if it
 *     is no longer available).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
// ponytail: delegates to the stock openai-completions stream with a swapped
// fetch. Drop the whole streamfix block when upstream (OpenRouter streamed
// usage accounting) fixes image token counting.
import { stream as stockStream } from "@earendil-works/pi-ai/api/openai-completions";

const MAX_IMAGE_EDIT_BYTES = 8 * 1024 * 1024;

/**
 * Resolve a user-supplied image path: absolute as-is; relative against cwd,
 * falling back to the pi-env uploads dir (autere attachments) and the shared
 * pi-images output dir (generated/edited images).
 */
function resolvePath(p: string): string {
	if (isAbsolute(p)) return p;
	const candidates = [
		resolve(process.cwd(), p),
		join(piAgentDir(), "uploads", p),
		join(homedir(), ".autere", "pi-images", p),
	];
	return candidates.find((c) => existsSync(c)) ?? candidates[0];
}
import { homedir } from "node:os";

const REQUEST_TIMEOUT_MS = 120_000;

// ── streamfix: non-streamed upstream requests for image-bearing chats ──
// OpenRouter's streamed "estimated" usage recount tokenizes base64 data-URLs
// as text (~4x prompt inflation, image_tokens: 0); the non-streamed path
// relays the provider's vision-correct usage. IMAGE_STREAM_FIX=0 disables.
const STREAM_FIX_RAW = String(process.env.IMAGE_STREAM_FIX ?? "").toLowerCase();
const STREAM_FIX_ENABLED = STREAM_FIX_RAW !== "0" && STREAM_FIX_RAW !== "false";

const sseEnc = new TextEncoder();

/** Convert a non-streaming chat-completion JSON body into the minimal SSE the OpenAI SDK / stock parser consumes. */
function sseFromJson(j: any): Uint8Array {
	const choice = j.choices?.[0] ?? {};
	const msg = choice.message ?? {};
	const delta: any = { role: "assistant" };
	if (msg.content) delta.content = msg.content;
	for (const f of ["reasoning", "reasoning_content", "reasoning_text"]) {
		if (msg[f]) delta[f] = msg[f];
	}
	if (msg.tool_calls) {
		delta.tool_calls = msg.tool_calls.map((tc: any, i: number) => ({
			index: i,
			id: tc.id,
			type: "function",
			function: { name: tc.function?.name, arguments: tc.function?.arguments },
		}));
	}
	const chunk = (d: any, fr: any, usage: any) =>
		`data: ${JSON.stringify({ id: j.id, object: "chat.completion.chunk", created: j.created, model: j.model, choices: [{ index: 0, delta: d, finish_reason: fr }], usage })}\n\n`;
	const out =
		chunk(delta, null, undefined) +
		chunk({}, choice.finish_reason ?? (msg.tool_calls ? "tool_calls" : "stop"), j.usage) +
		"data: [DONE]\n\n";
	return sseEnc.encode(out);
}

/** fetch wrapper: image requests go out non-streaming (JSON re-served as SSE); also scrubs reasoning_effort:"none" (upstream 400s on it). */
const scrubFetch: typeof globalThis.fetch = async (url, init) => {
	try {
		if (typeof init?.body === "string" && init.body.includes('"messages"')) {
			const body = JSON.parse(init.body);
			if (body.reasoning_effort === "none") delete body.reasoning_effort;
			if (init.body.includes('"image_url"') && body.stream) {
				body.stream = false;
				delete body.stream_options;
				const headers: Record<string, string> = {};
				const src: any = init.headers ?? {};
				if (typeof src.forEach === "function") {
					src.forEach((v: string, k: string) => {
						const lk = k.toLowerCase();
						if (lk !== "accept" && !lk.startsWith("x-stainless")) headers[k] = v;
					});
				} else {
					for (const [k, v] of Object.entries(src)) {
						const lk = k.toLowerCase();
						if (lk !== "accept" && !lk.startsWith("x-stainless")) headers[k] = String(v);
					}
				}
				headers.accept = "application/json";
				const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
				const ct = resp.headers.get("content-type") ?? "";
				if (resp.ok && ct.includes("json")) {
					const j = await resp.json();
					return new Response(sseFromJson(j), {
						status: resp.status,
						statusText: resp.statusText,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return resp;
			}
			return fetch(url, { ...init, body: JSON.stringify(body) });
		}
	} catch {
		/* fall through to plain fetch */
	}
	return fetch(url, init);
};

interface RouterConfig {
	baseUrl: string;
	apiKey: string;
	/** Optional selected image model (set via autere user settings) */
	imageModel?: string;
	/** Extra prompt appended to image operations (set via autere user settings) */
	imageExtraPrompt?: string;
}

/** Appended to edit_image prompts unless config overrides it (empty string disables). */
const DEFAULT_EXTRA_PROMPT =
	"This is a localized photo edit, NOT a re-creation. Keep the original image's exact orientation, aspect ratio, framing, and camera angle — do NOT rotate, tilt, reposition, crop, or recompose the subject or scene. Apply only the requested edit(s) in place; every other pixel-level detail (composition, colors, lighting, style, background, and all unedited elements) must remain identical to the input image.";

function extraPrompt(config: RouterConfig): string {
	// unset or empty → default (set to a custom text to override)
	if (config.imageExtraPrompt) return config.imageExtraPrompt;
	return DEFAULT_EXTRA_PROMPT;
}

function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function loadRouterConfig(): RouterConfig {
	const baseUrl = process.env.NINE_ROUTER_BASE_URL;
	const apiKey = process.env.NINE_ROUTER_API_KEY;
	if (baseUrl && apiKey) return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };

	const configPath = join(piAgentDir(), "9router-config.json");
	if (existsSync(configPath)) {
		try {
			const data = JSON.parse(readFileSync(configPath, "utf-8"));
			if (data.baseUrl) {
				return {
					baseUrl: String(data.baseUrl).replace(/\/+$/, ""),
					apiKey: String(data.apiKey || apiKey || ""),
					...(data.imageModel ? { imageModel: String(data.imageModel) } : {}),
					...(data.imageExtraPrompt !== undefined ? { imageExtraPrompt: String(data.imageExtraPrompt) } : {}),
				};
			}
		} catch (err) {
			console.error("[pi-images] Failed to parse 9router-config.json:", err);
		}
	}
	return { baseUrl: "http://localhost:20128", apiKey: apiKey || "" };
}

/**
 * Discover image models from 9router. Selection precedence:
 * PI_IMAGES_MODEL env > config.imageModel > first discovered model.
 * A configured model that is no longer available falls back to discovery.
 */
async function resolveImageModel(config: RouterConfig): Promise<string> {
	const envModel = process.env.PI_IMAGES_MODEL;
	if (envModel) return envModel;

	let models: { id: string; capabilities?: { imageOutput?: boolean } }[] = [];
	try {
		const res = await fetch(`${config.baseUrl}/v1/models`, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as { data?: typeof models };
		models = data.data || [];
	} catch (err) {
		console.error("[pi-images] Model discovery failed:", err);
		return config.imageModel || "";
	}

	const imageModels = models.filter((m) => m.capabilities?.imageOutput).map((m) => m.id);
	if (config.imageModel) {
		if (imageModels.includes(config.imageModel)) return config.imageModel;
		console.error(`[pi-images] Configured image model "${config.imageModel}" not found or not image-capable, falling back to discovery`);
	}
	if (imageModels.length > 0) return imageModels[0];
	return "";
}

interface OutputPart {
	type: "text" | "image";
	text?: string;
	data?: string;
	mimeType?: string;
}

/** Extract data-URL images and text from an OpenAI-style chat completion message. */
function parseChatImages(message: any): OutputPart[] {
	const parts: OutputPart[] = [];
	if (typeof message?.content === "string" && message.content.trim()) {
		parts.push({ type: "text", text: message.content });
	} else if (Array.isArray(message?.content)) {
		for (const block of message.content) {
			if (block?.type === "text" && block.text) parts.push({ type: "text", text: block.text });
		}
	}
	for (const image of message?.images ?? []) {
		const url = typeof image?.image_url === "string" ? image.image_url : image?.image_url?.url;
		if (!url) continue;
		const match = url.match(/^data:([^;]+);base64,(.+)$/s);
		if (match) parts.push({ type: "image", mimeType: match[1], data: match[2] });
	}
	return parts;
}

/** POST /v1/chat/completions with modalities (OpenRouter-style image output).
 *  `content` is either a plain string (generation) or multimodal parts (edit). */
async function generateViaChat(
	config: RouterConfig,
	model: string,
	prompt: string | OutputPart[],
	signal?: AbortSignal,
): Promise<OutputPart[]> {
	const content = typeof prompt === "string" ? prompt : prompt.map((p) =>
		p.type === "image"
				? { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } }
				: { type: "text", text: p.text ?? "" },
	);
	const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content }],
			stream: false,
			modalities: ["image", "text"],
		}),
		signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const body = await res.json();
	if (!res.ok) {
		const msg = body?.error?.message || `HTTP ${res.status}`;
		throw new Error(msg);
	}
	const parts = parseChatImages(body?.choices?.[0]?.message);
	if (!parts.some((p) => p.type === "image")) {
		throw new Error(parts[0]?.text || "response contained no image");
	}
	return parts;
}

/** Fallback: POST /v1/images/generations (b64_json response format). */
async function generateViaImagesApi(
	config: RouterConfig,
	model: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<OutputPart[]> {
	const res = await fetch(`${config.baseUrl}/v1/images/generations`, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, prompt, n: 1, response_format: "b64_json" }),
		signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const body = await res.json();
	if (!res.ok) {
		const msg = body?.error?.message || `HTTP ${res.status}`;
		throw new Error(msg);
	}
	const items: any[] = body?.data ?? [];
	const parts: OutputPart[] = [];
	for (const item of items) {
		if (item?.b64_json) parts.push({ type: "image", mimeType: "image/png", data: item.b64_json });
		else if (item?.url) parts.push({ type: "text", text: `![generated image](${item.url})` });
	}
	if (!parts.length) throw new Error("response contained no image");
	return parts;
}

export default function (pi: ExtensionAPI) {
	if (STREAM_FIX_ENABLED) {
		// Re-register the 9router provider with a stream wrapper: image-bearing
		// requests go out non-streamed. Registration merges over pi-9router-ext's
		// (which loads later without a streamSimple, so ours survives).
		pi.registerProvider("9router", {
			api: "openai-completions",
			streamSimple: (model, context, options) =>
				stockStream(model as any, context, { ...options, fetch: scrubFetch } as any),
		});
	}

	/**
	 * Save generated/edited images to disk and surface them to the dashboard.
	 * IMPORTANT: image base64 must NEVER be returned in tool result content —
	 * it would enter the LLM context and be re-sent on every subsequent
	 * request (multi-100K-token blowup). We persist to disk, emit an
	 * 'image_saved' custom entry (dashboard renders it as an image card),
	 * and return text-only content to the model.
	 */
	const persistImages = (images: { data: string; mimeType: string }[], prefix: string): string[] => {
		const savedPaths: string[] = [];
		if (images.length === 0) return savedPaths;
		const dir = join(homedir(), ".autere", "pi-images");
		mkdirSync(dir, { recursive: true });
		for (const [i, img] of images.entries()) {
			const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
			const file = join(dir, `${prefix}-${Date.now()}-${i + 1}.${ext}`);
			writeFileSync(file, Buffer.from(img.data, "base64"));
			savedPaths.push(file);
			// Copy into the uploads dir under the hist-* name served by
			// autere's /api/images route, and announce it to the dashboard.
			try {
				const envDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
				const uploads = join(envDir, "uploads");
				mkdirSync(uploads, { recursive: true });
				const name = `hist-${createHash("sha1").update(img.data).digest("hex").slice(0, 16)}.${ext}`;
				const histFile = join(uploads, name);
				if (!existsSync(histFile)) writeFileSync(histFile, Buffer.from(img.data, "base64"));
				pi.appendEntry("image_saved", { name, mimeType: img.mimeType, path: file });
			} catch (err: any) {
				console.error("[pi-images] failed to publish image to uploads:", err?.message || err);
			}
		}
		return savedPaths;
	};

	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate an image from a text prompt using an image-generation model " +
			"(via 9router). Use when the user asks to draw, create, or generate a " +
			"picture. Write a detailed, descriptive prompt for best results.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Detailed description of the image to generate" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const config = loadRouterConfig();
			if (!config.apiKey) {
				return {
					content: [{ type: "text", text: "Error: no API key configured for 9router (9router-config.json)." }],
					details: {},
				};
			}

			const model = await resolveImageModel(config);
			if (!model) {
				return {
					content: [
						{
							type: "text",
							text: "Error: no image-generation model available on 9router. " +
								"Configure an upstream image model (capabilities.imageOutput) or set PI_IMAGES_MODEL.",
						},
					],
					details: {},
				};
			}

			onUpdate?.({ content: [{ type: "text", text: `Generating image with ${model}…` }] });

			let parts: OutputPart[];
			try {
				try {
					parts = await generateViaChat(config, model, params.prompt, signal);
				} catch (chatErr: any) {
					if (signal?.aborted) throw chatErr;
					console.error("[pi-images] chat/modality path failed, trying images API:", chatErr?.message || chatErr);
					parts = await generateViaImagesApi(config, model, params.prompt, signal);
				}
			} catch (err: any) {
				console.error("[pi-images] Image generation failed:", err);
				return {
					content: [{ type: "text", text: `Error generating image: ${err?.message || err}` }],
					details: { model },
				};
			}

			const images = parts.filter((p) => p.type === "image");
			const text = parts
				.filter((p) => p.type === "text" && p.text)
				.map((p) => p.text)
				.join("\n")
				.trim();

			// Text-only result: images go to disk + dashboard entry, never into
			// LLM context (ponytail: ceiling is that the model can't see its own
			// output image; add a downscaled preview block only if ever needed).
			const savedPaths = persistImages(images, "gen");
			const content: any[] = [];
			if (savedPaths.length > 0) content.push({ type: "text", text: `Saved to: ${savedPaths.join(", ")}` });
			if (text) content.push({ type: "text", text });
			if (content.length === 0) content.push({ type: "text", text: "Image generated." });

			return {
				content,
				details: { model, imageCount: images.length, savedPaths },
			};
		},
	});

	pi.registerTool({
		name: "edit_image",
		label: "Edit Image",
		description:
			"Edit existing image(s) based on a text instruction using an image-editing " +
			"model (via 9router). Provide 1-4 image file paths (absolute, or relative " +
			"to the current working directory) and describe the change, e.g. 'make the " +
			"sky sunset orange' or 'remove the person on the left'. Use for edits to " +
			"generated or uploaded images; use generate_image for purely new images.",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				description: "Paths of the image file(s) to edit (1-4 images)",
				minItems: 1,
				maxItems: 4,
			}),
			prompt: Type.String({ description: "Description of the edit to apply" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const config = loadRouterConfig();
			if (!config.apiKey) {
				return {
					content: [{ type: "text", text: "Error: no API key configured for 9router (9router-config.json)." }],
					details: {},
				};
			}

			const model = await resolveImageModel(config);
			if (!model) {
				return {
					content: [{ type: "text", text: "Error: no image-generation model available on 9router." }],
					details: {},
				};
			}

			// Read + validate input images
			const extra = extraPrompt(config);
			const parts: OutputPart[] = [{ type: "text", text: extra ? `${params.prompt}\n\n${extra}` : params.prompt }];
			try {
				for (const p of params.paths) {
					const file = resolvePath(p);
					const stat = statSync(file);
					if (stat.size > MAX_IMAGE_EDIT_BYTES) {
						return { content: [{ type: "text", text: `Error: "${p}" is too large (max 8 MB).` }], details: {} };
					}
					const ext = extname(file).toLowerCase().replace(".", "");
					const mime = ext === "jpg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext || "png"}`;
					parts.push({ type: "image", data: readFileSync(file).toString("base64"), mimeType: mime });
				}
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error reading image: ${err?.message || err}` }], details: {} };
			}

			onUpdate?.({ content: [{ type: "text", text: `Editing image with ${model}…` }] });

			let parts_out: OutputPart[];
			try {
				parts_out = await generateViaChat(config, model, parts, signal);
			} catch (err: any) {
				if (signal?.aborted) throw err;
				console.error("[pi-images] Image edit failed:", err);
				return {
					content: [{ type: "text", text: `Error editing image: ${err?.message || err}` }],
					details: { model },
				};
			}

			const images = parts_out.filter((p) => p.type === "image");
			const text = parts_out
				.filter((p) => p.type === "text" && p.text)
				.map((p) => p.text)
				.join("\n")
				.trim();

			const savedPaths = persistImages(images, "edit");
			const content: any[] = [];
			if (savedPaths.length > 0) content.push({ type: "text", text: `Saved to: ${savedPaths.join(", ")}` });
			if (text) content.push({ type: "text", text });
			if (content.length === 0) content.push({ type: "text", text: "Image edited." });

			return {
				details: { model, imageCount: images.length, savedPaths },
			};
		},
	});
}
