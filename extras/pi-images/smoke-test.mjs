// Run: npx tsx smoke-test.mjs  (from extras/pi-images)
// Asserts scrubFetch behavior: passthrough perf, structural image detection,
// fresh-image demotion, eviction, reasoning_effort scrub.
import assert from "node:assert";
import { scrubFetch } from "./index.ts";

const origFetch = globalThis.fetch;
let captured;
globalThis.fetch = async (url, init) => {
	captured = { url, init };
	const outStream = JSON.parse(init.body).stream === false;
	const payload = outStream
		? JSON.stringify({ id: "1", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: {} })
		: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	return new Response(payload, {
		status: 200,
		headers: { "content-type": outStream ? "application/json" : "text/event-stream" },
	});
};
const img = () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
const call = (body) =>
	scrubFetch("https://9r/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer x" },
		body: JSON.stringify(body),
	});

try {
	// 1. Text-only history whose text CONTAINS the literal "image_url": must
	// pass through untouched (identity!) and keep streaming.
	const b1 = {
		stream: true,
		messages: [{ role: "user", content: [{ type: "text", text: 'the field is "image_url" in openai format' }] }],
	};
	let r = await call(b1);
	assert.strictEqual(captured.init.body, JSON.stringify(b1), "text-only body must pass through unmodified");
	assert.strictEqual(JSON.parse(captured.init.body).stream, true, "no bogus demotion from text match");

	// 2. Fresh image (newest tool-result batch): demote this one request.
	const b2 = {
		stream: true,
		messages: [
			{ role: "user", content: [{ type: "text", text: "look" }] },
			{ role: "assistant", content: "reading" },
			{ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, img()] },
		],
	};
	r = await call(b2);
	assert.strictEqual(JSON.parse(captured.init.body).stream, false, "fresh image demotes request");
	assert.ok(captured.init.body.includes("image_url"), "fresh image still present");
	assert.strictEqual(r.headers.get("content-type"), "text/event-stream", "JSON re-served as SSE");

	// 3. Evicted image + text message containing '"image_url"' literal:
	// image becomes a note, request keeps streaming (the original-bug case).
	const b3 = {
		stream: true,
		messages: [
			{ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, img()] },
			{ role: "assistant", content: "seen it" },
			{ role: "user", content: [{ type: "text", text: 'next question about "image_url" parts' }] },
		],
	};
	r = await call(b3);
	const p3 = JSON.parse(captured.init.body);
	assert.strictEqual(p3.stream, true, "evicted image must not demote");
	assert.ok(
	!p3.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url")),
	"no image_url parts on wire",
);
	assert.ok(p3.messages[0].content.some((p) => p.text?.startsWith("[image removed from context")), "note present");
	assert.ok(captured.init.body !== JSON.stringify(b3), "mutated body re-serialized");

	// 4. reasoning_effort:"none" scrub still applies without images.
	const b4 = {
		stream: true,
		reasoning_effort: "none",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	};
	await call(b4);
	const p4 = JSON.parse(captured.init.body);
	assert.ok(!("reasoning_effort" in p4), "reasoning_effort scrubbed");
	assert.strictEqual(p4.stream, true);

	console.log("smoke-test: all 4 cases OK");
} finally {
	globalThis.fetch = origFetch;
}
