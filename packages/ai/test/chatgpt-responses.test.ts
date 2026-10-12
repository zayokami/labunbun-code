/**
 * The ChatGPT subscription wire, tested against the shapes it is supposed to
 * produce. Each test pins a *difference* from the public Responses wire — the
 * frame the tools and the system prompt travel in, the lite request's constants,
 * the headers, and the 401 recovery — because those differences are the reason
 * this adapter exists; a test both wires would pass is a test for one wire.
 */
import { describe, expect, test } from "bun:test";
import { createDefaultStreamFn } from "../src/index.ts";
import { resolveModel } from "../src/model.ts";
import {
	CHATGPT_ORIGINATOR,
	ChatGptOAuthError,
	type ChatGptTokenGrant,
	type ChatGptTokenProvider,
} from "../src/providers/chatgpt-oauth.ts";
import { buildChatGptRequest, chatGptHeaders, createChatGptStreamFn } from "../src/providers/chatgpt-responses.ts";
import type { ResponsesRawEvent } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";
import { userMessage } from "../src/types.ts";

/** A lite row, the shape seven of the eight catalog entries carry. */
const LITE: Model = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "chatgpt-responses",
	provider: "chatgpt",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	contextWindow: 272_000,
	maxOutputTokens: 272_000,
	reasoning: true,
	reasoningEfforts: ["low", "medium", "high"],
	responsesLite: true,
	pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** The one row the catalog does not mark lite. */
const FULL: Model = { ...LITE, id: "gpt-5.5", name: "GPT-5.5", responsesLite: undefined };

function ctx(overrides: Partial<Context> = {}): Context {
	return { systemPrompt: "sys", messages: [userMessage("hi")], ...overrides };
}

const TOOLS = [{ name: "read", description: "d", parameters: { type: "object" as const, properties: {} } }];
const FLAT_TOOL = {
	type: "function" as const,
	name: "read",
	description: "d",
	parameters: { type: "object", properties: {} },
};

const GRANT: ChatGptTokenGrant = { token: "tok-1", expiresAt: null, accountId: "acct-1", fedramp: false };

async function collect(events: AsyncIterable<any>): Promise<any[]> {
	const out: any[] = [];
	for await (const e of events) out.push(e);
	return out;
}

async function* raw(events: ResponsesRawEvent[]) {
	for (const e of events) yield e;
}

function completed() {
	return raw([{ type: "response.completed", response: { status: "completed" } } as ResponsesRawEvent]);
}

/** A grant provider that serves the given grants in order and records its calls. */
function grantProvider(
	grants: ChatGptTokenGrant[],
	calls: Array<{ forceRefresh?: boolean } | undefined> = [],
): ChatGptTokenProvider {
	let index = 0;
	return Object.assign(
		async (options?: { forceRefresh?: boolean }) => {
			calls.push(options);
			const grant = grants[Math.min(index++, grants.length - 1)];
			if (!grant) throw new ChatGptOAuthError("no grant");
			return grant;
		},
		{ available: async () => true },
	);
}

