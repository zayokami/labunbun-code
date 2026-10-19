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
	dynamicProviderTemplates,
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
	type AnthropicAuthOptions,
	type AnthropicBreakpointPlan,
	type AnthropicCacheRequest,
	type AnthropicRawStreamEvent,
	type AnthropicRequestParams,
	type AnthropicStreamFnOptions,
	anthropicAuthOptions,
	buildAnthropicRequest,
	convertMessages as convertMessagesForAnthropic,
	createAnthropicStreamFn,
	mapAnthropicStream,
	OAUTH_BETA,
	planAnthropicBreakpoints,
	previousRequestTail,
} from "./providers/anthropic.ts";
export {
	CLAUDE_OAUTH_AUTHORIZE_URL,
	CLAUDE_OAUTH_CLIENT_ID,
	CLAUDE_OAUTH_MANUAL_REDIRECT_URL,
	CLAUDE_OAUTH_SCOPES,
	CLAUDE_OAUTH_TOKEN_URL,
	CLAUDE_REFRESH_WINDOW_MS,
	type ClaudeAuthorizeOptions,
	type ClaudeCredentialStore,
	type ClaudeOAuthCredential,
	ClaudeOAuthError,
	type ClaudeTokenProvider,
	type ClaudeTokenProviderOptions,
	claudeAuthorizeUrl,
	claudeRefreshDue,
	createClaudeTokenProvider,
	createOAuthState,
	createPkce,
	type ExchangeClaudeCodeOptions,
	exchangeClaudeCode,
	parseClaudeAuthorizationInput,
	type RefreshClaudeTokenOptions,
	refreshClaudeToken,
} from "./providers/anthropic-oauth.ts";
export {
	CHATGPT_OAUTH_AUTHORIZE_URL,
	CHATGPT_OAUTH_CLIENT_ID,
	CHATGPT_OAUTH_ISSUER,
	CHATGPT_OAUTH_SCOPE,
	CHATGPT_OAUTH_TOKEN_URL,
	CHATGPT_ORIGINATOR,
	CHATGPT_REFRESH_FALLBACK_MS,
	CHATGPT_REFRESH_WINDOW_MS,
	type ChatGptAuthorizeOptions,
	type ChatGptCredentialStore,
	type ChatGptDeviceCode,
	type ChatGptIdTokenClaims,
	type ChatGptOAuthCredential,
	ChatGptOAuthError,
	type ChatGptTokenGrant,
	type ChatGptTokenProvider,
	type ChatGptTokenProviderOptions,
	type CompleteChatGptDeviceLoginOptions,
	chatGptAuthorizeUrl,
	chatGptJwtExpiresAt,
	chatGptRefreshDue,
	completeChatGptDeviceLogin,
	createChatGptOAuthState,
	createChatGptPkce,
	createChatGptTokenProvider,
	type ExchangeChatGptCodeOptions,
	exchangeChatGptCode,
	parseChatGptIdToken,
	type RefreshChatGptTokenOptions,
	refreshChatGptToken,
	requestChatGptDeviceCode,
} from "./providers/chatgpt-oauth.ts";
export {
	buildChatGptRequest,
	CHATGPT_FUNCTION_NAMESPACE,
	type ChatGptRequestParams,
	type ChatGptStreamFnOptions,
	chatGptHeaders,
	createChatGptStreamFn,
	subscriptionMissingError,
} from "./providers/chatgpt-responses.ts";
export { FAUX_MODEL, type FauxProvider, type FauxStep, fauxProvider } from "./providers/faux.ts";
export {
	buildCodeAssistRequest,
	CODE_ASSIST_API_VERSION,
	CODE_ASSIST_ENDPOINT,
	type CodeAssistContent,
	type CodeAssistFrame,
	type CodeAssistGenerationConfig,
	type CodeAssistPart,
	type CodeAssistRequestParams,
	type CodeAssistStreamFnOptions,
	type CodeAssistThinkingConfig,
	type CodeAssistTool,
	type CodeAssistUsage,
	codeAssistHeaders,
	codeAssistThinkingConfig,
	codeAssistUrl,
	convertContents as convertContentsForCodeAssist,
	createCodeAssistStreamFn,
	DEFAULT_THINKING_BUDGET,
	GEMINI_CLI_VERSION,
	GeminiCodeAssistError,
	type GeminiTokenGrant,
	type GeminiTokenProvider,
	geminiSubscriptionMissingError,
	mapCodeAssistStream,
	parseCodeAssistSse,
	SYNTHETIC_THOUGHT_SIGNATURE,
} from "./providers/gemini-code-assist.ts";
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
export {
	INTERRUPTED_TOOL_RESULT_TEXT,
	repairToolPairing,
	type ToolPairingRepair,
} from "./transcript.ts";
// Types
export type {
	AgentMessage,
	ApiId,
	AssistantContent,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FallbackNotice,
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
import { apiKeyEnvNames, MissingApiKeyError, resolveApiKey } from "./model.ts";
import { createAnthropicStreamFn } from "./providers/anthropic.ts";
import type { ClaudeTokenProvider } from "./providers/anthropic-oauth.ts";
import type { ChatGptTokenGrant, ChatGptTokenProvider } from "./providers/chatgpt-oauth.ts";
import { createChatGptStreamFn } from "./providers/chatgpt-responses.ts";
import { createCodeAssistStreamFn, type GeminiTokenProvider } from "./providers/gemini-code-assist.ts";
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
	 * Where a Claude subscription's bearer token comes from. Travels with the
	 * transport for the same reason `onCacheNotice` does: one account per
	 * process, and the refresh policy it carries outlives any one request.
	 * Consulted per request for the anthropic provider; when its `available()`
	 * says no, requests fall back to the api-key path.
	 */
	credentials?: ClaudeTokenProvider;
	/**
	 * Where a ChatGPT subscription's bearer comes from, consulted per request by
	 * the `chatgpt-responses` adapter. Same transport-scoped reasoning as
	 * `credentials` above; there is no api-key fallback on this wire — the
	 * subscription is the only way in, so an unavailable provider surfaces as
	 * the adapter's own "not signed in" error, which names the login.
	 */
	chatgptCredentials?: ChatGptTokenProvider;
	/**
	 * The ChatGPT client, taking the grant rather than nothing: the bearer is
	 * per-request, and a test that proves the 401 recovery re-mints needs the
	 * second request's grant to be the observable one.
	 */
	chatgptClientFactory?: (grant: ChatGptTokenGrant) => ResponsesClientLike;
	/**
	 * Where a Gemini subscription's bearer comes from, consulted per request by
	 * the `gemini-code-assist` adapter. Same transport-scoped reasoning as
	 * `chatgptCredentials` above; no api-key fallback on this wire either — the
	 * subscription is the only way in, so an unavailable provider surfaces as
	 * the adapter's own "not signed in" error, which names the login.
	 */
	geminiCredentials?: GeminiTokenProvider;
	/**
	 * How long a request may go without a single stream event before it is
	 * declared stalled and torn down. The failure it bounds is the one no
	 * timeout inside the SDK covers: a connection that was accepted and then
	 * went silent.
	 */
	stallTimeoutMs?: number;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The error a model fails with when no key resolves, or undefined when one
 * does. `subscription` tells it a sign-in may be standing in for the key —
 * the check itself is sync and cannot ask; an unavailable subscription then
 * surfaces as the adapter's own "not signed in" error at request time, which
 * names the login instead of the environment variable.
 */
export function missingApiKey(
	model: Model,
	options?: StreamOptions,
	subscription = false,
): MissingApiKeyError | undefined {
	if (options?.apiKey) return undefined;
	// A row naming no variable wants no key: the local daemon. The distinction
	// is drawn off the empty name list, because the error below would otherwise
	// name a variable that does not exist.
	if (apiKeyEnvNames(model).length === 0) return undefined;
	if (subscription) return undefined;
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
		credentials: settings.credentials,
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
	const chatgpt = createChatGptStreamFn({
		policy: settings.policy,
		credentials: settings.chatgptCredentials,
		clientFactory: settings.chatgptClientFactory,
	});
	// No `policy` here either, for the reason the Responses wire has none of its
	// own: this request carries no cache field, so there is nothing a cache
	// setting could tune.
	const codeAssist = createCodeAssistStreamFn({ credentials: settings.geminiCredentials });
	return (model, context, options) => {
		const missingKey = missingApiKey(model, options, model.provider === "anthropic" && settings.credentials != null);
		if (missingKey) throw missingKey;
		if (model.api === "anthropic-messages") return anthropic(model, context, options);
		if (model.api === "openai-completions") return openai(model, context, options);
		if (model.api === "openai-responses") return responses(model, context, options);
		if (model.api === "chatgpt-responses") return chatgpt(model, context, options);
		if (model.api === "gemini-code-assist") return codeAssist(model, context, options);
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

// Talk is cheap. Show me the code!
