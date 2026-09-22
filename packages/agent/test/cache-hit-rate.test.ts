/**
 * The hit rate a real conversation gets, measured end to end.
 *
 * Everything above the socket is production: the real adapters, the real retry
 * policy, the real SDK clients, the real agent loop, and the tracker the app
 * builds its report from. What answers is a local endpoint that caches prefixes
 * the way the vendors document (`cache-stub-server.ts`), so the number this
 * file asserts is a statement about the machinery — that the breakpoints land
 * where the prefix actually ends and the bytes in between never move — and not
 * a claim about any vendor's cache. A real number comes from `/cache` against a
 * real endpoint; this is the strongest evidence available without one.
 *
 * The conversation is shaped so the bar is meaningful. A request can only read
 * what an earlier request wrote, so the best any sequence can do is
 * `sum(P[t-1]) / sum(P[t])` — a ceiling that falls as the final prompt grows
 * against the sum of all prompts. Here the prompt is large from the start and
 * each turn adds a little to it, which puts the ceiling above 99%; the tests
 * assert both that number and the rate achieved against it, because a session
 * at its own ceiling and a session throwing tokens away can print the same
 * percentage.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { AgentSession, buildTool } from "@labunbun/agent";
import {
	cacheCeiling,
	cacheTotals,
	createTrackedStreamFn,
	type Model,
	promptTotalsOf,
	totalsHitRate,
} from "@labunbun/ai";
import { z } from "zod";
import { type StubStep, startCacheStub } from "../../ai/test/cache-stub-server.ts";

/**
 * A credential nobody checks.
 *
 * Its own variable rather than a provider's: this file writes an environment
 * variable, and writing `ANTHROPIC_API_KEY` would change what every other test
 * in the process sees. The endpoint is on the loopback interface and rejects
 * nothing; the key only has to be non-empty.
 */
const KEY_ENV = "LABUNBUN_CACHE_STUB_KEY";
process.env[KEY_ENV] = "local-test-key";

/** A model pointing at a local endpoint instead of a provider. */
function stubModel(api: Model["api"], provider: string, baseUrl: string, id: string): Model {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl,
		apiKeyEnv: KEY_ENV,
		contextWindow: 200_000,
		maxOutputTokens: 4_096,
		reasoning: false,
		input: ["text"],
		pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	};
}

/**
 * A system prompt big enough to be worth caching.
 *
 * It has to clear the model's documented floor on its own — a prefix below it
 * is not cached at all — and it is the fixed part of every request, so it is
 * also what makes the ceiling high: a large `P[0]` with small growth is a
 * conversation where the sum is dominated by prefixes that could be read.
 */
const SYSTEM = Array.from(
	{ length: 600 },
	(_, i) => `Rule ${i}: keep the transcript byte-stable and never rewrite a message that was already sent.`,
).join("\n");

/** The tool the conversation loops through, so the transcript grows in real shapes. */
const noop = buildTool({
	name: "noop",
	description: "Record that a step happened. Reads nothing, writes nothing.",
	inputSchema: z.object({ n: z.number() }),
	isReadOnly: () => true,
	call: async (input) => ({ content: [{ type: "text", text: `noop ${input.n}` }] }),
});

/** `prompts` turns of tool round plus answer: two requests each. */
function script(prompts: number): StubStep[] {
	return Array.from({ length: prompts * 2 }, (_, i) =>
		i % 2 === 0 ? { tool: { name: "noop", input: { n: i } } } : { text: `answer ${i}` },
	);
}

/** Run `prompts` turns against the endpoint and hand back the session. */
async function converse(options: {
	model: Model;
	prompts: number;
	tracked: ReturnType<typeof createTrackedStreamFn>;
}): Promise<AgentSession> {
	const session = new AgentSession({
		model: options.model,
		systemPrompt: SYSTEM,
		tools: [noop],
		deps: { streamFn: options.tracked.streamFn },
	});
	for (let i = 0; i < options.prompts; i++) {
		await session.prompt(`turn ${i}`);
	}
	return session;
}

const stubs: Array<ReturnType<typeof startCacheStub>> = [];
function stub(options: Parameters<typeof startCacheStub>[0]): ReturnType<typeof startCacheStub> {
	const started = startCacheStub(options);
	stubs.push(started);
	return started;
}

afterAll(() => {
	for (const started of stubs.splice(0)) started.stop();
});

