export const AI_PACKAGE_VERSION = "0.1.0";

export { withModelFallback } from "./fallback.ts";
// Streaming internals
export { MessageBuilder, parseToolArguments } from "./message-builder.ts";
export {
	apiKeyEnvNames,
	applyBaseUrlOverrides,
	baseUrlEnvVar,
	clearCustomModels,
	listModels,
	type OpenAICompatibleProviderSpec,
	registerOpenAICompatibleProvider,
	resolveApiKey,
	resolveModel,
} from "./model.ts";
export { type CostBreakdown, computeCost, formatCost } from "./pricing.ts";

// Providers
export {
	type AnthropicRawStreamEvent,
	type AnthropicRequestParams,
	buildAnthropicRequest,
	convertMessages as convertMessagesForAnthropic,
	createAnthropicStreamFn,
	mapAnthropicStream,
} from "./providers/anthropic.ts";
export { FAUX_MODEL, type FauxProvider, type FauxStep, fauxProvider } from "./providers/faux.ts";
export {
	buildOpenAIRequest,
	convertMessages as convertMessagesForOpenAI,
	createOpenAIStreamFn,
	mapOpenAIStream,
	type OpenAIRawChunk,
	type OpenAIRequestParams,
} from "./providers/openai-compat.ts";

// Retry / pricing / registry
export { type RetryOptions, statusCodeOf, withRetry } from "./retry.ts";
// Types
export type {
	AgentMessage,
	ApiId,
	AssistantContent,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	JsonSchemaObject,
	Model,
	ModelPricing,
	StopReason,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
	ToolResultContent,
	ToolResultMessage,
	Usage,
	UserContent,
	UserMessage,
	WireTool,
} from "./types.ts";
export {
	assistantMessage,
	textContent,
	toolResultMessage,
	userMessage,
} from "./types.ts";

import { createAnthropicStreamFn } from "./providers/anthropic.ts";
import { createOpenAIStreamFn } from "./providers/openai-compat.ts";
import { withRetry } from "./retry.ts";
import type { StreamFn } from "./types.ts";

/**
 * Default StreamFn: dispatch by `model.api`, wrapped in retry policy.
 */
export function createDefaultStreamFn(): StreamFn {
	const anthropic = createAnthropicStreamFn();
	const openai = createOpenAIStreamFn();
	const base: StreamFn = (model, context, options) => {
		if (model.api === "anthropic-messages") return anthropic(model, context, options);
		if (model.api === "openai-completions") return openai(model, context, options);
		throw new Error(`Unsupported API: ${model.api}`);
	};
	return withRetry(base);
}
