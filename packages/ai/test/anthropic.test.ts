import { describe, expect, test } from "bun:test";
import { buildAnthropicRequest, convertMessages, mapAnthropicStream } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";
import { assistantMessage, toolResultMessage, userMessage } from "../src/types.ts";

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
	test("basic shape with system cache breakpoint", () => {
		const params = buildAnthropicRequest(MODEL, ctx());
		expect(params.model).toBe("claude-sonnet-5");
		expect(params.stream).toBe(true);
		expect(params.max_tokens).toBe(64_000);
		expect(params.system).toEqual([{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }]);
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
});
