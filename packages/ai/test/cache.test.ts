import { describe, expect, test } from "bun:test";
import {
	cacheCapability,
	cacheCeiling,
	cachedTokensFrom,
	cacheHitRate,
	cacheTotals,
	DEFAULT_CACHE_POLICY,
	estimatePrefixTokens,
	prefixTierTokens,
	promptCacheKeyFor,
	promptTotalsOf,
	resolveCacheTtl,
	resolvePromptCacheKey,
	resolvePromptCacheRetention,
	totalsHitRate,
} from "../src/cache.ts";
import type { Context, Model, Usage } from "../src/types.ts";
import { assistantMessage, toolResultMessage, userMessage } from "../src/types.ts";

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

function usage(overrides: Partial<Usage> = {}): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides };
}

describe("cacheCapability", () => {
	test("explicit provider reports its documented minimum and TTLs", () => {
		const cap = cacheCapability(model());
		expect(cap.mode).toBe("explicit");
		expect(cap.minPrefixTokens).toBe(1024);
		expect(cap.ttl).toEqual(["5m", "1h"]);
		expect(cap.promptCacheKey).toBe(false);
	});

	test("Anthropic's floor is per model, and the spread is not a family rule", () => {
		const floor = (id: string) => cacheCapability(model({ id })).minPrefixTokens;
		expect(floor("claude-opus-5")).toBe(512);
		expect(floor("claude-sonnet-5")).toBe(1024);
		expect(floor("claude-opus-4-7")).toBe(2048);
		expect(floor("claude-haiku-4-5")).toBe(4096);
		expect(floor("claude-3-5-haiku-latest")).toBe(2048);
	});

	test("a dated suffix does not change the floor", () => {
		expect(cacheCapability(model({ id: "claude-haiku-4-5-20251001" })).minPrefixTokens).toBe(4096);
		expect(cacheCapability(model({ id: "claude-opus-4-1-20250805" })).minPrefixTokens).toBe(1024);
	});

	test("ids that are prefixes of one another resolve to their own row", () => {
		const floor = (id: string) => cacheCapability(model({ id })).minPrefixTokens;
		// Opus 4.5 and 4.6 take 4096 while the rest of Opus 4 takes 1024, so the
		// order of the table is load-bearing.
		expect(floor("claude-opus-4-5")).toBe(4096);
		expect(floor("claude-opus-4-6")).toBe(4096);
		expect(floor("claude-opus-4")).toBe(1024);
		expect(floor("claude-opus-4-8")).toBe(1024);
	});

	test("an unrecognised Anthropic model gets the lowest documented floor", () => {
		// Erring low costs a breakpoint the provider ignores; erring high silently
		// forfeits every hit, so the unknown row is the cheapest one.
		expect(cacheCapability(model({ id: "claude-something-new" })).minPrefixTokens).toBe(512);
	});

	test("an Anthropic-shaped gateway gets breakpoints even if the provider is unknown", () => {
		// The wire format decides whether a marker is accepted, not the name under
		// which the endpoint was registered.
		const gateway = cacheCapability(
			model({ id: "claude-sonnet-5", provider: "someone-elses-gateway", api: "anthropic-messages" }),
		);
		expect(gateway.mode).toBe("explicit");
		expect(gateway.minPrefixTokens).toBe(1024);
	});

	test("automatic providers differ in minimum and granularity", () => {
		const openai = cacheCapability(model({ provider: "openai", api: "openai-completions" }));
		expect(openai.mode).toBe("automatic");
		expect(openai.minPrefixTokens).toBe(1024);
		expect(openai.incrementTokens).toBe(128);
		expect(openai.promptCacheKey).toBe(true);

		const kimi = cacheCapability(model({ provider: "kimi", api: "openai-completions" }));
		expect(kimi.minPrefixTokens).toBe(256);
		expect(kimi.ttl).toEqual([]);
		// Kimi's guide describes caching as automatic and documents no routing key.
		// Third-party clients forward one anyway and independent tests call it a
		// no-op, so the row records what the documentation says; `promptCacheKey:
		// "on"` is the setting for an endpoint that turns out to want one.
		expect(kimi.promptCacheKey).toBe(false);
	});

	test("an unmeasured provider falls back to the conservative row", () => {
		const cap = cacheCapability(model({ provider: "someone-elses-gateway", api: "openai-completions" }));
		expect(cap.mode).toBe("automatic");
		expect(cap.minPrefixTokens).toBe(1024);
		expect(cap.promptCacheKey).toBe(false);
	});

	test("a small-model override does not leak into other providers", () => {
		// A Haiku-shaped id on a non-Anthropic provider keeps that provider's row.
		const cap = cacheCapability(model({ id: "haiku-clone", provider: "kimi", api: "openai-completions" }));
		expect(cap.minPrefixTokens).toBe(256);
	});
});

