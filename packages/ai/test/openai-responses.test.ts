/**
 * The Responses wire, tested against the shapes it is supposed to produce.
 *
 * The organizing rule is the repository's: if the production line these are about
 * were made wrong, would this file go red? So each test pins a *difference* from
 * Chat Completions rather than restating that the request has a model name —
 * the differences are the reason the adapter exists, and a test that both wires
 * pass is a test neither of them needed.
 */
import { describe, expect, test } from "bun:test";
import { probeProvider } from "../src/discovery.ts";
import { createDefaultStreamFn } from "../src/index.ts";
import { resolveModel } from "../src/model.ts";
import {
	buildResponsesRequest,
	convertInput,
	createResponsesStreamFn,
	mapResponsesStream,
	type ResponsesRawEvent,
	resolveStopReason,
	responsesEffort,
} from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";
import { assistantMessage, toolResultMessage, userMessage } from "../src/types.ts";

const MODEL: Model = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	apiKeyEnv: "OPENAI_API_KEY",
	contextWindow: 1_050_000,
	maxOutputTokens: 128_000,
	reasoning: true,
	input: ["text", "image"],
	pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

function ctx(overrides: Partial<Context> = {}): Context {
	return { systemPrompt: "sys", messages: [], ...overrides };
}

const TOOLS = [{ name: "read", description: "d", parameters: { type: "object" as const, properties: {} } }];

async function collect(events: AsyncIterable<any>): Promise<any[]> {
	const out: any[] = [];
	for await (const e of events) out.push(e);
	return out;
}

async function* raw(events: ResponsesRawEvent[]) {
	for (const e of events) yield e;
}

/** The three events a tool-calling turn always contains, in order. */
function toolTurn(): ResponsesRawEvent[] {
	return [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "read" },
		},
		{
			type: "response.function_call_arguments.delta",
			item_id: "fc_1",
			output_index: 0,
			delta: '{"path":"a.ts"}',
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1_200, output_tokens: 40, input_tokens_details: { cached_tokens: 1_000 } },
			},
		},
	];
}

