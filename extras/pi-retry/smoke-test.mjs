// Run: npx tsx smoke-test.mjs  (from extras/pi-retry)
// Asserts retry counting, note content, reset, and give-up behavior.
import assert from "node:assert";
const { default: factory } = await import("./index.ts");

const handlers = {};
const pi = { on: (ev, fn) => { handlers[ev] = fn; return () => {}; }, sendMessage: (m) => { (pi.sent ||= []).push(m); } };
factory(pi);

const ok = { role: "assistant", stopReason: "stop", content: [] };
const failed = (msg) => ({ role: "assistant", stopReason: "error", errorMessage: msg, content: [] });
const fail = failed(
	'400: {"message":"[400]: {\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Upstream request failed: [invalid_request_error] native reasoning control reasoning_effort is not allowed\\"}}"}',
);
const withPrompt = [fail, { role: "user", content: [{ type: "text", text: "draw a panda" }] }, fail];

function settle(msgs, outcome = "error") {
	return handlers["agent_before_settle"](
		{ outcome, context: { contextMessages: msgs, canContinue: true } },
		undefined,
	);
}

// Without a user prompt there is nothing to replay → no retry (documented).
let r = await settle([fail, fail]);
assert.equal(r, undefined, "no retry without a user prompt (nothing to replay)");

// With a user prompt: hidden replay draft + visible note via sendMessage.
r = await settle(withPrompt);
assert.equal(r.continue, true, "retries failure with a user prompt");
assert.match(pi.sent[0].content, /upstream request failed/, "visible note sent via sendMessage");
assert.equal(pi.sent[0].display, true, "retry note is visible");
assert.deepEqual(r.entries.map((e) => e.display), [false], "replay note is hidden");

r = await settle(withPrompt);
assert.equal(r.continue, true, "second retry");

// Reset via a successful message, then fill the budget again.
await handlers["message_end"]({ message: ok });
r = await settle(withPrompt);
assert.equal(r.continue, true, "counter resets after success");
r = await settle(withPrompt);
assert.equal(r.continue, true, "second retry after reset");
r = await settle(withPrompt);
assert.equal(r.continue, true, "third retry allowed (attempts=3 of 3)");
r = await settle(withPrompt);
assert.equal(r, undefined, "no retry beyond 3 attempts");

// Non-400 error, aborts, quota limits, and non-error outcomes don't retry.
await handlers["message_end"]({ message: ok });
r = await settle([fail, { role: "user", content: [{ type: "text", text: "hi" }] }, failed("insufficient_quota: out of budget")]);
assert.equal(r, undefined, "quota errors not retried");

await handlers["message_end"]({ message: ok });
r = await settle([{ role: "user", content: [{ type: "text", text: "hi" }] }, failed("some random failure")]);
assert.equal(r, undefined, "non-400 errors not retried");

await handlers["message_end"]({ message: ok });
assert.equal(await settle([fail], "aborted"), undefined, "aborted outcome not retried");

console.log("pi-retry smoke test passed");
