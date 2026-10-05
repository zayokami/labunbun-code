/**
 * What a summary request costs, in cache terms.
 *
 * A summarization sends the largest request a session ever makes — the whole
 * transcript, rewritten as a summary — and it used to be sent as its own
 * conversation: a private system prompt and no tools, which put every byte
 * before the transcript out of reach of the prefix the main loop had just
 * cached, so the entire call was paid at the full rate. From the tracker's
 * side it was equally invisible: a family of one, whose first request is a
 * cold start by definition.
 *
 * The design these tests pin: the summary is requested through the session's
 * own system prompt and tool list, over the transcript exactly as the last
 * request sent it, with the instruction appended. The unchanged prefix then
 * reads back what that request wrote, and only the instruction — plus whatever
 * the previous request did not yet include — is paid for. Cheaper rungs
 * (previews of old tool results, then dropping the oldest round) exist, but
 * only behind a refusal: each one moves bytes and forfeits the cache, so it is
 * never worth taking before the provider says the full one does not fit.
 *
 * The first two tests observe the request shape against a scripted stream; the
 * last runs the whole thing against the caching endpoint (`cache-stub-server`)
 * so the read it asserts is what a cache that behaves as documented would
 * actually serve.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { CompactionManager, estimateContextUsage, microcompact, SUMMARY_PROMPT } from "@labunbun/agent";
import {
	type AgentMessage,
	assistantMessage,
	type Context,
	createTrackedStreamFn,
	FAUX_MODEL,
	type FauxStep,
	fauxProvider,
	type Model,
	type StreamFn,
	type StreamOptions,
	textContent,
	toolResultMessage,
	userMessage,
	type WireTool,
} from "@labunbun/ai";
import { startCacheStub } from "../../ai/test/cache-stub-server.ts";

/** The window the manager plans against. Large enough that big fixtures fit. */
const CONFIG = { contextWindow: 100_000, maxOutputTokens: 32_000 };

/** A real registry entry with a credential, as the summarizer must be. */
const SUMMARIZER: Model = { ...FAUX_MODEL, id: "summarizer-1", apiKeyEnv: "FAUX_API_KEY" };

const WIRE_TOOL: WireTool = {
	name: "noop",
	description: "Record that a step happened.",
	parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
};

/** A usage record big enough to anchor the estimator and gate the marks. */
function usage(promptTokens: number) {
	return { input: promptTokens, output: 20, cacheRead: 0, cacheWrite: 0, promptTotal: promptTokens };
}

/**
 * A conversation with everything the ladder reasons about: four tool results
 * (one more than the cheap rung keeps whole), two completed user turns (so a
 * round can be dropped), and a current request the suffix must retain.
 */
const TOOL_RESULT_CHARS = 3_000;
function captureHistory(): AgentMessage[] {
	const results = [1, 2, 3, 4].map((n) =>
		toolResultMessage(`call_${n}`, "noop", [textContent(`r${n} ${"y".repeat(TOOL_RESULT_CHARS)}`)]),
	);
	return [
		userMessage("u1 first request"),
		assistantMessage({ content: [textContent("a1")], usage: usage(2_000) }),
		...results,
		userMessage("u2 second request"),
		assistantMessage({ content: [textContent("a2")], usage: usage(6_000) }),
		userMessage("u3 current request"),
	];
}

interface CapturedCall {
	context: Context;
	options: StreamOptions | undefined;
}

/**
 * A scripted stream that also writes down what it was asked — the request
 * shape and the options — so the tests can read the ladder off the wire-side
 * of the manager rather than off its internals.
 *
 * One step per call, and a fresh provider each time: the manager stops reading
 * at a terminal error event, and a script generator abandoned mid-flight never
 * advances its index — a shared one would replay the refusal forever.
 */
function captureStreamFn(steps: FauxStep[], log: string[]): { calls: CapturedCall[]; streamFn: StreamFn } {
	const calls: CapturedCall[] = [];
	let call = 0;
	const streamFn: StreamFn = (model, context, options) => {
		calls.push({ context, options });
		log.push("send");
		const step = steps[Math.min(call++, steps.length - 1)] ?? { text: "" };
		return fauxProvider([step]).streamFn(model, context, options);
	};
	return { calls, streamFn };
}

/** One manager over a scripted stream, with the per-attempt hook recorded. */
function harness(steps: FauxStep[]) {
	const log: string[] = [];
	const { calls, streamFn } = captureStreamFn(steps, log);
	const manager = new CompactionManager(CONFIG, {
		streamFn,
		summarizerModel: SUMMARIZER,
		onSummarizeRequest: () => log.push("note"),
	});
	return { calls, log, manager };
}

