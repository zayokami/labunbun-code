// Long-form design notes: docs/dev/ai-layer.md
/** Anthropic Messages API adapter, in three testable pieces. */

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
import { composeSignals } from "../signals.ts";
import type {
	AgentMessage,
	AssistantMessageEvent,
	Context,
	Model,
	StopReason,
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
			delta?: { stop_reason?: string | null; stop_details?: AnthropicStopDetails | null };
			usage?: { output_tokens?: number };
	  }
	| { type: "message_stop" }
	| { type: "error"; error?: { type?: string; message?: string } };

// Long-form design notes: docs/dev/ai-layer.md
/** Why a refusal happened, exactly as far as the API will say. */
export interface AnthropicStopDetails {
	category?: string | null;
	explanation?: string | null;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
	minimal: 1024,
	low: 4096,
	medium: 16384,
	high: 32768,
};

// Long-form design notes: docs/dev/ai-layer.md
/** The depth dial for the models that think adaptively: what replaced the budget. */
const THINKING_EFFORT: Record<ThinkingLevel, "low" | "medium" | "high"> = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
};

/** The effort rungs the wire accepts, all five of them. */
type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** What the API should do when a replayed thinking block fails its prefix check. */
interface AnthropicBlockBinding {
	prefix_mismatch_behavior: "drop_block";
}

// Long-form design notes: docs/dev/ai-layer.md
/** The beta that lets a thinking block be dropped instead of failing the request. */
export const THINKING_BLOCK_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/**
 * Beta headers this model needs on every request, or nothing.
 *
 * Exported because the headers ride on the client call rather than in the
 * request body, and `buildAnthropicRequest` — the piece that is pure and
 * therefore the one the tests drive — cannot see them.
 */
export function anthropicBetaHeaders(model: Model): Record<string, string> {
	return model.thinkingBlockBinding ? { "anthropic-beta": THINKING_BLOCK_BINDING_BETA } : {};
}

export interface AnthropicRequestParams {
	[key: string]: unknown;
	model: string;
	max_tokens: number;
	system?: Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }>;
	messages: Array<Record<string, unknown>>;
	tools?: Array<{ name: string; description: string; input_schema: unknown; cache_control?: AnthropicCacheControl }>;
	stream: true;
	thinking?:
		| { type: "enabled"; budget_tokens: number }
		| { type: "adaptive"; display?: "summarized" | "omitted"; block_binding?: AnthropicBlockBinding };
	/**
	 * How deep the model thinks, on the models that decide for themselves.
	 *
	 * Spelled out even though the index signature above would let any key
	 * through: that signature is exactly why an omission here is invisible to
	 * the compiler, and this field is what the whole adaptive path hangs on.
	 */
	output_config?: { effort: AnthropicEffort };
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

// Long-form design notes: docs/dev/ai-layer.md
/** Which of the four breakpoint slots this request uses. */
export interface AnthropicBreakpointPlan {
	tools: boolean;
	system: boolean;
	previous: boolean;
	tail: boolean;
}

const NO_BREAKPOINTS: AnthropicBreakpointPlan = { tools: false, system: false, previous: false, tail: false };

// Long-form design notes: docs/dev/ai-layer.md
/** Where the request before this one ended, and how long its prompt was. */
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

	// Long-form design notes: docs/dev/ai-layer.md
	const declaresThinking = model.reasoning || model.thinkingMode !== undefined;
	const thinking = declaresThinking ? (options?.thinkingLevel ?? (model.reasoning ? "medium" : "off")) : "off";
	if (model.thinkingMode === "adaptive") {
		params.thinking = {
			type: "adaptive",
			// Left off, these models return thinking blocks whose text is empty:
			// the panel goes blank and so does the narration between tool calls,
			// on every turn, without an error to explain it. The beta alternative
			// is not the way out of that — `display: "updates"` empties the
			// reasoning blocks and fills only the progress-update ones, so it
			// buys back the narration by giving up the thinking. `summarized`
			// fills both, and is the richer of the two.
			display: "summarized",
			...(model.thinkingBlockBinding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}),
		};
		// Sent even for the levels that would once have meant "think less":
		// measuring the effort against the default and skipping the field would
		// save nothing, because the resolved setting is rendered into the prompt
		// either way.
		params.output_config = { effort: THINKING_EFFORT[thinking] };
	} else if (thinking !== "off") {
		const budget = Math.min(THINKING_BUDGETS[thinking], params.max_tokens - 1);
		if (budget >= 1024) {
			params.thinking = { type: "enabled", budget_tokens: budget };
		}
	}

	return params;
}