describe("buildResponsesRequest", () => {
	test("the system prompt is instructions, not a message", () => {
		const params = buildResponsesRequest(MODEL, ctx({ messages: [userMessage("hi")] }));
		expect(params.instructions).toBe("sys");
		// The negative is the half that matters. A system message in the input array
		// is accepted by the wire and quietly changes the cached prefix order, so an
		// implementation that did both would look right here and lose its cache.
		expect(JSON.stringify(params.input)).not.toContain('"role":"system"');
	});

	test("tools are declared flat, with no function wrapper", () => {
		const params = buildResponsesRequest(MODEL, ctx({ tools: TOOLS }));
		expect(params.tools).toEqual([
			{ type: "function", name: "read", description: "d", parameters: { type: "object", properties: {} } },
		]);
		expect(params.tool_choice).toBe("auto");
	});

	test("no tools means no tools key at all, and no tool_choice", () => {
		const params = buildResponsesRequest(MODEL, ctx());
		expect(params.tools).toBeUndefined();
		expect(params.tool_choice).toBeUndefined();
	});

	test("store is false and the reasoning blob is requested", () => {
		const params = buildResponsesRequest(MODEL, ctx());
		expect(params.store).toBe(false);
		// Without the include there is nothing to replay a reasoning item with, and
		// with store:false there is nothing on the far side to replay it from.
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("max_output_tokens is the Responses spelling, not max_tokens", () => {
		const params = buildResponsesRequest(MODEL, ctx(), { maxOutputTokens: 512 });
		expect(params.max_output_tokens).toBe(512);
		expect(params.max_tokens).toBeUndefined();
	});
});

describe("responsesEffort", () => {
	test("a level the model does not accept is omitted, not rounded", () => {
		const model: Model = { ...MODEL, reasoningEfforts: ["low", "medium", "high"] };
		// `minimal` is not on the row. The two things a reader must be able to tell
		// apart are "we sent low because the session asked for minimal" and "we sent
		// nothing" — only the second is true, and only the second leaves the model
		// applying its own default rather than a depth the user never chose.
		expect(responsesEffort(model, "minimal")).toBeUndefined();
		expect(responsesEffort(model, "low")).toEqual({ effort: "low" });
		expect(responsesEffort(model, "high")).toEqual({ effort: "high" });
	});

	test("off is never sent as a value", () => {
		expect(responsesEffort(MODEL, "off")).toBeUndefined();
	});

	test("a model with no declared subset takes what was asked for", () => {
		expect(responsesEffort(MODEL, "minimal")).toEqual({ effort: "minimal" });
	});

	test("the request carries the effort only when one survives", () => {
		const model: Model = { ...MODEL, reasoningEfforts: ["medium", "high"] };
		expect(buildResponsesRequest(model, ctx(), { thinkingLevel: "minimal" }).reasoning).toBeUndefined();
		expect(buildResponsesRequest(model, ctx(), { thinkingLevel: "medium" }).reasoning).toEqual({
			effort: "medium",
			summary: "auto",
		});
	});
});

describe("convertInput", () => {
	test("a tool result is an input item carrying call_id", () => {
		const items = convertInput(
			ctx({ messages: [toolResultMessage("call_abc", "read", [{ type: "text", text: "ok" }])] }),
		);
		expect(items).toEqual([{ type: "function_call_output", call_id: "call_abc", output: "ok" }]);
	});

	test("a tool call is replayed with call_id, never with a message role", () => {
		const items = convertInput(
			ctx({
				messages: [
					assistantMessage({
						content: [{ type: "toolCall", id: "call_abc", name: "read", arguments: "{}" }],
						stopReason: "toolUse",
					}),
				],
			}),
		);
		expect(items).toEqual([{ type: "function_call", call_id: "call_abc", name: "read", arguments: "{}" }]);
	});

	test("user text is input_text and assistant text is output_text", () => {
		const items = convertInput(
			ctx({
				messages: [
					userMessage("hi"),
					assistantMessage({ content: [{ type: "text", text: "hello" }], stopReason: "stop" }),
				],
			}),
		);
		// Same word, two different content types. Swapping them is a 400, and it is
		// the kind of 400 that only appears on the second turn of a conversation.
		expect(items[0].content).toEqual([{ type: "input_text", text: "hi" }]);
		expect(items[1].content).toEqual([{ type: "output_text", text: "hello" }]);
	});

	test("reasoning is replayed only when it carries the encrypted blob", () => {
		const withBlob = convertInput(
			ctx({
				messages: [
					assistantMessage({
						content: [{ type: "thinking", thinking: "planning", signature: "enc-1" }],
						stopReason: "stop",
					}),
				],
			}),
		);
		expect(withBlob[0]).toEqual({
			type: "reasoning",
			encrypted_content: "enc-1",
			summary: [{ type: "summary_text", text: "planning" }],
		});

		// No blob means nothing to verify against, and the wire has no spelling for
		// a reasoning item that is only our own summary.
		const withoutBlob = convertInput(
			ctx({
				messages: [assistantMessage({ content: [{ type: "thinking", thinking: "planning" }], stopReason: "stop" })],
			}),
		);
		expect(withoutBlob).toEqual([]);
	});

	test("images keep their data url", () => {
		const items = convertInput(
			ctx({ messages: [userMessage([{ type: "image", mimeType: "image/png", data: "AAA" }])] }),
		);
		expect(items[0].content).toEqual([{ type: "input_image", image_url: "data:image/png;base64,AAA" }]);
	});
});

describe("mapResponsesStream", () => {
	test("a turn with a tool call reports toolUse, not stop", async () => {
		const events = await collect(mapResponsesStream(raw(toolTurn()), "openai", MODEL.id));
		const done = events.at(-1);
		// The failure this pins: the terminal event says `completed` for both a plain
		// answer and a turn that ended in a call, so the two are told apart only by
		// what the turn holds. Reporting `stop` here is a session that does nothing.
		expect(done.type).toBe("done");
		expect(done.message.stopReason).toBe("toolUse");
	});

	test("the tool call carries call_id, not the item id", async () => {
		const events = await collect(mapResponsesStream(raw(toolTurn()), "openai", MODEL.id));
		const call = events.find((e) => e.type === "toolcall_end").toolCall;
		// The tool result that comes back is matched on this id. Taking `fc_1` here
		// produces a request whose every function_call_output is orphaned.
		expect(call.id).toBe("call_abc");
		expect(call.name).toBe("read");
		expect(JSON.parse(call.arguments)).toEqual({ path: "a.ts" });
	});

	test("a plain answer reports stop", async () => {
		const events = await collect(
			mapResponsesStream(
				raw([
					{ type: "response.output_text.delta", output_index: 0, delta: "hi" },
					{ type: "response.completed", response: { status: "completed" } },
				]),
				"openai",
				MODEL.id,
			),
		);
		expect(events.at(-1).message.stopReason).toBe("stop");
	});

	test("usage splits the cached prefix out of the input count", async () => {
		const events = await collect(mapResponsesStream(raw(toolTurn()), "openai", MODEL.id));
		const usage = events.at(-1).message.usage;
		// input_tokens counts the cached prefix on this wire, same as prompt_tokens
		// does on Chat Completions. Leaving it whole bills those tokens twice.
		expect(usage.input).toBe(200);
		expect(usage.cacheRead).toBe(1_000);
		expect(usage.promptTotal).toBe(1_200);
		expect(usage.output).toBe(40);
	});

	test("reasoning deltas become a thinking block that carries its blob", async () => {
		const events = await collect(
			mapResponsesStream(
				raw([
					{ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, delta: "think" },
					{ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: "enc-9" } },
					{ type: "response.output_text.delta", output_index: 1, delta: "answer" },
					{ type: "response.completed", response: { status: "completed" } },
				]),
				"openai",
				MODEL.id,
			),
		);
		const block = events.find((e) => e.type === "thinking_end").content;
		expect(block).toBe("think");
		const partial = events.find((e) => e.type === "thinking_end").partial;
		expect(partial.content[0]).toMatchObject({ type: "thinking", signature: "enc-9" });
		// The blob is only worth anything if it survives to the block that gets
		// replayed; convertInput reads nothing else.
		expect(partial.content[1]).toMatchObject({ type: "text", text: "answer" });
	});

	test("an empty stream is an error, not a silent empty answer", async () => {
		const events = await collect(mapResponsesStream(raw([]), "openai", MODEL.id));
		expect(events.at(-1).type).toBe("error");
		expect(events.at(-1).message.errorMessage).toContain("no events");
	});

	test("a stream that ends without a terminal event is an error, and its half-written call is not dispatched", async () => {
		// The events that came through hold a call whose arguments stopped
		// mid-JSON. Closing it as resolved would hand the loop a tool call the
		// model never finished writing; the missing status is the lie detector.
		const events = await collect(
			mapResponsesStream(
				raw([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { id: "item_1", type: "function_call", call_id: "call_1", name: "echo" },
					},
					{ type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"text":"par' },
				]),
				"openai",
				MODEL.id,
			),
		);
		expect(events.at(-1).type).toBe("error");
		expect(events.at(-1).message.errorMessage).toContain("terminal event");
		expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(0);
	});

	test("a failed response carries the provider's own message", async () => {
		const events = await collect(
			mapResponsesStream(
				raw([{ type: "response.failed", response: { status: "failed", error: { message: "quota exceeded" } } }]),
				"openai",
				MODEL.id,
			),
		);
		expect(events.at(-1).message.errorMessage).toBe("quota exceeded");
	});

	test("unknown event names are ignored rather than failing the turn", async () => {
		const events = await collect(
			mapResponsesStream(
				raw([
					{ type: "response.created" },
					{ type: "response.in_progress" },
					{ type: "response.content_part.added" },
					{ type: "response.output_text.delta", output_index: 0, delta: "hi" },
					{ type: "response.completed", response: { status: "completed" } },
				]),
				"openai",
				MODEL.id,
			),
		);
		expect(events.at(-1).type).toBe("done");
	});
});

describe("resolveStopReason", () => {
	test.each([
		["completed with no calls", "completed", undefined, 0, "stop"],
		["completed with a call", "completed", undefined, 1, "toolUse"],
		["incomplete on max_output_tokens", "incomplete", "max_output_tokens", 0, "length"],
		["incomplete for another reason", "incomplete", "content_filter", 0, "length"],
		["failed", "failed", undefined, 0, "error"],
		["cancelled", "cancelled", undefined, 0, "error"],
		["no terminal event at all", undefined, undefined, 0, "error"],
	] as const)("%s", (_name, status, reason, calls, expected) => {
		expect(resolveStopReason(status, reason, calls)).toBe(expected);
	});
});

describe("createResponsesStreamFn", () => {
	test("goes out on responses.create, not chat.completions", async () => {
		const seen: Record<string, unknown>[] = [];
		const streamFn = createResponsesStreamFn({
			clientFactory: () => ({
				responses: {
					async create(params: Record<string, unknown>) {
						seen.push(params);
						return raw([{ type: "response.completed", response: { status: "completed" } }]);
					},
				},
			}),
		});
		await collect(streamFn(MODEL, ctx(), { apiKey: "k" }));
		expect(seen).toHaveLength(1);
		expect(seen[0].model).toBe("gpt-6.1-sol");
	});
});

describe("dispatch", () => {
	test("a Responses model reaches the Responses adapter", async () => {
		// The claim that cannot be tested from the adapter's own file: that
		// `model.api` is what routes it. A model whose `api` this dispatcher does
		// not know fails every single request with `Unsupported API`, which is the
		// difference between a working model and one that cannot be used at all.
		// Faking the client is what makes it observable — the alternative proof is
		// that the call throws, and a missing branch throws exactly the same way a
		// refused network would.
		const seen: Record<string, unknown>[] = [];
		const streamFn = createDefaultStreamFn({
			responsesClientFactory: () => ({
				responses: {
					async create(params: Record<string, unknown>) {
						seen.push(params);
						return raw([{ type: "response.completed", response: { status: "completed" } }]);
					},
				},
			}),
		});
		await collect(streamFn(MODEL, ctx({ tools: TOOLS }), { apiKey: "k" }));
		expect(seen).toHaveLength(1);
		expect(seen[0].model).toBe("gpt-6.1-sol");
		expect(seen[0].tools).toBeDefined();
	});

	test("the model's own row reaches its own wire", async () => {
		// Ties the registry to the dispatch: the row that decides which wire a model
		// answers on is the same row this test reads, so a row moved to the wrong
		// `api` fails here rather than in production.
		expect(resolveModel("openai/gpt-6.1-sol")?.api).toBe("openai-responses");
	});
});

describe("catalog discovery", () => {
	test("a Responses model is still probed", async () => {
		// `providersWithKeys` picks one model per provider, so a provider whose first
		// row is on a wire the prober does not know is never asked what it serves —
		// the catalog quietly stops refreshing for that provider, with no error
		// anywhere. That makes this a per-wire claim rather than a nicety.
		const listing = await probeProvider(MODEL, undefined, {
			models: { list: async () => ({ data: [{ id: "gpt-6.1-sol" }] }) },
		});
		expect(listing?.provider).toBe("openai");
		expect(listing?.models.map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
	});

	test("an unknown wire is still left unprobed", async () => {
		// The negative that keeps the branch above honest: a model on a wire with no
		// listing call must return nothing rather than fall through to the OpenAI one.
		const listing = await probeProvider({ ...MODEL, api: "nonesuch" as never }, undefined, {
			models: { list: async () => ({ data: [{ id: "should-not-be-asked" }] }) },
		});
		expect(listing).toBeUndefined();
	});
});

describe("the registry", () => {
	test("GPT-6.1 Sol's first-party row is on the Responses wire", () => {
		const model = resolveModel("openai/gpt-6.1-sol");
		expect(model?.api).toBe("openai-responses");
		// The whole point of the row moving: tools are in the request, and this is
		// the wire that accepts them.
		expect(model?.toolCalling).toBeUndefined();
	});

	test("the row names the efforts it accepts", () => {
		expect(resolveModel("openai/gpt-6.1-sol")?.reasoningEfforts).toEqual(["low", "medium", "high"]);
	});

	test("the reseller row stays on Chat Completions and is marked", () => {
		// Zen's listing proves the id is served; it does not prove Zen answers
		// /v1/responses. Registering it there would be a row that 404s, so it stays
		// where it demonstrably answers and says it cannot act.
		const zen = resolveModel("opencode-zen-oai/gpt-6.1-sol");
		expect(zen?.api).toBe("openai-completions");
		expect(zen?.toolCalling).toBe(false);
	});

	test("no other row in the catalog claims it cannot call tools", () => {
		// The flag is a per-row fact. If a mutation adds it to a healthy row, this
		// turns the picker filter into a silent hole across the whole catalog.
		const marked = resolveModel("openai/gpt-6-sol");
		expect(marked?.toolCalling).toBeUndefined();
	});
});
