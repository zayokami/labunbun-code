/**
 * Anthropic Messages API adapter.
 *
 * Split into pure, individually testable pieces:
 * - `buildAnthropicRequest` — our Context → wire params (message grouping,
 *   thinking budget, cache breakpoints).
 * - `mapAnthropicStream` — raw SSE event objects → AssistantMessageEvent.
 * - `createAnthropicStreamFn` — wires the official SDK client to the two.
 *
 * Tool-call arguments arrive as `input_json_delta` fragments which are buffered
 * raw and parsed once at block end (avoids O(n²) partial-JSON parsing).
 */

import {
	type CacheNotice,
	type CachePolicy,
	type CacheTtl,
	cacheCapability,
	prefixTierTokens,
	resolveCacheTtl,
} from "../cache.ts";
import { MessageBuilder, parseToolArguments } from "../message-builder.ts";
import { type DiscoveredModel, resolveApiKey } from "../model.ts";
import { looksLikeContextOverflow, statusCodeOf } from "../retry.ts";
import type {
	AgentMessage,
	AssistantMessageEvent,
	Context,
	Model,
	StreamOptions,
	ThinkingLevel,
	WireTool,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Raw wire types (structural subset of the SDK's stream events, kept local so
// the mapper is testable with plain fixtures)
// ---------------------------------------------------------------------------

export type AnthropicRawStreamEvent =
	| {
			type: "message_start";
			message?: {
				model?: string;
				usage?: {
					input_tokens?: number;
					output_tokens?: number;
					cache_read_input_tokens?: number;
					cache_creation_input_tokens?: number;
					/** Write tokens split by TTL bucket; null while a diagnosis is pending. */
					cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
				};
			};
	  }
	| {
			type: "content_block_start";
			index?: number;
			content_block?:
				| { type: "text"; text?: string }
				| { type: "thinking"; thinking?: string }
				| { type: "redacted_thinking"; data?: string }
				| { type: "tool_use"; id?: string; name?: string; input?: unknown };
	  }
	| {
			type: "content_block_delta";
			index?: number;
			delta?:
				| { type: "text_delta"; text?: string }
				| { type: "thinking_delta"; thinking?: string }
				| { type: "signature_delta"; signature?: string }
				| { type: "input_json_delta"; partial_json?: string };
	  }
	| { type: "content_block_stop"; index?: number }
	| {
			type: "message_delta";
			delta?: { stop_reason?: string | null };
			usage?: { output_tokens?: number };
	  }
	| { type: "message_stop" }
	| { type: "error"; error?: { type?: string; message?: string } };

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
	minimal: 1024,
	low: 4096,
	medium: 16384,
	high: 32768,
};

export interface AnthropicRequestParams {
	[key: string]: unknown;
	model: string;
	max_tokens: number;
	system?: Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }>;
	messages: Array<Record<string, unknown>>;
	tools?: Array<{ name: string; description: string; input_schema: unknown; cache_control?: AnthropicCacheControl }>;
	stream: true;
	thinking?: { type: "enabled"; budget_tokens: number };
	metadata?: { user_id?: string };
}

interface AnthropicCacheControl {
	type: "ephemeral";
	ttl?: CacheTtl;
}

/** What to ask for on this request: whether to mark, and how long for. */
export interface AnthropicCacheRequest {
	/** Place breakpoints at all. */
	explicit: boolean;
	/** The TTL to ask for; undefined leaves the field off entirely. */
	ttl: CacheTtl | undefined;
}

function defaultCacheRequest(): AnthropicCacheRequest {
	return { explicit: true, ttl: resolveCacheTtl() };
}

function cacheControl(request: AnthropicCacheRequest): AnthropicCacheControl {
	return request.ttl === undefined ? { type: "ephemeral" } : { type: "ephemeral", ttl: request.ttl };
}

