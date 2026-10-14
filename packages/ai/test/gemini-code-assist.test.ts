/**
 * The Gemini Code Assist wire, tested against the shapes it is supposed to
 * produce. Each test pins a *difference* from the other wires — the envelope the
 * payload travels in, the camelCase thinking config inside an otherwise
 * snake_case request, the tool schema field, the SSE reader's tolerance, and the
 * 401 recovery — because those differences are the reason this adapter exists; a
 * test every wire would pass is a test for one wire.
 */
import { describe, expect, test } from "bun:test";
import { createDefaultStreamFn } from "../src/index.ts";
import { resolveModel } from "../src/model.ts";
import {
	buildCodeAssistRequest,
	CODE_ASSIST_API_VERSION,
	CODE_ASSIST_ENDPOINT,
	type CodeAssistFrame,
	type CodeAssistPart,
	type CodeAssistUsage,
	codeAssistHeaders,
	codeAssistThinkingConfig,
	codeAssistUrl,
	convertContents,
	createCodeAssistStreamFn,
	DEFAULT_THINKING_BUDGET,
	GEMINI_CLI_VERSION,
	GeminiCodeAssistError,
	type GeminiTokenGrant,
	type GeminiTokenProvider,
	mapCodeAssistStream,
	parseCodeAssistSse,
	SYNTHETIC_THOUGHT_SIGNATURE,
} from "../src/providers/gemini-code-assist.ts";
import { withRetry } from "../src/retry.ts";
import type { Context, Model } from "../src/types.ts";
import { assistantMessage, textContent, toolResultMessage, userMessage } from "../src/types.ts";

/** A subscription row, the shape all twelve catalog entries carry. */
const MODEL: Model = {
	id: "gemini-3.1-pro-preview",
	name: "Gemini 3.1 Pro",
	api: "gemini-code-assist",
	provider: "gemini",
	baseUrl: "https://cloudcode-pa.googleapis.com",
	contextWindow: 1_048_576,
	maxOutputTokens: 1_048_576,
	reasoning: true,
	pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function ctx(overrides: Partial<Context> = {}): Context {
	return { systemPrompt: "sys", messages: [userMessage("hi")], ...overrides };
}

const TOOLS = [{ name: "read", description: "d", parameters: { type: "object" as const, properties: {} } }];

const GRANT: GeminiTokenGrant = { token: "tok-1", expiresAt: null, project: "proj-1" };

async function collect(events: AsyncIterable<any>): Promise<any[]> {
	const out: any[] = [];
	for await (const event of events) out.push(event);
	return out;
}

type Candidate = NonNullable<NonNullable<CodeAssistFrame["response"]>["candidates"]>[number];

/** One response frame as the backend frames it: the payload inside `response`. */
function wrapped(partial: {
	parts?: CodeAssistPart[];
	finishReason?: string;
	finishMessage?: string;
	usageMetadata?: CodeAssistUsage;
}): CodeAssistFrame {
	const candidate: Candidate = { content: { role: "model", parts: partial.parts } };
	if (partial.finishReason !== undefined) candidate.finishReason = partial.finishReason;
	if (partial.finishMessage !== undefined) candidate.finishMessage = partial.finishMessage;
	return { response: { candidates: [candidate], usageMetadata: partial.usageMetadata } };
}

async function* framesOf(items: CodeAssistFrame[]): AsyncGenerator<CodeAssistFrame> {
	for (const item of items) yield item;
}

/** The wire bytes for a run of frames: one `data:` event each, blank-line terminated. */
function sseText(items: CodeAssistFrame[]): string {
	return items.map((item) => `data: ${JSON.stringify(item)}\r\n\r\n`).join("");
}

function streamOf(text: string, chunkSize = text.length): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (let at = 0; at < bytes.length; at += chunkSize) controller.enqueue(bytes.slice(at, at + chunkSize));
			controller.close();
		},
	});
}

