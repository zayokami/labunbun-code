export const AI_PACKAGE_VERSION = "0.1.0";

// Prompt caching
export {
	anthropicMinPrefixTokens,
	type CacheCapability,
	type CacheMode,
	type CacheNotice,
	type CachePolicy,
	type CacheTotals,
	type CacheTtl,
	cacheCapability,
	cacheCeiling,
	cachedTokensFrom,
	cacheHitRate,
	cacheTotals,
	DEFAULT_CACHE_POLICY,
	estimatePrefixTokens,
	hash64,
	type PrefixTiers,
	type PromptCacheKeyMode,
	type PromptCacheRetention,
	prefixIdentity,
	prefixTierTokens,
	promptCacheKeyFor,
	promptTotalsOf,
	resolveCacheTtl,
	resolvePromptCacheKey,
	resolvePromptCacheRetention,
	totalsHitRate,
} from "./cache.ts";
export {
	type CacheDivergence,
	type CacheRequestRecord,
	type CacheTracker,
	type CacheTrackerOptions,
	contextFingerprints,
	type DivergenceScope,
	firstDivergence,
	withCacheTracker,
} from "./cache-tracker.ts";
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
	gatewayProvidersFor,
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
	type AnthropicBreakpointPlan,
	type AnthropicCacheRequest,
	type AnthropicRawStreamEvent,
	type AnthropicRequestParams,
	type AnthropicStreamFnOptions,
	buildAnthropicRequest,
	convertMessages as convertMessagesForAnthropic,
	createAnthropicStreamFn,
	mapAnthropicStream,
	planAnthropicBreakpoints,
	previousRequestTail,
} from "./providers/anthropic.ts";
export { FAUX_MODEL, type FauxProvider, type FauxStep, fauxProvider } from "./providers/faux.ts";
export {
	buildOpenAIRequest,
	convertMessages as convertMessagesForOpenAI,
	createOpenAIStreamFn,
	mapOpenAIStream,
	type OpenAIRawChunk,
	type OpenAIRequestParams,
	type OpenAIStreamFnOptions,
} from "./providers/openai-compat.ts";
export {
	buildResponsesRequest,
	convertInput as convertInputForResponses,
	createResponsesStreamFn,
	mapResponsesStream,
	type ResponsesClientLike,
	type ResponsesEnvelope,
	type ResponsesInputItem,
	type ResponsesItem,
	type ResponsesRawEvent,
	type ResponsesRequestParams,
	type ResponsesStreamFnOptions,
	resolveStopReason,
	responsesEffort,
} from "./providers/openai-responses.ts";

// Retry / pricing / registry
export {
	isContextOverflowError,
	looksLikeContextOverflow,
	type RetryOptions,
	statusCodeOf,
	withRetry,
} from "./retry.ts";
export { type StallTimeoutOptions, StreamStallError, withStallTimeout } from "./stall-timeout.ts";
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
	THINKING_LEVELS,
	textContent,
	toolResultMessage,
	userMessage,
} from "./types.ts";

import type { CacheNotice, CachePolicy } from "./cache.ts";
import type { CacheTracker } from "./cache-tracker.ts";
import { withCacheTracker } from "./cache-tracker.ts";
import { MissingApiKeyError, resolveApiKey } from "./model.ts";
import { createAnthropicStreamFn } from "./providers/anthropic.ts";
import { createOpenAIStreamFn } from "./providers/openai-compat.ts";
import { createResponsesStreamFn, type ResponsesClientLike } from "./providers/openai-responses.ts";
import { withRetry } from "./retry.ts";
import { withStallTimeout } from "./stall-timeout.ts";
import type { Model, StreamFn, StreamOptions } from "./types.ts";

/** What the caller wants done about caching, and where to hear about it. */
export interface StreamFnOptions {
	/** Cache settings; the defaults are the ones this app ships with. */
	policy?: CachePolicy;
	/**
	 * Called when a provider refused a cache setting.
	 *
	 * Travels with the transport rather than with `StreamOptions` because it
	 * describes the connection, not the request: the answer outlives the call that
	 * provoked it.
	 */
	onCacheNotice?: (notice: CacheNotice) => void;
	/**
	 * The Responses client, for the same reason the adapters each take one
	 * internally: a test that wants to prove *which adapter a model's `api` reaches*
	 * cannot do it without either a network call or an injection point, and
	 * without one the only available proof is that the call fails — which is
	 * indistinguishable from the branch not existing at all.
	 */
	responsesClientFactory?: () => ResponsesClientLike;
	/**
	 * How long a request may go without a single stream event before it is
	 * declared stalled and torn down. The failure it bounds is the one no
	 * timeout inside the SDK covers: a connection that was accepted and then
	 * went silent.
	 */
	stallTimeoutMs?: number;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The error a model fails with when no key resolves, or undefined when one does. */
export function missingApiKey(model: Model, options?: StreamOptions): MissingApiKeyError | undefined {
	if (options?.apiKey) return undefined;
	return resolveApiKey(model) ? undefined : new MissingApiKeyError(model);
}

/**
 * One request, dispatched by `model.api` — the part both factories share.
 *
 * Not exported: the retry policy and the cache observation are what callers
 * choose between, and both of them wrap this rather than being it.
 */
function dispatchStreamFn(settings: StreamFnOptions): StreamFn {
	const anthropic = createAnthropicStreamFn({
		policy: settings.policy,
		onCacheNotice: settings.onCacheNotice,
	});
	const openai = createOpenAIStreamFn({ policy: settings.policy });
	// Same `policy`, no `onCacheNotice`: the notices this adapter can raise are the
	// two the tracking wrapper already derives, and it has nothing to say about a
	// Responses request that the Chat Completions one might refuse. Wiring the
	// callback in without a notice to pass would be a lie about a hook.
	const responses = createResponsesStreamFn({
		policy: settings.policy,
		clientFactory: settings.responsesClientFactory,
	});
	return (model, context, options) => {
		const missingKey = missingApiKey(model, options);
		if (missingKey) throw missingKey;
		if (model.api === "anthropic-messages") return anthropic(model, context, options);
		if (model.api === "openai-completions") return openai(model, context, options);
		if (model.api === "openai-responses") return responses(model, context, options);
		throw new Error(`Unsupported API: ${model.api}`);
	};
}

// Long-form design notes: docs/dev/ai-layer.md
/** Default StreamFn: dispatch by `model.api`, under the stall watchdog, under the retry policy. */
export function createDefaultStreamFn(settings: StreamFnOptions = {}): StreamFn {
	const guarded = withStallTimeout(dispatchStreamFn(settings), {
		idleTimeoutMs: settings.stallTimeoutMs ?? 120_000,
	});
	return withRetry(guarded);
}

// Long-form design notes: docs/dev/ai-layer.md
/** The same stream function, plus a record of what each request did to the cache. */
export function createTrackedStreamFn(settings: StreamFnOptions = {}): { streamFn: StreamFn; tracker: CacheTracker } {
	const notices: CacheNotice[] = [];
	const inner = createDefaultStreamFn({
		...settings,
		onCacheNotice: (notice) => {
			notices.push(notice);
			settings.onCacheNotice?.(notice);
		},
	});
	return withCacheTracker(inner, { notices });
}
