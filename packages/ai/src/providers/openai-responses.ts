/**
 * OpenAI Responses adapter — the third wire, and the one that carries tool
 * calling for the GPT-6 generation.
 *
 * What made this a separate adapter rather than a mode flag on the
 * Chat Completions one is that the two disagree on every shape the agent loop
 * touches:
 *
 *   - The system prompt is a top-level `instructions` field, not the first
 *     message. That is not cosmetic: the cached prefix runs `instructions` first
 *     and then `input`, so a conversation whose system prompt is rebuilt per turn
 *     invalidates the whole prefix no matter how little else changed.
 *   - Tools are declared flat — `{type, name, description, parameters}` with no
 *     `function` wrapper.
 *   - A tool result is an input item `{type: "function_call_output", call_id}`
 *     referencing the call, not a `role: "tool"` message.
 *   - The stream is a sequence of *named* events (`response.output_text.delta`,
 *     `response.function_call_arguments.delta`, …) rather than an array of deltas,
 *     and the terminal event carries the whole response envelope including usage.
 *
 * **How much of this is verified.** The shapes and event names are the vendor's
 * published wire format. Nothing here has been round-tripped against a live
 * endpoint — this checkout cannot make a paid request, and the repository's
 * standing rule is that a claim about the wire is only as good as the evidence
 * for it. The parts a live request would settle, and that a reader should treat
 * as open rather than settled, are called out where they appear.
 *
 * Store-side, this sends `store: false`. A coding session's transcript is the
 * user's source code and everything said about it; keeping it on the provider's
 * side by default is not a decision this adapter gets to make quietly, and the
 * flag is also what makes reasoning replay possible without an `id`.
 */
import {
	type CachePolicy,
	cacheCapability,
	cachedTokensFrom,
	promptCacheKeyFor,
	resolvePromptCacheKey,
	resolvePromptCacheRetention,
} from "../cache.ts";
import { MessageBuilder } from "../message-builder.ts";
import { resolveApiKey } from "../model.ts";
import type { AssistantMessageEvent, Context, Model, StreamOptions, ThinkingLevel, WireTool } from "../types.ts";

// ---------------------------------------------------------------------------
// Raw wire types (structural subset, local so tests use plain fixtures)
// ---------------------------------------------------------------------------

/** One item as the Responses API spells it, for the output or the input array. */
export interface ResponsesItem {
	type: string;
	id?: string;
	/** Function calls carry both: `id` names the item, `call_id` names the call. */
	call_id?: string;
	name?: string;
	/** A JSON *string*, not an object — the wire does not parse it for us. */
	arguments?: string;
	encrypted_content?: string;
	status?: string;
	summary?: Array<{ type: string; text: string }>;
	content?: unknown;
	role?: string;
}

/** The response envelope the terminal events carry. */
export interface ResponsesEnvelope {
	status?: string;
	error?: { message?: string; code?: string } | null;
	incomplete_details?: { reason?: string } | null;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		input_tokens_details?: { cached_tokens?: number } | null;
		output_tokens_details?: { reasoning_tokens?: number } | null;
	} | null;
}

