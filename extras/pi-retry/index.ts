/**
 * pi-retry — retries provider requests that pi's own auto-retry does not cover
 * (transient 400 "bad request" wrapper errors, e.g. github-copilot
 * "Upstream request failed: [invalid_request_error] ..." which are often a
 * transient upstream failover, not a real parameter problem).
 *
 * On `agent_before_settle` with outcome "error" and a last assistant message
 * whose error text matches a 400/upstream-request pattern, sleeps briefly and
 * returns `continue: true` so pi issues the same provider request once more.
 * Up to 3 retries per run; the counter resets on the next non-error assistant
 * message. Deliberately does NOT retry errors already matching the
 * NON_RETRYABLE quota/billing pattern (those would never succeed).
 *
 * ponytail: pattern overlap with pi's RETRYABLE_PROVIDER_ERROR_PATTERN is
 * harmless; if upstream ever grants 400-retry config, delete this extension.
 */
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_500;

const RETRYABLE_400 =
	/(\b400\b\s*:)|"code"\s*:\s*"bad_request"|\b400\s*[:\-]?\s*\{|invalid_request_error|upstream request failed/i;

const NON_RETRYABLE =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/** Retry note added to the context so the model knows why it is asked again. */
const retryNote = (turn: number) =>
	`Your previous request failed, retry. The original prompt is as follow:\n\n${turn}`;

let attempts = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function (pi: any) {
	pi.on("message_end", (event: any) => {
		const msg = event?.message;
		if (msg?.role === "assistant" && msg?.stopReason !== "error") attempts = 0;
	});

	pi.on("agent_before_settle", async (event: any) => {
		if (event?.outcome !== "error") return;
		if (!event.canContinue && !event.context?.canContinue) return;
		const msgs = event.context?.contextMessages ?? [];
		const last = msgs[msgs.length - 1];
		if (!last || last.role !== "assistant" || last.stopReason !== "error" || !last.errorMessage) return;
		if (NON_RETRYABLE.test(last.errorMessage)) return;
		if (!RETRYABLE_400.test(last.errorMessage)) return;
		if (attempts >= MAX_RETRIES) return;
		attempts++;
		await sleep(RETRY_DELAY_MS);
		// Original user prompt before the failed turn — reuse it verbatim.
		const idx = msgs.findLastIndex((m: any) => m.role === "user");
		const original = idx >= 0 ? msgs[idx] : undefined;
		const promptText = original
			? original.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
			: undefined;
		return {
			continue: true,
			entries: promptText
				? [
						{
							type: "custom_message",
							customType: "pi-retry",
							content: retryNote(promptText),
							display: false,
						},
				  ]
				: [],
		};
	});
}
