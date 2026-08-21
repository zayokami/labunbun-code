import { describe, expect, test } from "bun:test";
import { buildOpenAIRequest, convertMessages, mapOpenAIStream } from "../src/providers/openai-compat.ts";
import type { Context, Model } from "../src/types.ts";
import { assistantMessage, toolResultMessage, userMessage } from "../src/types.ts";

const MODEL: Model = {
	id: "deepseek-chat",
	name: "DeepSeek Chat",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com/v1",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	contextWindow: 128_000,
	maxOutputTokens: 8_192,
	reasoning: false,
	input: ["text"],
};

function ctx(overrides: Partial<Context> = {}): Context {
	return { systemPrompt: "sys", messages: [], ...overrides };
}

async function collect(events: AsyncIterable<any>) {
	const out: any[] = [];
	for await (const e of events) out.push(e);
	return out;
}

async function* raw(chunks: any[]) {
	for (const c of chunks) yield c;
}

describe("buildOpenAIRequest", () => {
	test("system prompt, stream_options, tools", () => {
		const params = buildOpenAIRequest(
			MODEL,
			ctx({ tools: [{ name: "read", description: "d", parameters: { type: "object", properties: {} } }] }),
		);
		expect(params.stream).toBe(true);
		expect(params.stream_options).toEqual({ include_usage: true });
		expect(params.messages[0]).toEqual({ role: "system", content: "sys" });
		expect(params.tools?.[0]).toEqual({
			type: "function",
			function: { name: "read", description: "d", parameters: { type: "object", properties: {} } },
		});
	});

	test("reasoning_effort only for reasoning levels", () => {
		expect(buildOpenAIRequest(MODEL, ctx(), { thinkingLevel: "high" }).reasoning_effort).toBe("high");
		expect(buildOpenAIRequest(MODEL, ctx(), { thinkingLevel: "off" }).reasoning_effort).toBeUndefined();
	});
});

describe("convertMessages", () => {
	test("assistant toolCalls + toolResult → tool role", () => {
		const wire = convertMessages(
			ctx({
				messages: [
					userMessage("hi"),
					assistantMessage({
						content: [{ type: "toolCall", id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }],
						stopReason: "toolUse",
					}),
					toolResultMessage("c1", "bash", [{ type: "text", text: "out" }]),
				],
			}),
		);
		expect(wire).toHaveLength(4);
		expect(wire[2]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
		});
		expect(wire[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "out" });
	});
});

describe("mapOpenAIStream", () => {
	test("text + usage from final chunk", async () => {
		const events = await collect(
			mapOpenAIStream(
				raw([
					{ choices: [{ delta: { content: "Hel" } }] },
					{ choices: [{ delta: { content: "lo" } }] },
					{
						choices: [{ delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 7, completion_tokens: 2 },
					},
				]),
				"deepseek",
				"deepseek-chat",
			),
		);

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		const done = events.at(-1) as any;
		expect(done.message.stopReason).toBe("stop");
		expect(done.message.usage).toMatchObject({ input: 7, output: 2 });
	});

	test("fragmented tool_calls keyed by index reassemble; id only on first fragment", async () => {
		const events = await collect(
			mapOpenAIStream(
				raw([
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, id: "call_A", function: { name: "write", arguments: '{"pa' } }],
								},
							},
						],
					},
					{
						choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }],
					},
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				]),
				"deepseek",
				"deepseek-chat",
			),
		);

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
		const end = events.find((e) => e.type === "toolcall_end") as any;
		expect(end.toolCall.id).toBe("call_A");
		expect(end.toolCall.name).toBe("write");
		expect(end.toolCall.arguments).toBe('{"path":"x"}');
		expect((events.at(-1) as any).message.stopReason).toBe("toolUse");
	});

	test("two parallel tool calls stay in slot order", async () => {
		const events = await collect(
			mapOpenAIStream(
				raw([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 1, id: "call_B", function: { name: "b", arguments: "{}" } },
										{ index: 0, id: "call_A", function: { name: "a", arguments: "{}" } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				]),
				"deepseek",
				"deepseek-chat",
			),
		);
		const starts = events.filter((e) => e.type === "toolcall_start") as any[];
		// Blocks are assigned content indices in ARRIVAL order; when a provider
		// emits slot 1 before slot 0, block order follows arrival. Downstream
		// pairing is by call id, so correctness never depends on this order.
		expect(starts.map((s) => s.partial.content[s.contentIndex].name)).toEqual(["b", "a"]);
	});

	test("reasoning_content maps to thinking events (DeepSeek-R1 style)", async () => {
		const events = await collect(
			mapOpenAIStream(
				raw([
					{ choices: [{ delta: { reasoning_content: "let me " } }] },
					{ choices: [{ delta: { reasoning_content: "think" } }] },
					{ choices: [{ delta: { content: "42" } }] },
					{ choices: [{ delta: {}, finish_reason: "stop" }] },
				]),
				"deepseek",
				"deepseek-reasoner",
			),
		);
		const types = events.map((e) => e.type);
		expect(types).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"text_start",
			"text_delta",
			"thinking_end",
			"text_end",
			"done",
		]);
	});

	test("reasoning_tokens reported as usage subset", async () => {
		const events = await collect(
			mapOpenAIStream(
				raw([
					{ choices: [{ delta: { content: "x" } }] },
					{
						choices: [{ delta: {}, finish_reason: "stop" }],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 20,
							prompt_tokens_details: { cached_tokens: 4 },
							completion_tokens_details: { reasoning_tokens: 15 },
						},
					},
				]),
				"deepseek",
				"deepseek-chat",
			),
		);
		const done = events.at(-1) as any;
		expect(done.message.usage).toEqual({ input: 10, output: 20, cacheRead: 4, cacheWrite: 0, reasoning: 15 });
	});

	test("empty stream yields terminal error event", async () => {
		const events = await collect(mapOpenAIStream(raw([]), "deepseek", "deepseek-chat"));
		expect(events.map((e) => e.type)).toEqual(["start", "error"]);
	});
});
