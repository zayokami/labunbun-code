import { describe, expect, test } from "bun:test";
import { createDefaultStreamFn, MissingApiKeyError, missingApiKey } from "../src/index.ts";
import { MessageBuilder } from "../src/message-builder.ts";
import { FAUX_MODEL, fauxProvider } from "../src/providers/faux.ts";
import {
	isAbortError,
	isContextOverflowError,
	looksLikeContextOverflow,
	statusCodeOf,
	withRetry,
} from "../src/retry.ts";
import type { AssistantMessageEvent, Model, RetryNotice, StreamFn } from "../src/types.ts";

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
		const wrapped = withRetry(fn, { baseDelayMs: 1, onRetry: (notice) => retries.push(notice.attempt) });

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

describe("context overflow classification", () => {
	test("recognizes the provider wordings for an oversized request", () => {
		expect(looksLikeContextOverflow("This model's maximum context length is 200000 tokens")).toBe(true);
		expect(looksLikeContextOverflow("prompt is too long: 250000 tokens > 200000 maximum")).toBe(true);
		expect(looksLikeContextOverflow("input is too long for requested model")).toBe(true);
		expect(looksLikeContextOverflow("Request failed: context length exceeded")).toBe(true);
		expect(looksLikeContextOverflow("invalid api key")).toBe(false);
		expect(looksLikeContextOverflow("model not found")).toBe(false);
	});

	test("an overflow-shaped message is only an overflow under an overflow status", () => {
		// 429 with that wording is a rate limit that happens to mention tokens;
		// classifying it as an overflow would skip the backoff it needs.
		const rateLimited = Object.assign(new Error("prompt is too long"), { status: 429 });
		expect(isContextOverflowError(rateLimited)).toBe(false);
		const badRequest = Object.assign(new Error("prompt is too long: 250000 tokens"), { status: 400 });
		expect(isContextOverflowError(badRequest)).toBe(true);
		// A gateway's 413 needs no wording: the remedy is the same.
		expect(isContextOverflowError(Object.assign(new Error("Request Entity Too Large"), { status: 413 }))).toBe(true);
		// Status-less (a wrapper that dropped it) still classifies on wording.
		expect(isContextOverflowError(new Error("maximum context length exceeded"))).toBe(true);
		expect(isContextOverflowError(new Error("ECONNRESET"))).toBe(false);
	});

	// The whole point of the classification: a request that is too large must not
	// be sent again. The retry burns the backoff ladder, and with a fallback chain
	// configured the same context is then replayed against every later model.
	//
	// The status-less shape is the one that proves it. An error with no status is
	// assumed transient and earns a retry; a 400 would not be retried either way.
	test("an overflow fails on the first attempt, tagged so callers can act on it", async () => {
		const { fn, calls } = failingStreamFn(99, new Error("prompt is too long: 250000 tokens > 200000 maximum"));
		let slept = false;
		const wrapped = withRetry(fn, {
			baseDelayMs: 1,
			sleep: async () => {
				slept = true;
			},
		});

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(calls()).toBe(1);
		expect(slept).toBe(false);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		expect((terminal as any).message.errorKind).toBe("context_overflow");
		expect((terminal as any).message.errorMessage).toContain("larger than");
	});

	test("a tagged 400 is not retried and does not lose the tag", async () => {
		const { fn, calls } = failingStreamFn(
			99,
			Object.assign(new Error("This model's maximum context length is 200000 tokens"), { status: 400 }),
		);
		const events = await collect(withRetry(fn, { baseDelayMs: 1 })(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(calls()).toBe(1);
		expect((events.at(-1) as any).message.errorKind).toBe("context_overflow");
	});

	test("an ordinary 400 is not tagged as an overflow", async () => {
		const { fn } = failingStreamFn(99, Object.assign(new Error("bad request: unknown field"), { status: 400 }));
		const events = await collect(withRetry(fn, { baseDelayMs: 1 })(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect((events.at(-1) as any).message.errorKind).toBeUndefined();
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

describe("retry notices", () => {
	test("a notice carries the attempt, the wait, and the reason, and is awaited before the sleep", async () => {
		const { fn } = failingStreamFn(1, Object.assign(new Error("rate limited"), { status: 429 }));
		const order: string[] = [];
		const notices: RetryNotice[] = [];
		const wrapped = withRetry(fn, {
			baseDelayMs: 1000,
			onRetry: (notice) => {
				order.push("notice");
				notices.push(notice);
			},
			sleep: async () => {
				order.push("sleep");
			},
		});

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(events.at(-1)?.type).toBe("done");
		expect(notices).toHaveLength(1);
		expect(notices[0].attempt).toBe(1);
		expect(notices[0].delayMs).toBe(1000);
		expect(notices[0].message).toBe("rate limited");
		expect(notices[0].error).toBeInstanceOf(Error);
		// The announcement is the point of the callback, so it has to land before
		// the wait it describes rather than with it.
		expect(order).toEqual(["notice", "sleep"]);
	});

	// A turn belonging to one session is retried per request, so the callback
	// rides on `streamOptions` — the loop's own handle on this call. The
	// wrapper-level one is the fallback for callers that have no turn to name.
	test("the per-request callback runs instead of the wrapper's", async () => {
		const { fn } = failingStreamFn(1, Object.assign(new Error("rate limited"), { status: 429 }));
		const wrapperLevel: number[] = [];
		const perRequest: number[] = [];
		const wrapped = withRetry(fn, {
			baseDelayMs: 1,
			onRetry: (notice) => wrapperLevel.push(notice.attempt),
			sleep: async () => {},
		});

		await collect(
			wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }, { onRetry: (notice) => perRequest.push(notice.attempt) }),
		);
		expect(perRequest).toEqual([1]);
		expect(wrapperLevel).toEqual([]);
	});
});

describe("missing API key", () => {
	test("names the provider and every variable that would have satisfied it", () => {
		expect(new MissingApiKeyError(FAUX_MODEL).message).toBe(
			"Missing API key for faux: set FAUX_API_KEY in your environment.",
		);
		const withFallback: Model = { ...FAUX_MODEL, apiKeyEnvFallbacks: ["FAUX_API_KEY_ALT"] };
		const error = new MissingApiKeyError(withFallback);
		expect(error.provider).toBe("faux");
		expect(error.envNames).toEqual(["FAUX_API_KEY", "FAUX_API_KEY_ALT"]);
		expect(error.message).toBe("Missing API key for faux: set FAUX_API_KEY or FAUX_API_KEY_ALT in your environment.");
	});

	// The reported failure mode: with no key in the environment, `-p` was silent
	// for two minutes and then blamed the network. An unresolvable credential
	// arrives status-less, which used to read as "try again" — so this is the
	// branch that makes it terminal on the first attempt. The sleep count proves
	// it rather than the clock.
	test("fails on the first attempt, without climbing the ladder", async () => {
		const { fn, calls } = failingStreamFn(99, new MissingApiKeyError(FAUX_MODEL));
		let slept = 0;
		const wrapped = withRetry(fn, {
			baseDelayMs: 1,
			sleep: async () => {
				slept++;
			},
		});

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(calls()).toBe(1);
		expect(slept).toBe(0);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		// The message, not a retry report: no "after N attempt(s)" prefix claiming
		// attempts that were never made.
		expect((terminal as any).message.errorMessage).toBe(
			"Missing API key for faux: set FAUX_API_KEY in your environment.",
		);
	});
});

describe("the missing-key pre-flight", () => {
	// `createDefaultStreamFn` is production's own wiring, and the pre-flight is
	// what it runs before dispatch — so this covers the shipped path with no
	// provider and no network on the happy side. The base URL is loopback
	// because the falsified version of this test would otherwise leave the
	// machine: a missing guard means the adapter builds a client with an empty
	// key and dials the real endpoint.
	const model: Model = { ...FAUX_MODEL, baseUrl: "http://127.0.0.1:9" };

	async function withNoKey<T>(body: () => T | Promise<T>): Promise<T> {
		const saved = process.env.FAUX_API_KEY;
		delete process.env.FAUX_API_KEY;
		try {
			return await body();
		} finally {
			if (saved === undefined) delete process.env.FAUX_API_KEY;
			else process.env.FAUX_API_KEY = saved;
		}
	}

	test("answers from the environment, and yields to an explicit key", async () => {
		await withNoKey(() => {
			const missing = missingApiKey(model);
			expect(missing).toBeInstanceOf(MissingApiKeyError);
			expect((missing as MissingApiKeyError).provider).toBe("faux");
			expect(missingApiKey(model, { apiKey: "sk-test" })).toBeUndefined();
		});
		process.env.FAUX_API_KEY = "sk-test";
		try {
			expect(missingApiKey(model)).toBeUndefined();
		} finally {
			delete process.env.FAUX_API_KEY;
		}
	});

	test("the default stream fn ends the turn on a missing key instead of dialling", async () => {
		await withNoKey(async () => {
			const events = await collect(createDefaultStreamFn()(model, { systemPrompt: "", messages: [] }));
			expect(events.at(-1)?.type).toBe("error");
			expect((events.at(-1) as any).message.errorMessage).toContain("set FAUX_API_KEY");
		});
	});
});
