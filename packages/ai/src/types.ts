/**
 * Provider-neutral message model and streaming protocol.
 *
 * Design contract (see plan): the streaming protocol is event-based; errors
 * never throw across a stream boundary — they arrive as a terminal `error`
 * event carrying a finalized AssistantMessage with stopReason "error"/"aborted".
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/** Provider signature proving the thinking block's provenance (Anthropic). */
	signature?: string;
}

export interface ImageContent {
	type: "image";
	/** MIME type, e.g. "image/png". */
	mimeType: string;
	/** Base64-encoded image data. */
	data: string;
}

/** A tool invocation requested by the model. `arguments` is raw JSON text. */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	/**
	 * Raw JSON object text. Kept as a string until the block completes so
	 * adapters never parse partial JSON; parsed exactly once at toolcall_end.
	 */
	arguments: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export type UserContent = TextContent | ImageContent;
export type ToolResultContent = TextContent | ImageContent;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type StopReason = "pending" | "stop" | "toolUse" | "length" | "error" | "aborted";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Reasoning tokens; a subset of `output`, reported separately when known. */
	reasoning?: number;
}

export interface UserMessage {
	role: "user";
	content: string | UserContent[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ToolResultContent[];
	isError: boolean;
	timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export function userMessage(content: string | UserContent[], timestamp = Date.now()): UserMessage {
	return { role: "user", content, timestamp };
}

export function assistantMessage(init: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		provider: "",
		model: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "pending",
		timestamp: Date.now(),
		...init,
	};
}

export function toolResultMessage(
	toolCallId: string,
	toolName: string,
	content: ToolResultContent[],
	isError = false,
	timestamp = Date.now(),
): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content, isError, timestamp };
}

export function textContent(text: string): TextContent {
	return { type: "text", text };
}

// ---------------------------------------------------------------------------
// Models, context, streaming
// ---------------------------------------------------------------------------

export type ApiId = "anthropic-messages" | "openai-completions";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** Minimal structural type for a JSON Schema object (tool parameters). */
export interface JsonSchemaObject {
	type: "object";
	properties?: Record<string, unknown>;
	required?: string[];
	[key: string]: unknown;
}

/** Price in USD per million tokens. */
export interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Model<Api extends ApiId = ApiId> {
	/** Fully-qualified model id, e.g. "claude-sonnet-5". */
	id: string;
	/** Human-readable display name. */
	name: string;
	api: Api;
	/** Provider key, e.g. "anthropic" | "deepseek" | "kimi". */
	provider: string;
	baseUrl: string;
	/** Environment variable holding the API key. */
	apiKeyEnv: string;
	contextWindow: number;
	maxOutputTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
	pricing?: ModelPricing;
}

/** A tool as sent over the wire (schema already converted to JSON Schema). */
export interface WireTool {
	name: string;
	description: string;
	parameters: JsonSchemaObject;
}

export interface Context {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: WireTool[];
}

export interface StreamOptions {
	signal?: AbortSignal;
	maxOutputTokens?: number;
	thinkingLevel?: ThinkingLevel;
	/** Explicit API key override (rare; usually resolved from `model.apiKeyEnv`). */
	apiKey?: string;
	headers?: Record<string, string>;
}

export type StreamFn = (
	model: Model,
	context: Context,
	options?: StreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

// ---------------------------------------------------------------------------
// Streaming event protocol
// ---------------------------------------------------------------------------

/**
 * The uniform streaming protocol every provider adapter emits.
 *
 * Contract:
 * - `start` is emitted exactly once, first.
 * - Exactly one terminal event (`done` or `error`) is emitted last.
 * - `*_start`/`*_delta`/`*_end` events for the same content share contentIndex.
 * - Every event carries the accumulated `partial` message snapshot, so
 *   consumers render directly without re-reducing deltas.
 * - toolcall arguments arrive as raw JSON fragments (`toolcall_delta`) and are
 *   parsed once, at `toolcall_end`.
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; message: AssistantMessage };