/**
 * Which of the four breakpoint slots this request uses.
 *
 * Anthropic's tiers are ordered `tools → system → messages`, and a change at one
 * level invalidates that level and everything below it. So the positions are
 * chosen to be the longest prefixes that do not change between the requests of
 * one conversation:
 *
 *   - `tools`     — the tool definitions, frozen when the session was built;
 *   - `system`    — the same plus the system prompt, which changes only when the
 *                   app rebuilds it (a resumed session, a different working
 *                   directory). Keeping this separate from `tools` means a
 *                   changed system prompt still reads the tools tier back.
 *   - `previous`  — where the request before this one ended;
 *   - `tail`      — where this one ends, written for the next one to read.
 *
 * `previous` is the one that needs justifying. A read is an exact hash match at
 * a breakpoint; failing that the API walks backwards at most 20 positions. In an
 * ordinary tool loop the previous request's tail is two or three positions back
 * — an assistant turn and a run of tool results, which the API counts as one
 * position each — so the walk finds it and the extra breakpoint changes nothing.
 * It exists for the case where the tail moved further than the walk reaches,
 * where having a breakpoint *on* the position rather than searching for it turns
 * a full miss into a full read.
 *
 * All four slots are spent when all four positions clear their minimum, in the
 * order the tiers require: `tools`, `system`, `previous`, `tail`. There is no
 * reserve, so anything added later — a request-level automatic breakpoint, a
 * marker an embedding app wants to place — has to take a slot from this list
 * rather than be appended to it.
 *
 * Every position is checked against its own minimum: a breakpoint below the
 * model's floor is not cached, and (unlike a breakpoint that is simply shorter)
 * it tells us nothing in the response except that nothing happened.
 */
export interface AnthropicBreakpointPlan {
	tools: boolean;
	system: boolean;
	previous: boolean;
	tail: boolean;
}

const NO_BREAKPOINTS: AnthropicBreakpointPlan = { tools: false, system: false, previous: false, tail: false };

/**
 * Where the request before this one ended, and how long its prompt was.
 *
 * The prompt that produced the newest assistant message was everything before
 * it, and a transcript only grows by appending — so the message immediately
 * before that assistant message is exactly where that prompt ended. No state
 * across requests is needed, which matters: this survives a process restart and
 * a resumed session, where a remembered index would not.
 *
 * The token count comes from that message's own usage, because it *is* the
 * prompt the provider billed and therefore exact. That doubles as the
 * correctness condition: a message with no usage came from a request that never
 * answered, so nothing is known to have been written at the position before it,
 * and there is nothing worth pointing a breakpoint at.
 */
export function previousRequestTail(messages: readonly AgentMessage[]): { index: number; tokens: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		if (i === 0) return undefined;
		const usage = message.usage;
		const tokens = usage.promptTotal ?? usage.input + usage.cacheRead + usage.cacheWrite;
		return tokens > 0 ? { index: i - 1, tokens } : undefined;
	}
	return undefined;
}

export function planAnthropicBreakpoints(context: Context, minPrefixTokens: number): AnthropicBreakpointPlan {
	const tiers = prefixTierTokens(context);
	const previous = previousRequestTail(context.messages);
	return {
		tools: tiers.tools >= minPrefixTokens,
		system: tiers.system >= minPrefixTokens,
		previous: previous !== undefined && previous.tokens >= minPrefixTokens,
		tail: tiers.messages >= minPrefixTokens,
	};
}

export function buildAnthropicRequest(
	model: Model,
	context: Context,
	options?: StreamOptions,
	cache: AnthropicCacheRequest = defaultCacheRequest(),
): AnthropicRequestParams {
	const plan = cache.explicit
		? planAnthropicBreakpoints(context, cacheCapability(model).minPrefixTokens)
		: NO_BREAKPOINTS;
	const previous = plan.previous ? previousRequestTail(context.messages) : undefined;
	const marks = new Set<number>();
	if (previous) marks.add(previous.index);
	// The tail mark is added last so that, on a one-message request, the tail
	// position wins: it is the one that writes the entry this turn will read.
	if (plan.tail && context.messages.length > 0) marks.add(context.messages.length - 1);

	const params: AnthropicRequestParams = {
		model: model.id,
		max_tokens: options?.maxOutputTokens ?? model.maxOutputTokens,
		messages: convertMessages(context.messages, marks, cache),
		stream: true,
	};

	if (context.systemPrompt) {
		params.system = [
			{
				type: "text",
				text: context.systemPrompt,
				...(plan.system ? { cache_control: cacheControl(cache) } : {}),
			},
		];
	}

	if (context.tools && context.tools.length > 0) {
		const last = context.tools.length - 1;
		params.tools = context.tools.map((tool: WireTool, index: number) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
			...(plan.tools && index === last ? { cache_control: cacheControl(cache) } : {}),
		}));
	}

	const thinking = options?.thinkingLevel ?? (model.reasoning ? "medium" : "off");
	if (thinking !== "off") {
		const budget = Math.min(THINKING_BUDGETS[thinking], params.max_tokens - 1);
		if (budget >= 1024) {
			params.thinking = { type: "enabled", budget_tokens: budget };
		}
	}

	return params;
}