describe("cacheHitRate", () => {
	test("is the cached share of the whole prompt", () => {
		expect(cacheHitRate(usage({ input: 100, cacheRead: 900, cacheWrite: 0, promptTotal: 1000 }))).toBeCloseTo(0.9);
	});

	test("undefined when the request did not report a prompt total", () => {
		// Zero would read as "the cache did nothing", which is a different claim.
		expect(cacheHitRate(usage({ cacheRead: 500 }))).toBeUndefined();
		expect(cacheHitRate(usage({ promptTotal: 0 }))).toBeUndefined();
	});

	test("a write-only request scores zero, not undefined", () => {
		expect(cacheHitRate(usage({ input: 0, cacheWrite: 1000, promptTotal: 1000 }))).toBe(0);
	});
});

describe("cachedTokensFrom", () => {
	test("reads the nested OpenAI spelling", () => {
		expect(cachedTokensFrom({ prompt_tokens_details: { cached_tokens: 42 } })).toBe(42);
	});

	test("reads Kimi's top-level spelling", () => {
		expect(cachedTokensFrom({ cached_tokens: 700 })).toBe(700);
	});

	test("reads DeepSeek's prompt_cache_hit_tokens", () => {
		expect(cachedTokensFrom({ prompt_cache_hit_tokens: 900 })).toBe(900);
	});

	test("takes the largest when spellings disagree", () => {
		// A gateway that emits a stale nested zero next to a correct top-level
		// count must not read as a miss: under-reporting is the bug being fixed.
		expect(cachedTokensFrom({ prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 1234 })).toBe(1234);
	});

	test("undefined when no spelling is present", () => {
		expect(cachedTokensFrom({})).toBeUndefined();
		expect(cachedTokensFrom({ prompt_tokens_details: null })).toBeUndefined();
	});
});

describe("estimatePrefixTokens", () => {
	const base: Context = { systemPrompt: "You are helpful.", messages: [] };

	test("anchors on the last assistant usage and adds what came after", () => {
		const context: Context = {
			...base,
			messages: [
				userMessage("first"),
				assistantMessage({ usage: usage({ input: 1000, output: 200, promptTotal: 1000 }) }),
				// 400 chars of new text at ~4 chars/token.
				userMessage("x".repeat(400)),
			],
		};
		const system = Math.ceil(base.systemPrompt.length / 4);
		expect(estimatePrefixTokens(context)).toBe(1000 + 200 + 100 + system);
	});

	test("with no assistant message at all, counts every character", () => {
		const context: Context = { ...base, messages: [userMessage("y".repeat(400))] };
		expect(estimatePrefixTokens(context)).toBe(100 + Math.ceil(base.systemPrompt.length / 4));
	});

	test("counts the tool schema at its own density", () => {
		const context: Context = {
			...base,
			tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
		};
		const schema = JSON.stringify(context.tools);
		expect(estimatePrefixTokens(context)).toBe(Math.ceil(schema.length / 3) + Math.ceil(base.systemPrompt.length / 4));
	});

	test("counts thinking and tool-call arguments as prompt bytes", () => {
		const context: Context = {
			...base,
			messages: [
				assistantMessage({
					content: [
						{ type: "thinking", thinking: "z".repeat(80) },
						{ type: "toolCall", id: "t1", name: "ls", arguments: "a".repeat(40) },
					],
				}),
			],
		};
		expect(estimatePrefixTokens(context)).toBe(30 + Math.ceil(base.systemPrompt.length / 4));
	});

	test("a tool result is counted too", () => {
		const context: Context = {
			...base,
			messages: [toolResultMessage("t1", "ls", [{ type: "text", text: "r".repeat(200) }])],
		};
		expect(estimatePrefixTokens(context)).toBe(50 + Math.ceil(base.systemPrompt.length / 4));
	});
});

