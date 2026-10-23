/**
 * pi-retry — retries interruptions that pi's own auto-retry does not cover:
 *
 * 1. provider-level transient 400 "bad request" wrapper errors, e.g. 9router/
 *    z.ai combo "Upstream request failed: [invalid_request_error] ...
 *    reasoning_effort is not allowed" — often a transient upstream failover,
 *    not a real parameter problem;
 * 2. system-level interruptions that never reached a provider, e.g.
 *    "OAuth refresh failed for github-copilot: The operation was aborted due
 *    to timeout". pi classifies those as retryable too, but only while its own
 *    budget lasts; a refresh that keeps timing out (or an instance with retry
 *    disabled) otherwise ends the turn. Only transient causes qualify — a
 *    revoked credential (invalid_grant, 401) needs a re-login, not a retry.
 *
 * On `agent_before_settle` with outcome "error" and the last assistant message
 * matching either pattern:
 *  1. broadcast a VISIBLE system note ("upstream request failed: …, retrying
 *     (n/3)") via pi.sendMessage so the user sees retries happening,
 *  2. sleep briefly, then return continue:true plus a hidden custom_message
 *     that replays the original user prompt — pi only honours a boundary
 *     continuation when the final context ends with a user turn.
 * Up to 3 retries per run; the counter resets on the next non-error assistant
 * message. Never retries quota/billing errors (they cannot succeed) or
 * aborted turns.
 */
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_500;

const RETRYABLE_400 =
	/(\b400\b\s*:)|"code"\s*:\s*"bad_request"|\b400\s*[:-]?\s*\{|invalid_request_error|upstream request failed/i;

const NON_RETRYABLE =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/** Credential refresh failures: the request never reached the provider. */
const OAUTH_REFRESH_FAILED = /OAuth refresh failed for /i;

/** ...and only a transient cause is worth another attempt. */
const TRANSIENT_CAUSE =
	/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network error|temporarily unavailable/i;

export type RetryKind = "provider" | "system";

/** Which retry class an error message belongs to (null = do not retry). */
export function classifyRetryError(errorMessage: string): RetryKind | null {
	if (NON_RETRYABLE.test(errorMessage)) return null;
	if (RETRYABLE_400.test(errorMessage)) return "provider";
	if (OAUTH_REFRESH_FAILED.test(errorMessage) && TRANSIENT_CAUSE.test(errorMessage)) return "system";
	return null;
}

/** Truncate the raw provider error for the visible system note. */
const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);

const asText = (content: any): string | undefined => {
	try {
		const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
		const text = blocks
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");
		return text || undefined;
	} catch {
		return undefined;
	}
};

let attempts = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function (pi: any) {
	pi.on("message_end", (event: any) => {
		const msg = event?.message;
		if (msg?.role === "assistant" && msg?.stopReason !== "error") attempts = 0;
	});

	pi.on("agent_before_settle", async (event: any) => {
		if (event?.outcome !== "error") return;
		const msgs = event?.context?.contextMessages ?? [];
		const last = msgs[msgs.length - 1];
		if (!last || last.role !== "assistant" || last.stopReason !== "error" || !last.errorMessage) return;
		// pi rejects a boundary continuation whose final role is not "user";
		// a retriable retry therefore needs the original prompt to replay.
		const idx = msgs.findLastIndex((m: any) => m.role === "user");
		if (idx < 0) return;
		const originalText = asText(msgs[idx].content);
		if (!originalText) return;
		const kind = classifyRetryError(last.errorMessage);
		if (!kind) return;
		if (attempts >= MAX_RETRIES) return;
		attempts++;
		// Visible system-level note so the user knows retries are happening.
		const label = kind === "system" ? "system interruption" : "upstream request failed";
		pi.sendMessage({
			customType: "pi-retry",
			content: `${label}: ${clip(last.errorMessage)}, retrying (${attempts}/${MAX_RETRIES})`,
			display: true,
		});
		await sleep(RETRY_DELAY_MS);
		return {
			continue: true,
			entries: [
				{
					type: "custom_message",
					customType: "pi-retry",
					content: `Your previous request failed, retry. The original prompt is as follow:\n\n${originalText}`,
					display: false,
				},
			],
		};
	});
}