/**
 * Convert our neutral messages to Anthropic wire format.
 *
 * Key rules:
 * - Consecutive ToolResultMessages merge into ONE user message of tool_result
 *   blocks (the API requires tool_use/result pairing inside user turns).
 * - Thinking blocks round-trip with their signature so extended thinking
 *   conversations stay valid.
 * - A user message's text is sent as a block array even when it would fit in a
 *   bare string. The two forms are the same prompt, but one message carries a
 *   breakpoint on the turn it arrives and none on the turns after it, and a
 *   breakpoint can only attach to a block — so sending blocks throughout means
 *   the bytes of a message never depend on whether it happens to be the tail.
 *   The exception is an empty message, which has no block to attach to and no
 *   tokens to cache, and keeps its old form.
 *
 * `marks` are indices into the *neutral* array, not the wire array: the merge
 * below means the two do not line up, and a rewind report that said "wire
 * message 7" would be describing something the reader cannot find.
 */
export function convertMessages(
	messages: Context["messages"],
	marks?: ReadonlySet<number>,
	cache: AnthropicCacheRequest = defaultCacheRequest(),
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	const control = cacheControl(cache);
	const mark = (block: Record<string, unknown>): Record<string, unknown> =>
		cache.explicit ? { ...block, cache_control: control } : block;

	/** One accumulated tool_result block, and the neutral index it came from. */
	let toolResults: Array<{ index: number; block: Record<string, unknown> }> = [];
	const flushToolResults = (): void => {
		if (toolResults.length === 0) return;
		out.push({
			role: "user",
			content: toolResults.map((entry) => (marks?.has(entry.index) ? mark(entry.block) : entry.block)),
		});
		toolResults = [];
	};

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "toolResult") {
			const content = message.content.map((block) =>
				block.type === "text" ? { type: "text", text: block.text } : imageBlock(block),
			);
			toolResults.push({
				index,
				block: {
					type: "tool_result",
					tool_use_id: message.toolCallId,
					content: content.length > 0 ? content : [{ type: "text", text: "" }],
					...(message.isError ? { is_error: true } : {}),
				},
			});
			continue;
		}
		flushToolResults();

		if (message.role === "user") {
			const marked = marks?.has(index) ?? false;
			if (typeof message.content === "string") {
				// An empty message keeps the bare form: there is no block to hang a
				// breakpoint on, an empty text block is not something the API accepts,
				// and a message with no tokens in it costs nothing to leave alone.
				if (message.content === "") {
					out.push({ role: "user", content: "" });
					continue;
				}
				const block: Record<string, unknown> = { type: "text", text: message.content };
				out.push({ role: "user", content: [marked ? mark(block) : block] });
				continue;
			}
			const blocks = message.content.map((block) =>
				block.type === "text" ? { type: "text", text: block.text } : imageBlock(block),
			);
			const last = blocks.length - 1;
			out.push({
				role: "user",
				content: blocks.map((block, i) => (marked && i === last ? mark(block) : block)),
			});
			continue;
		}

		// assistant
		const content: Array<Record<string, unknown>> = [];
		for (const block of message.content) {
			if (block.type === "text") {
				if (block.text) content.push({ type: "text", text: block.text });
			} else if (block.type === "thinking") {
				content.push({ type: "thinking", thinking: block.thinking, signature: block.signature ?? "" });
			} else {
				// The API's schema wants an object here, and `ToolCall.arguments` is the
				// model's JSON text — so it is parsed on the way out with the same
				// function the dispatcher parses it with on the way in. Sending the
				// string was accepted by the type system (the field is untyped in
				// `AnthropicRequestParams`) and rejected by nothing we test against, so
				// a transcript with a tool call could not be replayed at all.
				content.push({
					type: "tool_use",
					id: block.id,
					name: block.name,
					input: parseToolArguments(block.arguments),
				});
			}
		}
		if (content.length > 0) {
			const last = content.length - 1;
			const marked = marks?.has(index) ?? false;
			out.push({
				role: "assistant",
				content: content.map((block, i) => (marked && i === last ? mark(block) : block)),
			});
		}
	}
	flushToolResults();
	return out;
}

