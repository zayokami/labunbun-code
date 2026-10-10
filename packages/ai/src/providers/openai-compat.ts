// Long-form design notes: docs/dev/ai-layer.md
/** OpenAI-compatible Chat Completions adapter. */
import {
	type CachePolicy,
	cacheCapability,
	cachedTokensFrom,
	promptCacheKeyFor,
	resolvePromptCacheKey,
	resolvePromptCacheRetention,
} from "../cache.ts";
import { MessageBuilder, parseToolArguments } from "../message-builder.ts";
import { type DiscoveredModel, resolveApiKey } from "../model.ts";
import { composeSignals } from "../signals.ts";
import type { AssistantMessageEvent, Context, Model, StopReason, StreamOptions, WireTool } from "../types.ts";

// ---------------------------------------------------------------------------
// Raw wire types (structural subset, local so tests use plain fixtures)
// ---------------------------------------------------------------------------

/** One entry of the list shape some providers stream as `delta.content`. */
interface OpenAIContentPart {
	type?: string | null;
	text?: string | null;
	/** A thinking part carries its text one level down, in its own list. */
	thinking?: Array<{ type?: string | null; text?: string | null }> | null;
}

export interface OpenAIRawChunk {
	choices?: Array<{
		delta?: {
			content?: string | null | OpenAIContentPart[];
			reasoning_content?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string | null;
				type?: string | null;
				function?: { name?: string | null; arguments?: string | null };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number } | null;
		/**
		 * The same number under two more names. Moonshot reports Kimi's cache hits
		 * at the top level, and DeepSeek states them twice — `prompt_cache_hit_tokens`
		 * next to the nested copy. `cachedTokensFrom` reads all three; this type
		 * lists them so a fixture can prove each spelling is understood.
		 */
		cached_tokens?: number;
		prompt_cache_hit_tokens?: number;
		completion_tokens_details?: { reasoning_tokens?: number } | null;
	} | null;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface OpenAIRequestParams {
	[key: string]: unknown;
	model: string;
	messages: Array<Record<string, unknown>>;
	stream: true;
	stream_options?: { include_usage: boolean };
	max_tokens?: number;
	max_completion_tokens?: number;
	tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
	tool_choice?: "auto";
	reasoning_effort?: "low" | "medium" | "high" | "none";
	temperature?: number;
	/**
	 * A routing hint, not a cache instruction: it asks the provider to send
	 * requests that share this prefix to a machine that already holds it. A key on
	 * its own produces no hits — the prefix still has to match byte for byte.
	 */
	prompt_cache_key?: string;
	/** How long the provider should keep the entry, where it lets the caller say. */
	prompt_cache_retention?: string;
}

export function buildOpenAIRequest(
	model: Model,
	context: Context,
	options?: StreamOptions,
	policy?: CachePolicy,
): OpenAIRequestParams {
	const params: OpenAIRequestParams = {
		model: model.id,
		messages: convertMessages(context),
		stream: true,
		stream_options: { include_usage: true },
	};

	// What this provider does about caching decides both fields below, and a
	// provider with no row gets neither: an unknown endpoint that rejects an
	// unknown field is a 400 on every request, and that is a worse outcome than
	// caching nothing. See `cacheCapability`.
	const capability = cacheCapability(model);
	if (resolvePromptCacheKey(policy, capability)) {
		params.prompt_cache_key = promptCacheKeyFor(model, context);
	}
	const retention = resolvePromptCacheRetention(policy, capability);
	if (retention) params.prompt_cache_retention = retention;

	if (options?.maxOutputTokens) {
		// Newer OpenAI models want max_completion_tokens; most compat providers
		// only understand max_tokens. Send both — unknown fields are ignored.
		params.max_completion_tokens = options.maxOutputTokens;
		params.max_tokens = options.maxOutputTokens;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = context.tools.map((tool: WireTool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
		params.tool_choice = "auto";
	}

	// Reasoning effort for providers that support it (OpenAI o-series, etc.).
	// DeepSeek-style providers ignore it. Never send temperature alongside.
	const thinking = options?.thinkingLevel ?? (model.reasoning ? "medium" : "off");
	if (model.toolReasoningEffort !== undefined && context.tools && context.tools.length > 0) {
		// The session's level is not negotiable with the wire: some models publish
		// function calling as available only at one effort, and the request still
		// goes out with `tools` on it either way. Answering at the level asked for
		// there does not degrade the turn, it removes the tools from it.
		params.reasoning_effort = model.toolReasoningEffort;
	} else if (thinking === "low" || thinking === "medium" || thinking === "high") {
		params.reasoning_effort = thinking;
	}

	return params;
}

export function convertMessages(context: Context): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];

	if (context.systemPrompt) {
		out.push({ role: "system", content: context.systemPrompt });
	}

	for (const message of context.messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				out.push({ role: "user", content: message.content });
			} else {
				out.push({
					role: "user",
					content: message.content.map((block) =>
						block.type === "text"
							? { type: "text", text: block.text }
							: { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
					),
				});
			}
		} else if (message.role === "assistant") {
			const toolCalls = message.content.filter((block) => block.type === "toolCall");
			const text = message.content
				.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (toolCalls.length > 0) {
				out.push({
					role: "assistant",
					content: text || null,
					tool_calls: toolCalls.map((call) => ({
						id: call.id,
						type: "function",
						function: { name: call.name, arguments: call.arguments || "{}" },
					})),
				});
			} else if (text) {
				out.push({ role: "assistant", content: text });
			}
		} else {
			// toolResult → role:"tool"
			const text = message.content
				.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			out.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				content: text,
			});
		}
	}

	return out;
}

