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
	// Long-form design notes: docs/dev/ai-layer.md
	/**
	 * Why the request failed, when the reason is one the caller can act on.
	 *
	 * The one reader is the fallback walk: `rate_limit`, `overload` and `auth`
	 * are failures another model may answer, so the chain descends on them;
	 * `context_overflow` is not — the same context will not fit anywhere with
	 * the same window — and ends the walk with this message as it stands. An
	 * absent kind is an unclassified failure, and the walk keeps it: provider
	 * wordings that match no rule have always been retried on the next model.
	 */
	errorKind?: "context_overflow" | "rate_limit" | "overload" | "auth";
	// Long-form design notes: docs/dev/error-handling.md
	/**
	 * Set when this turn kept partial content through a failure or an abort.
	 *
	 * The text is real but the answer is not finished, and without the flag a
	 * resumed session would show it as a complete response. Provider adapters
	 * build their payloads field by field, so this marker never reaches the
	 * wire; it is written to the session file with the rest of the message.
	 */
	incomplete?: true;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ToolResultContent[];
	isError: boolean;
	timestamp: number;
	// Long-form design notes: docs/dev/ai-layer.md
	/**
	 * Set only on a result a transcript repair invented for an interrupted call.
	 *
	 * Memory-only: it is never written to a session file and never sent on the
	 * wire — provider adapters read the roles and content they already know.
	 * Compaction reads it to keep such a result out of the suffix it records,
	 * because the file has no entry behind it to match against.
	 */
	synthetic?: true;
	// Long-form design notes: docs/dev/error-handling.md
	/**
	 * Set on the result the loop writes for a call an abort cut short.
	 *
	 * `isError` stays true because the wire pairing needs a failed result, but
	 * the failure is the user's own Esc, not a broken tool: the interface shows
	 * it as an interruption rather than a red error. Unlike `synthetic`, this
	 * marker is written to the session file, so a resumed transcript keeps the
	 * distinction.
	 */
	interrupted?: true;
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

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The five wires this app speaks. `chatgpt-responses` is the Responses wire as
 * the ChatGPT subscription backend speaks it, and `gemini-code-assist` the
 * generate-content wire as the Gemini subscription backend does.
 */
export type ApiId =
	| "anthropic-messages"
	| "openai-completions"
	| "openai-responses"
	| "chatgpt-responses"
	| "gemini-code-assist";

/**
 * The wires a user-defined provider may name. The two subscription wires are
 * deliberately absent: each is tied to a token minted by a login this app
 * performs, so a settings file naming one could only describe a connection it
 * cannot make. The first entry is the default, which keeps every provider
 * written before this choice existed working unchanged.
 */
export const CUSTOM_PROVIDER_API_IDS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type CustomProviderApiId = (typeof CUSTOM_PROVIDER_API_IDS)[number];

/** Whether a value read from outside (a settings file, another agent's config) names a custom wire. */
export function isCustomProviderApiId(value: unknown): value is CustomProviderApiId {
	return typeof value === "string" && (CUSTOM_PROVIDER_API_IDS as readonly string[]).includes(value);
}

/**
 * The thinking levels a session can ask for, as a runtime list. Anything that
 * has to validate a level — the settings schema is one — derives its set from
 * here rather than restating it, so the two cannot drift apart.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
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
	/**
	 * The write rate for tokens written under a one-hour TTL, where the provider
	 * charges a different rate for that bucket — Anthropic charges twice the input
	 * rate for it against 1.25x for the five-minute default. Absent means the same
	 * rate as `cacheWrite`, which is what every other provider bills.
	 */
	cacheWrite1h?: number;
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
	/**
	 * Environment variable holding the API key. Absent for a provider that needs
	 * none — the local Ollama daemon so far — which `missingApiKey` reads as
	 * "there is nothing to miss" rather than as a variable named `undefined`.
	 */
	apiKeyEnv?: string;
	/**
	 * Additional environment variables to try when `apiKeyEnv` is unset, in
	 * order. Exists because the same provider is commonly configured under more
	 * than one variable name depending on how the credential was issued.
	 */
	apiKeyEnvFallbacks?: string[];
	contextWindow: number;
	maxOutputTokens: number;
	reasoning: boolean;
	// Long-form design notes: docs/dev/ai-layer.md
	/** Which thinking shape the model accepts, where the vendor offers a choice or retired one. */
	thinkingMode?: "adaptive" | "extended";
	// Long-form design notes: docs/dev/ai-layer.md
	/** Whether the provider validates a replayed thinking block against its conversation. */
	thinkingBlockBinding?: boolean;
	// Long-form design notes: docs/dev/ai-layer.md
	/** The effort this model needs on the OpenAI-compatibility wire when the request carries tools. */
	toolReasoningEffort?: "low" | "medium" | "high" | "none";
	// Long-form design notes: docs/dev/ai-layer.md
	/** The efforts this model accepts on its own wire, when that is a proper subset of ours. */
	reasoningEfforts?: readonly Exclude<ThinkingLevel, "off">[];
	// Long-form design notes: docs/dev/ai-layer.md
	/**
	 * The ChatGPT backend's Responses Lite shape, off the catalog codex ships:
	 * tools ride inside an `additional_tools` input item wrapped in a namespace,
	 * top-level `tools` and `instructions` are not sent, and reasoning carries
	 * `context: "all_turns"`.
	 */
	responsesLite?: boolean;
	// Long-form design notes: docs/dev/ai-layer.md
	/** `false` when this model cannot call tools on the wire its own row names. */
	toolCalling?: false;
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
	 * A JSON Schema the answer's text must follow.
	 *
	 * The host gates it to wires that can express one; an adapter that receives
	 * it puts it on the request in that wire's own spelling. A provider that
	 * cannot express the constraint must refuse rather than send a request that
	 * silently ignores it.
	 */
	outputSchema?: Record<string, unknown>;
	/**
	 * Called once per retry, just before the wrapper sleeps.
	 *
	 * A ladder that backs off to thirty seconds a step runs for minutes, and
	 * without this the whole of it is silence: the request may be per-model, so
	 * the callback rides on the options rather than on the wrapper.
	 */
	onRetry?: (retry: RetryNotice) => void;
	/**
	 * Called once per descent of the fallback chain, before the next model is
	 * tried.
	 *
	 * A switch is otherwise invisible: the answer arrives from a model the user
	 * never chose, billed at a price they may not expect. The callback rides on
	 * the options for the same reason `onRetry` does — the decision is per
	 * request, and the wrapper sees the options every candidate received.
	 */
	onFallback?: (notice: FallbackNotice) => void;
}

/** One step down a model fallback chain, announced before the next model runs. */
export interface FallbackNotice {
	/** The model whose attempt ended the descent. */
	from: { provider: string; id: string };
	/** The model about to be tried. */
	to: { provider: string; id: string };
	/** The failure that caused the descent, as its own message. */
	reason: string;
	errorKind?: AssistantMessage["errorKind"];
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

// Long-form design notes: docs/dev/ai-layer.md
/** The uniform streaming protocol every provider adapter emits. */
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
