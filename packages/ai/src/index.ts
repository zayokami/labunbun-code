export const AI_PACKAGE_VERSION = "0.1.0";

export {
	type CatalogProbe,
	type CatalogRefresh,
	type DiscoveredListing,
	formatCatalogNotice,
	refreshModelCatalog,
} from "./discovery.ts";
export { withModelFallback } from "./fallback.ts";
// Streaming internals
export { MessageBuilder, parseToolArguments } from "./message-builder.ts";
export {
	apiKeyEnvNames,
	applyBaseUrlOverrides,
	baseUrlEnvVar,
	clearCustomModels,
	clearDiscovery,
	clearPricingOverrides,
	type DiscoveredModel,
	listModels,
	MissingApiKeyError,
	type OpenAICompatibleProviderSpec,
	registerOpenAICompatibleProvider,
	resolveApiKey,
	resolveModel,
	setPricingOverride,
	setProviderCatalogue,
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
export {
	isContextOverflowError,
	looksLikeContextOverflow,
	type RetryOptions,
	statusCodeOf,
	withRetry,
} from "./retry.ts";
export { repairToolPairing } from "./transcript.ts";
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
	RetryNotice,
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

import { MissingApiKeyError, resolveApiKey } from "./model.ts";
import { createAnthropicStreamFn } from "./providers/anthropic.ts";
import { createOpenAIStreamFn } from "./providers/openai-compat.ts";
import { withRetry } from "./retry.ts";
import type { Model, StreamFn, StreamOptions } from "./types.ts";

/**
 * The error a model fails with when no key resolves, or undefined when one does.
 *
 * The adapters would otherwise hand the SDK an empty key and let it complain
 * about authentication, which reads like a failure a retry might get past. The
 * pre-flight is the whole difference, so it is exported: a test that proved it
 * by reaching a provider would be testing the provider.
 */
export function missingApiKey(model: Model, options?: StreamOptions): MissingApiKeyError | undefined {
	if (options?.apiKey) return undefined;
	return resolveApiKey(model) ? undefined : new MissingApiKeyError(model);
}

/**
 * Default StreamFn: dispatch by `model.api`, wrapped in retry policy.
 */
export function createDefaultStreamFn(): StreamFn {
	const anthropic = createAnthropicStreamFn();
	const openai = createOpenAIStreamFn();
	const base: StreamFn = (model, context, options) => {
		const missingKey = missingApiKey(model, options);
		if (missingKey) throw missingKey;
		if (model.api === "anthropic-messages") return anthropic(model, context, options);
		if (model.api === "openai-completions") return openai(model, context, options);
		throw new Error(`Unsupported API: ${model.api}`);
	};
	return withRetry(base);
}