const OVERFLOW: FauxStep = { stopReason: "error", errorKind: "context_overflow", errorMessage: "too big" };
const SUMMARY: FauxStep = { text: "<analysis>thinking</analysis>\n<summary>The summary.</summary>" };

describe("the summary request reuses the session's prefix", () => {
	test("the first attempt is the session's own request, uncut", async () => {
		const { calls, log, manager } = harness([OVERFLOW, SUMMARY]);
		const all = captureHistory();
		const prefix = all.slice(0, -1);
		const context: Context = { systemPrompt: "S".repeat(1_000), tools: [WIRE_TOOL], messages: all };

		await manager.compact(context);

		expect(calls).toHaveLength(2);
		const first = calls[0];
		if (!first) throw new Error("no request was sent");
		// Same system prompt, same tools: that is what makes the prefix the main
		// loop cached reachable at all.
		expect(first.context.systemPrompt).toBe(context.systemPrompt);
		expect(first.context.tools).toEqual([WIRE_TOOL]);
		// The transcript exactly as the last request sent it — the tool results
		// still whole, which is the difference between reading the cache and
		// rewriting it in the act of paying for a summary.
		expect(first.context.messages.slice(0, prefix.length)).toEqual(prefix);
		const rawResult = first.context.messages[2];
		if (rawResult?.role !== "toolResult") throw new Error("fixture shape moved");
		expect(rawResult.content[0]?.type === "text" ? rawResult.content[0].text.length : 0).toBeGreaterThan(
			TOOL_RESULT_CHARS - 1,
		);
		// The instruction rides last, and is the whole of what is new.
		const instruction = first.context.messages.at(-1);
		if (instruction?.role !== "user" || typeof instruction.content !== "string") {
			throw new Error("the instruction is not the last message");
		}
		expect(instruction.content).toContain(SUMMARY_PROMPT);
		// Summaries are a translation, not a thinking task, and the output cap
		// keeps the request inside the window even though it is at its largest.
		expect(first.options?.thinkingLevel).toBe("off");
		const cap = first.options?.maxOutputTokens ?? 0;
		expect(cap).toBeGreaterThanOrEqual(1024);
		expect(cap).toBeLessThanOrEqual(SUMMARIZER.maxOutputTokens);
		expect(estimateContextUsage(first.context) + cap).toBeLessThanOrEqual(CONFIG.contextWindow - 3_000);
		// The rewrite was declared before each send, not once after the fact:
		// every attempt is its own request, and the tracker consumes one cause
		// per request.
		expect(log).toEqual(["note", "send", "note", "send"]);
	});

	test("a refusal steps down the ladder, never up front", async () => {
		const { calls, log, manager } = harness([OVERFLOW, OVERFLOW, SUMMARY]);
		const all = captureHistory();
		const prefix = all.slice(0, -1);
		const context: Context = { systemPrompt: "S".repeat(1_000), tools: [WIRE_TOOL], messages: all };

		await manager.compact(context);

		expect(calls).toHaveLength(3);
		const [raw, previewed, dropped] = calls;
		if (!raw || !previewed || !dropped) throw new Error("the ladder did not take three steps");
		// Rung two is the cheap rung: the same messages, old results previewed.
		expect(previewed.context.messages.slice(0, prefix.length)).toEqual(microcompact(prefix));
		expect(previewed.context.systemPrompt).toBe(context.systemPrompt);
		// Rung three gives up whole rounds, oldest first.
		expect(dropped.context.messages.length).toBeLessThan(previewed.context.messages.length);
		const firstDropped = dropped.context.messages[0];
		expect(firstDropped?.role === "user" && firstDropped.content).toBe("u2 second request");
		// Every step strictly smaller than the one before it — the property that
		// makes the ladder terminate rather than circle. Measured in bytes, because
		// the token estimate anchors on the newest usage record and cannot see that
		// older text was cut — which is the one thing a rung does.
		const sizeOf = (call: CapturedCall): number => JSON.stringify(call.context.messages).length;
		expect(sizeOf(raw)).toBeGreaterThan(sizeOf(previewed));
		expect(sizeOf(previewed)).toBeGreaterThan(sizeOf(dropped));
		expect(log).toEqual(["note", "send", "note", "send", "note", "send"]);
	});
});

// ---------------------------------------------------------------------------
// End to end, against the caching endpoint
// ---------------------------------------------------------------------------

const KEY_ENV = "LABUNBUN_COMPACTION_STUB_KEY";
process.env[KEY_ENV] = "local-test-key";

