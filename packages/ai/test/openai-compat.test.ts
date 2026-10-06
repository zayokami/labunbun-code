import { describe, expect, test } from "bun:test";
import { resolveModel } from "../src/model.ts";
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

describe("a model that needs an effort of its own to keep its tools", () => {
	// `gpt-6-sol` / `gpt-6-luna` as the table declares them. Shaped like the real
	// rows so the wire behaviour is what a shipped row gets, with a DeepSeek base
	// URL so nothing here can reach a network by accident.
	const SOL: Model = {
		...MODEL,
		id: "gpt-6-sol",
		provider: "openai",
		reasoning: true,
		toolReasoningEffort: "none",
	};
	const TOOLS = [{ name: "read", description: "d", parameters: { type: "object" as const, properties: {} } }];

	test("the level the session asked for does not go out, the model's does", () => {
		// The failure this field exists for is not an error. The turn comes back
		// with no `tool_calls` in it, so the agent stops acting and the run reads as
		// a model that ignored its tools — with nothing in the response to say so.
		// "high" and "medium" are the two settings that lose them: one is a depth
		// the model has tools at, the other is its own default.
		for (const level of ["low", "medium", "high"] as const) {
			const params = buildOpenAIRequest(SOL, ctx({ tools: TOOLS }), { thinkingLevel: level });
			expect(params.reasoning_effort).toBe("none");
			// The tools still go out, which is what makes this worth protecting.
			expect(params.tools).toHaveLength(1);
			expect(params.tool_choice).toBe("auto");
		}
	});

	test("with no tools on the request, the level asked for is what goes out", () => {
		// The guard is `context.tools`, not "the model has tools available". A
		// tool-less request has nothing to protect, and pinning "none" there would
		// throw away the depth the session bought for a turn that could carry it.
		expect(buildOpenAIRequest(SOL, ctx(), { thinkingLevel: "high" }).reasoning_effort).toBe("high");
		expect(buildOpenAIRequest(SOL, ctx(), { thinkingLevel: "off" }).reasoning_effort).toBeUndefined();
		// An empty array is not a request with tools: it goes out as no tools.
		expect(buildOpenAIRequest(SOL, ctx({ tools: [] }), { thinkingLevel: "high" }).reasoning_effort).toBe("high");
	});

	test("a model that names no effort keeps the level it was given", () => {
		// The control, and it is why this is a row's field rather than a provider's.
		// `gpt-6-astra` is the same tier and the same generation; its page does not
		// publish the constraint, and "none" is not one of its efforts at all — so a
		// default applied by provider would send it a value it rejects.
		const astra = { ...SOL, toolReasoningEffort: undefined };
		expect(buildOpenAIRequest(astra, ctx({ tools: TOOLS }), { thinkingLevel: "high" }).reasoning_effort).toBe("high");
		expect(buildOpenAIRequest(astra, ctx({ tools: TOOLS })).reasoning_effort).toBe("medium");
	});

	test("a model that rejects the value cannot be given it, so its request goes out as asked", () => {
		// The other reason this is a row's field, and the one that is not a silent
		// loss. Astra simply has no constraint; GPT-6.1 Sol is in the opposite
		// position — it supports `low`/`medium`/`high`/`xhigh`/`max` and says
		// outright that `none` and `minimal` are not supported efforts, so the
		// value that rescues Sol and Luna would be a 400 here. The table therefore
		// leaves the field off, and the request goes out asking for the depth the
		// session wanted, which is the best a row can do on a model that has taken
		// tool calling to the Responses API and left Chat Completions to the
		// tool-less requests.
		//
		// Read from the shipped row rather than restated as a fixture, so that
		// adding `toolReasoningEffort: "none"` to `openai/gpt-6.1-sol` fails here
		// and not only in the catalog test.
		const point = resolveModel("openai/gpt-6.1-sol");
		expect(point).toBeDefined();
		expect(point?.toolReasoningEffort).toBeUndefined();
		for (const level of ["low", "medium", "high"] as const) {
			const params = buildOpenAIRequest(point as Model, ctx({ tools: TOOLS }), { thinkingLevel: level });
			// Never the rescue value, and never one the vendor does not take.
			expect(params.reasoning_effort).toBe(level);
		}
		// The three levels above are the whole vocabulary this adapter can put on
		// the wire, and they are a subset of the five the model takes
		// (`low`/`medium`/`high`/`xhigh`/`max`) — so leaving the field unset cannot
		// send it a value it rejects. The other direction is a ceiling rather than
		// a bug: `xhigh` and `max` are reachable on this model and `ThinkingLevel`
		// has no word for either, which is true of every reasoning row here.
		//
		// The tools still go out, and the row says nothing about them. What
		// happens next is OpenAI's: the request is well-formed, and the turn comes
		// back without `tool_calls` on this wire.
		expect(buildOpenAIRequest(point as Model, ctx({ tools: TOOLS })).tools).toHaveLength(1);
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

	test("an unrecognized finish reason is named as an error, not passed off as a stop", async () => {
		// A reason the map does not know is not a normal finish. Filing it as
		// "stop" reports an unknown outcome as a successful turn; naming the
		// value is what turns a mystery into a bug report.
		const events = await collect(
			mapOpenAIStream(
				raw([
					{ choices: [{ delta: { content: "partial answer" } }] },
					{ choices: [{ delta: {}, finish_reason: "some_future_reason" }] },
				]),
				"deepseek",
				"deepseek-chat",
			),
		);
		const done = events.at(-1) as any;
		expect(done.type).toBe("done");
		expect(done.message.stopReason).toBe("error");
		expect(done.message.errorMessage).toBe("Unrecognized finish reason: some_future_reason");
	});

	test("a content-filtered response is a refusal, not a silent stop", async () => {
		// Same turn the Anthropic wire names with its own stop reason: no
		// content, and the reason is the only thing that keeps it from being
		// read as an empty successful reply.
		const events = await collect(
			mapOpenAIStream(
				raw([{ choices: [{ delta: {}, finish_reason: "content_filter" }] }]),
				"deepseek",
				"deepseek-chat",
			),
		);
		expect((events.at(-1) as any).message.stopReason).toBe("refusal");
	});

	test("eos and eos_token are normal stops, not unknown reasons", async () => {
		// Real terminal values from TGI-style clones. Every unmapped reason is
		// an error now, so these entries are what keeps the strictness from
		// misfiring on a provider that was working.
		const eos = await collect(
			mapOpenAIStream(
				raw([{ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "eos" }] }]),
				"tgi-clone",
				"llama",
			),
		);
		expect((eos.at(-1) as any).message.stopReason).toBe("stop");

		const eosToken = await collect(
			mapOpenAIStream(raw([{ choices: [{ delta: {}, finish_reason: "eos_token" }] }]), "tgi-clone", "llama"),
		);
		expect((eosToken.at(-1) as any).message.stopReason).toBe("stop");
	});

	test("a stream that never states a finish reason keeps the documented stop guess", async () => {
		// Not an oversight. The SDK consumes the `[DONE]` sentinel before the
		// mapper sees it, so a clean end and a proxy that dropped the
		// connection after the last content chunk look identical here. "stop"
		// is what the sentinel would have confirmed, and the content arrived.
		const events = await collect(
			mapOpenAIStream(raw([{ choices: [{ delta: { content: "ok" } }] }]), "deepseek", "deepseek-chat"),
		);
		expect((events.at(-1) as any).message.stopReason).toBe("stop");
	});

	test("empty stream yields terminal error event, with no start to un-say", async () => {
		// No start in front of the error: start marks the first wire event, and
		// a stream that never produced one never started. Emitting it eagerly
		// would also make an accepted-then-silent connection look mid-stream to
		// the retry layer, which refuses to retry anything after a first event.
		const events = await collect(mapOpenAIStream(raw([]), "deepseek", "deepseek-chat"));
		expect(events.map((e) => e.type)).toEqual(["error"]);
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

	test("the caller's abort reaches the request and the SDK's own signal is not overwritten", async () => {
		await withFetch(
			() => new Response(CHAT_SSE, { headers: { "content-type": "text/event-stream" } }),
			async (calls) => {
				const controller = new AbortController();
				await collect(createOpenAIStreamFn({})(MODEL, ctx(), { apiKey: "test-key", signal: controller.signal }));

				// A real client built a real request from the model's baseUrl.
				expect(calls[0]?.url).toContain("api.deepseek.com/v1/chat/completions");
				const forwarded = calls[0]?.signal;
				expect(forwarded).toBeDefined();
				// The SDK hands the fetch hook its own controller's signal — the one
				// its timeout timer aborts through — and identity with the caller's
				// is exactly the bug: forwarding the caller's alone detaches that
				// timer, and a request that can never time out is a hang with no
				// ceiling. The composition must still stop when the caller aborts.
				expect(forwarded).not.toBe(controller.signal);
				expect(forwarded?.aborted).toBe(false);
				controller.abort();
				expect(forwarded?.aborted).toBe(true);
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