describe("cacheCeiling", () => {
	test("each request can read at most the previous prompt", () => {
		// 1000 + 2000 read out of 1000 + 2000 + 3000.
		expect(cacheCeiling([1000, 2000, 3000])).toBeCloseTo(3000 / 6000);
	});

	test("a steady conversation approaches one as it lengthens", () => {
		const sizes = Array.from({ length: 200 }, (_, i) => 100_000 + i * 100);
		const ceiling = cacheCeiling(sizes);
		expect(ceiling).toBeGreaterThan(0.99);
	});

	test("undefined below two measurable requests", () => {
		expect(cacheCeiling([])).toBeUndefined();
		expect(cacheCeiling([1000])).toBeUndefined();
		expect(cacheCeiling([0, 0])).toBeUndefined();
	});
});

describe("prefixTierTokens", () => {
	test("is cumulative at each tier boundary", () => {
		const context: Context = {
			systemPrompt: "s".repeat(400),
			messages: [userMessage("x".repeat(400))],
			tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
		};
		const schema = Math.ceil(JSON.stringify(context.tools).length / 3);
		const tiers = prefixTierTokens(context);
		expect(tiers.tools).toBe(schema);
		expect(tiers.system).toBe(schema + 100);
		expect(tiers.messages).toBe(schema + 100 + 100);
	});

	test("agrees with estimatePrefixTokens on the whole request", () => {
		const context: Context = { systemPrompt: "hello", messages: [userMessage("world")] };
		expect(estimatePrefixTokens(context)).toBe(prefixTierTokens(context).messages);
	});
});

describe("cache policy", () => {
	test("an unset policy asks for the long TTL and marks the prefix", () => {
		expect(resolveCacheTtl()).toBe("1h");
		expect(resolveCacheTtl(DEFAULT_CACHE_POLICY)).toBe("1h");
		expect(DEFAULT_CACHE_POLICY.explicitBreakpoints).toBe(true);
	});

	test('"auto" and "1h" agree; an explicit short TTL is honoured', () => {
		expect(resolveCacheTtl({ ttl: "auto" })).toBe("1h");
		expect(resolveCacheTtl({ ttl: "1h" })).toBe("1h");
		expect(resolveCacheTtl({ ttl: "5m" })).toBe("5m");
		// Turning breakpoints off says nothing about the TTL, and the TTL says
		// nothing about breakpoints: they are separate knobs.
		expect(resolveCacheTtl({ explicitBreakpoints: false })).toBe("1h");
	});
});

