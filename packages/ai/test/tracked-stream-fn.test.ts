/**
 * The composed default transport: dispatch, retry policy, the adapter's own
 * ladder, and the tracker that observes all of it.
 *
 * Every other test in this package drives a piece of that stack directly — the
 * adapter through an injected client, the tracker through a stub stream — and
 * the seam between the two is exactly where a wire could be left unconnected:
 * a notice the adapter raises has to travel out through `withRetry` and land in
 * the list the tracker reads, or `/cache` shows a fallback that never happened.
 * So this test goes through the real SDK over a stubbed `fetch`, which is the
 * one path the other three cannot reach.
 *
 * The stub answers with real HTTP: a 400 whose body names the field, then a
 * real SSE stream. Nothing here depends on the network, and nothing is billed.
 */
import { describe, expect, test } from "bun:test";
import { createTrackedStreamFn } from "../src/index.ts";
import type { Context, Model } from "../src/types.ts";
import { userMessage } from "../src/types.ts";

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
	input: ["text"],
};

/** Long enough that the breakpoint planner has something to mark. */
function longCtx(): Context {
	return { systemPrompt: "s".repeat(8_000), messages: [userMessage("u".repeat(8_000))] };
}

/** One complete response, as the SSE the SDK parses. */
const SSE_BODY = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

/** A 400 whose wording names the field the provider would not take. */
function cacheRefusal(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message: "cache_control: Extra inputs are not permitted" },
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function okStream(): Response {
	return new Response(SSE_BODY, { headers: { "content-type": "text/event-stream" } });
}

/** The chat-completions spelling of the same thing: data-only SSE, then [DONE]. */
const CHAT_BODY = [
	'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
	'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
	"data: [DONE]\n\n",
].join("");

function chatStream(): Response {
	return new Response(CHAT_BODY, { headers: { "content-type": "text/event-stream" } });
}

/**
 * Answer each request from `answer`, restoring the global fetch afterwards.
 *
 * `bodies` collects what each request actually put on the wire, which is the
 * only way to see that a downgrade reached the request rather than only the
 * report.
 */
async function withFetch(
	answer: (call: number) => Response,
	body: (bodies: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
	const realFetch = globalThis.fetch;
	const bodies: Array<Record<string, unknown>> = [];
	let call = 0;
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		call++;
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return answer(call);
	}) as unknown as typeof fetch;
	try {
		await body(bodies);
	} finally {
		globalThis.fetch = realFetch;
	}
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
	for await (const _event of events) {
		// drained: the tracker records on the terminal event
	}
}

describe("createTrackedStreamFn", () => {
	test("a refusal the adapter worked around reaches the report", async () => {
		await withFetch(
			(call) => (call === 1 ? cacheRefusal() : okStream()),
			async (bodies) => {
				const { streamFn, tracker } = createTrackedStreamFn();
				await drain(streamFn(MODEL, longCtx(), { apiKey: "test-key" }));

				// Out through the adapter, past the retry wrapper, into the list the
				// tracker hands to `/cache`.
				expect(tracker.notices()).toEqual([
					{
						kind: "ttl-downgrade",
						from: "1h",
						to: "5m",
						reason: expect.stringContaining("cache_control"),
					},
				]);
				// And the request that succeeded is the one at the short TTL: the notice
				// describes the wire, not a label applied after the fact.
				const system = bodies[1]?.system as Array<{ cache_control?: Record<string, unknown> }>;
				expect(system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
				expect(tracker.records()).toHaveLength(1);
				expect(tracker.records()[0]?.kind).toBe("first");
			},
		);
	});

	test("a request that was never refused reports no notice at all", async () => {
		// The negative half: a wiring that always produced a notice would pass the
		// test above and mislead every reader of `/cache`.
		await withFetch(
			() => okStream(),
			async () => {
				const { streamFn, tracker } = createTrackedStreamFn();
				await drain(streamFn(MODEL, longCtx(), { apiKey: "test-key" }));
				expect(tracker.notices()).toEqual([]);
				expect(tracker.records()).toHaveLength(1);
			},
		);
	});

	test("the policy reaches the wire through the composed transport", async () => {
		// `settings.cache` is read by the apps and handed to this factory, so the
		// policy has to survive dispatch and retry rather than being dropped at
		// the first hop.
		await withFetch(
			() => okStream(),
			async (bodies) => {
				const { streamFn } = createTrackedStreamFn({ policy: { explicitBreakpoints: false } });
				await drain(streamFn(MODEL, longCtx(), { apiKey: "test-key" }));
				expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
			},
		);
	});

	test("the chat-completions path carries the routing key the policy allows", async () => {
		// The other wire format, dispatched by the same factory: the key is decided
		// by the provider row, and the policy is the only way to overrule it.
		const openaiModel: Model = {
			...MODEL,
			id: "gpt-5.5",
			provider: "openai",
			api: "openai-completions",
			baseUrl: "https://api.openai.com/v1",
			apiKeyEnv: "OPENAI_API_KEY",
		};
		await withFetch(
			() => chatStream(),
			async (bodies) => {
				const { streamFn } = createTrackedStreamFn();
				await drain(streamFn(openaiModel, longCtx(), { apiKey: "test-key" }));
				expect(String(bodies[0]?.prompt_cache_key).startsWith("labunbun-")).toBe(true);
			},
		);
		await withFetch(
			() => chatStream(),
			async (bodies) => {
				const { streamFn } = createTrackedStreamFn({ policy: { promptCacheKey: "off" } });
				await drain(streamFn(openaiModel, longCtx(), { apiKey: "test-key" }));
				expect(bodies[0]?.prompt_cache_key).toBeUndefined();
			},
		);
	});
});
