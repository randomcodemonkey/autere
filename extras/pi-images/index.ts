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
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

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
	"Change the original image as little as possible. Apply only the requested edit(s) and keep everything else — composition, framing, colors, lighting, style, and all unedited details — exactly as they are.";

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

			const content: any[] = images.map((p) => ({ type: "image", data: p.data, mimeType: p.mimeType }));

			// Save to disk so the image can be referenced later (e.g. as an
			// edit_image input) without round-tripping base64 through the LLM.
			const savedPaths: string[] = [];
			if (images.length > 0) {
				try {
					const dir = join(homedir(), ".autere", "pi-images");
					mkdirSync(dir, { recursive: true });
					for (const [i, img] of images.entries()) {
						const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
						const file = join(dir, `gen-${Date.now()}-${i + 1}.${ext}`);
						writeFileSync(file, Buffer.from(img.data, "base64"));
						savedPaths.push(file);
					}
					content.push({ type: "text", text: `Saved to: ${savedPaths.join(", ")}` });
				} catch (err: any) {
					console.error("[pi-images] Failed to save image to disk:", err?.message || err);
				}
			}
			if (text) content.push({ type: "text", text });

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

			const content: any[] = images.map((p) => ({ type: "image", data: p.data, mimeType: p.mimeType }));

			// Save edited result to disk like generate_image does
			const savedPaths: string[] = [];
			if (images.length > 0) {
				try {
					const dir = join(homedir(), ".autere", "pi-images");
					mkdirSync(dir, { recursive: true });
					for (const [i, img] of images.entries()) {
						const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
						const file = join(dir, `edit-${Date.now()}-${i + 1}.${ext}`);
						writeFileSync(file, Buffer.from(img.data, "base64"));
						savedPaths.push(file);
					}
					content.push({ type: "text", text: `Saved to: ${savedPaths.join(", ")}` });
				} catch (err: any) {
					console.error("[pi-images] Failed to save edited image to disk:", err?.message || err);
				}
			}
			if (text) content.push({ type: "text", text });

			return {
				content,
				details: { model, imageCount: images.length, savedPaths },
			};
		},
	});
}