describe("the routing key", () => {
	const openai = model({ provider: "openai", api: "openai-completions", id: "gpt-5.5" });
	const gateway = model({ provider: "someone-elses-gateway", api: "openai-completions", id: "gpt-5.5" });
	const prefix = (systemPrompt = "sys", tools: Context["tools"] = undefined): Context => ({
		systemPrompt,
		messages: [userMessage("ask")],
		tools,
	});

	test("auto follows the provider's own documentation and nothing else", () => {
		expect(resolvePromptCacheKey(undefined, cacheCapability(openai))).toBe(true);
		expect(resolvePromptCacheKey({ promptCacheKey: "auto" }, cacheCapability(openai))).toBe(true);
		// DeepSeek's guide documents no such field, and an unmeasured gateway is
		// not a provider whose docs can be read at all.
		const deepseek = model({ provider: "deepseek", api: "openai-completions" });
		expect(resolvePromptCacheKey(undefined, cacheCapability(deepseek))).toBe(false);
		expect(resolvePromptCacheKey(undefined, cacheCapability(gateway))).toBe(false);
	});

	test("an explicit mode overrides the row in both directions", () => {
		// "on" exists for an endpoint that wants the field and does not say so; a
		// provider that documents it can still be told to leave it out.
		expect(resolvePromptCacheKey({ promptCacheKey: "on" }, cacheCapability(gateway))).toBe(true);
		expect(resolvePromptCacheKey({ promptCacheKey: "off" }, cacheCapability(openai))).toBe(false);
	});

	test("retention goes only to the provider that documents the field", () => {
		expect(resolvePromptCacheRetention(undefined, cacheCapability(openai))).toBeUndefined();
		expect(resolvePromptCacheRetention({ promptCacheRetention: "24h" }, cacheCapability(openai))).toBe("24h");
		expect(resolvePromptCacheRetention({ promptCacheRetention: "in_memory" }, cacheCapability(openai))).toBe(
			"in_memory",
		);
		// Not even when asked: a gateway that has never heard of the field answers a
		// request carrying it with a 400.
		expect(resolvePromptCacheRetention({ promptCacheRetention: "24h" }, cacheCapability(gateway))).toBeUndefined();
	});

	test("the key names the prefix, so the same prefix gets the same key", () => {
		// The whole point: a resumed session, or a second process, has to arrive at
		// the same routing key without having stored anything.
		const first = promptCacheKeyFor(openai, prefix());
		const second = promptCacheKeyFor(openai, { systemPrompt: "sys", messages: [], tools: undefined });
		expect(first).toBe(second);
		expect(first.startsWith("labunbun-")).toBe(true);
	});

	test("everything the prefix is keyed on moves the key", () => {
		const base = promptCacheKeyFor(openai, prefix());
		expect(promptCacheKeyFor(openai, prefix("other"))).not.toBe(base);
		expect(
			promptCacheKeyFor(openai, prefix("sys", [{ name: "read", description: "d", parameters: { type: "object" } }])),
		).not.toBe(base);
		expect(promptCacheKeyFor(model({ ...openai, id: "gpt-5.4" }), prefix())).not.toBe(base);
		// The api is in there too: the same id behind a different wire format is a
		// different cache.
		expect(promptCacheKeyFor(model({ ...openai, api: "anthropic-messages" }), prefix())).not.toBe(base);
	});

	test("messages are not part of the identity, because they are what grows", () => {
		// A key that moved with every turn would name a fresh cache each time and
		// route nothing anywhere.
		expect(promptCacheKeyFor(openai, { systemPrompt: "sys", messages: [userMessage("one")] })).toBe(
			promptCacheKeyFor(openai, { systemPrompt: "sys", messages: [userMessage("one"), userMessage("two")] }),
		);
	});
});

describe("promptTotalsOf / cacheTotals / totalsHitRate", () => {
	const messages = [
		userMessage("hi"),
		assistantMessage({ usage: usage({ input: 10, cacheRead: 90, promptTotal: 100 }) }),
		assistantMessage({ usage: usage({ input: 0, cacheRead: 0 }) }),
		assistantMessage({ usage: usage({ input: 5, output: 7, cacheRead: 95, cacheWrite: 0, promptTotal: 100 }) }),
	];

	test("prompt totals come back in order, skipping the unreported one", () => {
		expect(promptTotalsOf(messages)).toEqual([100, 100]);
	});

	test("totals sum every channel and count requests", () => {
		const totals = cacheTotals(messages);
		expect(totals).toEqual({ read: 185, write: 0, input: 15, output: 7, requests: 3 });
		expect(totalsHitRate(totals)).toBeCloseTo(185 / 200);
	});

	test("totalsHitRate is undefined when nothing was reported", () => {
		expect(totalsHitRate({ read: 0, write: 0, input: 0, output: 0, requests: 0 })).toBeUndefined();
	});
});
