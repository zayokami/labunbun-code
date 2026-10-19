import { describe, expect, test } from "bun:test";
import { withModelFallback } from "../src/fallback.ts";
import { MessageBuilder } from "../src/message-builder.ts";
import { FAUX_MODEL } from "../src/providers/faux.ts";
import type { AssistantMessage, AssistantMessageEvent, FallbackNotice, Model, StreamFn } from "../src/types.ts";
import { userMessage } from "../src/types.ts";

const FALLBACK_MODEL: Model = {
	...FAUX_MODEL,
	id: "faux-fallback",
	name: "Faux Fallback",
};

async function collect(events: AsyncIterable<AssistantMessageEvent>) {
	const out: AssistantMessageEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

function scriptedStreamFn(
	behavior: (model: Model) => "ok" | "error" | "throw-after-content",
	errorKind?: AssistantMessage["errorKind"],
): StreamFn {
	return async function* (model, _context, _options) {
		const builder = new MessageBuilder(model.provider, model.id);
		yield builder.start();
		const behaviorKind = behavior(model);
		if (behaviorKind === "error") {
			yield builder.error(`${model.id} unavailable`, errorKind ? { errorKind } : {});
			return;
		}
		yield builder.textStart(0);
		if (behaviorKind === "throw-after-content") {
			throw new Error("connection reset mid-stream");
		}
		yield builder.textDelta(0, `answer from ${model.id}`);
		yield builder.textEnd(0);
		yield builder.done("stop");
	};
}

describe("withModelFallback", () => {
	test("falls back when primary errors before content", async () => {
		const base = scriptedStreamFn((model) => (model.id === FAUX_MODEL.id ? "error" : "ok"));
		const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [userMessage("hi")] }));
		expect(events.at(-1)?.type).toBe("done");
		const done = events.at(-1) as any;
		expect(done.message.content[0].text).toBe(`answer from ${FALLBACK_MODEL.id}`);
	});

	test("announces the descent through onFallback before the next model speaks", async () => {
		const notices: FallbackNotice[] = [];
		const base = scriptedStreamFn((model) => (model.id === FAUX_MODEL.id ? "error" : "ok"));
		const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);

		const events = await collect(
			wrapped(
				FAUX_MODEL,
				{ systemPrompt: "", messages: [userMessage("hi")] },
				{ onFallback: (notice) => notices.push(notice) },
			),
		);

		// One switch, named from the model that failed to the one about to answer.
		expect(notices).toEqual([
			{
				from: { provider: FAUX_MODEL.provider, id: FAUX_MODEL.id },
				to: { provider: FALLBACK_MODEL.provider, id: FALLBACK_MODEL.id },
				reason: `${FAUX_MODEL.id} unavailable`,
			},
		]);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("the notice carries the failure kind", async () => {
		const notices: FallbackNotice[] = [];
		const base = scriptedStreamFn((model) => (model.id === FAUX_MODEL.id ? "error" : "ok"), "rate_limit");
		const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);

		await collect(
			wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }, { onFallback: (notice) => notices.push(notice) }),
		);

		expect(notices).toHaveLength(1);
		expect(notices[0]?.errorKind).toBe("rate_limit");
	});

	test("a pre-content throw is announced too", async () => {
		const notices: FallbackNotice[] = [];
		const throwing: StreamFn = async function* (model) {
			if (model.id === FAUX_MODEL.id) throw new Error("socket closed");
			const builder = new MessageBuilder(model.provider, model.id);
			yield builder.start();
			yield builder.textStart(0);
			yield builder.textDelta(0, "answer from the next model");
			yield builder.textEnd(0);
			yield builder.done("stop");
		};
		const wrapped = withModelFallback(throwing, () => [FALLBACK_MODEL]);

		const events = await collect(
			wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }, { onFallback: (notice) => notices.push(notice) }),
		);

		expect(notices).toEqual([
			{
				from: { provider: FAUX_MODEL.provider, id: FAUX_MODEL.id },
				to: { provider: FALLBACK_MODEL.provider, id: FALLBACK_MODEL.id },
				reason: "socket closed",
			},
		]);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("a stream that ends without a terminal event is announced", async () => {
		const notices: FallbackNotice[] = [];
		const truncated: StreamFn = async function* (model) {
			const builder = new MessageBuilder(model.provider, model.id);
			yield builder.start();
			if (model.id === FAUX_MODEL.id) return;
			yield builder.textStart(0);
			yield builder.textDelta(0, "answer from the next model");
			yield builder.textEnd(0);
			yield builder.done("stop");
		};
		const wrapped = withModelFallback(truncated, () => [FALLBACK_MODEL]);

		await collect(
			wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }, { onFallback: (notice) => notices.push(notice) }),
		);

		expect(notices).toHaveLength(1);
		expect(notices[0]?.reason).toContain("stream ended without a terminal event");
	});

	test("no notice when the primary answers", async () => {
		const notices: FallbackNotice[] = [];
		const base = scriptedStreamFn(() => "ok");
		const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);

		await collect(
			wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }, { onFallback: (notice) => notices.push(notice) }),
		);

		expect(notices).toEqual([]);
	});

	test("no notice for a context overflow, a mid-stream failure, or an abort", async () => {
		const notices: FallbackNotice[] = [];

		const overflowing: StreamFn = async function* (model) {
			const builder = new MessageBuilder(model.provider, model.id);
			yield builder.start();
			yield builder.error("too large", { errorKind: "context_overflow" });
		};
		await collect(
			withModelFallback(overflowing, () => [FALLBACK_MODEL])(
				FAUX_MODEL,
				{ systemPrompt: "", messages: [] },
				{ onFallback: (notice) => notices.push(notice) },
			),
		);

		const controller = new AbortController();
		controller.abort();
		const aborting: StreamFn = async function* (model, _context, options) {
			options?.signal?.throwIfAborted();
			yield new MessageBuilder(model.provider, model.id).start();
		};
		await expect(
			collect(
				withModelFallback(aborting, () => [FALLBACK_MODEL])(
					FAUX_MODEL,
					{ systemPrompt: "", messages: [] },
					{ signal: controller.signal, onFallback: (notice) => notices.push(notice) },
				),
			),
		).rejects.toThrow();

		await expect(
			collect(
				withModelFallback(
					scriptedStreamFn(() => "throw-after-content"),
					() => [FALLBACK_MODEL],
				)(FAUX_MODEL, { systemPrompt: "", messages: [] }, { onFallback: (notice) => notices.push(notice) }),
			),
		).rejects.toThrow("connection reset");

		expect(notices).toEqual([]);
	});

	test("no fallback when primary succeeds", async () => {
		const base = scriptedStreamFn(() => "ok");
		const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);
		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect((events.at(-1) as any).message.content[0].text).toBe(`answer from ${FAUX_MODEL.id}`);
	});

	test("mid-stream failure propagates even with fallbacks left", async () => {
		const base = scriptedStreamFn(() => "throw-after-content");
		const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);
		await expect(collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }))).rejects.toThrow("connection reset");
	});

	test("exhausted chain yields the final error event", async () => {
		const base = scriptedStreamFn(() => "error");
		const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);
		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }));
		expect(events.at(-1)?.type).toBe("error");
		expect((events.at(-1) as any).message.errorMessage).toContain(FALLBACK_MODEL.id);
	});

	// A context that is too large for the primary is too large for the model
	// after it. Walking the chain replays the same oversized request against
	// every remaining model, turning one explainable refusal into a generic
	// failure per model — and the caller still cannot tell why.
	test("a context overflow is yielded instead of replayed on the next model", async () => {
		const calledFor: string[] = [];
		const overflowing: StreamFn = async function* (model, _context, _options) {
			calledFor.push(model.id);
			const builder = new MessageBuilder(model.provider, model.id);
			yield builder.start();
			yield builder.error(`The request is larger than ${model.id}'s context window`, {
				errorKind: "context_overflow",
			});
		};
		const wrapped = withModelFallback(overflowing, () => [FALLBACK_MODEL]);

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [userMessage("hi")] }));
		expect(calledFor).toEqual([FAUX_MODEL.id]);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		expect((terminal as any).message.errorKind).toBe("context_overflow");
	});

	// The safe half of the same policy: kinds whose remedy is another model.
	// A rate limit, an overload or a refused credential is a fact about this
	// model, not about the request, and the next model — or the next
	// provider's key — may answer where this one will not.
	for (const kind of ["rate_limit", "overload", "auth"] as const) {
		test(`a ${kind} failure walks to the next model`, async () => {
			const base = scriptedStreamFn((model) => (model.id === FAUX_MODEL.id ? "error" : "ok"), kind);
			const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);

			const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [userMessage("hi")] }));

			expect(events.at(-1)?.type).toBe("done");
			expect((events.at(-1) as any).message.content[0].text).toBe(`answer from ${FALLBACK_MODEL.id}`);
		});
	}

	test("a kind this version does not know stops the walk", async () => {
		// The allowlist's other edge: the set is closed, and a label this
		// version cannot reason about is treated like the overflow it might
		// be, not like the unlabelled wordings that walk. A producer adding a
		// kind opts into the walk by adding it to FALLBACK_SAFE_KINDS.
		const unknownKind = "safety_block" as unknown as AssistantMessage["errorKind"];
		const base = scriptedStreamFn((model) => (model.id === FAUX_MODEL.id ? "error" : "ok"), unknownKind);
		const calledFor: string[] = [];
		const recording: StreamFn = async function* (model, context, options) {
			calledFor.push(model.id);
			yield* base(model, context, options);
		};
		const wrapped = withModelFallback(recording, () => [FALLBACK_MODEL]);

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [userMessage("hi")] }));

		expect(calledFor).toEqual([FAUX_MODEL.id]);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		expect((terminal as any).message.errorKind).toBe("safety_block");
	});

	// Without this guard an interrupt thrown before the first byte would be
	// treated as an ordinary pre-content failure and the chain would try every
	// remaining model — Esc would appear to do nothing until all of them ran.
	test("an abort propagates instead of walking the chain", async () => {
		const calledFor: string[] = [];
		const aborting: StreamFn = async function* (model, _context, options) {
			calledFor.push(model.id);
			options?.signal?.throwIfAborted();
			yield new MessageBuilder(FAUX_MODEL.provider, FAUX_MODEL.id).start();
		};
		const controller = new AbortController();
		controller.abort();
		const wrapped = withModelFallback(aborting, () => [FALLBACK_MODEL]);

		await expect(
			collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [] }, { signal: controller.signal })),
		).rejects.toThrow();
		expect(calledFor).toEqual([FAUX_MODEL.id]);
		expect(calledFor).not.toContain(FALLBACK_MODEL.id);
	});
});
