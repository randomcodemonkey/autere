/**
 * Shared fetch plumbing: an abort-timeout signal, and a fetch that bounds the
 * BODY too (a consume callback runs inside the timeout) — used by both
 * index.ts and web.ts, which had byte-identical copies.
 */

export function createTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, timeoutMs);
	timer.unref?.();

	if (signal?.aborted) {
		abort();
	} else {
		signal?.addEventListener("abort", abort, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}

export async function fetchWithTimedBody<T>(
	url: string,
	init: RequestInit = {},
	signal: AbortSignal | undefined,
	timeoutMs: number,
	consume: (response: Response) => Promise<T>,
): Promise<T> {
	const timeout = createTimeoutSignal(signal, timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: timeout.signal });
		return await consume(response);
	} finally {
		timeout.cleanup();
	}
}