function stubModel(baseUrl: string): Model {
	return {
		id: "claude-opus-5",
		name: "claude-opus-5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		apiKeyEnv: KEY_ENV,
		contextWindow: 200_000,
		maxOutputTokens: 4_096,
		reasoning: false,
		input: ["text"],
		pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	};
}

const SYSTEM = Array.from(
	{ length: 600 },
	(_, i) => `Rule ${i}: keep the transcript byte-stable and never rewrite a message that was already sent.`,
).join("\n");

/** Remove cache_control markers so two wire bodies compare on content alone. */
function stripMarks(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripMarks);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (key !== "cache_control") out[key] = stripMarks(entry);
		}
		return out;
	}
	return value;
}

const stubs: Array<ReturnType<typeof startCacheStub>> = [];
afterAll(() => {
	for (const started of stubs.splice(0)) started.stop();
});

describe("the summary request against a caching endpoint", () => {
	test("reads the prefix the last request wrote instead of paying for it again", async () => {
		const server = startCacheStub({
			steps: [{ text: "the answer" }, { text: "<summary>The summary.</summary>" }, { text: "answer 2" }],
			modelId: "claude-opus-5",
			minPrefixTokens: 512,
		});
		stubs.push(server);
		const model = stubModel(server.baseUrl);
		const tracked = createTrackedStreamFn();

		// A conversation the shape the real loop produces: completed turns, a
		// fresh request at the end, and usage recorded on the assistant turns.
		const history: AgentMessage[] = [
			userMessage(`u1 ${"x".repeat(8_000)}`),
			assistantMessage({
				content: [textContent(`a1 ${"x".repeat(8_000)}`)],
				provider: "anthropic",
				model: "claude-opus-5",
				stopReason: "stop",
				usage: usage(16_000),
			}),
			userMessage(`u2 ${"x".repeat(8_000)}`),
			assistantMessage({
				content: [textContent("a2 short")],
				provider: "anthropic",
				model: "claude-opus-5",
				stopReason: "stop",
				usage: usage(33_000),
			}),
		];
		const current = userMessage("u3 what now");
		const mainContext: Context = { systemPrompt: SYSTEM, tools: [WIRE_TOOL], messages: history };
		const fullContext: Context = { systemPrompt: SYSTEM, tools: [WIRE_TOOL], messages: [...history, current] };

		// The last request of the previous turn, exactly as the session sends it.
		for await (const _ of tracked.streamFn(model, mainContext)) {
			// drain
		}

		const manager = new CompactionManager(
			{ contextWindow: 200_000, maxOutputTokens: 4_096 },
			{
				streamFn: tracked.streamFn,
				summarizerModel: model,
				// What the wiring does: one declaration per summary attempt.
				onSummarizeRequest: () => tracked.tracker.note("compaction"),
			},
		);
		const compacted = await manager.compact(fullContext);

		const [main, summary] = server.requests;
		if (!main || !summary) throw new Error("expected a main request and a summary request");

		// The summary was sent with the same fixed prefix — in the same bytes,
		// not merely the same spirit: that identity is what the cache keys on.
		expect(summary.body.system).toEqual(main.body.system);
		expect(summary.body.tools).toEqual(main.body.tools);
		const summaryMessages = summary.body.messages as unknown[];
		expect(stripMarks(summaryMessages.slice(0, 4))).toEqual(stripMarks(main.body.messages));

		// What the endpoint billed: the previous prompt nearly all read back,
		// and only the instruction — plus the previous answer, which no earlier
		// request had yet written — at the full rate. The old private-system
		// request read nothing, which is the regression this pins.
		expect(summary.usage.read).toBeGreaterThan(0.9 * summary.usage.total);
		expect(summary.usage.input).toBeLessThan(0.05 * summary.usage.total);

		// The tracker sees the summary as a step of the same conversation, with
		// the rewrite declared — and the request after the compaction as the one
		// rewind this pass is allowed to cause, also declared: that declaration is
		// the wiring's, made once `check` reports the rewrite it just performed.
		tracked.tracker.note("compaction");
		for await (const _ of tracked.streamFn(model, compacted)) {
			// drain
		}
		const records = tracked.tracker.records();
		expect(records.map((record) => record.kind)).toEqual(["first", "extension", "rewind"]);
		expect(records[1]?.causes).toEqual(["compaction"]);
		expect(records[2]?.causes).toEqual(["compaction"]);
		expect(records.filter((record) => record.kind === "rewind" && record.causes.length === 0)).toEqual([]);
	}, 120_000);
});
