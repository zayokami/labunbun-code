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

import { MessageBuilder } from "../message-builder.ts";
import type { AssistantMessageEvent, Context, Model, StreamOptions, ThinkingLevel, WireTool } from "../types.ts";

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
	system?: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
	messages: Array<Record<string, unknown>>;
	tools?: Array<{ name: string; description: string; input_schema: unknown }>;
	stream: true;
	thinking?: { type: "enabled"; budget_tokens: number };
	metadata?: { user_id?: string };
}

export function buildAnthropicRequest(model: Model, context: Context, options?: StreamOptions): AnthropicRequestParams {
	const params: AnthropicRequestParams = {
		model: model.id,
		max_tokens: options?.maxOutputTokens ?? model.maxOutputTokens,
		messages: convertMessages(context.messages),
		stream: true,
	};

	if (context.systemPrompt) {
		params.system = [
			{
				type: "text",
				text: context.systemPrompt,
				// Single cache breakpoint on the system prompt for now; the agent
				// layer adds a transcript-prefix breakpoint once it knows the
				// stable prefix (Phase 2+).
				cache_control: { type: "ephemeral" },
			},
		];
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = context.tools.map((tool: WireTool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
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
 */
export function convertMessages(messages: Context["messages"]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];

	const flushToolResults = (pending: Array<Record<string, unknown>>): void => {
		if (pending.length > 0) out.push({ role: "user", content: pending });
	};

	let toolResults: Array<Record<string, unknown>> = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			const content = message.content.map((block) =>
				block.type === "text" ? { type: "text", text: block.text } : imageBlock(block),
			);
			toolResults.push({
				type: "tool_result",
				tool_use_id: message.toolCallId,
				content: content.length > 0 ? content : [{ type: "text", text: "" }],
				...(message.isError ? { is_error: true } : {}),
			});
			continue;
		}
		flushToolResults(toolResults);
		toolResults = [];

		if (message.role === "user") {
			out.push({
				role: "user",
				content:
					typeof message.content === "string"
						? message.content
						: message.content.map((block) =>
								block.type === "text" ? { type: "text", text: block.text } : imageBlock(block),
							),
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
				content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
			}
		}
		if (content.length > 0) out.push({ role: "assistant", content });
	}
	flushToolResults(toolResults);
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
				builder.message.usage = {
					input: usage?.input_tokens ?? 0,
					output: usage?.output_tokens ?? 0,
					cacheRead: usage?.cache_read_input_tokens ?? 0,
					cacheWrite: usage?.cache_creation_input_tokens ?? 0,
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
				yield builder.error(message);
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

export function createAnthropicStreamFn(clientFactory?: () => AnthropicClientLike) {
	return async function* anthropicStream(
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AsyncGenerator<AssistantMessageEvent> {
		const client = clientFactory ? clientFactory() : await defaultClient(model, options);
		const params = buildAnthropicRequest(model, context, options);
		const raw = (await client.messages.create(params)) as unknown as AsyncIterable<AnthropicRawStreamEvent>;
		yield* mapAnthropicStream(raw, model.provider, model.id);
	};
}

async function defaultClient(model: Model, options?: StreamOptions): Promise<AnthropicClientLike> {
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	const apiKey = options?.apiKey ?? process.env[model.apiKeyEnv] ?? "";
	return new Anthropic({
		apiKey,
		baseURL: model.baseUrl || undefined,
		maxRetries: 0, // our retry wrapper owns retry policy
		fetch: options?.signal ? (input, init) => fetch(input, { ...init, signal: options.signal }) : undefined,
	}) as unknown as AnthropicClientLike;
}
