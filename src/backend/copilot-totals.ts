// Extracted only to keep extension-handlers.ts readable — one copy of the
// Copilot session-file math. Run: npx tsx cypress/component/support/copilot-credits.check.ts

/**
 * Copilot credit usage for ONE user, computed from their own pi env session
 * files — the same math as the copilot-credit-usage extension (only
 * assistant messages with usage whose provider/api/model matches
 * copilot|github-copilot; recorded $ cost when present, else estimated
 * from GitHub's published per-model pricing; 1 AI credit = $0.01).
 */
export const CREDIT_USD = 0.01;

/** USD per 1M tokens (copilot-credit-usage's table) */
const COPILOT_PRICING: Array<{ match: RegExp; input: number; cacheRead: number; output: number }> = [
	{ match: /gpt-5[._-]?mini|raptor[._-]?mini/i, input: 0.25, cacheRead: 0.025, output: 2 },
	{ match: /gpt-5[._-]?4[._-]?mini/i, input: 0.75, cacheRead: 0.075, output: 4.5 },
	{ match: /gpt-5[._-]?4[._-]?nano/i, input: 0.2, cacheRead: 0.02, output: 1.25 },
	{ match: /gpt-5[._-]?4(?:$|[^\d])/i, input: 2.5, cacheRead: 0.25, output: 15 },
	{ match: /gpt-5[._-]?[23]/i, input: 1.75, cacheRead: 0.175, output: 14 },
	{ match: /gpt-5[._-]?5/i, input: 5, cacheRead: 0.5, output: 30 },
	{ match: /claude[._-]?haiku/i, input: 1, cacheRead: 0.1, output: 5 },
	{ match: /claude[._-]?opus/i, input: 5, cacheRead: 0.5, output: 25 },
	{ match: /claude[._-]?sonnet/i, input: 3, cacheRead: 0.3, output: 15 },
	{ match: /gemini[._-]?[23]/i, input: 1.25, cacheRead: 0.125, output: 10 },
	{ match: /mai[._-]?code/i, input: 0.75, cacheRead: 0.075, output: 4.5 },
];

const COPILOT_RE = /copilot|github-copilot/i;

export interface CopilotTotals {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	costUsd: number;
	credits: number;
}

export function emptyTotals(): CopilotTotals {
	return { turns: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0, credits: 0 };
}

function n0(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function estimate(model: string | undefined, u: { input: number; cacheRead: number; output: number }): number {
	const p = COPILOT_PRICING.find((e) => e.match.test(model || ''));
	if (!p) return 0;
	return (u.input * p.input + u.cacheRead * p.cacheRead + u.output * p.output) / 1_000_000;
}

function isCopilotAssistant(m: any): boolean {
	return m?.role === 'assistant' && m.usage &&
		[m.provider, m.api, m.model].some((v: any) => typeof v === 'string' && COPILOT_RE.test(v));
}

/** Per assistant-message copilot usage (undefined = non-copilot / no usage) */
export function usageFromMessage(message: any): { model?: string; input: number; output: number; cacheRead: number; costUsd: number } | null {
	if (!isCopilotAssistant(message)) return null;
	const u = message.usage;
	if (!u) return null;
	const input = n0(u.input), output = n0(u.output), cacheRead = n0(u.cacheRead);
	const recorded = n0(u.cost?.total);
	const model = typeof message.model === 'string' ? message.model : undefined;
	return { model, input, output, cacheRead, costUsd: recorded > 0 ? recorded : estimate(model, { input, output, cacheRead }) };
}

export function addUsage(t: CopilotTotals, u: { input: number; output: number; cacheRead: number; costUsd: number }): void {
	t.turns++;
	t.input += u.input;
	t.output += u.output;
	t.cacheRead += u.cacheRead;
	t.costUsd += u.costUsd;
}

/** finalize: convert cost to credits */
export function finalize(t: CopilotTotals): CopilotTotals {
	t.credits = t.costUsd / CREDIT_USD;
	return t;
}
