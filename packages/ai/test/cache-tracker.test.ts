import { describe, expect, test } from "bun:test";
import type { CacheNotice } from "../src/cache.ts";
import { contextFingerprints, firstDivergence, withCacheTracker } from "../src/cache-tracker.ts";
import type { AssistantMessageEvent, Context, Model, StreamFn, Usage } from "../src/types.ts";
import { assistantMessage, userMessage } from "../src/types.ts";

function model(overrides: Partial<Model> = {}): Model {
	return {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		apiKeyEnv: "ANTHROPIC_API_KEY",
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		reasoning: true,
		input: ["text"],
		...overrides,
	};
}

function ctx(messages: Context["messages"] = [userMessage("hello")], systemPrompt = "sys"): Context {
	return { systemPrompt, messages };
}

/** A stream that reports `usage` on its terminal event, or misbehaves as asked. */
function stubStream(usage: Partial<Usage> = {}, behaviour: "ok" | "abandon" | "throw" = "ok"): StreamFn {
	return async function* () {
		if (behaviour === "throw") throw new Error("boom");
		const message = assistantMessage({
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
			stopReason: "stop",
		});
		yield { type: "start", partial: message } as AssistantMessageEvent;
		if (behaviour === "abandon") return;
		yield { type: "done", message } as AssistantMessageEvent;
	};
}