function imageBlock(block: { type: "image"; mimeType: string; data: string }): Record<string, unknown> {
	return {
		type: "image",
		source: { type: "base64", media_type: block.mimeType, data: block.data },
	};
}

// ---------------------------------------------------------------------------
// Stream mapping
// ---------------------------------------------------------------------------

const STOP_REASON_MAP: Record<string, "stop" | "toolUse" | "length"> = {
	end_turn: "stop",
	stop_sequence: "stop",
	tool_use: "toolUse",
	max_tokens: "length",
	refusal: "stop",
};

/**
 * Transform a raw Anthropic event stream into our uniform protocol.
 * Exceptions thrown by the underlying iterator propagate to the caller
 * (the retry wrapper is the throw boundary, not this mapper).
 */
export async function* mapAnthropicStream(
	rawEvents: AsyncIterable<AnthropicRawStreamEvent>,
	provider: string,
	modelId: string,
): AsyncGenerator<AssistantMessageEvent> {
	const builder = new MessageBuilder(provider, modelId);
	const blockTypes = new Map<number, string>();
	// signature_delta arrives as its own delta event before block stop; buffer
	// per index and attach when the thinking block closes. Without it, extended
	// thinking blocks can't round-trip on the next request.
	const signatures = new Map<number, string>();

	for await (const event of rawEvents) {
		switch (event.type) {
			case "message_start": {
				const usage = event.message?.usage;
				const cacheRead = usage?.cache_read_input_tokens ?? 0;
				const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
				const creation = usage?.cache_creation;
				const breakdown = creation
					? { "5m": creation.ephemeral_5m_input_tokens ?? 0, "1h": creation.ephemeral_1h_input_tokens ?? 0 }
					: undefined;
				builder.message.usage = {
					input: usage?.input_tokens ?? 0,
					output: usage?.output_tokens ?? 0,
					cacheRead,
					cacheWrite,
					...(breakdown ? { cacheWriteTtl: breakdown } : {}),
					promptTotal: (usage?.input_tokens ?? 0) + cacheRead + cacheWrite,
				};
				yield builder.start();
				break;
			}
			case "content_block_start": {
				const index = event.index ?? 0;
				const block = event.content_block;
				if (!block) break;
				blockTypes.set(index, block.type);
				if (block.type === "text") {
					yield builder.textStart(index);
				} else if (block.type === "thinking") {
					yield builder.thinkingStart(index);
				} else if (block.type === "tool_use") {
					yield builder.toolCallStart(index, block.id ?? "", block.name ?? "");
					// Some models inline a complete input object instead of deltas.
					if (block.input !== undefined && block.input !== null) {
						yield builder.toolCallDelta(index, JSON.stringify(block.input));
					}
				}
				// redacted_thinking: opaque block, no deltas — record type only.
				break;
			}
			case "content_block_delta": {
				const index = event.index ?? 0;
				const delta = event.delta;
				if (!delta) break;
				if (delta.type === "text_delta" && delta.text) {
					yield builder.textDelta(index, delta.text);
				} else if (delta.type === "thinking_delta" && delta.thinking) {
					yield builder.thinkingDelta(index, delta.thinking);
				} else if (delta.type === "signature_delta" && delta.signature) {
					signatures.set(index, delta.signature);
				} else if (delta.type === "input_json_delta" && delta.partial_json) {
					yield builder.toolCallDelta(index, delta.partial_json);
				}
				break;
			}
			case "content_block_stop": {
				const index = event.index ?? 0;
				const kind = blockTypes.get(index);
				if (kind === "text") {
					yield builder.textEnd(index);
				} else if (kind === "thinking") {
					yield builder.thinkingEnd(index, signatures.get(index));
				} else if (kind === "tool_use") {
					yield builder.toolCallEnd(index);
				}
				break;
			}
			case "message_delta": {
				const stopReason = event.delta?.stop_reason;
				if (event.usage?.output_tokens !== undefined) {
					builder.message.usage.output = event.usage.output_tokens;
				}
				if (typeof stopReason === "string") {
					builder.message.stopReason = STOP_REASON_MAP[stopReason] ?? "stop";
				}
				break;
			}
			case "message_stop": {
				yield builder.done(builder.message.stopReason === "pending" ? "stop" : builder.message.stopReason);
				return;
			}
			case "error": {
				const message = event.error?.message ?? "Unknown Anthropic stream error";
				// Classify here too: an in-stream refusal never becomes a throw, so
				// the retry layer above cannot see it.
				yield builder.error(message, looksLikeContextOverflow(message) ? { errorKind: "context_overflow" } : {});
				return;
			}
			default:
				break;
		}
	}

	// Stream ended without message_stop — treat as an error per protocol.
	if (builder.started) {
		yield builder.error("Anthropic stream ended without message_stop");
	} else {
		yield builder.error("Anthropic stream produced no events");
	}
}

