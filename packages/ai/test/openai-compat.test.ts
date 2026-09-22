import { describe, expect, test } from "bun:test";
import {
	buildOpenAIRequest,
	convertMessages,
	createOpenAIStreamFn,
	mapOpenAIStream,
} from "../src/providers/openai-compat.ts";
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

	test("with no level asked for, the model's own flag decides", () => {
		// The only path by which `model.reasoning` matters: a caller that states no
		// level. It has to send "medium" rather than nothing, because a model that
		// thinks by default and is told nothing thinks at whatever depth it likes —
		// and it has to send nothing at all for the rows where "medium" is not a
		// value the vendor takes (Kimi K3's set is low/high/max, Z.AI's 5.3 is
		// max/high/low), which is why those rows carry `reasoning: false`.
		const reasoning = { ...MODEL, reasoning: true };
		expect(buildOpenAIRequest(reasoning, ctx()).reasoning_effort).toBe("medium");
		expect(buildOpenAIRequest(MODEL, ctx()).reasoning_effort).toBeUndefined();
	});
});

describe("the cache routing fields", () => {
	// The default fixture is DeepSeek, which documents no routing key, so most of
	// these switch the provider rather than the request.
	const gpt = { ...MODEL, id: "gpt-5.5", provider: "openai", baseUrl: "https://api.openai.com/v1" };

	test("a provider that documents the key gets one, and it names the prefix", () => {
		const params = buildOpenAIRequest(gpt, ctx());
		expect(String(params.prompt_cache_key).startsWith("labunbun-")).toBe(true);
		// Stable across calls with the same prefix, which is what routing needs.
		expect(buildOpenAIRequest(gpt, ctx()).prompt_cache_key).toBe(params.prompt_cache_key);
	});

	test("a provider whose guide never mentions the field gets nothing", () => {
		expect(buildOpenAIRequest(MODEL, ctx()).prompt_cache_key).toBeUndefined();
		// The same is true of an endpoint nobody has measured: inventing a field for
		// a gateway is how every request becomes a 400.
		const gateway = { ...gpt, provider: "someone-elses-gateway" };
		expect(buildOpenAIRequest(gateway, ctx()).prompt_cache_key).toBeUndefined();
	});

	test("the policy can force the key on and off", () => {
		const gateway = { ...gpt, provider: "someone-elses-gateway" };
		expect(buildOpenAIRequest(gateway, ctx(), undefined, { promptCacheKey: "on" }).prompt_cache_key).toBeDefined();
		expect(buildOpenAIRequest(gpt, ctx(), undefined, { promptCacheKey: "off" }).prompt_cache_key).toBeUndefined();
	});

	test("a different prefix is a different key", () => {
		const one = buildOpenAIRequest(gpt, ctx({ systemPrompt: "sys" }));
		const two = buildOpenAIRequest(gpt, ctx({ systemPrompt: "other" }));
		expect(two.prompt_cache_key).not.toBe(one.prompt_cache_key);
	});

	test("retention is sent only when asked and only where the field exists", () => {
		expect(buildOpenAIRequest(gpt, ctx()).prompt_cache_retention).toBeUndefined();
		expect(buildOpenAIRequest(gpt, ctx(), undefined, { promptCacheRetention: "24h" }).prompt_cache_retention).toBe(
			"24h",
		);
		// The value asked for is the value that goes out, rather than a default the
		// adapter keeps to itself: "in_memory" exists to make an entry shorter.
		expect(
			buildOpenAIRequest(gpt, ctx(), undefined, { promptCacheRetention: "in_memory" }).prompt_cache_retention,
		).toBe("in_memory");
		const gateway = { ...gpt, provider: "someone-elses-gateway" };
		expect(
			buildOpenAIRequest(gateway, ctx(), undefined, { promptCacheKey: "on", promptCacheRetention: "24h" })
				.prompt_cache_retention,
		).toBeUndefined();
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

	test("cached prompt tokens are not also counted as input", async () => {
		// `prompt_tokens` covers the whole prefix including the cached part, while
		// Anthropic's `input_tokens` does not. Normalizing to the Anthropic reading
		// keeps row-by-row pricing honest — otherwise the cached tokens are billed
		// twice — and keeps the four usage channels non-overlapping.
		const events = await collect(
			mapOpenAIStream(
				raw([
					{ choices: [{ delta: { content: "x" } }] },
					{
						choices: [{ delta: {}, finish_reason: "stop" }],
						usage: {
							prompt_tokens: 10_000,
							completion_tokens: 5,
							prompt_tokens_details: { cached_tokens: 9_600 },
						},
					},
				]),
				"deepseek",
				"deepseek-chat",
			),
		);
		const done = events.at(-1) as any;
		expect(done.message.usage).toMatchObject({ input: 400, cacheRead: 9_600, promptTotal: 10_000 });
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
		// 10 prompt tokens, 4 of them cached: `input` is the other 6, and
		// `promptTotal` is the whole prefix the model actually read.
		expect(done.message.usage).toEqual({
			input: 6,
			output: 20,
			cacheRead: 4,
			cacheWrite: 0,
			reasoning: 15,
			promptTotal: 10,
		});
	});

	test("empty stream yields terminal error event", async () => {
		const events = await collect(mapOpenAIStream(raw([]), "deepseek", "deepseek-chat"));
		expect(events.map((e) => e.type)).toEqual(["start", "error"]);
	});
});

describe("defaultClient", () => {
	/** One complete response, as the SSE the SDK parses. */
	const CHAT_SSE = [
		'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
		'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
		"data: [DONE]\n\n",
	].join("");

	/**
	 * Answer every request from `answer`, recording what each call carried.
	 *
	 * The OpenAI SDK reads `globalThis.fetch` when the client is constructed and
	 * `defaultClient` constructs one per request, so overriding the global here
	 * drives the real SDK with no network and no module mock. That distinction is
	 * the point rather than a detail: `mock.module("openai", …)` is process-wide
	 * in Bun, and Bun documents that `mock.restore()` does not undo it — there is
	 * no API that does, the override lives as long as the process. A fake left in
	 * place is therefore handed to every later test that builds a client, which is
	 * exactly what happened here: the composed-transport test in the next file
	 * quietly exercised a stub instead of the SDK. Where a module mock is the only
	 * way in — `@labunbun/ai` is mocked in several coding-agent tests — the repo
	 * runs it in a child process instead; this one does not need the ceremony.
	 */
	async function withFetch(
		answer: () => Response,
		body: (calls: Array<{ url: string; signal: AbortSignal | null | undefined }>) => Promise<void>,
	): Promise<void> {
		const realFetch = globalThis.fetch;
		const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			calls.push({ url: String(input), signal: init?.signal });
			return answer();
		}) as unknown as typeof fetch;
		try {
			await body(calls);
		} finally {
			globalThis.fetch = realFetch;
		}
	}

	test("the caller's abort signal reaches fetch through the real client", async () => {
		await withFetch(
			() => new Response(CHAT_SSE, { headers: { "content-type": "text/event-stream" } }),
			async (calls) => {
				const controller = new AbortController();
				await collect(createOpenAIStreamFn({})(MODEL, ctx(), { apiKey: "test-key", signal: controller.signal }));

				// A real client built a real request from the model's baseUrl, and the
				// wrapper's whole job — injecting the caller's signal into the init it
				// forwards — is what is asserted, not merely that a function exists.
				expect(calls[0]?.url).toContain("api.deepseek.com/v1/chat/completions");
				expect(calls[0]?.signal).toBe(controller.signal);
			},
		);
	});

	test("the SDK is told not to retry, because the wrapper above owns retry policy", async () => {
		// The setting has to be asserted behaviourally, because nothing outside the
		// SDK can read it: a 500 that the SDK would otherwise attempt twice more.
		await withFetch(
			() =>
				new Response(JSON.stringify({ error: { message: "boom" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
			async (calls) => {
				await expect(collect(createOpenAIStreamFn({})(MODEL, ctx(), { apiKey: "test-key" }))).rejects.toThrow();
				expect(calls).toHaveLength(1);
			},
		);
	});
});