describe("buildChatGptRequest", () => {
	test("lite: tools ride in the frame under one namespace, with no top-level tools or instructions", () => {
		const params = buildChatGptRequest(LITE, ctx({ tools: TOOLS }));
		// The negatives are half the claim: a request that also carried the
		// top-level pair would look right to a reviewer reading either field list
		// and be a different request than the backend's own client sends.
		expect("tools" in params).toBe(false);
		expect("instructions" in params).toBe(false);
		// The frame, in the backend's order: the tool set first…
		expect(params.input[0]).toEqual({
			type: "additional_tools",
			role: "developer",
			tools: [{ type: "namespace", name: "functions", description: "", tools: [FLAT_TOOL] }],
		});
		// …then the system prompt as a developer message…
		expect(params.input[1]).toEqual({ role: "developer", content: [{ type: "input_text", text: "sys" }] });
		// …then the conversation.
		expect(params.input[2]).toEqual({ role: "user", content: [{ type: "input_text", text: "hi" }] });
		expect(params.parallel_tool_calls).toBe(false);
		// A constant on this wire, per the backend's client — sent even with no
		// top-level tools in sight.
		expect(params.tool_choice).toBe("auto");
	});

	test("lite: reasoning carries context all_turns even when no effort goes out", () => {
		// `context` is a property of the lite wire, not of the session's thinking
		// level: with the session asking for `off` — the one level that resolves
		// to no effort anywhere — the context still goes out. An implementation
		// that folded it into the effort branch would send nothing here.
		expect(buildChatGptRequest(LITE, ctx(), { thinkingLevel: "off" }).reasoning).toEqual({
			context: "all_turns",
		});
		// And the shared builder's default rides along when the session says
		// nothing: `responsesEffort` reads a reasoning row with no level as
		// `medium`, the same call every other wire gets.
		expect(buildChatGptRequest(LITE, ctx()).reasoning).toEqual({
			effort: "medium",
			summary: "auto",
			context: "all_turns",
		});
	});

	test("lite: a level the row rejects drops the effort and keeps the context", () => {
		// `minimal` is ours, not this catalog's. The two failures the pair of
		// assertions separates: sending `minimal` anyway (a 400 or a silent
		// substitution) and dropping `context` along with the effort.
		expect(buildChatGptRequest(LITE, ctx(), { thinkingLevel: "minimal" }).reasoning).toEqual({
			context: "all_turns",
		});
		expect(buildChatGptRequest(LITE, ctx(), { thinkingLevel: "high" }).reasoning).toEqual({
			effort: "high",
			summary: "auto",
			context: "all_turns",
		});
	});

	test("lite with no tools: no frame item, and the system prompt still leads", () => {
		const params = buildChatGptRequest(LITE, ctx());
		expect(params.input[0]).toEqual({ role: "developer", content: [{ type: "input_text", text: "sys" }] });
		expect(params.input.some((item) => item.type === "additional_tools")).toBe(false);
	});

	test("an empty system prompt means no developer message at all", () => {
		const params = buildChatGptRequest(LITE, ctx({ systemPrompt: "" }));
		expect(params.input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "hi" }] });
	});

	test("the full wire keeps tools flat and top-level, and parallel calls on", () => {
		const params = buildChatGptRequest(FULL, ctx({ tools: TOOLS }));
		expect(params.tools).toEqual([FLAT_TOOL]);
		expect(params.parallel_tool_calls).toBe(true);
		expect(params.input.some((item) => item.type === "additional_tools")).toBe(false);
		// The system prompt is a developer message on this wire for every row —
		// the frame is not a lite feature.
		expect(params.input[0]).toEqual({ role: "developer", content: [{ type: "input_text", text: "sys" }] });
		// The inherited default applies — `medium` for a level the session never
		// named — and no `context` comes with it on this wire's rows.
		expect(params.reasoning).toEqual({ effort: "medium", summary: "auto" });
	});

	test("the full wire keeps an asked-for effort and never grows a context", () => {
		const params = buildChatGptRequest(FULL, ctx(), { thinkingLevel: "high" });
		expect(params.reasoning).toEqual({ effort: "high", summary: "auto" });
		// `off` is the absence: no reasoning block at all, and no context either.
		expect(buildChatGptRequest(FULL, ctx(), { thinkingLevel: "off" }).reasoning).toBeUndefined();
	});

	test("retention never goes out, and the routing key and include do", () => {
		const params = buildChatGptRequest(LITE, ctx());
		// The backend's request struct has no such field; a caller asking for a
		// retention window cannot smuggle one in through the shared builder.
		expect("prompt_cache_retention" in params).toBe(false);
		// The key is the opposite: the backend's client sends it on every request,
		// the capability row records that, and so the default policy resolves one.
		expect(typeof params.prompt_cache_key).toBe("string");
		// The reasoning blob is requested on every request, the same as the public
		// Responses wire: without it there is nothing to replay a reasoning item
		// with, and with `store: false` nothing on the far side to replay from.
		expect(params.include).toEqual(["reasoning.encrypted_content"]);
	});

	test("max_output_tokens rides only when asked", () => {
		expect(buildChatGptRequest(LITE, ctx(), { maxOutputTokens: 512 }).max_output_tokens).toBe(512);
		expect("max_output_tokens" in buildChatGptRequest(LITE, ctx())).toBe(false);
	});
});

