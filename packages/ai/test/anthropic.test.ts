import { describe, expect, test } from "bun:test";
import { cacheCapability } from "../src/cache.ts";
import {
	type AnthropicClientLike,
	buildAnthropicRequest,
	convertMessages,
	createAnthropicStreamFn,
	mapAnthropicStream,
	planAnthropicBreakpoints,
	previousRequestTail,
} from "../src/providers/anthropic.ts";
import type { Context, Model, Usage, UserContent } from "../src/types.ts";
import { assistantMessage, toolResultMessage, userMessage } from "../src/types.ts";

/** A usage record with only the fields a test cares about spelled out. */
function usage(overrides: Partial<Usage> = {}): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides };
}

const MODEL: Model = {
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	apiKeyEnv: "ANTHROPIC_API_KEY",
	contextWindow: 200_000,
	maxOutputTokens: 64_000,
	reasoning: true,
	input: ["text", "image"],
};

function ctx(overrides: Partial<Context> = {}): Context {
	return { systemPrompt: "You are helpful.", messages: [], tools: undefined, ...overrides };
}

async function collect(events: AsyncIterable<any>) {
	const out: any[] = [];
	for await (const e of events) out.push(e);
	return out;
}

describe("buildAnthropicRequest", () => {
	test("basic shape without a cache breakpoint when the request is too short", () => {
		const params = buildAnthropicRequest(MODEL, ctx());
		expect(params.model).toBe("claude-sonnet-5");
		expect(params.stream).toBe(true);
		expect(params.max_tokens).toBe(64_000);
		// Sonnet 5 will not cache a prompt under 1024 tokens, and this one is a few
		// dozen: a breakpoint here would be a marker the provider ignores.
		expect(params.system).toEqual([{ type: "text", text: "You are helpful." }]);
	});

	test("tools map to input_schema", () => {
		const params = buildAnthropicRequest(
			MODEL,
			ctx({
				tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
			}),
		);
		expect(params.tools).toEqual([
			{ name: "read", description: "Read a file", input_schema: { type: "object", properties: {} } },
		]);
	});

	test("thinking budget derived from level and capped by max_tokens", () => {
		const params = buildAnthropicRequest(MODEL, ctx(), { thinkingLevel: "medium" });
		expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 });

		// budget_tokens must stay below max_tokens
		const capped = buildAnthropicRequest(MODEL, ctx(), { thinkingLevel: "high", maxOutputTokens: 2000 });
		expect(capped.thinking).toEqual({ type: "enabled", budget_tokens: 1999 });

		// below the 1024 minimum, thinking is dropped entirely
		const tiny = buildAnthropicRequest(MODEL, ctx(), { thinkingLevel: "low", maxOutputTokens: 1024 });
		expect(tiny.thinking).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Cache breakpoints
// ---------------------------------------------------------------------------

/** Two tools whose schema JSON clears 1024 tokens by itself. */
const TOOLS = [
	{ name: "read", description: "r".repeat(2_000), parameters: { type: "object" as const, properties: {} } },
	{ name: "write", description: "w".repeat(2_000), parameters: { type: "object" as const, properties: {} } },
];

const SMALL_TOOLS = [
	{ name: "read", description: "Read a file", parameters: { type: "object" as const, properties: {} } },
];

/** A context long enough to clear the floor, with a tools tier of its own. */
function longCtx(overrides: Partial<Context> = {}): Context {
	return {
		systemPrompt: "s".repeat(8_000),
		messages: [userMessage("u".repeat(8_000))],
		tools: TOOLS,
		...overrides,
	};
}

/** The `cache_control` on the last piece of each section, or undefined. */
function cacheControlOf(value: unknown): unknown {
	if (Array.isArray(value)) {
		const last = value.at(-1) as Record<string, unknown> | undefined;
		return last?.cache_control;
	}
	return (value as Record<string, unknown> | undefined)?.cache_control;
}

describe("planAnthropicBreakpoints", () => {
	test("marks the tiers that are long enough and no others", () => {
		const plan = planAnthropicBreakpoints(longCtx(), 1024);
		expect(plan).toEqual({ tools: true, system: true, previous: false, tail: true });
	});

	test("marks nothing when every tier is under the floor", () => {
		const short: Context = { systemPrompt: "tiny", messages: [userMessage("also tiny")] };
		expect(planAnthropicBreakpoints(short, 1024)).toEqual({
			tools: false,
			system: false,
			previous: false,
			tail: false,
		});
	});

	test("a tier is judged on its own length, not on the prompt's", () => {
		// A short tool list under a long transcript: the tools tier is too small to
		// cache, the tail is not, and the system tier sits between the two.
		const context = longCtx({ tools: SMALL_TOOLS, systemPrompt: "s".repeat(100) });
		const plan = planAnthropicBreakpoints(context, 1024);
		expect(plan.tools).toBe(false);
		expect(plan.system).toBe(false);
		expect(plan.tail).toBe(true);
	});

	test("the floor is the model's own", () => {
		// Haiku 4.5 takes 4096, so a request that is worth marking on Sonnet is not
		// worth marking there.
		const context = longCtx({ messages: [userMessage("u".repeat(1_000))] });
		const small = { ...MODEL, id: "claude-haiku-4-5" };
		expect(planAnthropicBreakpoints(context, cacheCapability(MODEL).minPrefixTokens).tail).toBe(true);
		expect(planAnthropicBreakpoints(context, cacheCapability(small).minPrefixTokens).tail).toBe(false);
	});
});

describe("previousRequestTail", () => {
	test("is the message before the newest assistant message, with its own prompt length", () => {
		const messages = [
			userMessage("one"),
			assistantMessage({ usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, promptTotal: 100 } }),
			toolResultMessage("t1", "read", [{ type: "text", text: "result" }]),
		];
		expect(previousRequestTail(messages)).toEqual({ index: 0, tokens: 100 });
	});

	test("counts the whole prompt when the provider reported it in pieces", () => {
		const messages = [
			userMessage("one"),
			assistantMessage({ usage: { input: 40, output: 5, cacheRead: 900, cacheWrite: 60 } }),
		];
		expect(previousRequestTail(messages)).toEqual({ index: 0, tokens: 1_000 });
	});

	test("undefined before any request has been answered", () => {
		expect(previousRequestTail([userMessage("hello")])).toBeUndefined();
		expect(previousRequestTail([])).toBeUndefined();
	});

	test("undefined when the newest request never reported usage", () => {
		// An aborted or failed request wrote nothing at the position before it, so
		// there is no entry to point a breakpoint at.
		const messages = [userMessage("one"), assistantMessage({ stopReason: "aborted" })];
		expect(previousRequestTail(messages)).toBeUndefined();
	});

	test("points at the previous request's tail, not at the newest message", () => {
		// This is the whole claim: the prompt that produced the newest assistant
		// message ended at the message before it, and the transcript only grows by
		// appending — so that index is where a cache entry already exists.
		const messages = [
			userMessage("turn one"),
			assistantMessage({ usage: usage({ input: 1, cacheRead: 999, promptTotal: 1_000 }) }),
			toolResultMessage("t1", "read", [{ type: "text", text: "a" }]),
			assistantMessage({ content: [{ type: "text", text: "done" }], usage: usage({ input: 1, cacheRead: 1_199 }) }),
			userMessage("turn two"),
		];
		// The newest assistant message is at index 3, so the previous request's
		// prompt ended at index 2 — the tool result — and its length is that
		// message's promptTotal, not an estimate.
		expect(previousRequestTail(messages)).toEqual({ index: 2, tokens: 1_200 });
	});
});

describe("breakpoint placement on the wire", () => {
	test("system and the last tool carry one; earlier tools do not", () => {
		const params = buildAnthropicRequest(MODEL, longCtx());
		expect(cacheControlOf(params.system)).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(params.tools?.[0]?.cache_control).toBeUndefined();
		expect(params.tools?.[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	test("the tail message carries one, and it is the last block of it", () => {
		const params = buildAnthropicRequest(MODEL, longCtx());
		expect(cacheControlOf(params.messages.at(-1)?.content)).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	test("the previous request's tail carries one, on the block that ended that request", () => {
		const context = longCtx({
			messages: [
				userMessage("first"),
				assistantMessage({
					content: [{ type: "toolCall", id: "t1", name: "read", arguments: '{"path":"a"}' }],
					usage: usage({ input: 1, cacheRead: 1_999, output: 10, promptTotal: 2_000 }),
				}),
				toolResultMessage("t1", "read", [{ type: "text", text: "contents" }]),
			],
		});
		const params = buildAnthropicRequest(MODEL, context);
		// The newest assistant message is at neutral index 1, so the previous request
		// ended at index 0 — the user message — and that is where the third
		// breakpoint goes. The fourth is on the tail.
		const wire = params.messages;
		expect(cacheControlOf(wire[0]?.content)).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(cacheControlOf(wire[1]?.content)).toBeUndefined();
		expect(cacheControlOf(wire[2]?.content)).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	test("a mark on a merged run lands on the block it came from, not on the run", () => {
		// The merge means neutral indices and wire indices do not line up — two
		// toolResults become one wire message — so a mark resolved by wire position
		// would land somewhere no request ever ended at.
		const context = longCtx({
			messages: [
				userMessage("first"),
				assistantMessage({
					content: [{ type: "toolCall", id: "t1", name: "read", arguments: "{}" }],
					usage: usage({ input: 1, cacheRead: 2_999, promptTotal: 3_000 }),
				}),
				toolResultMessage("t1", "read", [{ type: "text", text: "a" }]),
				toolResultMessage("t2", "read", [{ type: "text", text: "b" }]),
				assistantMessage({ content: [{ type: "text", text: "done" }], usage: usage({ input: 1, cacheRead: 3_999 }) }),
				userMessage("second"),
			],
		});
		const params = buildAnthropicRequest(MODEL, context);
		// Wire message 2 is the merged run of the two tool results.
		const merged = params.messages[2]?.content as Array<Record<string, unknown>>;
		expect(merged).toHaveLength(2);
		// Neutral index 3 is the second tool result, and it is the last of its run, so
		// the mark belongs on the second block.
		expect(merged[0]?.cache_control).toBeUndefined();
		expect(merged[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		// And the tail mark landed on the last message, not on this one.
		expect(cacheControlOf(params.messages.at(-1)?.content)).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	test("the policy can turn marking off without changing anything else", () => {
		const params = buildAnthropicRequest(MODEL, longCtx(), undefined, { explicit: false, ttl: "1h" });
		expect(cacheControlOf(params.system)).toBeUndefined();
		expect(cacheControlOf(params.messages.at(-1)?.content)).toBeUndefined();
		expect(params.tools?.[1]?.cache_control).toBeUndefined();
		// The message shape does not depend on whether a mark was placed.
		expect(params.messages.at(-1)?.content).toEqual([{ type: "text", text: "u".repeat(8_000) }]);
	});

	test("the requested TTL is the one on every breakpoint", () => {
		const params = buildAnthropicRequest(MODEL, longCtx(), undefined, { explicit: true, ttl: "5m" });
		expect(cacheControlOf(params.system)).toEqual({ type: "ephemeral", ttl: "5m" });
		expect(params.tools?.[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
	});

	test("no ttl field at all when the ladder has fallen that far", () => {
		const params = buildAnthropicRequest(MODEL, longCtx(), undefined, { explicit: true, ttl: undefined });
		expect(cacheControlOf(params.system)).toEqual({ type: "ephemeral" });
	});
});

describe("convertMessages", () => {
	test("consecutive toolResults merge into one user message", () => {
		const messages = [
			userMessage("list files"),
			assistantMessage({
				content: [
					{ type: "toolCall", id: "t1", name: "ls", arguments: "{}" },
					{ type: "toolCall", id: "t2", name: "ls", arguments: "{}" },
				],
				stopReason: "toolUse",
			}),
			toolResultMessage("t1", "ls", [{ type: "text", text: "a" }]),
			toolResultMessage("t2", "ls", [{ type: "text", text: "b" }]),
		];
		const wire = convertMessages(messages);
		expect(wire).toHaveLength(3);
		expect(wire[2]).toEqual({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }] },
				{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "b" }] },
			],
		});
	});

	test("isError flag round-trips on tool_result", () => {
		const wire = convertMessages([toolResultMessage("t9", "bash", [{ type: "text", text: "boom" }], true)]);
		expect((wire[0].content as any[])[0].is_error).toBe(true);
	});

	test("thinking blocks keep signature; empty text dropped", () => {
		const wire = convertMessages([
			assistantMessage({
				content: [
					{ type: "thinking", thinking: "hmm", signature: "sig1" },
					{ type: "text", text: "" },
					{ type: "text", text: "answer" },
				],
				stopReason: "stop",
			}),
		]);
		const content = wire[0].content as any[];
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({ type: "thinking", thinking: "hmm", signature: "sig1" });
	});

	test("a user message is sent as blocks whether or not it carries a breakpoint", () => {
		// The bytes of a message must not depend on whether it happens to be the
		// tail this turn: the message that is marked now is unmarked next turn, and
		// a form that changed with it would be a different prompt.
		const plain = convertMessages([userMessage("hello")]);
		const marked = convertMessages([userMessage("hello")], new Set([0]), { explicit: true, ttl: "1h" });
		expect(plain[0].content).toEqual([{ type: "text", text: "hello" }]);
		expect(marked[0].content).toEqual([
			{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } },
		]);
		// Only the marked block differs — the text itself is identical.
		expect((marked[0].content as any[])[0].text).toBe((plain[0].content as any[])[0].text);
	});

	test("a mark on a many-block message lands on its last block, and only there", () => {
		// A breakpoint caches the prefix through the block it sits on, so a mark on
		// the first block of a twelve-block message covers one twelfth of it. No
		// conversation this app composes reaches this branch — a request always ends
		// with a user or tool-result message, so its tail is a single text block or a
		// run of tool results — but `convertMessages` is exported and takes whatever
		// indices it is handed, and this is the invariant that makes them safe:
		// wherever a mark is put on a message, the message ends up covered.
		const images: UserContent[] = [
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
			{ type: "text", text: "three" },
		];
		const user = convertMessages([userMessage(images)], new Set([0]), { explicit: true, ttl: "5m" });
		expect(user[0].content).toEqual([
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
			{ type: "text", text: "three", cache_control: { type: "ephemeral", ttl: "5m" } },
		]);

		const assistant = convertMessages(
			[
				assistantMessage({
					content: [
						{ type: "toolCall", id: "t1", name: "ls", arguments: "{}" },
						{ type: "toolCall", id: "t2", name: "ls", arguments: "{}" },
					],
					stopReason: "toolUse",
				}),
			],
			new Set([0]),
			{ explicit: true, ttl: "5m" },
		);
		const blocks = assistant[0].content as any[];
		expect(blocks[0]?.cache_control).toBeUndefined();
		expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
	});

	test("an empty user message keeps its bare form", () => {
		// There is no block to attach a breakpoint to, and an empty text block is not
		// something the API accepts.
		expect(convertMessages([userMessage("")])[0].content).toBe("");
	});

	test("tool_use input is sent as an object, not as the model's JSON text", () => {
		// `ToolCall.arguments` is a string. The API's schema wants an object, so a
		// transcript containing a tool call could not be replayed at all while this
		// was passed through unchanged.
		const wire = convertMessages([
			assistantMessage({
				content: [{ type: "toolCall", id: "t1", name: "write", arguments: '{"path":"a.txt","text":"hi"}' }],
				stopReason: "toolUse",
			}),
		]);
		const block = (wire[0].content as any[])[0];
		expect(block.input).toEqual({ path: "a.txt", text: "hi" });
		expect(typeof block.input).toBe("object");
	});

	test("a malformed tool_use payload becomes an empty object rather than a string", () => {
		// Same parse as the dispatcher uses: the shape the API requires, even when
		// the text was not JSON. There is nothing else to send.
		const wire = convertMessages([
			assistantMessage({
				content: [{ type: "toolCall", id: "t1", name: "write", arguments: "{not json" }],
				stopReason: "toolUse",
			}),
		]);
		expect((wire[0].content as any[])[0].input).toEqual({});
	});
});

describe("mapAnthropicStream", () => {
	async function* raw(events: any[]) {
		for (const e of events) yield e;
	}

	test("plain text response maps to full event sequence", async () => {
		const events = await collect(
			mapAnthropicStream(
				raw([
					{
						type: "message_start",
						message: { usage: { input_tokens: 10, output_tokens: 1 } },
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
					{ type: "message_stop" },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);

		const done = events.at(-1) as any;
		expect(done.message.stopReason).toBe("stop");
		expect(done.message.usage).toMatchObject({ input: 10, output: 3 });
		expect(done.message.content[0]).toEqual({ type: "text", text: "Hello" });
	});

	test("promptTotal covers the cached prefix that input leaves out", async () => {
		// The whole request was 10k tokens; only 400 of them missed the cache.
		// `input` alone would describe a session that is 96% smaller than it is.
		const events = await collect(
			mapAnthropicStream(
				raw([
					{
						type: "message_start",
						message: {
							usage: { input_tokens: 400, cache_read_input_tokens: 9_600, cache_creation_input_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" } },
					{ type: "message_stop" },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		const done = events.at(-1) as any;
		expect(done.message.usage).toMatchObject({ input: 400, cacheRead: 9_600, promptTotal: 10_000 });
	});

	test("tool_use with fragmented JSON deltas reassembles once", async () => {
		const events = await collect(
			mapAnthropicStream(
				raw([
					{ type: "message_start", message: { usage: { input_tokens: 5 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "write" } },
					{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path"' } },
					{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"a.txt"}' } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" } },
					{ type: "message_stop" },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
		const end = events.find((e) => e.type === "toolcall_end") as any;
		expect(end.toolCall).toEqual({
			type: "toolCall",
			id: "tu_1",
			name: "write",
			arguments: '{"path":"a.txt"}',
		});
		const done = events.at(-1) as any;
		expect(done.message.stopReason).toBe("toolUse");
	});

	test("in-stream error event becomes terminal error, not a throw", async () => {
		const events = await collect(
			mapAnthropicStream(
				raw([
					{ type: "message_start", message: {} },
					{ type: "error", error: { message: "overloaded" } },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		expect(events.at(-1)?.type).toBe("error");
		expect((events.at(-1) as any).message.errorMessage).toBe("overloaded");
	});

	test("an in-stream refusal for size is tagged, so it is not replayed", async () => {
		// An in-stream error never becomes a throw, so the retry layer above cannot
		// classify it — and an untagged error is treated as an ordinary failure:
		// retried, then replayed against every model in the fallback chain.
		const events = await collect(
			mapAnthropicStream(
				raw([
					{ type: "message_start", message: {} },
					{ type: "error", error: { message: "prompt is too long: 250000 tokens > 200000 maximum" } },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		const terminal = events.at(-1) as any;
		expect(terminal.message.errorKind).toBe("context_overflow");

		const ordinary = await collect(
			mapAnthropicStream(
				raw([
					{ type: "message_start", message: {} },
					{ type: "error", error: { message: "overloaded_error" } },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		expect((ordinary.at(-1) as any).message.errorKind).toBeUndefined();
	});

	test("signature_delta attaches to the thinking block at close (extended thinking round-trip)", async () => {
		const events = await collect(
			mapAnthropicStream(
				raw([
					{ type: "message_start", message: {} },
					{ type: "content_block_start", index: 0, content_block: { type: "thinking" } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
					{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig9" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "content_block_start", index: 1, content_block: { type: "text" } },
					{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ans" } },
					{ type: "content_block_stop", index: 1 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" } },
					{ type: "message_stop" },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		const done = events.at(-1) as any;
		expect(done.type).toBe("done");
		const thinking = done.message.content.find((b: any) => b.type === "thinking");
		expect(thinking.signature).toBe("sig9");
		expect(thinking.thinking).toBe("hmm");
	});

	test("tool_use with inline input object (no deltas) still yields a complete call", async () => {
		const events = await collect(
			mapAnthropicStream(
				raw([
					{ type: "message_start", message: {} },
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tu_9", name: "write", input: { path: "a.txt" } },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" } },
					{ type: "message_stop" },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		const end = events.find((e) => e.type === "toolcall_end") as any;
		expect(JSON.parse(end.toolCall.arguments)).toEqual({ path: "a.txt" });
	});

	test("redacted_thinking blocks pass through without crashing", async () => {
		const events = await collect(
			mapAnthropicStream(
				raw([
					{ type: "message_start", message: {} },
					{ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "xx" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "content_block_start", index: 1, content_block: { type: "text" } },
					{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
					{ type: "content_block_stop", index: 1 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" } },
					{ type: "message_stop" },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("the write-TTL split is carried through when the provider reports one", async () => {
		// The only evidence that a one-hour TTL took effect: `cacheWrite` is the same
		// number whether the entry was written for five minutes or sixty.
		const events = await collect(
			mapAnthropicStream(
				raw([
					{
						type: "message_start",
						message: {
							usage: {
								input_tokens: 10,
								cache_read_input_tokens: 900,
								cache_creation_input_tokens: 400,
								cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 400 },
							},
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" } },
					{ type: "message_stop" },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		const usage = (events.at(-1) as any).message.usage;
		expect(usage.cacheWriteTtl).toEqual({ "5m": 0, "1h": 400 });
		expect(usage.cacheWrite).toBe(400);
	});

	test("no split is invented when the provider does not report one", async () => {
		const events = await collect(
			mapAnthropicStream(
				raw([
					{ type: "message_start", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 100 } } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" } },
					{ type: "message_stop" },
				]),
				"anthropic",
				"claude-sonnet-5",
			),
		);
		expect((events.at(-1) as any).message.usage.cacheWriteTtl).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// The TTL ladder
// ---------------------------------------------------------------------------

function statusError(status: number, message: string): Error {
	const error = new Error(message) as Error & { status: number };
	error.status = status;
	return error;
}

/** A complete, minimal response, so the mapper has something to walk. */
async function* okStream(): AsyncGenerator<Record<string, unknown>, void, unknown> {
	yield { type: "message_start", message: { usage: { input_tokens: 5 } } };
	yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
	yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
	yield { type: "content_block_stop", index: 0 };
	yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
	yield { type: "message_stop" };
}

/**
 * A client that records each request and answers with whatever the test says.
 *
 * The real thing is one object per request too — `createAnthropicStreamFn` builds
 * a client per call — so a factory here is the shape, not a simplification.
 */
function fakeClient(
	answer: (params: Record<string, unknown>, call: number) => AsyncIterable<unknown>,
): () => AnthropicClientLike {
	let call = 0;
	return () => ({
		messages: {
			create: async (params: Record<string, unknown>) => {
				call++;
				return answer(params, call);
			},
		},
	});
}

describe("createAnthropicStreamFn — the TTL ladder", () => {
	test("asks for the long TTL first", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const streamFn = createAnthropicStreamFn({
			clientFactory: fakeClient((params) => {
				seen.push(params);
				return okStream();
			}),
		});
		const events = await collect(streamFn(MODEL, longCtx()));
		expect(events.at(-1)?.type).toBe("done");
		expect(seen).toHaveLength(1);
		expect(cacheControlOf(seen[0]?.system)).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	test("a refused TTL is retried at the short one and reported once", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const notices: unknown[] = [];
		const streamFn = createAnthropicStreamFn({
			onCacheNotice: (notice) => notices.push(notice),
			clientFactory: fakeClient((params, call) => {
				seen.push(params);
				if (call === 1) throw statusError(400, "cache_control.ttl: unknown field");
				return okStream();
			}),
		});
		const events = await collect(streamFn(MODEL, longCtx()));
		expect(events.at(-1)?.type).toBe("done");
		expect(seen).toHaveLength(2);
		expect(cacheControlOf(seen[0]?.system)).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(cacheControlOf(seen[1]?.system)).toEqual({ type: "ephemeral", ttl: "5m" });
		expect(notices).toEqual([
			{ kind: "ttl-downgrade", from: "1h", to: "5m", reason: "cache_control.ttl: unknown field" },
		]);
	});

	test("the fallback is remembered by the next request", async () => {
		// Re-learning it per request would mean paying a failed request to be told
		// the same thing on every turn.
		const ttls: unknown[] = [];
		const streamFn = createAnthropicStreamFn({
			clientFactory: fakeClient((params, call) => {
				ttls.push(cacheControlOf(params.system));
				if (call === 1) throw statusError(400, "ttl is not supported");
				return okStream();
			}),
		});
		await collect(streamFn(MODEL, longCtx()));
		await collect(streamFn(MODEL, longCtx()));
		expect(ttls).toEqual([
			{ type: "ephemeral", ttl: "1h" },
			{ type: "ephemeral", ttl: "5m" },
			{ type: "ephemeral", ttl: "5m" },
		]);
	});

	test("a second refusal drops the field entirely rather than failing the turn", async () => {
		const ttls: unknown[] = [];
		const notices: Array<{ to: unknown }> = [];
		const streamFn = createAnthropicStreamFn({
			onCacheNotice: (notice) => notices.push(notice),
			clientFactory: fakeClient((params, call) => {
				ttls.push(cacheControlOf(params.system));
				if (call < 3) throw statusError(400, "unexpected field cache_control");
				return okStream();
			}),
		});
		const events = await collect(streamFn(MODEL, longCtx()));
		expect(events.at(-1)?.type).toBe("done");
		expect(ttls).toEqual([{ type: "ephemeral", ttl: "1h" }, { type: "ephemeral", ttl: "5m" }, { type: "ephemeral" }]);
		expect(notices.map((notice) => notice.to)).toEqual(["5m", undefined]);
	});

	test("a policy asking for the short TTL never tries the long one", async () => {
		const ttls: unknown[] = [];
		const streamFn = createAnthropicStreamFn({
			policy: { ttl: "5m" },
			clientFactory: fakeClient((params) => {
				ttls.push(cacheControlOf(params.system));
				return okStream();
			}),
		});
		await collect(streamFn(MODEL, longCtx()));
		expect(ttls).toEqual([{ type: "ephemeral", ttl: "5m" }]);
	});

	test("a 400 that does not mention the cache is not retried", async () => {
		// The line between "the provider does not take our cache settings" and "the
		// request is malformed" is the wording, and guessing it wrong turns a real
		// error into a silent one.
		let calls = 0;
		const streamFn = createAnthropicStreamFn({
			clientFactory: fakeClient(() => {
				calls++;
				throw statusError(400, "messages.0.content: expected an array");
			}),
		});
		await expect(collect(streamFn(MODEL, longCtx()))).rejects.toThrow("expected an array");
		expect(calls).toBe(1);
	});

	test("a refusal for any other status is not a cache problem", async () => {
		let calls = 0;
		const streamFn = createAnthropicStreamFn({
			clientFactory: fakeClient(() => {
				calls++;
				throw statusError(500, "cache is on fire");
			}),
		});
		await expect(collect(streamFn(MODEL, longCtx()))).rejects.toThrow("cache is on fire");
		expect(calls).toBe(1);
	});

	test("no cache settings are sent at all when the policy turns marking off", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const streamFn = createAnthropicStreamFn({
			policy: { explicitBreakpoints: false },
			clientFactory: fakeClient((params) => {
				seen.push(params);
				return okStream();
			}),
		});
		await collect(streamFn(MODEL, longCtx()));
		expect(cacheControlOf(seen[0]?.system)).toBeUndefined();
		expect(cacheControlOf(seen[0]?.messages && (seen[0].messages as any[]).at(-1)?.content)).toBeUndefined();
	});
});