export interface ResponsesRawEvent {
	type: string;
	/** Text deltas, on both the output-text and the reasoning-summary events. */
	delta?: string;
	/** Function-call argument deltas arrive keyed by item rather than by index. */
	item_id?: string;
	output_index?: number;
	item?: ResponsesItem;
	/** `response.output_item.done` for a reasoning item carries the blob to replay. */
	arguments?: string;
	response?: ResponsesEnvelope;
	error?: { message?: string; code?: string };
	code?: string;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface ResponsesRequestParams {
	[key: string]: unknown;
	model: string;
	/** The conversation. Note the *absence* of a system message — see above. */
	input: Array<Record<string, unknown>>;
	stream: true;
	instructions?: string;
	max_output_tokens?: number;
	/** Flat: no `function` wrapper, unlike Chat Completions. */
	tools?: Array<{ type: "function"; name: string; description: string; parameters: unknown }>;
	tool_choice?: "auto";
	reasoning?: { effort: Exclude<ThinkingLevel, "off">; summary: "auto" };
	/**
	 * Do not keep the conversation on the provider's side. This is the default
	 * for a coding agent and not a tuning knob.
	 */
	store: false;
	/**
	 * Ask for the encrypted reasoning blob. With `store: false` there is nothing on
	 * the provider's side to refer back to, so this is the only thing that makes a
	 * reasoning item replayable — and a reasoning model that is asked to continue a
	 * conversation it has no record of behaves in ways the caller cannot correct.
	 */
	include?: string[];
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
}

/**
 * The effort this request can actually carry.
 *
 * `undefined` means the request carries no `reasoning` field at all, which is
 * three different things that must not be confused: the session asked for none,
 * the session asked for one this model does not accept, or the model says nothing
 * about efforts and we send what was asked for.
 */
export function responsesEffort(
	model: Model,
	thinkingLevel: ThinkingLevel | undefined,
):
	| {
			effort: Exclude<ThinkingLevel, "off">;
	  }
	| undefined {
	const asked = thinkingLevel ?? (model.reasoning ? "medium" : "off");
	if (asked === "off") return undefined;
	const accepted = model.reasoningEfforts;
	// Absent means the model publishes no subset, so everything we can express is
	// on the table. Present means the row is telling us what it accepts and
	// `minimal` is not in it — an omission, not a round-down to `low`.
	if (accepted && !accepted.includes(asked)) return undefined;
	return { effort: asked };
}

export function buildResponsesRequest(
	model: Model,
	context: Context,
	options?: StreamOptions,
	policy?: CachePolicy,
): ResponsesRequestParams {
	const params: ResponsesRequestParams = {
		model: model.id,
		input: convertInput(context),
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"],
	};

	if (context.systemPrompt) params.instructions = context.systemPrompt;
	if (options?.maxOutputTokens) params.max_output_tokens = options.maxOutputTokens;

	// Same ordering constraint as the other two wires: what the provider does
	// about caching decides whether these fields go out at all.
	const capability = cacheCapability(model);
	if (resolvePromptCacheKey(policy, capability)) {
		params.prompt_cache_key = promptCacheKeyFor(model, context);
	}
	const retention = resolvePromptCacheRetention(policy, capability);
	if (retention) params.prompt_cache_retention = retention;

	if (context.tools && context.tools.length > 0) {
		params.tools = context.tools.map((tool: WireTool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
		params.tool_choice = "auto";
	}

	const effort = responsesEffort(model, options?.thinkingLevel);
	if (effort) params.reasoning = { ...effort, summary: "auto" };

	return params;
}

/** One input item. Deliberately loose: the wire has more item types than we emit. */
export type ResponsesInputItem = Record<string, unknown>;

export function convertInput(context: Context): ResponsesInputItem[] {
	const out: ResponsesInputItem[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				out.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
				continue;
			}
			out.push({
				role: "user",
				content: message.content.map((block) =>
					block.type === "text"
						? { type: "input_text", text: block.text }
						: { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` },
				),
			});
			continue;
		}

		if (message.role === "assistant") {
			// Order matters and is not cosmetic. The model emits reasoning, then text,
			// then tool calls, and the input array has to read back in that order for
			// the items to be attributed to the turn that produced them.
			for (const block of message.content) {
				if (block.type === "thinking" && block.thinking) {
					// Only a block that came back with the encrypted blob is replayable.
					// One without it is dropped rather than sent empty: the wire has no
					// spelling for a reasoning item with neither text we can read nor a
					// blob it can verify, and sending one is the request that 400s.
					//
					// Note what is NOT carried: the item `id`. With `store: false` there
					// is nothing on the provider's side for it to name. If the wire turns
					// out to want it, this is where that would go — which is the one claim
					// in this adapter a live request would falsify and this checkout
					// cannot.
					if (block.signature) {
						out.push({
							type: "reasoning",
							encrypted_content: block.signature,
							summary: [{ type: "summary_text", text: block.thinking }],
						});
					}
				} else if (block.type === "text" && block.text) {
					out.push({ role: "assistant", content: [{ type: "output_text", text: block.text }] });
				} else if (block.type === "toolCall") {
					// `call_id`, not the item id: the tool result that comes back names
					// the call, and that name is what has to line up.
					out.push({
						type: "function_call",
						call_id: block.id,
						name: block.name,
						arguments: block.arguments || "{}",
					});
				}
			}
			continue;
		}

		// toolResult → a function_call_output item, which references the call rather
		// than sitting in the conversation as a turn of its own.
		const text = message.content
			.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		out.push({
			type: "function_call_output",
			call_id: message.toolCallId,
			output: text,
		});
	}

	return out;
}

// ---------------------------------------------------------------------------
// Stream mapping
// ---------------------------------------------------------------------------

interface OpenCallState {
	/** The `call_id` — the thing a tool result will be matched against. */
	callId: string;
	name: string;
	index: number;
	/** The item id the argument deltas arrive keyed by. Distinct from callId. */
	itemId: string;
}

/**
 * What the argument deltas have produced for one call so far.
 *
 * Read back off the builder rather than tracked beside it: the builder is the
 * single thing that owns the accumulated text, and a second copy here would be a
 * second answer to "what has this call received".
 */
function accumulatedArguments(builder: MessageBuilder, index: number): string {
	const block = builder.message.content[index];
	return block?.type === "toolCall" ? block.arguments : "";
}

export async function* mapResponsesStream(
	rawEvents: AsyncIterable<ResponsesRawEvent>,
	provider: string,
	modelId: string,
): AsyncGenerator<AssistantMessageEvent> {
	const builder = new MessageBuilder(provider, modelId);
	/** Keyed by item id, because that is what the argument deltas carry. */
	const openCalls = new Map<string, OpenCallState>();
	/** The same states keyed by wire item id — a different key from the call id. */
	const callsByItem = new Map<string, OpenCallState>();
	const thinkingIndexByItem = new Map<string, number>();
	/** Content order, so text and reasoning land where the model put them. */
	const slots = new Map<number, number>();
	let nextContentIndex = 0;
	let thinkingIndex = -1;
	let textIndex = -1;
	let encrypted: string | undefined;
	let status: string | undefined;
	let usage: ResponsesEnvelope["usage"];
	let incompleteReason: string | undefined;
	let failure: string | undefined;
	let sawEvent = false;

	/** Content index for a wire output slot, allocated the first time it is used. */
	function slot(outputIndex: number): number {
		const existing = slots.get(outputIndex);
		if (existing !== undefined) return existing;
		const index = nextContentIndex++;
		slots.set(outputIndex, index);
		return index;
	}

	yield builder.start();

	for await (const event of rawEvents) {
		sawEvent = true;

		switch (event.type) {
			case "response.output_text.delta": {
				if (event.delta) {
					if (textIndex === -1) {
						textIndex = slot(event.output_index ?? 0);
						yield builder.textStart(textIndex);
					}
					yield builder.textDelta(textIndex, event.delta);
				}
				break;
			}
			case "response.reasoning_summary_text.delta": {
				if (event.delta) {
					const key = event.item_id ?? "";
					let index = thinkingIndexByItem.get(key);
					if (index === undefined) {
						index = slot(event.output_index ?? 0);
						thinkingIndexByItem.set(key, index);
						if (thinkingIndex === -1) thinkingIndex = index;
						yield builder.thinkingStart(index);
					}
					yield builder.thinkingDelta(index, event.delta);
				}
				break;
			}
			case "response.output_item.added": {
				const item = event.item;
				if (item?.type === "function_call") {
					// `call_id` is what a tool result will reference. Preferring it over
					// the item `id` is the whole reason this adapter cannot reuse the
					// Chat Completions one: taking the item id here produces a request
					// whose every tool result is unmatched.
					const callId = item.call_id ?? item.id ?? "";
					if (!openCalls.has(callId)) {
						const state: OpenCallState = {
							callId,
							name: item.name ?? "",
							index: slot(event.output_index ?? 0),
							itemId: item.id ?? callId,
						};
						openCalls.set(callId, state);
						callsByItem.set(state.itemId, state);
						yield builder.toolCallStart(state.index, state.callId, state.name);
					}
				} else if (item?.type === "reasoning") {
					encrypted = item.encrypted_content ?? encrypted;
				}
				break;
			}
			case "response.function_call_arguments.delta": {
				const target = event.item_id === undefined ? undefined : callsByItem.get(event.item_id);
				if (target && event.delta) yield builder.toolCallDelta(target.index, event.delta);
				break;
			}
			case "response.output_item.done": {
				const item = event.item;
				if (item?.type === "reasoning") {
					// The blob arrives on the done event for the item, not on the
					// summary deltas. It is what makes the block replayable next turn.
					if (item.encrypted_content) encrypted = item.encrypted_content;
				} else if (item?.type === "function_call" && item.arguments !== undefined) {
					// A well-formed stream repeats the finished arguments here. Using them
					// only when the deltas produced nothing keeps a stream that omits the
					// event working, and repairs one whose deltas did not reassemble.
					const target = [...openCalls.values()].find((c) => c.callId === (item.call_id ?? item.id));
					const accumulated = target ? accumulatedArguments(builder, target.index) : "";
					if (target && !accumulated) yield builder.toolCallDelta(target.index, item.arguments);
				}
				break;
			}
			case "response.reasoning_encrypted_content.delta":
			case "response.reasoning_encrypted_content.done": {
				if (event.item?.encrypted_content) encrypted = event.item.encrypted_content;
				break;
			}
			case "response.completed":
			case "response.incomplete":
			case "response.failed": {
				const envelope = event.response;
				status = envelope?.status ?? event.type.replace("response.", "");
				usage = envelope?.usage ?? usage;
				incompleteReason = envelope?.incomplete_details?.reason ?? incompleteReason;
				const message = envelope?.error?.message ?? event.error?.message;
				if (message || event.type === "response.failed") {
					failure = message ?? `Responses stream failed (${envelope?.error?.code ?? event.code ?? "unknown"})`;
				}
				break;
			}
			default:
				// `response.created`, `response.in_progress`, `*.added`, `*.done` for
				// content parts, and whatever a future revision adds. An unknown event
				// is not an error: the terminal event is what decides the turn.
				break;
		}
	}

	if (!sawEvent) {
		yield builder.error("Responses stream produced no events");
		return;
	}

	if (thinkingIndex !== -1) {
		yield builder.thinkingEnd(thinkingIndex, encrypted);
	}
	if (textIndex !== -1) {
		yield builder.textEnd(textIndex);
	}

	const stop = resolveStopReason(status, incompleteReason, openCalls.size);

	if (usage) {
		const cacheRead = cachedTokensFrom(usage) ?? builder.message.usage.cacheRead;
		const promptTotal = usage.input_tokens ?? builder.message.usage.promptTotal;
		builder.message.usage = {
			// As on Chat Completions, `input_tokens` counts the cached prefix and
			// `input` must not, or those tokens are billed twice.
			input: promptTotal === undefined ? builder.message.usage.input : Math.max(0, promptTotal - cacheRead),
			output: usage.output_tokens ?? builder.message.usage.output,
			cacheRead,
			cacheWrite: builder.message.usage.cacheWrite,
			reasoning: usage.output_tokens_details?.reasoning_tokens,
			promptTotal,
		};
	}

	if (failure) {
		yield builder.error(failure, { usage: builder.message.usage });
		return;
	}

	// Sorted by content index, so a stream that interleaved two calls closes them
	// in the order the message will be read back in.
	for (const state of [...openCalls.values()].sort((a, b) => a.index - b.index)) {
		yield builder.toolCallEnd(state.index);
	}

	yield builder.done(stop, builder.message.usage);
}

/**
 * The turn's outcome.
 *
 * A Responses terminal event names a *status*, not a reason: `completed` covers
 * both a plain answer and a turn that ended in tool calls, so the two are told
 * apart by what the turn contains. Getting this wrong is not cosmetic — the agent
 * loop stops on `stop` and runs tools on `toolUse`, so an answer that ended in a
 * tool call reported as `stop` is a session that quietly does nothing.
 */
export function resolveStopReason(
	status: string | undefined,
	incompleteReason: string | undefined,
	toolCallCount: number,
): "stop" | "toolUse" | "length" | "error" {
	if (status === "incomplete" && incompleteReason === "max_output_tokens") return "length";
	if (status === "failed" || status === "cancelled") return "error";
	if (status === "incomplete") return "length";
	return toolCallCount > 0 ? "toolUse" : "stop";
}

// ---------------------------------------------------------------------------
// Live StreamFn
// ---------------------------------------------------------------------------

export interface ResponsesClientLike {
	responses: {
		create(params: Record<string, unknown>): Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>;
	};
}

export interface ResponsesStreamFnOptions {
	clientFactory?: () => ResponsesClientLike;
	policy?: CachePolicy;
}

export function createResponsesStreamFn(settings: ResponsesStreamFnOptions = {}) {
	return async function* responsesStream(
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		const client = settings.clientFactory ? settings.clientFactory() : await defaultClient(model, options);
		const params = buildResponsesRequest(model, context, options, settings.policy);
		const raw = (await client.responses.create(params)) as unknown as AsyncIterable<ResponsesRawEvent>;
		yield* mapResponsesStream(raw, model.provider, model.id);
	};
}

async function defaultClient(model: Model, options?: StreamOptions): Promise<ResponsesClientLike> {
	const { default: OpenAI } = await import("openai");
	const apiKey = options?.apiKey ?? resolveApiKey(model) ?? "";
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl || undefined,
		maxRetries: 0, // our retry wrapper owns retry policy
		// The same reason as the Chat Completions adapter: Esc has to cancel this
		// wire exactly as it cancels the other two.
		fetch: options?.signal ? (input, init) => fetch(input, { ...init, signal: options.signal }) : undefined,
	}) as unknown as ResponsesClientLike;
}