/** A grant provider that serves the given grants in order and records its calls. */
function grantProvider(
	grants: GeminiTokenGrant[],
	calls: Array<{ forceRefresh?: boolean } | undefined> = [],
): GeminiTokenProvider {
	let index = 0;
	return Object.assign(
		async (options?: { forceRefresh?: boolean }) => {
			calls.push(options);
			const grant = grants[Math.min(index++, grants.length - 1)];
			if (!grant) throw new Error("no grant");
			return grant;
		},
		{ available: async () => true },
	);
}

/** A fetch that answers the scripted responses in order and records what it saw. */
function recordingFetch(responses: Array<() => Response>): {
	fetch: typeof fetch;
	seen: Array<{ url: string; init: RequestInit | undefined }>;
} {
	const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
	let index = 0;
	const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		seen.push({ url: String(url), init });
		const make = responses[Math.min(index++, responses.length - 1)];
		if (!make) throw new Error("no scripted response");
		return make();
	};
	return { fetch: fetchImpl as typeof fetch, seen };
}

function headersOf(seen: Array<{ init: RequestInit | undefined }>, at: number): Record<string, string> {
	return (seen[at]?.init?.headers ?? {}) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe("buildCodeAssistRequest", () => {
	test("the payload rides inside a `request` field, with the model and a fresh prompt id beside it", () => {
		const params = buildCodeAssistRequest(MODEL, ctx(), undefined, "proj-1");
		// The envelope is the difference from every other wire here: the model
		// names the call outside, and the conversation is inside `request`.
		expect(params.model).toBe("gemini-3.1-pro-preview");
		expect(params.project).toBe("proj-1");
		expect(typeof params.user_prompt_id).toBe("string");
		expect(params.user_prompt_id.length).toBeGreaterThan(0);
		expect(params.request.systemInstruction).toEqual({ role: "user", parts: [{ text: "sys" }] });
		expect(params.request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
		// No session identity and no cache field exist on this wire, so neither may
		// appear: a `session_id` invented here would be a value the backend never
		// gave this process.
		expect("session_id" in params.request).toBe(false);
		// A fresh id per request, not a reused one.
		expect(buildCodeAssistRequest(MODEL, ctx()).user_prompt_id).not.toBe(params.user_prompt_id);
		// And the project is omitted, not sent empty, when nothing onboarded one.
		expect("project" in buildCodeAssistRequest(MODEL, ctx())).toBe(false);
	});

	test("tools go out as functionDeclarations with the schema under `parametersJsonSchema`", () => {
		const params = buildCodeAssistRequest(MODEL, ctx({ tools: TOOLS }));
		// The sibling `parameters` field takes the backend's own Schema dialect;
		// our schemas are JSON Schema, so the field that accepts one is the only
		// correct spelling.
		expect(params.request.tools).toEqual([
			{
				functionDeclarations: [
					{ name: "read", description: "d", parametersJsonSchema: { type: "object", properties: {} } },
				],
			},
		]);
		expect(buildCodeAssistRequest(MODEL, ctx()).request.tools).toBeUndefined();
	});

	test("generationConfig carries the cap only when asked, and the thinking config from the model", () => {
		const bare = buildCodeAssistRequest(MODEL, ctx());
		// A reasoning row with no level asked reads as medium, which the level
		// family answers with HIGH.
		expect(bare.request.generationConfig).toEqual({
			thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
		});
		expect(buildCodeAssistRequest(MODEL, ctx(), { maxOutputTokens: 512 }).request.generationConfig).toEqual({
			maxOutputTokens: 512,
			thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
		});
		// A row that does not reason sends no thinking config at all — and with
		// nothing else asked for, no generationConfig.
		const plain: Model = { ...MODEL, reasoning: false };
		expect(buildCodeAssistRequest(plain, ctx()).request.generationConfig).toBeUndefined();
	});
});

describe("convertContents", () => {
	test("thoughts are dropped, and the replay signature lands on the first function call only", () => {
		const contents = convertContents({
			systemPrompt: "",
			messages: [
				assistantMessage({
					content: [
						{ type: "thinking", thinking: "hmm", signature: "sig-1" },
						{ type: "text", text: "let me look" },
						{ type: "toolCall", id: "call_1", name: "read", arguments: '{"path":"a"}' },
						{ type: "toolCall", id: "call_2", name: "read", arguments: '{"path":"b"}' },
					],
				}),
			],
		});
		expect(contents).toEqual([
			{
				role: "model",
				parts: [
					{ text: "let me look" },
					{
						functionCall: { id: "call_1", name: "read", args: { path: "a" } },
						thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE,
					},
					{ functionCall: { id: "call_2", name: "read", args: { path: "b" } } },
				],
			},
		]);
	});

	test("a tool result is a `user` turn, three outcomes inside one response object", () => {
		const contents = convertContents({
			systemPrompt: "",
			messages: [
				assistantMessage({ content: [{ type: "toolCall", id: "c1", name: "read", arguments: "{}" }] }),
				toolResultMessage("c1", "read", [textContent("done")]),
				toolResultMessage("c2", "read", [textContent("boom")], true),
				toolResultMessage("c3", "read", []),
			],
		});
		// The three results coalesce into one turn: consecutive `user` turns are a
		// 400 outright, and results are `user` turns here.
		expect(contents).toEqual([
			{
				role: "model",
				parts: [{ functionCall: { id: "c1", name: "read", args: {} }, thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE }],
			},
			{
				role: "user",
				parts: [
					{ functionResponse: { id: "c1", name: "read", response: { output: "done" } } },
					{ functionResponse: { id: "c2", name: "read", response: { error: "boom" } } },
					{ functionResponse: { id: "c3", name: "read", response: {} } },
				],
			},
		]);
	});

	test("consecutive user-side turns merge, images travel as inlineData, and empty turns vanish", () => {
		const contents = convertContents({
			systemPrompt: "",
			messages: [
				assistantMessage({ content: [{ type: "thinking", thinking: "only thoughts" }] }),
				userMessage("hi"),
				userMessage([{ type: "image", mimeType: "image/png", data: "AAAA" }, textContent("what is this")]),
			],
		});
		// The thinking-only assistant turn contributes no parts and is not a record
		// at all; the two user turns coalesce into one.
		expect(contents).toEqual([
			{
				role: "user",
				parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }, { text: "what is this" }],
			},
		]);
	});
});