async function drain(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

describe("contextFingerprints", () => {
	test("tools, system and each message get a unit", () => {
		expect(contextFingerprints(ctx([userMessage("a"), userMessage("b")]))).toHaveLength(4);
	});

	test("units are position-stable across identical contexts", () => {
		expect(contextFingerprints(ctx())).toEqual(contextFingerprints(ctx()));
	});
});

describe("firstDivergence", () => {
	const base = contextFingerprints(ctx([userMessage("a"), userMessage("b")]));

	test("undefined when the new request extends the old one", () => {
		expect(
			firstDivergence(base, contextFingerprints(ctx([userMessage("a"), userMessage("b"), userMessage("c")]))),
		).toBeUndefined();
	});

	test("a changed tool list is a tools divergence", () => {
		const withTools = contextFingerprints({
			...ctx(),
			tools: [{ name: "read", description: "r", parameters: { type: "object" } }],
		});
		expect(firstDivergence(base, withTools)?.scope).toBe("tools");
	});

	test("a changed system prompt is a system divergence", () => {
		expect(firstDivergence(base, contextFingerprints(ctx([userMessage("a"), userMessage("b")], "other")))?.scope).toBe(
			"system",
		);
	});

	test("a changed message reports its index", () => {
		const divergence = firstDivergence(base, contextFingerprints(ctx([userMessage("a"), userMessage("B!")])));
		expect(divergence).toEqual({ scope: "messages", messageIndex: 1 });
	});
});

describe("withCacheTracker", () => {
	test("a growing conversation is an extension", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream({ promptTotal: 100, cacheRead: 90 }));
		await drain(streamFn(model(), ctx([userMessage("one")])));
		await drain(streamFn(model(), ctx([userMessage("one"), userMessage("two")])));

		const records = tracker.records();
		expect(records.map((record) => record.kind)).toEqual(["first", "extension"]);
		expect(records[1]?.divergence).toBeUndefined();
		expect(records.map((record) => record.turn)).toEqual([1, 2]);
		expect(records[1]?.gapMs).toBeGreaterThanOrEqual(0);
	});

	test("two requests with no message array change at all", async () => {
		// The second request here is byte-identical to the first — what a retry
		// attempt looks like — and must be labelled as one, not as an extension.
		const { streamFn, tracker } = withCacheTracker(stubStream());
		await drain(streamFn(model(), ctx()));
		await drain(streamFn(model(), ctx()));
		expect(tracker.records().map((record) => record.kind)).toEqual(["first", "reask"]);
	});

	test("editing a message in place is a rewind at that index", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream());
		await drain(streamFn(model(), ctx([userMessage("one"), userMessage("two")])));
		await drain(streamFn(model(), ctx([userMessage("one"), userMessage("TWO")])));

		const rewind = tracker.records()[1];
		expect(rewind?.kind).toBe("rewind");
		expect(rewind?.divergence).toEqual({ scope: "messages", messageIndex: 1 });
	});

	test("a transient prefix that reverts is caught on the way back", async () => {
		// The hook-context bug, reduced: turn 1 prepends text to the last message,
		// turn 2 sends it without. Only a tracker that remembers turn 1 sees this.
		const { streamFn, tracker } = withCacheTracker(stubStream());
		await drain(streamFn(model(), ctx([userMessage("hook\n---\nask")])));
		await drain(streamFn(model(), ctx([userMessage("ask")])));

		const rewind = tracker.records()[1];
		expect(rewind?.kind).toBe("rewind");
		expect(rewind?.divergence).toEqual({ scope: "messages", messageIndex: 0 });
	});

	test("a truncated conversation is a rewind at the new end", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream());
		await drain(streamFn(model(), ctx([userMessage("one"), userMessage("two"), userMessage("three")])));
		await drain(streamFn(model(), ctx([userMessage("one")])));

		expect(tracker.records()[1]?.divergence).toEqual({ scope: "messages", messageIndex: 1 });
	});

	test("a different system prompt is a new family, never a rewind", async () => {
		// A subagent: same model, its own prompt and tools. Comparing it against the
		// main loop would report a rewind at message 0 on every single call.
		const { streamFn, tracker } = withCacheTracker(stubStream());
		await drain(streamFn(model(), ctx([userMessage("one")], "main prompt")));
		await drain(streamFn(model(), ctx([userMessage("one")], "subagent prompt")));

		const records = tracker.records();
		expect(records.map((record) => record.kind)).toEqual(["first", "first"]);
		expect(records[1]?.turn).toBe(1);
		expect(tracker.families()).toHaveLength(2);
	});

	test("a model switch is a new family", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream());
		await drain(streamFn(model(), ctx()));
		await drain(streamFn(model({ id: "claude-haiku-4-5" }), ctx()));

		expect(tracker.records().map((record) => record.kind)).toEqual(["first", "first"]);
		expect(tracker.records()[1]?.familyLabel).toBe("anthropic/claude-haiku-4-5");
	});

	test("fields that never reach the wire do not count as rewinds", async () => {
		// `timestamp` and `usage` move on every turn while the adapter sends
		// neither; hashing the whole neutral message would invent a rewind here.
		const { streamFn, tracker } = withCacheTracker(stubStream());
		const content = [{ type: "text" as const, text: "same" }];
		const first = {
			...assistantMessage({ content, usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } }),
			timestamp: 1,
		};
		const second = {
			...assistantMessage({ content, usage: { input: 9, output: 4, cacheRead: 0, cacheWrite: 0 } }),
			timestamp: 2,
		};

		await drain(streamFn(model(), { systemPrompt: "sys", messages: [first] }));
		await drain(streamFn(model(), { systemPrompt: "sys", messages: [second] }));
		expect(tracker.records()[1]?.kind).toBe("reask");

		// And a genuinely different assistant turn is an extension, not a rewind.
		await drain(streamFn(model(), { systemPrompt: "sys", messages: [second, { ...second, timestamp: 3 }] }));
		expect(tracker.records()[2]?.kind).toBe("extension");
	});

	test("note() registers a cause for the next request only", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream());
		await drain(streamFn(model(), ctx([userMessage("one")])));
		tracker.note("compaction");
		await drain(streamFn(model(), ctx([userMessage("summary")])));
		await drain(streamFn(model(), ctx([userMessage("summary"), userMessage("next")])));

		const records = tracker.records();
		expect(records[1]?.causes).toEqual(["compaction"]);
		expect(records[1]?.kind).toBe("rewind");
		expect(records[2]?.causes).toEqual([]);
	});

	test("usage lands on the record from the terminal event", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream({ promptTotal: 1000, cacheRead: 990, input: 10 }));
		await drain(streamFn(model(), ctx()));
		const record = tracker.records()[0];
		expect(record?.reported).toBe(true);
		expect(record?.outcome).toBe("reported");
		expect(record?.promptTotal).toBe(1000);
		expect(record?.cacheRead).toBe(990);
	});

	test("a request that never reported usage is still recorded", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream({}, "abandon"));
		await drain(streamFn(model(), ctx()));
		const record = tracker.records()[0];
		expect(record?.reported).toBe(false);
		expect(record?.outcome).toBe("cancelled");
		expect(record?.promptTotal).toBeUndefined();
	});

	test("a consumer that walks away is recorded as cancelled", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream({ promptTotal: 10 }));
		for await (const _event of streamFn(model(), ctx())) break;
		expect(tracker.records()[0]?.outcome).toBe("cancelled");
	});

	test("a throwing client is recorded as failed and the error propagates", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream({}, "throw"));
		await expect(drain(streamFn(model(), ctx()))).rejects.toThrow("boom");
		expect(tracker.records()[0]?.outcome).toBe("failed");
	});

	test("reset forgets families and records", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream());
		await drain(streamFn(model(), ctx()));
		tracker.reset();
		expect(tracker.records()).toHaveLength(0);
		await drain(streamFn(model(), ctx()));
		expect(tracker.records()[0]?.kind).toBe("first");
	});

	test("families beyond the window start over instead of misreporting", async () => {
		const { streamFn, tracker } = withCacheTracker(stubStream());
		for (let i = 0; i < 9; i++) {
			await drain(streamFn(model(), ctx([userMessage("one")], `prompt ${i}`)));
		}
		expect(tracker.families()).toHaveLength(8);
		// The first family was evicted, so its next request is a cold start.
		await drain(streamFn(model(), ctx([userMessage("one")], "prompt 0")));
		const last = tracker.records()[tracker.records().length - 1];
		expect(last?.kind).toBe("first");
	});

	test("notices are read from a list the caller owns, not copied at construction", async () => {
		// The order the app builds things in: the adapter has to exist before the
		// wrapper that would own the list, so the list is made first and handed to
		// both. A notice pushed after the tracker was built still has to be visible,
		// which is only true if this reads the array rather than a snapshot of it.
		const notices: CacheNotice[] = [];
		const { streamFn, tracker } = withCacheTracker(stubStream({ promptTotal: 10 }), { notices });
		expect(tracker.notices()).toEqual([]);
		notices.push({ kind: "ttl-downgrade", from: "1h", to: "5m", reason: "1h is not available" });
		await drain(streamFn(model(), ctx()));
		expect(tracker.notices()).toEqual([{ kind: "ttl-downgrade", from: "1h", to: "5m", reason: "1h is not available" }]);
	});
});