describe("a conversation's cache hit rate", () => {
	test("clears 99% while staying at its ceiling, with no rewrite nobody declared", async () => {
		const prompts = 120;
		const server = stub({ steps: script(prompts), modelId: "claude-opus-5", minPrefixTokens: 512 });
		const tracked = createTrackedStreamFn();
		const session = await converse({
			model: stubModel("anthropic-messages", "anthropic", server.baseUrl, "claude-opus-5"),
			prompts,
			tracked,
		});

		// Two requests per turn: the tool round and the answer after it.
		expect(server.requests).toHaveLength(prompts * 2);

		const totals = cacheTotals(session.messages);
		const rate = totalsHitRate(totals);
		const ceiling = cacheCeiling(promptTotalsOf(session.messages));
		expect(rate).toBeDefined();
		expect(ceiling).toBeDefined();
		if (rate === undefined || ceiling === undefined) return;

		// The bar the work was measured against, and the arithmetic that says this
		// workload can reach it.
		expect(ceiling).toBeGreaterThan(0.99);
		expect(rate).toBeGreaterThanOrEqual(0.99);
		// And everything that was reachable was reached: a lower rate here would mean
		// tokens were thrown away, not that the conversation was short.
		expect(rate).toBeGreaterThanOrEqual(ceiling - 0.001);

		// Every request after the first was an exact extension of the one before it.
		// A rewind is the failure the whole design exists to prevent, and it is
		// checked per request rather than inferred from the rate.
		const records = tracked.tracker.records();
		expect(records.filter((record) => record.kind === "rewind")).toEqual([]);
		expect(records.filter((record) => record.kind === "first")).toHaveLength(1);
		expect(records.filter((record) => record.kind === "extension")).toHaveLength(records.length - 1);

		// The prefix was billed two ways and never a third: after the cold start, no
		// token of any prompt was charged at the full uncached rate, because every
		// one of them was either read from the cache or written to it.
		expect(server.requests.slice(1).filter((request) => request.usage.input > 0)).toEqual([]);
		expect(server.requests.every((request) => request.marks > 0)).toBe(true);
	}, 120_000);

	test("keeps the whole prefix cached across turns that answer many tools at once", async () => {
		// A turn that answers twelve tools at once is where a breakpoint's *place*
		// inside a message stops being a detail. A breakpoint caches the prefix
		// through the block it sits on, so marking the first block of a twelve-block
		// answer covers one block and leaves eleven to be charged again — invisible
		// on a quiet turn, where every message is one block, and visible here as a
		// full-price remainder on every request after the first.
		//
		// It is also the turn where the vendor's own look-back cannot help: it reads
		// back twenty *blocks*, and twelve tool calls are twenty-four of them between
		// two consecutive requests. Whatever the previous request wrote is beyond its
		// reach, so a prefix that survives a turn this heavy survives because the
		// client marked it, not because the endpoint went looking.
		const turns = 20;
		const perTurn = 12;
		const server = stub({
			steps: Array.from({ length: turns * 2 }, (_, i) =>
				i % 2 === 0
					? {
							tools: Array.from({ length: perTurn }, (_, n) => ({ name: "noop", input: { n: i * perTurn + n } })),
						}
					: { text: `answer ${i}` },
			),
			modelId: "claude-opus-5",
			minPrefixTokens: 512,
		});
		const tracked = createTrackedStreamFn();
		const session = await converse({
			model: stubModel("anthropic-messages", "anthropic", server.baseUrl, "claude-opus-5"),
			prompts: turns,
			tracked,
		});

		expect(server.requests).toHaveLength(turns * 2);

		// The turn really was heavy on the wire, or the rest of this test would be
		// asserting nothing: twelve calls in one answer, twelve results in one
		// message after it. Without that, the distance the look-back has to cross
		// is two blocks and any client at all would pass.
		const wire = server.requests[1]?.body.messages as Array<{ role: string; content: unknown }> | undefined;
		expect(wire).toHaveLength(3);
		expect((wire?.[1]?.content as unknown[]) ?? []).toHaveLength(perTurn);
		expect((wire?.[2]?.content as unknown[]) ?? []).toHaveLength(perTurn);

		const totals = cacheTotals(session.messages);
		const rate = totalsHitRate(totals);
		const ceiling = cacheCeiling(promptTotalsOf(session.messages));
		if (rate === undefined || ceiling === undefined) throw new Error("no usage was reported");

		// The bar here is not 99% — a turn this fat grows the prompt too fast for
		// any ceiling to reach it — it is the whole of what was reachable.
		expect(rate).toBeGreaterThanOrEqual(ceiling - 0.001);
		const records = tracked.tracker.records();
		expect(records.filter((record) => record.kind === "rewind")).toEqual([]);
		expect(records.filter((record) => record.kind === "first")).toHaveLength(1);
		expect(server.requests.slice(1).filter((request) => request.usage.input > 0)).toEqual([]);
	}, 120_000);

	test("reads a Kimi-shaped usage field, which used to be read as a miss", async () => {
		// The automatic route: no breakpoints to place, and the count arrives at the
		// top level of `usage` rather than nested under `prompt_tokens_details`.
		// Before that spelling was read, a session with a warm cache was recorded as
		// having read nothing — which is the number this test refuses to accept.
		const prompts = 60;
		const server = stub({
			steps: script(prompts),
			modelId: "kimi-k2-turbo",
			minPrefixTokens: 256,
			usageSpelling: "topLevel",
		});
		const tracked = createTrackedStreamFn();
		const session = await converse({
			model: stubModel("openai-completions", "kimi", server.openAIBaseUrl, "kimi-k2-turbo"),
			prompts,
			tracked,
		});

		const totals = cacheTotals(session.messages);
		const rate = totalsHitRate(totals);
		const ceiling = cacheCeiling(promptTotalsOf(session.messages));
		if (rate === undefined || ceiling === undefined) throw new Error("no usage was reported");

		expect(server.requests).toHaveLength(prompts * 2);
		expect(totals.read).toBeGreaterThan(0);
		expect(rate).toBeGreaterThan(0.95);
		// The gap to the ceiling is the provider's 128-token rounding, which this
		// endpoint implements: one read per request can lose up to 127 tokens, so the
		// bound below is what a correct client can still achieve here.
		const rounding = (128 * server.requests.length) / (totals.read + totals.write + totals.input);
		expect(rate).toBeGreaterThanOrEqual(ceiling - rounding - 0.001);

		// The capability row says this provider documents no routing key, so none
		// goes out — the gate, measured on the wire rather than in the table.
		expect(server.requests.every((request) => request.cacheKey === undefined)).toBe(true);
		expect(tracked.tracker.records().filter((record) => record.kind === "rewind")).toEqual([]);
	}, 120_000);

	test("sends a routing key when the policy asks for one, and the same one every turn", async () => {
		// "on" is for the gateway that turns out to want a key its documentation does
		// not mention. It has to be the *prefix's* key and not the turn's: a key that
		// moved per request would route every turn to a different cache and read
		// nothing.
		const prompts = 3;
		const server = stub({ steps: script(prompts), modelId: "glm-4.6", minPrefixTokens: 500 });
		const tracked = createTrackedStreamFn({ policy: { promptCacheKey: "on" } });
		await converse({
			model: stubModel("openai-completions", "glm", server.openAIBaseUrl, "glm-4.6"),
			prompts,
			tracked,
		});

		const keys = server.requests.map((request) => request.cacheKey);
		expect(keys[0]).toStartWith("labunbun-");
		expect(new Set(keys).size).toBe(1);
	}, 60_000);

	test("climbs down the TTL ladder when the endpoint refuses the field", async () => {
		// The one class of 400 the client can fix by itself, exercised against a
		// socket rather than a stub client: the long TTL is refused, then the short
		// one, and the third attempt carries no `ttl` at all — which any
		// Anthropic-shaped endpoint accepts. Each rung costs one failed request, and
		// the user is told, because a fallback that leaves no trace is a hit rate
		// nobody can explain.
		const server = stub({ steps: [{ text: "answered anyway" }], modelId: "claude-opus-5", rejectTtl: true });
		const noticed: string[] = [];
		const tracked = createTrackedStreamFn({ onCacheNotice: (notice) => noticed.push(`${notice.from}->${notice.to}`) });

		const session = new AgentSession({
			model: stubModel("anthropic-messages", "anthropic", server.baseUrl, "claude-opus-5"),
			systemPrompt: SYSTEM,
			tools: [noop],
			deps: { streamFn: tracked.streamFn },
		});
		await session.prompt("hello");

		expect(server.requests.map((request) => request.status)).toEqual([400, 400, 200]);
		// Every mark on a request carries the same TTL: the rung the ladder is on.
		expect(server.requests.map((request) => [...new Set(request.ttls)])).toEqual([["1h"], ["5m"], [undefined]]);
		expect(server.requests[0]?.marks).toBeGreaterThan(0);
		expect(noticed).toEqual(["1h->5m", "5m->undefined"]);
		expect(tracked.tracker.notices().map((notice) => notice.kind)).toEqual(["ttl-downgrade", "ttl-downgrade"]);
		// What the user sees, including the provider's own words.
		const report = tracked.tracker.notices()[0]?.reason ?? "";
		expect(report).toContain("cache_control.ttl");
	}, 60_000);
});