describe("codeAssistThinkingConfig", () => {
	test("the 2.5 family is steered by a budget, and the default cap is the one the chat traffic runs at", () => {
		const pro25: Model = { ...MODEL, id: "gemini-2.5-pro" };
		// The upstream cap this adapter copies is a cap, not a target: the number
		// is pinned so a later "tune" of it is a visible decision.
		expect(DEFAULT_THINKING_BUDGET).toBe(8192);
		expect(codeAssistThinkingConfig(pro25, "off")).toEqual({ thinkingBudget: 0 });
		expect(codeAssistThinkingConfig(pro25, "medium")).toEqual({
			includeThoughts: true,
			thinkingBudget: DEFAULT_THINKING_BUDGET,
		});
		// With no level asked, a reasoning row reads as medium.
		expect(codeAssistThinkingConfig(pro25)).toEqual({ includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET });
	});

	test("the level family speaks LOW and HIGH, and off is the absence of a request for thoughts", () => {
		expect(codeAssistThinkingConfig(MODEL, "off")).toEqual({ includeThoughts: false });
		expect(codeAssistThinkingConfig(MODEL, "minimal")).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
		expect(codeAssistThinkingConfig(MODEL, "low")).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
		expect(codeAssistThinkingConfig(MODEL, "medium")).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
		expect(codeAssistThinkingConfig(MODEL, "high")).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
		// The split reads the id, not the catalog row: both Gemma 4s follow the
		// models after 2.5.
		const gemma: Model = { ...MODEL, id: "gemma-4-31b-it" };
		expect(codeAssistThinkingConfig(gemma, "high")).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
		// A non-reasoning row with no level asked answers off.
		const plain: Model = { ...MODEL, reasoning: false };
		expect(codeAssistThinkingConfig(plain)).toEqual({ includeThoughts: false });
	});
});