// ---------------------------------------------------------------------------
// Stream mapping
// ---------------------------------------------------------------------------

const FINISH_REASON_MAP: Record<string, "stop" | "toolUse" | "length" | "refusal"> = {
	stop: "stop",
	tool_calls: "toolUse",
	function_call: "toolUse",
	length: "length",
	max_tokens: "length",
	// A filtered response is a refusal, the same turn the Anthropic wire names
	// with its own stop reason. "stop" would file the model's refusal as a
	// successful turn that happened to say nothing.
	content_filter: "refusal",
	// Real terminal values from TGI-style clones. Every unmapped reason is an
	// error now, so these entries are what keeps the strictness from misfiring
	// on a provider that was working.
	eos: "stop",
	eos_token: "stop",
};

interface OpenToolCallState {
	id: string;
	name: string;
	index: number;
}

export async function* mapOpenAIStream(
	rawChunks: AsyncIterable<OpenAIRawChunk>,
	provider: string,
	modelId: string,
): AsyncGenerator<AssistantMessageEvent> {
	const builder = new MessageBuilder(provider, modelId);
	const openCalls = new Map<number, OpenToolCallState>();
	let textIndex = -1;
	let thinkingIndex = -1;
	let nextContentIndex = 0;
	let finishReason: string | null = null;
	let sawContent = false;

	for await (const chunk of rawChunks) {
		if (!sawContent) {
			// Start marks the first wire event, not the act of connecting. A
			// connection that was accepted and then went silent must look
			// event-less to the retry layer above, where it earns a second
			// attempt instead of ending the turn. The Anthropic mapper has
			// always emitted start this way, off its first wire event.
			yield builder.start();
		}
		sawContent = true;
		if (chunk.usage) {
			const promptTotal = chunk.usage.prompt_tokens ?? builder.message.usage.promptTotal;
			// Not `prompt_tokens_details.cached_tokens` alone: Kimi and DeepSeek state
			// the same number elsewhere, and reading one spelling recorded every one
			// of their cache hits as a miss.
			const cacheRead = cachedTokensFrom(chunk.usage) ?? builder.message.usage.cacheRead;
			builder.message.usage = {
				// `prompt_tokens` counts the cached prefix; `input` must not, or the
				// cached tokens are billed once as input and again as cacheRead.
				input: promptTotal === undefined ? builder.message.usage.input : Math.max(0, promptTotal - cacheRead),
				output: chunk.usage.completion_tokens ?? builder.message.usage.output,
				cacheRead,
				cacheWrite: builder.message.usage.cacheWrite,
				reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens,
				promptTotal,
			};
		}

		const choice = chunk.choices?.[0];
		if (!choice) continue;

		const delta = choice.delta;
		if (delta?.reasoning_content) {
			if (thinkingIndex === -1) {
				thinkingIndex = nextContentIndex++;
				yield builder.thinkingStart(thinkingIndex);
			}
			yield builder.thinkingDelta(thinkingIndex, delta.reasoning_content);
		}

		// `content` arrives as a string on most providers and as a list of parts
		// on some: a thinking part carries its text one level down (a `thinking`
		// array of text parts), the answer's first text part shares its list with
		// the trace's last, and once the answer is running the field is a plain
		// string again. Read as a string alone, the list lands whole in
		// `textDelta` — a block of "[object Object]" in the middle of the
		// answer, with the trace lost.
		const content = delta?.content;
		if (typeof content === "string") {
			if (content) {
				if (textIndex === -1) {
					textIndex = nextContentIndex++;
					yield builder.textStart(textIndex);
				}
				yield builder.textDelta(textIndex, content);
			}
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (part?.type === "thinking") {
					for (const inner of part.thinking ?? []) {
						if (inner?.type === "text" && inner.text) {
							if (thinkingIndex === -1) {
								thinkingIndex = nextContentIndex++;
								yield builder.thinkingStart(thinkingIndex);
							}
							yield builder.thinkingDelta(thinkingIndex, inner.text);
						}
					}
				} else if (part?.type === "text" && part.text) {
					if (textIndex === -1) {
						textIndex = nextContentIndex++;
						yield builder.textStart(textIndex);
					}
					yield builder.textDelta(textIndex, part.text);
				}
			}
		}

		if (delta?.tool_calls) {
			for (const fragment of delta.tool_calls) {
				const slot = fragment.index;
				let state = openCalls.get(slot);
				if (!state) {
					state = {
						id: fragment.id ?? `call_${slot}`,
						name: fragment.function?.name ?? "",
						index: nextContentIndex++,
					};
					openCalls.set(slot, state);
					yield builder.toolCallStart(state.index, state.id, state.name);
				} else if (fragment.function?.name && !state.name) {
					state.name = fragment.function.name;
				}
				if (fragment.function?.arguments) {
					yield builder.toolCallDelta(state.index, fragment.function.arguments);
				}
			}
		}

		if (choice.finish_reason) {
			finishReason = choice.finish_reason;
		}
	}

	if (!sawContent) {
		yield builder.error("OpenAI-compatible stream produced no content");
		return;
	}

	// Close open blocks in creation order.
	if (thinkingIndex !== -1) {
		yield builder.thinkingEnd(thinkingIndex);
	}
	if (textIndex !== -1) {
		yield builder.textEnd(textIndex);
	}

	// Long-form design notes: docs/dev/ai-layer.md
	let stop: StopReason = "stop";
	if (finishReason) {
		const mapped = FINISH_REASON_MAP[finishReason];
		if (mapped) {
			stop = mapped;
		} else {
			stop = "error";
			builder.message.errorMessage = `Unrecognized finish reason: ${finishReason}`;
		}
	}
	builder.message.stopReason = stop;

	const sorted = [...openCalls.values()].sort((a, b) => a.index - b.index);
	for (const state of sorted) {
		yield builder.toolCallEnd(state.index);
	}

	yield builder.done(stop);
}

