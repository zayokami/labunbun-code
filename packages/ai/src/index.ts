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

import type { CacheNotice, CachePolicy } from "./cache.ts";
import type { CacheTracker } from "./cache-tracker.ts";
import { withCacheTracker } from "./cache-tracker.ts";
import { MissingApiKeyError, resolveApiKey } from "./model.ts";
import { createAnthropicStreamFn } from "./providers/anthropic.ts";
import { createOpenAIStreamFn } from "./providers/openai-compat.ts";
import { withRetry } from "./retry.ts";
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
}

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
	return (model, context, options) => {
		const missingKey = missingApiKey(model, options);
		if (missingKey) throw missingKey;
		if (model.api === "anthropic-messages") return anthropic(model, context, options);
		if (model.api === "openai-completions") return openai(model, context, options);
		throw new Error(`Unsupported API: ${model.api}`);
	};
}

/**
 * Default StreamFn: dispatch by `model.api`, wrapped in retry policy.
 */
export function createDefaultStreamFn(settings: StreamFnOptions = {}): StreamFn {
	return withRetry(dispatchStreamFn(settings));
}

/**
 * The same stream function, plus a record of what each request did to the cache.
 *
 * The tracker wraps the *whole* transport, retry policy included, so what it
 * records is one entry per request the caller made rather than per attempt
 * underneath it: a retry that succeeds is the same prefix asked twice, and that
 * is how it is recorded.
 *
 * A caller that wants no tracking uses `createDefaultStreamFn` and pays nothing:
 * the hashing here runs per request, and an embedder who never reads the report
 * should not be charged for it.
 *
 * The notices list is created here and handed to both — the adapter writes to it,
 * the tracker reads it — because the adapter has to exist before the wrapper
 * that would otherwise be its owner.
 */
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
