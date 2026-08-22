/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * Works unchanged against OpenAI, DeepSeek, Kimi (Moonshot), GLM (Z.AI),
 * OpenRouter, and any other provider exposing the /chat/completions wire
 * format via a custom baseUrl.
 *
 * Wire quirks handled:
 * - Tool calls stream as fragments keyed by array INDEX (id/name only on the
 *   first fragment of each call); arguments pieces are concatenated raw and
 *   parsed once at finish.
 * - Reasoning models (DeepSeek-R1 style) stream `delta.reasoning_content`.
 * - Usage only arrives when `stream_options: { include_usage: true }`.
 * - finish_reason is the terminal signal: we emit toolcall_end for all open
 *   calls and map to our StopReason.
 */
import { MessageBuilder, parseToolArguments } from "../message-builder.ts";
import { resolveApiKey } from "../model.ts";
import type { AssistantMessageEvent, Context, Model, StreamOptions, WireTool } from "../types.ts";

// ---------------------------------------------------------------------------
// Raw wire types (structural subset, local so tests use plain fixtures)
// ---------------------------------------------------------------------------

export interface OpenAIRawChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
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
	reasoning_effort?: "low" | "medium" | "high";
	temperature?: number;
}

export function buildOpenAIRequest(model: Model, context: Context, options?: StreamOptions): OpenAIRequestParams {
	const params: OpenAIRequestParams = {
		model: model.id,
		messages: convertMessages(context),
		stream: true,
		stream_options: { include_usage: true },
	};

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
	if (thinking === "low" || thinking === "medium" || thinking === "high") {
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

const FINISH_REASON_MAP: Record<string, "stop" | "toolUse" | "length"> = {
	stop: "stop",
	tool_calls: "toolUse",
	function_call: "toolUse",
	length: "length",
	max_tokens: "length",
	content_filter: "stop",
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

	yield builder.start();

	for await (const chunk of rawChunks) {
		sawContent = true;
		if (chunk.usage) {
			builder.message.usage = {
				input: chunk.usage.prompt_tokens ?? builder.message.usage.input,
				output: chunk.usage.completion_tokens ?? builder.message.usage.output,
				cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? builder.message.usage.cacheRead,
				cacheWrite: builder.message.usage.cacheWrite,
				reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens,
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

		if (delta?.content) {
			if (textIndex === -1) {
				textIndex = nextContentIndex++;
				yield builder.textStart(textIndex);
			}
			yield builder.textDelta(textIndex, delta.content);
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

	// Determine terminal stop reason BEFORE emitting toolcall_end events so the
	// finalized partial carries the right stopReason.
	const stop = finishReason ? (FINISH_REASON_MAP[finishReason] ?? "stop") : "stop";
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

export function createOpenAIStreamFn(clientFactory?: () => OpenAIClientLike) {
	return async function* openAIStream(
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		const client = clientFactory ? clientFactory() : await defaultClient(model, options);
		const params = buildOpenAIRequest(model, context, options);
		const raw = (await client.chat.completions.create(params)) as unknown as AsyncIterable<OpenAIRawChunk>;
		yield* mapOpenAIStream(raw, model.provider, model.id);
	};
}

async function defaultClient(model: Model, options?: StreamOptions): Promise<OpenAIClientLike> {
	const { default: OpenAI } = await import("openai");
	const apiKey = options?.apiKey ?? resolveApiKey(model) ?? "";
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl || undefined,
		maxRetries: 0, // our retry wrapper owns retry policy
	}) as unknown as OpenAIClientLike;
}

export { parseToolArguments };
