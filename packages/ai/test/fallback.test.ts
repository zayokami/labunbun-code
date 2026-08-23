import { describe, expect, test } from "bun:test";
import { withModelFallback } from "../src/fallback.ts";
import { MessageBuilder } from "../src/message-builder.ts";
import { FAUX_MODEL } from "../src/providers/faux.ts";
import type { AssistantMessageEvent, Model, StreamFn } from "../src/types.ts";
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

function scriptedStreamFn(behavior: (model: Model) => "ok" | "error" | "throw-after-content"): StreamFn {
	return async function* (model, _context, _options) {
		const builder = new MessageBuilder(model.provider, model.id);
		yield builder.start();
		const behaviorKind = behavior(model);
		if (behaviorKind === "error") {
			yield builder.error(`${model.id} unavailable`);
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
	test("falls back silently when primary errors before content", async () => {
		const base = scriptedStreamFn((model) => (model.id === FAUX_MODEL.id ? "error" : "ok"));
		const wrapped = withModelFallback(base, () => [FALLBACK_MODEL]);

		const events = await collect(wrapped(FAUX_MODEL, { systemPrompt: "", messages: [userMessage("hi")] }));
		expect(events.at(-1)?.type).toBe("done");
		const done = events.at(-1) as any;
		expect(done.message.content[0].text).toBe(`answer from ${FALLBACK_MODEL.id}`);
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
