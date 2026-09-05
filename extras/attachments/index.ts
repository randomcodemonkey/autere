/**
 * attachments — saves images attached to user prompts to the pi-env's
 * uploads/ directory and appends the saved file paths to the prompt text,
 * so tools (bash, edit_image, …) know where the files live on disk.
 *
 * The image blocks are kept on the message, so vision models still see
 * them; the path note is additive.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface InputImage {
	type: "image";
	data: string; // base64, no data: prefix
	mimeType: string;
}

function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export default function (pi: any) {
	pi.on("input", async (event: any) => {
		const images: InputImage[] | undefined = event.images;
		if (!images || images.length === 0 || event.source === "extension") {
			return { action: "continue" };
		}

		try {
			const dir = join(piAgentDir(), "uploads");
			mkdirSync(dir, { recursive: true });
			const stamp = Date.now();
			const paths: string[] = [];
			for (const [i, img] of images.entries()) {
				const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
				const file = join(dir, `upload-${stamp}-${i + 1}.${ext}`);
				writeFileSync(file, Buffer.from(img.data, "base64"));
				paths.push(file);
			}
			const note =
				`\n\n[Attached file${paths.length > 1 ? "s" : ""} saved to:\n` +
				paths.join("\n") +
				"\nUse these paths directly with tools (read, bash, edit_image, …) instead of searching for the attachment.]";
			return { action: "transform", text: (event.text || "") + note, images };
		} catch (err: any) {
			console.error("[attachments] Failed to save attached images:", err?.message || err);
			return { action: "continue" };
		}
	});
}