// ---------------------------------------------------------------------------
// Live StreamFn
// ---------------------------------------------------------------------------

export interface OpenAIClientLike {
	chat: {
		completions: {
			create(params: Record<string, unknown>): Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>;
		};
	};
}

export interface OpenAIStreamFnOptions {
	clientFactory?: () => OpenAIClientLike;
	policy?: CachePolicy;
}

export function createOpenAIStreamFn(settings: OpenAIStreamFnOptions = {}) {
	return async function* openAIStream(
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		const client = settings.clientFactory ? settings.clientFactory() : await defaultClient(model, options);
		const params = buildOpenAIRequest(model, context, options, settings.policy);
		const raw = (await client.chat.completions.create(params)) as unknown as AsyncIterable<OpenAIRawChunk>;
		yield* mapOpenAIStream(raw, model.provider, model.id);
	};
}

async function defaultClient(model: Model, options?: StreamOptions): Promise<OpenAIClientLike> {
	const { default: OpenAI } = await import("openai");
	const apiKey = options?.apiKey ?? resolveApiKey(model) ?? "";
	// Thread the caller's abort signal into every request so Esc cancels
	// OpenAI-compatible providers the same way it cancels Anthropic.
	//
	// Both signals must reach the request: the SDK puts its own on the init —
	// its timeout timer aborts through that one — so replacing it with the
	// caller's alone would leave the timeout with no listener.
	const callerSignal = options?.signal;
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl || undefined,
		maxRetries: 0, // our retry wrapper owns retry policy
		fetch: callerSignal
			? (input, init) => fetch(input, { ...init, signal: composeSignals(init?.signal, callerSignal) })
			: undefined,
	}) as unknown as OpenAIClientLike;
}

export { parseToolArguments };

// ---------------------------------------------------------------------------
// Catalog listing
// ---------------------------------------------------------------------------

/** `GET /models` answers with one page and no cursor — this is the whole shape. */
export interface OpenAIModelPage {
	/** `context_length` is Kimi's; the other vendors answer with an id and nothing else. */
	data?: Array<{ id?: string; context_length?: number }>;
}

export interface OpenAIModelsClientLike {
	models: { list(options?: { signal?: AbortSignal }): Promise<OpenAIModelPage> };
}

// Long-form design notes: docs/dev/ai-layer.md
/** What this key can reach: almost only ids, plus a window where a vendor states one. */
export async function listOpenAIModels(
	model: Model,
	options?: { client?: OpenAIModelsClientLike; signal?: AbortSignal },
): Promise<{ models: DiscoveredModel[]; complete: boolean }> {
	const client = options?.client ?? (await defaultModelsClient(model));
	const response = await client.models.list({ signal: options?.signal });
	const models: DiscoveredModel[] = [];
	for (const entry of response.data ?? []) {
		if (!entry.id) continue;
		const window = entry.context_length;
		models.push(typeof window === "number" && window > 0 ? { id: entry.id, contextWindow: window } : { id: entry.id });
	}
	return { models, complete: true };
}

async function defaultModelsClient(model: Model): Promise<OpenAIModelsClientLike> {
	const { default: OpenAI } = await import("openai");
	// As in the Anthropic adapter: how long to wait arrives as a signal.
	return new OpenAI({
		apiKey: resolveApiKey(model) ?? "",
		baseURL: model.baseUrl || undefined,
		maxRetries: 0,
	}) as unknown as OpenAIModelsClientLike;
}