// ---------------------------------------------------------------------------
// Live StreamFn
// ---------------------------------------------------------------------------

export interface AnthropicClientLike {
	messages: {
		create(params: Record<string, unknown>): Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>;
	};
}

export interface AnthropicStreamFnOptions {
	clientFactory?: () => AnthropicClientLike;
	policy?: CachePolicy;
	/** Told once when a TTL the policy asked for was refused and a fallback is in force. */
	onCacheNotice?: (notice: CacheNotice) => void;
}

/**
 * The TTLs to try, in order, each rung reached only because the one above it was
 * refused.
 *
 * The first rung is what the policy asked for. Below it the short TTL, and below
 * that no `ttl` field at all: a gateway that rejects the field outright rejects
 * either value, and the point of a ladder is that the third rung is a request
 * that any Anthropic-shaped endpoint will accept. Each rung costs one failed
 * request, once per process, and then never again.
 */
function ttlLadder(policy?: CachePolicy): Array<CacheTtl | undefined> {
	if (policy?.explicitBreakpoints === false) return [undefined];
	return resolveCacheTtl(policy) === "1h" ? ["1h", "5m", undefined] : ["5m", undefined];
}

/**
 * Whether a failure is the provider refusing our cache settings.
 *
 * A 400 that mentions none of this is a genuinely malformed request and must
 * propagate: retrying it without a `ttl` would turn a real error into a silent
 * one. The wording check is what separates the two, and it is deliberately
 * narrow.
 */
function looksLikeCacheSettingRejection(error: unknown): boolean {
	if (statusCodeOf(error) !== 400) return false;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return /cache|ttl|ephemeral|beta/i.test(message);
}