describe("chatGptHeaders", () => {
	test("the originator is always there; account and fedramp only when the grant has them", () => {
		expect(chatGptHeaders({ token: "t", expiresAt: null, accountId: null, fedramp: false })).toEqual({
			originator: CHATGPT_ORIGINATOR,
		});
		expect(chatGptHeaders(GRANT)).toEqual({ originator: CHATGPT_ORIGINATOR, "ChatGPT-Account-ID": "acct-1" });
		expect(chatGptHeaders({ ...GRANT, fedramp: true })).toEqual({
			originator: CHATGPT_ORIGINATOR,
			"ChatGPT-Account-ID": "acct-1",
			"X-OpenAI-Fedramp": "true",
		});
	});

	test("the wire's own headers win a collision with the caller's", () => {
		const headers = chatGptHeaders(GRANT, {
			originator: "not-codex",
			"ChatGPT-Account-ID": "spoofed",
			"x-gateway": "route-a",
		});
		expect(headers).toEqual({
			originator: CHATGPT_ORIGINATOR,
			"ChatGPT-Account-ID": "acct-1",
			"x-gateway": "route-a",
		});
	});
});

describe("createChatGptStreamFn", () => {
	test("the request goes out on responses.create with the grant's headers and the lite body", async () => {
		const seen: Array<{ params: any; headers: any; token: string }> = [];
		const streamFn = createChatGptStreamFn({
			credentials: grantProvider([GRANT]),
			clientFactory: (grant) => ({
				responses: {
					async create(params: any, options?: { headers?: Record<string, string> }) {
						seen.push({ params, headers: options?.headers, token: grant.token });
						return completed();
					},
				},
			}),
		});
		const events = await collect(streamFn(LITE, ctx({ tools: TOOLS }), { headers: { "x-gateway": "route-a" } }));
		expect(events.at(-1)?.type).toBe("done");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.token).toBe("tok-1");
		expect(seen[0]?.headers).toEqual({
			"x-gateway": "route-a",
			originator: CHATGPT_ORIGINATOR,
			"ChatGPT-Account-ID": "acct-1",
		});
		// The lite body rode along: this is the request shape, through the live path.
		expect(seen[0]?.params.input[0].type).toBe("additional_tools");
	});

	test("a 401 re-mints once, bypassing the freshness window, and the retry authenticates with the new grant", async () => {
		// The grant is threaded into the client factory on purpose: the claim is
		// not just "a retry happened" but "the retry went out on the token the
		// forced mint produced", and the token the factory saw is the observable.
		const calls: Array<{ forceRefresh?: boolean } | undefined> = [];
		const tokens: string[] = [];
		let attempt = 0;
		const streamFn = createChatGptStreamFn({
			credentials: grantProvider([GRANT, { ...GRANT, token: "tok-2", accountId: "acct-2" }], calls),
			clientFactory: (grant) => ({
				responses: {
					async create() {
						tokens.push(grant.token);
						if (attempt++ === 0) throw Object.assign(new Error("unauthorized"), { status: 401 });
						return completed();
					},
				},
			}),
		});
		const events = await collect(streamFn(LITE, ctx()));
		expect(events.at(-1)?.type).toBe("done");
		expect(tokens).toEqual(["tok-1", "tok-2"]);
		expect(calls).toEqual([undefined, { forceRefresh: true }]);
	});

	test("a second 401 is the account's answer, not another refresh", async () => {
		const calls: Array<{ forceRefresh?: boolean } | undefined> = [];
		let attempt = 0;
		const streamFn = createChatGptStreamFn({
			credentials: grantProvider([GRANT, { ...GRANT, token: "tok-2" }], calls),
			clientFactory: () => ({
				responses: {
					async create() {
						attempt++;
						throw Object.assign(new Error("unauthorized"), { status: 401 });
					},
				},
			}),
		});
		await expect(collect(streamFn(LITE, ctx()))).rejects.toThrow("unauthorized");
		expect(attempt).toBe(2);
		// One forced refresh, not one per attempt: the second 401 on a token minted
		// moments ago is not a stale token's.
		expect(calls).toEqual([undefined, { forceRefresh: true }]);
	});

	test("a refresh that fails leaves the original 401 as the answer", async () => {
		// The API's refusal is the better report: it is what the endpoint said,
		// where the refresh failure is about a token that is not the request's.
		const credentials: ChatGptTokenProvider = Object.assign(
			async (options?: { forceRefresh?: boolean }) => {
				if (options?.forceRefresh) throw new ChatGptOAuthError("dead refresh token", { invalidGrant: true });
				return GRANT;
			},
			{ available: async () => true },
		);
		const streamFn = createChatGptStreamFn({
			credentials,
			clientFactory: () => ({
				responses: {
					async create() {
						throw Object.assign(new Error("unauthorized"), { status: 401 });
					},
				},
			}),
		});
		await expect(collect(streamFn(LITE, ctx()))).rejects.toThrow("unauthorized");
	});

	test("a failure that is not a 401 does not re-mint", async () => {
		const calls: Array<{ forceRefresh?: boolean } | undefined> = [];
		const streamFn = createChatGptStreamFn({
			credentials: grantProvider([GRANT], calls),
			clientFactory: () => ({
				responses: {
					async create() {
						throw Object.assign(new Error("overloaded"), { status: 500 });
					},
				},
			}),
		});
		await expect(collect(streamFn(LITE, ctx()))).rejects.toThrow("overloaded");
		expect(calls).toHaveLength(1);
	});

	test("no credentials at all is the login error, and nothing dials", async () => {
		const streamFn = createChatGptStreamFn({
			clientFactory: () => {
				throw new Error("must not dial");
			},
		});
		await expect(collect(streamFn(LITE, ctx()))).rejects.toThrow(
			"Not signed in to a ChatGPT subscription for gpt-6.1-sol: run /login.",
		);
	});
});