// Long-form design notes: docs/dev/ai-layer.md
/** Convert our neutral messages to Anthropic wire format. */
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

const STOP_REASON_MAP: Record<string, StopReason> = {
	end_turn: "stop",
	stop_sequence: "stop",
	tool_use: "toolUse",
	max_tokens: "length",
	// The server handed the turn back mid-flight and would take it again with
	// the same messages. Nothing here continues a paused turn, so it ends the
	// way an ordinary stop does — but it is named rather than left to the
	// fallback, because "we do not continue these" is a decision.
	pause_turn: "stop",
	// "refusal" and "model_context_window_exceeded" are handled where they are
	// read, not here: each needs more than a one-word translation.
};

/**
 * The explanation to show for a refusal, or nothing when the API gave none.
 *
 * Returning undefined rather than inventing a sentence keeps the wording a user
 * reads in the one place that has to say something regardless of what the wire
 * carried.
 */
function refusalMessage(details: AnthropicStopDetails | null | undefined): string | undefined {
	const explanation = details?.explanation?.trim();
	if (explanation) return explanation;
	const category = details?.category?.trim();
	return category ? `Claude declined this request (${category})` : undefined;
}

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
	// per index and attach when the thinking block closes. Without it the block
	// comes back unsigned, and an unsigned block cannot be replayed.
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
					if (stopReason === "refusal") {
						// A refusal is an answer, and an empty one: no content, no tool
						// calls, and the same stop_reason a turn that finished normally
						// would send. Folding it into "stop" files it as a successful
						// turn that happened to say nothing, which is how a user ends up
						// staring at an empty reply with nothing to act on.
						builder.message.stopReason = "refusal";
						builder.message.errorMessage = refusalMessage(event.delta?.stop_details);
					} else if (stopReason === "model_context_window_exceeded") {
						// The turn ran out of room, and unlike a max_tokens stop no
						// continuation fixes it: the request itself is at the window.
						// Reported as the same error the thrown form of this produces, so
						// callers reach for the one remedy that works — sending less.
						builder.message.stopReason = "error";
						builder.message.errorKind = "context_overflow";
						builder.message.errorMessage = "The model's context window was exceeded";
					} else {
						const mapped = STOP_REASON_MAP[stopReason];
						if (mapped) {
							builder.message.stopReason = mapped;
						} else {
							// A stop reason this adapter has never seen is not a normal
							// finish. Defaulting to "stop" is how a refusal went unnoticed
							// for as long as it did, and the failure it hides — an empty turn
							// filed as a successful one — is invisible by construction. Naming
							// the value is the difference between a bug report and a mystery.
							builder.message.stopReason = "error";
							builder.message.errorMessage = `Unrecognized stop reason: ${stopReason}`;
						}
					}
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
		create(
			params: Record<string, unknown>,
			options?: { headers?: Record<string, string> },
		): Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>;
	};
}

export interface AnthropicStreamFnOptions {
	clientFactory?: () => AnthropicClientLike;
	policy?: CachePolicy;
	/** Told once when a TTL the policy asked for was refused and a fallback is in force. */
	onCacheNotice?: (notice: CacheNotice) => void;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The TTLs to try, in order, each rung reached because the one above was refused. */
function ttlLadder(policy?: CachePolicy): Array<CacheTtl | undefined> {
	if (policy?.explicitBreakpoints === false) return [undefined];
	return resolveCacheTtl(policy) === "1h" ? ["1h", "5m", undefined] : ["5m", undefined];
}

// Long-form design notes: docs/dev/ai-layer.md
/** Whether a failure is the provider refusing our cache settings. */
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
			// Per request rather than on the client, so that a model without the
			// flag is not carrying a header meant for another one.
			const betaHeaders = anthropicBetaHeaders(model);

			let raw: AsyncIterable<AnthropicRawStreamEvent>;
			try {
				raw = (await client.messages.create(
					params,
					Object.keys(betaHeaders).length > 0 ? { headers: betaHeaders } : undefined,
				)) as unknown as AsyncIterable<AnthropicRawStreamEvent>;
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
	// Both signals must reach the request: the SDK puts its own on the init —
	// its timeout timer aborts through that one — so replacing it with the
	// caller's alone would leave the timeout with no listener.
	const callerSignal = options?.signal;
	return new Anthropic({
		apiKey,
		baseURL: model.baseUrl || undefined,
		maxRetries: 0, // our retry wrapper owns retry policy
		fetch: callerSignal
			? (input, init) => fetch(input, { ...init, signal: composeSignals(init?.signal, callerSignal) })
			: undefined,
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

// Long-form design notes: docs/dev/ai-layer.md
/** What this key can reach, with the limits the API states for each model. */
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
