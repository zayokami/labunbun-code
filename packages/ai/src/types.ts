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

/**
 * How a turn ended. "refusal" is the model declining on policy grounds — a
 * deliberate answer, not a failure of the request, but one the caller has to
 * see: it arrives with no content and no tool calls, so folding it into "stop"
 * makes a refusal indistinguishable from a model that simply said nothing.
 */
export type StopReason = "pending" | "stop" | "toolUse" | "length" | "error" | "aborted" | "refusal";

export interface Usage {
	/**
	 * Input tokens billed at the full rate — the *uncached* part of the prompt.
	 * The wire formats disagree: Anthropic's `input_tokens` already excludes the
	 * cached prefix, OpenAI's `prompt_tokens` includes it. Adapters normalize to
	 * the Anthropic reading, so summing all four channels is the true token
	 * count and never counts a cached token twice.
	 */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/**
	 * Write tokens split by the TTL they were written under, where the provider
	 * says. Anthropic does, and it is the only evidence that a one-hour TTL took
	 * effect: a provider that quietly accepted the field and wrote a five-minute
	 * entry anyway reports the same `cacheWrite` either way.
	 */
	cacheWriteTtl?: { "5m": number; "1h": number };
	/** Reasoning tokens; a subset of `output`, reported separately when known. */
	reasoning?: number;
	/**
	 * Every token in the request prefix, cached or not — the number to compare
	 * against a context window, and the only one that means the same thing on
	 * both APIs. Absent on messages recorded before adapters reported it.
	 */
	promptTotal?: number;
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
	/**
	 * Why the request failed, when the reason is one the caller can act on.
	 *
	 * "context_overflow" means the provider refused the request for being bigger
	 * than the model's window. Nothing about the request changes by sending it
	 * again or sending it to the next model in a fallback chain, so callers stop
	 * rather than replay: only sending less can help.
	 */
	errorKind?: "context_overflow";
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

/**
 * The three wires this app speaks.
 *
 * `openai-responses` is not a vendor but an endpoint, and it is separate from
 * `openai-completions` because the two disagree on nearly everything that
 * matters to an agent: the system prompt is a top-level field rather than the
 * first message, tools are declared flat rather than nested under `function`,
 * tool results are input items carrying a `call_id` rather than `role: "tool"`
 * messages, and the stream is a sequence of named events rather than a delta
 * array. A row that answers on one does not answer on the other — `gpt-6.1-sol`
 * is the one that makes this concrete, since its function calling is published
 * on Responses only and a Chat Completions request that carries tools is a shape
 * it does not accept.
 */
export type ApiId = "anthropic-messages" | "openai-completions" | "openai-responses";

/**
 * The thinking levels a session can ask for, as a runtime list. Anything that
 * has to validate a level — the settings schema is one — derives its set from
 * here rather than restating it, so the two cannot drift apart.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

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
	/**
	 * Additional environment variables to try when `apiKeyEnv` is unset, in
	 * order. Exists because the same provider is commonly configured under more
	 * than one variable name depending on how the credential was issued.
	 */
	apiKeyEnvFallbacks?: string[];
	contextWindow: number;
	maxOutputTokens: number;
	reasoning: boolean;
	/**
	 * Which thinking shape the model accepts, where the vendor offers a choice
	 * or has retired one of them. `"adaptive"` means the model decides for
	 * itself and depth comes from a separate effort control; `"extended"` means
	 * the caller names a token budget. Sending the wrong one is a 400 on the
	 * first request, not a degraded answer.
	 *
	 * Absent means the adapter has nothing to say on the subject — for models
	 * with a single documented shape that is the same thing as naming it.
	 */
	thinkingMode?: "adaptive" | "extended";
	/**
	 * Whether the provider validates that a replayed thinking block came from
	 * the conversation it is being replayed into. Only a few models run that
	 * check, and only they can be told what to do when it fails; the adapter
	 * reads this to opt those models into dropping the block instead of failing
	 * the whole request. Flagging a model that runs no check would send it a
	 * parameter it does not know.
	 */
	thinkingBlockBinding?: boolean;
	/**
	 * The `reasoning_effort` this model needs on the OpenAI-compatibility wire when
	 * the request carries tools, where that is not the effort the session asked for.
	 *
	 * `reasoning` is a two-state flag and cannot express this: on Chat Completions
	 * `gpt-6-sol` and `gpt-6-luna` make function calling available *only* at `none`,
	 * and their own default is `medium` — so the flag's `true` sends a value that
	 * costs the tools and its `false` sends nothing, which is the same default. The
	 * failure is not an error. The turn comes back with no `tool_calls` in it and the
	 * agent simply stops acting, which reads as the model ignoring the tools.
	 *
	 * Applies only to a request that has tools: without them there is nothing to
	 * protect, and forcing `none` would drop the reasoning depth the session asked
	 * for on a request that could have carried it.
	 *
	 * The value is not a preference between the efforts a model has, which is why
	 * it is a row's field and not something a family or a provider settles.
	 * `gpt-6-astra` has the same price tier and the same generation and no
	 * constraint at all, and `gpt-6.1-sol` is the case where setting the field
	 * would be worse than leaving it unset: it moved tool calling to the Responses
	 * API, leaving Chat Completions to requests that carry no tools, and it does
	 * not support `none` as an effort — so the value that rescues the rows above
	 * is one it rejects outright rather than one it quietly ignores.
	 */
	toolReasoningEffort?: "low" | "medium" | "high" | "none";
	/**
	 * The efforts this model accepts on its own wire, when it accepts a proper
	 * subset of ours — the OpenAI-compatibility field cannot say this, because it
	 * exists to name one *replacement* effort, not a range.
	 *
	 * The session asks for a `ThinkingLevel` and this is what says whether the
	 * request can carry it. `gpt-6.1-sol` is the case that needs it: it supports
	 * neither `minimal` nor `none`, so a session set to `minimal` would otherwise
	 * put a value the model rejects on every request, and the adapter has no way
	 * to learn that from the request it is building. The field is per-row because
	 * it is a per-model fact, the same way `toolReasoningEffort` is.
	 *
	 * A requested level outside the list is **omitted from the request** rather
	 * than rounded to the nearest one it does accept. Rounding is a guess about
	 * what the session would have wanted; omitting says what actually happened,
	 * and the model's own default is a thing the vendor picked rather than one we
	 * picked on the user's behalf.
	 */
	reasoningEfforts?: readonly Exclude<ThinkingLevel, "off">[];
	/**
	 * `false` when this model cannot call tools on the wire its own row names.
	 *
	 * Absent means it can, which is true of every row but one shape. The shape is
	 * a reseller: it serves a model whose function calling is published on
	 * `/v1/responses` over an endpoint that only answers `/chat/completions`. The
	 * row is not broken — it answers, the text is good, the price is right — and
	 * it is still wrong to offer it for an agent session, because
	 * `packages/agent/src/session.ts` puts `tools` on every request and a model
	 * that cannot act returns prose where the user is waiting for a file edit.
	 *
	 * So this is a fact about the row rather than a filter applied at the picker:
	 * every place that offers a model to a session reads it, and a second place
	 * that forgot to would re-open the trap this field exists to close.
	 */
	toolCalling?: false;
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
	/**
	 * Called once per retry, just before the wrapper sleeps.
	 *
	 * A ladder that backs off to thirty seconds a step runs for minutes, and
	 * without this the whole of it is silence: the request may be per-model, so
	 * the callback rides on the options rather than on the wrapper.
	 */
	onRetry?: (retry: RetryNotice) => void;
}

/** One step of a retry ladder, before the sleep that follows it. */
export interface RetryNotice {
	/** 1 for the first failure, i.e. the attempt that just failed. */
	attempt: number;
	error: unknown;
	delayMs: number;
	/** The error's own message, so a caller that only displays need not narrow it. */
	message: string;
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
