/**
 * `withStallTimeout` — the idle watchdog between the consumer and the wire.
 *
 * Its whole job is the request that never ends and never fails: a provider or
 * a proxy that accepted the connection and then went silent. The wrapper's
 * idle timer turns that into a thrown `StreamStallError`, which the retry
 * layer above treats like any other pre-first-byte failure and the session
 * loop records as an errored turn once events have flowed.
 *
 * The stalls here are hand-rolled streams that await a promise which never
 * settles — faux deliberately cannot express that, and a fixture that could
 * would grow a field for a physics nothing else uses. Timing is real
 * (`setTimeout`), so windows are one-sided ("did fire", "did not fire") with
 * generous margins rather than equality on wall-clock numbers. Every test
 * that can hang if the wrapper misbehaves is bounded by `within`, because a
 * never-settling promise does not respect this runner's per-test timeout.
 */
import { describe, expect, test } from "bun:test";
import { MessageBuilder } from "../src/message-builder.ts";
import { FAUX_MODEL, fauxProvider } from "../src/providers/faux.ts";
import { withRetry } from "../src/retry.ts";
import { StreamStallError, withStallTimeout } from "../src/stall-timeout.ts";
import type { AssistantMessageEvent, StreamFn } from "../src/types.ts";

async function collect(events: AsyncIterable<AssistantMessageEvent>) {
	const out: AssistantMessageEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

/** Collect, but fail — rather than hang — if the stream never terminates. */
async function within(ms: number, events: AsyncIterable<AssistantMessageEvent>) {
	return Promise.race([
		collect(events),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`stream did not terminate within ${ms}ms`)), ms),
		),
	]);
}

const ctx = { systemPrompt: "", messages: [] };

describe("withStallTimeout", () => {
	test("a stream that goes quiet before any event fails as a stall", async () => {
		const silent: StreamFn = async function* () {
			await new Promise(() => {});
		};
		const guarded = withStallTimeout(silent, { idleTimeoutMs: 40 });

		const error: unknown = await within(2_000, guarded(FAUX_MODEL, ctx)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(StreamStallError);
		expect((error as Error).message).toContain("stalled");
	});

	test("each event resets the window, so a slow-but-alive stream survives", async () => {
		// Events every 40ms against a 150ms idle window: a wrapper that armed
		// one timer for the whole stream would fire at 150ms, with four events
		// still to come. Load-sensitive by nature (real timers on a shared CI
		// runner) — the margins are what keep it honest, not the numbers.
		const ticking: StreamFn = async function* () {
			const builder = new MessageBuilder(FAUX_MODEL.provider, FAUX_MODEL.id);
			yield builder.start();
			for (let i = 0; i < 6; i++) {
				await new Promise((r) => setTimeout(r, 40));
				yield builder.textStart(0);
				yield builder.textDelta(0, "x");
				yield builder.textEnd(0);
			}
			yield builder.done("stop");
		};
		const guarded = withStallTimeout(ticking, { idleTimeoutMs: 150 });

		const events = await within(3_000, guarded(FAUX_MODEL, ctx));
		expect(events.at(-1)?.type).toBe("done");
	});

	test("the stall abort is the wrapper's own, so a user's abort stays distinguishable", async () => {
		// The signal handed to the inner stream must carry the caller's abort
		// (Esc still cancels) — but the stall must not abort the *caller's*
		// signal, or every layer above would read the stall as an interrupt.
		let seen: AbortSignal | undefined;
		const silent: StreamFn = async function* (_model, _context, options) {
			seen = options?.signal;
			await new Promise(() => {});
		};
		const caller = new AbortController();
		const guarded = withStallTimeout(silent, { idleTimeoutMs: 40 });

		await expect(within(2_000, guarded(FAUX_MODEL, ctx, { signal: caller.signal }))).rejects.toThrow(/stalled/);
		expect(seen?.aborted).toBe(true); // the stall reached the wire...
		expect(caller.signal.aborted).toBe(false); // ...without claiming the user cancelled
	});
});

describe("under withRetry, in the composition the app wires", () => {
	test("a first-byte stall is retried like any failed connection", async () => {
		// This pins the order — stall guard *inside* retry. Swapped, the stall
		// would fire while the retry wrapper was still waiting on its first
		// inner attempt, and the ladder would never get its second shot.
		let calls = 0;
		const flaky: StreamFn = async function* (model, context, options) {
			calls++;
			if (calls === 1) {
				await new Promise(() => {});
				return;
			}
			yield* fauxProvider([{ text: "recovered" }]).streamFn(model, context, options);
		};
		const composed = withRetry(withStallTimeout(flaky, { idleTimeoutMs: 40 }), {
			baseDelayMs: 1,
			sleep: async () => {},
		});

		const events = await within(2_000, composed(FAUX_MODEL, ctx));
		expect(calls).toBe(2);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("a stall after events have flowed is rethrown, not retried", async () => {
		let calls = 0;
		const dies: StreamFn = async function* () {
			calls++;
			const builder = new MessageBuilder(FAUX_MODEL.provider, FAUX_MODEL.id);
			yield builder.start();
			yield builder.textStart(0);
			yield builder.textDelta(0, "half an answer");
			await new Promise(() => {});
		};
		const composed = withRetry(withStallTimeout(dies, { idleTimeoutMs: 40 }), {
			baseDelayMs: 1,
			sleep: async () => {},
		});

		const seen: string[] = [];
		const pump = (async () => {
			for await (const e of composed(FAUX_MODEL, ctx)) seen.push(e.type);
		})();
		await expect(
			Promise.race([
				pump,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("stream did not terminate within 2000ms")), 2_000),
				),
			]),
		).rejects.toThrow(/stalled/);
		expect(calls).toBe(1); // the partial answer is the turn's record now; no second request
		expect(seen).toContain("text_delta");
	});
});
