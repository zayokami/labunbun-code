import { describe, expect, test } from "bun:test";
import { MessageBuilder } from "../src/message-builder.ts";
import { FAUX_MODEL, fauxProvider } from "../src/providers/faux.ts";
import { isAbortError, statusCodeOf, withRetry } from "../src/retry.ts";
import type { AssistantMessageEvent, StreamFn } from "../src/types.ts";

async function collect(events: AsyncIterable<AssistantMessageEvent>) {
	const out: AssistantMessageEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

function failingStreamFn(failTimes: number, error: Error, succeedWith = "ok"): { fn: StreamFn; calls: () => number } {
	let calls = 0;
	const fn: StreamFn = async function* () {
		calls++;
		if (calls <= failTimes) throw error;
		const builder = new MessageBuilder(FAUX_MODEL.provider, FAUX_MODEL.id);
		yield builder.start();
		yield builder.textStart(0);
		yield builder.textDelta(0, succeedWith);
		yield builder.textEnd(0);
		yield builder.done("stop");
	};
	return { fn, calls: () => calls };
}

describe("statusCodeOf", () => {
	test("reads status and response.status", () => {
		expect(statusCodeOf({ status: 429 })).toBe(429);
		expect(statusCodeOf({ response: { status: 500 } })).toBe(500);
		expect(statusCodeOf(new Error("x"))).toBeNull();
		expect(statusCodeOf(null)).toBeNull();
	});
});

describe("withRetry", () => {
	test("retries pre-content failures and eventually succeeds", async () => {
		const { fn, calls } = failingStreamFn(2, Object.assign(new Error("rate limited"), { status: 429 }));
		const retries: number[] = [];
		const wrapped = withRetry(fn, { baseDelayMs: 1, onRetry: (a) => retries.push(a) });

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(calls()).toBe(3);
		expect(retries).toEqual([1, 2]);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("gives up after maxAttempts and yields terminal error event", async () => {
		const { fn, calls } = failingStreamFn(99, Object.assign(new Error("down"), { status: 503 }));
		const wrapped = withRetry(fn, { baseDelayMs: 1, maxAttempts: 3 });

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(calls()).toBe(3);
		expect(events.at(-1)?.type).toBe("error");
		expect((events.at(-1) as any).message.errorMessage).toContain("3 attempt(s)");
	});

	test("529 overloaded capped at 3 attempts even with higher maxAttempts", async () => {
		const { fn, calls } = failingStreamFn(99, Object.assign(new Error("o"), { status: 529 }));
		const wrapped = withRetry(fn, { baseDelayMs: 1, maxAttempts: 10 });
		await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(calls()).toBe(3);
	});

	test("non-retryable status (400) fails immediately without retry", async () => {
		const { fn, calls } = failingStreamFn(99, Object.assign(new Error("bad request"), { status: 400 }));
		const wrapped = withRetry(fn, { baseDelayMs: 1 });
		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(calls()).toBe(1);
		expect(events.at(-1)?.type).toBe("error");
	});

	test("mid-stream failure propagates instead of retrying", async () => {
		const fn: StreamFn = async function* () {
			const builder = new MessageBuilder(FAUX_MODEL.provider, FAUX_MODEL.id);
			yield builder.start();
			yield builder.textStart(0);
			yield builder.textDelta(0, "partial");
			throw new Error("connection reset");
		};
		const wrapped = withRetry(fn, { baseDelayMs: 1 });
		await expect(collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }))).rejects.toThrow("connection reset");
	});

	test("honors retry-after header", async () => {
		let waited = 0;
		const { fn } = failingStreamFn(1, Object.assign(new Error("rl"), { status: 429, headers: { "retry-after": "2" } }));
		const wrapped = withRetry(fn, {
			baseDelayMs: 1,
			sleep: async (ms) => {
				waited = ms;
			},
		});
		await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(waited).toBe(2000);
	});

	test("wraps a normal faux stream unchanged", async () => {
		const faux = fauxProvider([{ text: "fine" }]);
		const wrapped = withRetry(faux.streamFn);
		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(events.at(-1)?.type).toBe("done");
	});
});

describe("abort handling", () => {
	function abortError(): Error {
		return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
	}

	test("isAbortError recognizes the abort error names", () => {
		expect(isAbortError(abortError())).toBe(true);
		expect(isAbortError(Object.assign(new Error("x"), { name: "APIUserAbortError" }))).toBe(true);
		expect(isAbortError(new Error("plain"))).toBe(false);
		expect(isAbortError({ name: "AbortError" })).toBe(false); // not an Error instance
	});

	// The reported failure mode: pressing Esc during the connection phase used
	// to enter the retry ladder — up to 10 backoff attempts against a request
	// the user had already cancelled.
	test("an abort before the first byte fails in exactly one attempt, with no backoff", async () => {
		let calls = 0;
		let slept = false;
		const fn: StreamFn = async function* (_model, _context, options) {
			calls++;
			options?.signal?.throwIfAborted();
			yield new MessageBuilder(FAUX_MODEL.provider, FAUX_MODEL.id).start();
		};
		const controller = new AbortController();
		controller.abort();
		const wrapped = withRetry(fn, {
			baseDelayMs: 1,
			sleep: async () => {
				slept = true;
			},
		});

		await expect(
			collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }, { signal: controller.signal })),
		).rejects.toThrow();
		expect(calls).toBe(1);
		expect(slept).toBe(false);
	});

	test("an abort error thrown by the adapter propagates even without the signal", async () => {
		// biome-ignore lint/correctness/useYield: the abort must surface before any event exists
		const fn: StreamFn = async function* () {
			throw abortError();
		};
		// No terminal conversion: the raw abort must reach the caller so the
		// session loop can map it to stopReason "aborted".
		await expect(collect(withRetry(fn)(FAUX_MODEL, { systemPrompt: "", messages: [] }))).rejects.toThrow(
			"This operation was aborted",
		);
	});
});