describe("dispatch", () => {
	test("a chatgpt row reaches the chatgpt adapter through the default stream fn", async () => {
		// The claim an adapter-local file cannot make: that `model.api` is what
		// routes it, and that the pre-flight lets it through with no key anywhere —
		// these rows name no key variable, so the missing-key error must not fire.
		const model = resolveModel("chatgpt/gpt-6.1-sol");
		expect(model).toBeDefined();
		const seen: any[] = [];
		const streamFn = createDefaultStreamFn({
			chatgptCredentials: grantProvider([GRANT]),
			chatgptClientFactory: () => ({
				responses: {
					async create(params: any) {
						seen.push(params);
						return completed();
					},
				},
			}),
		});
		const events = await collect(streamFn(model as Model, ctx({ tools: TOOLS })));
		expect(events.at(-1)?.type).toBe("done");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.model).toBe("gpt-6.1-sol");
		expect(seen[0]?.input[0].type).toBe("additional_tools");
	});

	test("the rows behind the subscription reach their own wire", () => {
		const lite = resolveModel("chatgpt/gpt-6.1-sol");
		expect(lite?.api).toBe("chatgpt-responses");
		expect(lite?.provider).toBe("chatgpt");
		expect(lite?.responsesLite).toBe(true);
		// No key variable, and the absence is the statement: the sign-in is the
		// only way in.
		expect(lite?.apiKeyEnv).toBeUndefined();
		// The catalog's levels run low through ultra: `minimal` is ours, not this
		// backend's, and the row must say so rather than accept and round.
		expect(lite?.reasoningEfforts).toEqual(["low", "medium", "high"]);
		const full = resolveModel("chatgpt/gpt-5.5");
		expect(full?.api).toBe("chatgpt-responses");
		expect(full?.responsesLite).toBeUndefined();
	});

	test("a bare id resolves to the first-party API row, and gpt-5.5 to the subscription", () => {
		// The ordering requirement, pinned: the subscription block sits *after*
		// the openai block, so the ids both catalogs carry answer at the API
		// first and only the subscription's own id routes there bare.
		expect(resolveModel("gpt-6.1-sol")?.provider).toBe("openai");
		expect(resolveModel("gpt-5.5")?.provider).toBe("chatgpt");
	});
});