describe("codeAssistUrl / codeAssistHeaders", () => {
	test("the streaming method hangs off the base, and a trailing slash does not double", () => {
		expect(codeAssistUrl(MODEL)).toBe(
			`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`,
		);
		expect(codeAssistUrl({ ...MODEL, baseUrl: "https://example.test/" })).toBe(
			"https://example.test/v1internal:streamGenerateContent?alt=sse",
		);
	});

	test("the bearer, the JSON content type and the client User-Agent; no client-metadata header exists", () => {
		const headers = codeAssistHeaders(MODEL, GRANT, { authorization: "Bearer spoofed", "x-gateway": "route-a" });
		expect(headers).toEqual({
			authorization: "Bearer tok-1",
			"x-gateway": "route-a",
			"content-type": "application/json",
			"user-agent": `GeminiCLI/${GEMINI_CLI_VERSION}/${MODEL.id} (${process.platform}; ${process.arch}; terminal)`,
		});
		// The metadata this backend reads travels in the body JSON; there is no
		// header carrying it, so one appearing here would be invented.
		expect(Object.keys(headers).filter((name) => name.toLowerCase().includes("metadata"))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

describe("parseCodeAssistSse", () => {
	test("a frame split across reads and across data lines still arrives whole", async () => {
		const doc = JSON.stringify(wrapped({ parts: [{ text: "hi" }], finishReason: "STOP" }));
		// Split between tokens, not inside one: the reader joins the two data lines
		// with a newline, exactly as the event-stream format reads them.
		const at = doc.indexOf(",") + 1;
		const text = `data: ${doc.slice(0, at)}\r\ndata: ${doc.slice(at)}\r\n\r\n`;
		expect(await collect(parseCodeAssistSse(streamOf(text, 7)))).toEqual([JSON.parse(doc)]);
	});

	test("a malformed frame is skipped and the frames around it arrive", async () => {
		const good1 = JSON.stringify(wrapped({ parts: [{ text: "a" }] }));
		const good2 = JSON.stringify(wrapped({ parts: [{ text: "b" }] }));
		const text = `data: ${good1}\r\n\r\ndata: {oops\r\n\r\ndata: ${good2}\r\n\r\n`;
		// One bad frame must not cost the turn the frames around it.
		expect(await collect(parseCodeAssistSse(streamOf(text, 1_000)))).toEqual([JSON.parse(good1), JSON.parse(good2)]);
	});

	test("a trailing event with no blank line is dropped, and non-data lines are ignored", async () => {
		const doc = JSON.stringify(wrapped({ parts: [{ text: "a" }] }));
		// A comment line and an `id:` line are not payload; an incomplete trailing
		// event is not a frame.
		const unterminated = `: keep-alive\nid: 7\ndata: ${doc}\n`;
		expect(await collect(parseCodeAssistSse(streamOf(unterminated)))).toEqual([]);
		expect(await collect(parseCodeAssistSse(streamOf(`${unterminated}\n`)))).toEqual([JSON.parse(doc)]);
	});

	test("a null body is no frames", async () => {
		expect(await collect(parseCodeAssistSse(null))).toEqual([]);
	});
});

async function stopOf(finishReason: string | undefined, extra: { finishMessage?: string } = {}): Promise<any> {
	const events = await collect(
		mapCodeAssistStream(framesOf([wrapped({ parts: [{ text: "x" }], finishReason, ...extra })]), "gemini", MODEL.id),
	);
	return events.at(-1);
}

describe("mapCodeAssistStream", () => {
	test("text deltas stream and the turn seals as a stop", async () => {
		const events = await collect(
			mapCodeAssistStream(
				framesOf([wrapped({ parts: [{ text: "hel" }] }), wrapped({ parts: [{ text: "lo" }], finishReason: "STOP" })]),
				"gemini",
				MODEL.id,
			),
		);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		const done = events.at(-1);
		expect(done.message.stopReason).toBe("stop");
		expect(done.message.provider).toBe("gemini");
		expect(done.message.model).toBe(MODEL.id);
		expect(done.message.content).toEqual([{ type: "text", text: "hello" }]);
	});

	test("a function call arrives whole, in its three events, and flips the turn to a tool turn", async () => {
		const events = await collect(
			mapCodeAssistStream(
				framesOf([
					wrapped({
						parts: [{ functionCall: { id: "call_1", name: "read", args: { path: "a" } } }],
						finishReason: "STOP",
					}),
				]),
				"gemini",
				MODEL.id,
			),
		);
		// The wire delivers the call whole — arguments included — where the OpenAI
		// wires stream fragments, so the three events come back to back.
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(events[3].contentIndex).toBe(0);
		expect(events[3].toolCall).toEqual({ type: "toolCall", id: "call_1", name: "read", arguments: '{"path":"a"}' });
		// A call-bearing turn is the tool loop's continue signal even though the
		// reason beside it is a plain STOP.
		expect(events.at(-1)?.message.stopReason).toBe("toolUse");
	});

	test("a call with no id gets one minted, and a call with no name is named", async () => {
		const events = await collect(
			mapCodeAssistStream(
				framesOf([
					wrapped({
						parts: [{ functionCall: { name: "read", args: {} } }, { functionCall: { args: {} } }],
						finishReason: "STOP",
					}),
				]),
				"gemini",
				MODEL.id,
			),
		);
		const ends = events.filter((event) => event.type === "toolcall_end");
		expect(ends[0].toolCall.id.startsWith("read_")).toBe(true);
		expect(ends[1].toolCall.name).toBe("generic_tool");
		expect(ends[1].toolCall.id.startsWith("generic_tool_")).toBe(true);
		expect(ends[0].toolCall.id).not.toBe(ends[1].toolCall.id);
	});

	test("thought parts open a thinking block, keep their signature, and stay off the answer text", async () => {
		const events = await collect(
			mapCodeAssistStream(
				framesOf([
					wrapped({
						parts: [
							{ thought: true, text: "hmm" },
							{ thought: true, text: " more", thoughtSignature: "sig-1" },
							{ text: "answer" },
						],
						finishReason: "STOP",
					}),
				]),
				"gemini",
				MODEL.id,
			),
		);
		expect(events.map((event) => event.type)).toEqual([
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
		// The thought is block 0 and the answer is block 1: a thought part is not
		// answer text, which is the difference a naive `part.text` reader loses.
		const done = events.at(-1);
		expect(done.message.content).toEqual([
			{ type: "thinking", thinking: "hmm more", signature: "sig-1" },
			{ type: "text", text: "answer" },
		]);
	});

	test("usage normalizes: the cached prefix counts once, and thoughts join the output", async () => {
		const events = await collect(
			mapCodeAssistStream(
				framesOf([
					wrapped({
						parts: [{ text: "x" }],
						finishReason: "STOP",
						usageMetadata: {
							promptTokenCount: 100,
							cachedContentTokenCount: 40,
							candidatesTokenCount: 20,
							thoughtsTokenCount: 8,
							toolUsePromptTokenCount: 5,
							totalTokenCount: 133,
						},
					}),
				]),
				"gemini",
				MODEL.id,
			),
		);
		const usage = events.at(-1)?.message.usage;
		expect(usage.input).toBe(65);
		expect(usage.cacheRead).toBe(40);
		expect(usage.output).toBe(28);
		expect(usage.reasoning).toBe(8);
		expect(usage.promptTotal).toBe(105);
	});

	test("the finish reasons: length, refusal with its message, and an unmapped reason is an error", async () => {
		expect((await stopOf("MAX_TOKENS")).message.stopReason).toBe("length");
		const refused = await stopOf("SAFETY", { finishMessage: "blocked by policy" });
		expect(refused.message.stopReason).toBe("refusal");
		expect(refused.message.errorMessage).toBe("blocked by policy");
		const malformed = await stopOf("MALFORMED_FUNCTION_CALL");
		expect(malformed.message.stopReason).toBe("error");
		expect(malformed.message.errorMessage).toBe("The model's function call was malformed and could not be run");
		const unknown = await stopOf("SOMETHING_NEW");
		expect(unknown.message.stopReason).toBe("error");
		expect(unknown.message.errorMessage).toBe("Unrecognized finish reason: SOMETHING_NEW");
	});

	test("a truncated call-bearing turn keeps its own reason rather than becoming a tool turn", async () => {
		const events = await collect(
			mapCodeAssistStream(
				framesOf([
					wrapped({
						parts: [{ functionCall: { id: "c1", name: "read", args: {} } }],
						finishReason: "MAX_TOKENS",
					}),
				]),
				"gemini",
				MODEL.id,
			),
		);
		// The calls, if any, are partial: sealing the turn as toolUse would run
		// half a call and report success.
		expect(events.at(-1)?.message.stopReason).toBe("length");
	});

	test("a stream with no finish reason is an error, never a stop", async () => {
		// The close itself is an event the stall watchdog cannot see, so a
		// truncated turn reporting stop would be a success that never happened.
		const done = await stopOf(undefined);
		expect(done.type).toBe("done");
		expect(done.message.stopReason).toBe("error");
		expect(done.message.errorMessage).toBe("The stream ended without a finish reason");
	});

	test("a stream with no frames is an error, and no start was ever claimed", async () => {
		const events = await collect(mapCodeAssistStream(framesOf([]), "gemini", MODEL.id));
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		expect(events[0].message.errorMessage).toBe("Gemini Code Assist stream produced no content");
	});
});

// ---------------------------------------------------------------------------
// The live stream function
// ---------------------------------------------------------------------------

describe("createCodeAssistStreamFn", () => {
	test("the request goes out at the streaming URL with the grant's bearer, the project, and the wrapped body", async () => {
		const { fetch: fauxFetch, seen } = recordingFetch([
			() =>
				new Response(streamOf(sseText([wrapped({ parts: [{ text: "hi" }], finishReason: "STOP" })])), {
					headers: { "content-type": "text/event-stream" },
				}),
		]);
		const streamFn = createCodeAssistStreamFn({ credentials: grantProvider([GRANT]), fetch: fauxFetch });
		const events = await collect(streamFn(MODEL, ctx({ tools: TOOLS }), { headers: { "x-gateway": "route-a" } }));
		expect(events.at(-1)?.type).toBe("done");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`);
		expect(seen[0]?.init?.method).toBe("POST");
		const headers = headersOf(seen, 0);
		expect(headers.authorization).toBe("Bearer tok-1");
		expect(headers["x-gateway"]).toBe("route-a");
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["user-agent"]).toBe(
			`GeminiCLI/${GEMINI_CLI_VERSION}/${MODEL.id} (${process.platform}; ${process.arch}; terminal)`,
		);
		const body = JSON.parse(String(seen[0]?.init?.body));
		expect(body.model).toBe(MODEL.id);
		expect(body.project).toBe("proj-1");
		expect(body.request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
		expect(body.request.tools).toEqual([
			{
				functionDeclarations: [
					{ name: "read", description: "d", parametersJsonSchema: { type: "object", properties: {} } },
				],
			},
		]);
	});

	test("a grant without a project sends no project field", async () => {
		const { fetch: fauxFetch, seen } = recordingFetch([
			() => new Response(streamOf(sseText([wrapped({ parts: [{ text: "hi" }], finishReason: "STOP" })]))),
		]);
		const streamFn = createCodeAssistStreamFn({
			credentials: grantProvider([{ token: "tok-1", expiresAt: null }]),
			fetch: fauxFetch,
		});
		await collect(streamFn(MODEL, ctx()));
		const body = JSON.parse(String(seen[0]?.init?.body));
		expect("project" in body).toBe(false);
	});

	test("a non-200 carries the status and the body into the error", async () => {
		const { fetch: fauxFetch } = recordingFetch([
			() => new Response("denied by policy", { status: 403, statusText: "Forbidden" }),
		]);
		const streamFn = createCodeAssistStreamFn({ credentials: grantProvider([GRANT]), fetch: fauxFetch });
		const error = await collect(streamFn(MODEL, ctx())).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(GeminiCodeAssistError);
		expect(error.status).toBe(403);
		expect(error.invalidGrant).toBe(false);
		expect(error.message).toContain("403");
		expect(error.message).toContain("denied by policy");
	});

	test("a 401 re-mints once, bypassing the freshness window, and the retry goes out on the new token", async () => {
		const calls: Array<{ forceRefresh?: boolean } | undefined> = [];
		const { fetch: fauxFetch, seen } = recordingFetch([
			() => new Response("unauthorized", { status: 401 }),
			() => new Response(streamOf(sseText([wrapped({ parts: [{ text: "hi" }], finishReason: "STOP" })]))),
		]);
		const streamFn = createCodeAssistStreamFn({
			credentials: grantProvider([GRANT, { ...GRANT, token: "tok-2" }], calls),
			fetch: fauxFetch,
		});
		const events = await collect(streamFn(MODEL, ctx()));
		expect(events.at(-1)?.type).toBe("done");
		expect(seen).toHaveLength(2);
		expect(headersOf(seen, 1).authorization).toBe("Bearer tok-2");
		expect(calls).toEqual([undefined, { forceRefresh: true }]);
	});

	test("a second 401 is the account's answer, not another refresh", async () => {
		const calls: Array<{ forceRefresh?: boolean } | undefined> = [];
		const { fetch: fauxFetch, seen } = recordingFetch([() => new Response("unauthorized", { status: 401 })]);
		const streamFn = createCodeAssistStreamFn({
			credentials: grantProvider([GRANT, { ...GRANT, token: "tok-2" }], calls),
			fetch: fauxFetch,
		});
		const error = await collect(streamFn(MODEL, ctx())).catch((thrown) => thrown);
		expect(error.status).toBe(401);
		expect(seen).toHaveLength(2);
		// One forced refresh, not one per attempt: the second 401 on a token minted
		// moments ago is not a stale token's.
		expect(calls).toEqual([undefined, { forceRefresh: true }]);
	});

	test("a refresh that fails leaves the original 401 as the answer", async () => {
		const credentials: GeminiTokenProvider = Object.assign(
			async (options?: { forceRefresh?: boolean }) => {
				if (options?.forceRefresh) throw new Error("refresh dead");
				return GRANT;
			},
			{ available: async () => true },
		);
		const { fetch: fauxFetch } = recordingFetch([() => new Response("unauthorized", { status: 401 })]);
		const streamFn = createCodeAssistStreamFn({ credentials, fetch: fauxFetch });
		// The API's refusal is the better report: it is what the endpoint said,
		// where the refresh failure is about a token that is not the request's.
		await expect(collect(streamFn(MODEL, ctx()))).rejects.toThrow("Gemini Code Assist request failed: 401");
	});

	test("no credentials at all is the login error, and nothing dials", async () => {
		const { fetch: fauxFetch, seen } = recordingFetch([
			() => {
				throw new Error("must not dial");
			},
		]);
		const streamFn = createCodeAssistStreamFn({ fetch: fauxFetch });
		const error = await collect(streamFn(MODEL, ctx())).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(GeminiCodeAssistError);
		expect(error.invalidGrant).toBe(true);
		expect(error.message).toBe("Not signed in to a Gemini subscription for gemini-3.1-pro-preview: run /login.");
		expect(seen).toHaveLength(0);
	});

	test("a login-layer error that marks an invalid grant is translated, so the retry door sees it with no ladder", async () => {
		// The login layer lives outside this package, so its error is read
		// structurally; the translation is what makes the retry wrapper below let
		// it out on the first attempt.
		let mints = 0;
		const credentials: GeminiTokenProvider = Object.assign(
			async () => {
				mints++;
				throw Object.assign(new Error("dead refresh token"), { invalidGrant: true });
			},
			{ available: async () => true },
		);
		const streamFn = withRetry(createCodeAssistStreamFn({ credentials }), { sleep: async () => {} });
		const events = await collect(streamFn(MODEL, ctx()));
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		expect(events[0].message.errorKind).toBe("auth");
		expect(events[0].message.errorMessage).toContain("dead refresh token");
		// One mint, not ten: a session that cannot sign in beats no ladder.
		expect(mints).toBe(1);
	});

	test("a mint failure without the mark is not translated — the ladder is what a token endpoint's bad day is for", async () => {
		const credentials: GeminiTokenProvider = Object.assign(
			async () => {
				throw new Error("token endpoint 503");
			},
			{ available: async () => true },
		);
		const streamFn = createCodeAssistStreamFn({ credentials });
		const error = await collect(streamFn(MODEL, ctx())).catch((thrown) => thrown);
		expect(error).not.toBeInstanceOf(GeminiCodeAssistError);
		expect(error.message).toBe("token endpoint 503");
	});
});

describe("dispatch", () => {
	test("a gemini row reaches the code-assist wire through the default stream fn, with no key anywhere", async () => {
		// The claim an adapter-local file cannot make: that `model.api` is what
		// routes it, and that the pre-flight lets it through with no key variable —
		// these rows name none, so the missing-key error must not fire.
		const model = resolveModel("gemini/gemini-3.1-pro-preview");
		expect(model).toBeDefined();
		const original = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request) => {
			seen.push(String(url));
			return new Response(streamOf(sseText([wrapped({ parts: [{ text: "hi" }], finishReason: "STOP" })])));
		}) as typeof fetch;
		try {
			const streamFn = createDefaultStreamFn({ geminiCredentials: grantProvider([GRANT]) });
			const events = await collect(streamFn(model as Model, ctx()));
			expect(events.at(-1)?.type).toBe("done");
			expect(seen).toEqual([`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`]);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("the rows behind the subscription reach their own wire", () => {
		const row = resolveModel("gemini/gemini-3.1-pro-preview");
		expect(row?.api).toBe("gemini-code-assist");
		expect(row?.provider).toBe("gemini");
		expect(row?.baseUrl).toBe("https://cloudcode-pa.googleapis.com");
		// No key variable, and the absence is the statement: the sign-in is the
		// only way in.
		expect(row?.apiKeyEnv).toBeUndefined();
		expect(row?.reasoning).toBe(true);
		// A subscription plan, so every row is priced at zero.
		expect(row?.pricing).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("a bare id both catalogs carry answers at the public API first, and one only the subscription serves routes there bare", () => {
		// The ordering requirement, pinned: the subscription block sits *after*
		// the Google block, so the ids both catalogs carry answer at the API first
		// and only the subscription's own ids route there bare.
		expect(resolveModel("gemini-3.1-pro-preview")?.provider).toBe("google");
		expect(resolveModel("gemini-3.8-flash")?.provider).toBe("google");
		expect(resolveModel("gemini-3-flash-preview")?.provider).toBe("gemini");
	});
});