export function createAnthropicStreamFn(options: AnthropicStreamFnOptions = {}) {
	const ladder = ttlLadder(options.policy);
	// Index into the ladder, advanced only by a refusal. Process-wide on purpose:
	// a provider that does not take the long TTL will not take it for the next
	// session either, and re-learning that on every request means paying a failed
	// request to be told the same thing.
	let rung = 0;

	return async function* anthropicStream(
		model: Model,
		context: Context,
		streamOptions?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		while (true) {
			const ttl = ladder[Math.min(rung, ladder.length - 1)];
			const cache: AnthropicCacheRequest = {
				explicit: options.policy?.explicitBreakpoints ?? true,
				ttl,
			};
			const client = options.clientFactory ? options.clientFactory() : await defaultClient(model, streamOptions);
			const params = buildAnthropicRequest(model, context, streamOptions, cache);

			let raw: AsyncIterable<AnthropicRawStreamEvent>;
			try {
				raw = (await client.messages.create(params)) as unknown as AsyncIterable<AnthropicRawStreamEvent>;
			} catch (error) {
				// The downgrade happens here, below `withRetry`, because a 400 is not a
				// status that wrapper retries — it is right not to, and the consequence
				// is that the one class of 400 we can fix ourselves has to be fixed
				// before the first event is yielded, which is where this is.
				if (rung + 1 < ladder.length && looksLikeCacheSettingRejection(error)) {
					const next = ladder[rung + 1];
					options.onCacheNotice?.({
						kind: "ttl-downgrade",
						from: ttl,
						to: next,
						reason: error instanceof Error ? error.message : String(error),
					});
					rung++;
					continue;
				}
				throw error;
			}
			yield* mapAnthropicStream(raw, model.provider, model.id);
			return;
		}
	};
}

async function defaultClient(model: Model, options?: StreamOptions): Promise<AnthropicClientLike> {
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	const apiKey = options?.apiKey ?? resolveApiKey(model) ?? "";
	return new Anthropic({
		apiKey,
		baseURL: model.baseUrl || undefined,
		maxRetries: 0, // our retry wrapper owns retry policy
		fetch: options?.signal ? (input, init) => fetch(input, { ...init, signal: options.signal }) : undefined,
	}) as unknown as AnthropicClientLike;
}

// ---------------------------------------------------------------------------
// Catalog listing
// ---------------------------------------------------------------------------

/** Rows per page. The endpoint's own maximum, and it defaults to 20. */
const MODELS_PAGE_SIZE = 1_000;

/** Pages to follow before giving up on seeing the whole catalog. */
const MAX_MODEL_PAGES = 10;

/** One page of `GET /v1/models`, structurally. */
export interface AnthropicModelPage {
	data?: Array<{
		id?: string;
		display_name?: string | null;
		max_input_tokens?: number | null;
		max_tokens?: number | null;
	}>;
	has_more?: boolean;
	last_id?: string | null;
}

export interface AnthropicModelsClientLike {
	models: { list(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AnthropicModelPage> };
}

/**
 * What this key can reach, with the limits the API states for each model.
 *
 * Paginated: the endpoint answers 20 rows at a time unless asked for more, and a
 * list truncated at the page cap would be a list that says the models past it do
 * not exist. `complete` reports whether we saw all of them — a partial listing is
 * still worth reading for its limits, but it must never be used to conclude that
 * something is gone.
 */
export async function listAnthropicModels(
	model: Model,
	options?: { client?: AnthropicModelsClientLike; signal?: AbortSignal },
): Promise<{ models: DiscoveredModel[]; complete: boolean }> {
	const client = options?.client ?? (await defaultModelsClient(model));
	const models: DiscoveredModel[] = [];
	let after: string | undefined;
	let complete = false;

	for (let page = 0; page < MAX_MODEL_PAGES; page++) {
		const response = await client.models.list(
			{ limit: MODELS_PAGE_SIZE, ...(after ? { after_id: after } : {}) },
			{ signal: options?.signal },
		);
		for (const entry of response.data ?? []) {
			if (!entry.id) continue;
			models.push({
				id: entry.id,
				displayName: entry.display_name ?? undefined,
				contextWindow: entry.max_input_tokens ?? undefined,
				maxOutputTokens: entry.max_tokens ?? undefined,
			});
		}
		if (!response.has_more) {
			complete = true;
			break;
		}
		after = response.last_id ?? undefined;
		// More rows exist but there is no cursor to reach them: what we have is a
		// fragment, and it stays marked as one.
		if (!after) break;
	}

	return { models, complete };
}

async function defaultModelsClient(model: Model): Promise<AnthropicModelsClientLike> {
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	// No retries and no timeout of its own: how long the caller is willing to
	// wait is the caller's policy, and it says so with the signal it passes.
	return new Anthropic({
		apiKey: resolveApiKey(model) ?? "",
		baseURL: model.baseUrl || undefined,
		maxRetries: 0,
	}) as unknown as AnthropicModelsClientLike;
}
