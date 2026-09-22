/**
 * Prompt caching, as facts rather than hopes.
 *
 * Two things live here, and they are deliberately separate from the adapters
 * that use them: what each provider actually caches (capability, minimum
 * prefix, granularity, knobs) and how a cached prefix is *measured* once the
 * provider reports it back. Both are pure, so a test can pin them without a
 * network and without a provider.
 *
 * The measurement half exists because the numbers were previously invisible:
 * `prompt_cache_hit_tokens` and the top-level `cached_tokens` some providers
 * put on the usage object were never read, so a session that read 99% of its
 * prompt from cache was recorded as having read none of it. A cache hit rate
 * nobody can see is a cache hit rate nobody can raise.
 */

import type { AgentMessage, Context, Model, Usage } from "./types.ts";

/** Whether the caller marks the prefix, or the provider decides by itself. */
export type CacheMode = "explicit" | "automatic";

/**
 * What one provider does about caching, and what a caller may do about it.
 *
 * `minPrefixTokens` is a floor the provider documents: a prefix shorter than it
 * is not cached at all, so a marker placed there is a write that never becomes
 * a read. `incrementTokens` is the granularity a hit is rounded to — OpenAI
 * matches the first 1024 tokens exactly and then every further 128, so a
 * 1100-token prefix reads back 1024. Both are floors and granularities, not
 * promises: the real numbers come back in `usage`, which is why this module
 * also knows how to read them.
 */
export interface CacheCapability {
	mode: CacheMode;
	minPrefixTokens: number;
	incrementTokens: number;
	/** TTL tiers the provider documents. Empty means "not selectable". */
	ttl: readonly ("5m" | "1h")[];
	/** Whether a request may name a routing key to keep a prefix on one machine. */
	promptCacheKey: boolean;
}

/**
 * Anthropic: the one provider that needs the caller to mark the prefix.
 *
 * Its `minPrefixTokens` here is only the fallback for a model id not in the
 * table below; {@link cacheCapability} resolves the real per-model floor.
 */
const ANTHROPIC: CacheCapability = {
	mode: "explicit",
	minPrefixTokens: 512,
	incrementTokens: 1,
	ttl: ["5m", "1h"],
	promptCacheKey: false,
};

/**
 * The documented behaviour, per provider.
 *
 * Where a provider documents no minimum (DeepSeek cuts cache units at request
 * boundaries rather than at a length), the floor is 0 rather than a number
 * invented to look precise.
 */
const CAPABILITIES: Readonly<Record<string, CacheCapability>> = {
	anthropic: ANTHROPIC,
	// The floor is documented as a range — 1,024 to 2,048 depending on the model —
	// and the low end is recorded, because this number only ever decides whether
	// the report calls a prefix cacheable, and erring low there says "the provider
	// may have chosen not to" rather than "the provider could not".
	openai: { mode: "automatic", minPrefixTokens: 1024, incrementTokens: 128, ttl: [], promptCacheKey: true },
	deepseek: { mode: "automatic", minPrefixTokens: 0, incrementTokens: 1, ttl: [], promptCacheKey: false },
	// Kimi's own guide describes caching as automatic and says the previous prompt
	// must exceed 256 tokens; it documents no routing key. Third-party clients
	// forward `prompt_cache_key` to the Kimi Coding presets and report it as
	// required there, while independent tests on the same endpoint report it as a
	// no-op that changes nothing. The documentation does not settle it, so the row
	// records the documented position — no key — and `promptCacheKey: "on"` is how
	// to send one anyway to an endpoint that turns out to want it.
	kimi: { mode: "automatic", minPrefixTokens: 256, incrementTokens: 1, ttl: [], promptCacheKey: false },
	glm: { mode: "automatic", minPrefixTokens: 500, incrementTokens: 1, ttl: [], promptCacheKey: false },
	google: { mode: "automatic", minPrefixTokens: 1024, incrementTokens: 1, ttl: [], promptCacheKey: false },
};

/** A provider nobody has measured: assume automatic, assume nothing else. */
const UNKNOWN: CacheCapability = {
	mode: "automatic",
	minPrefixTokens: 1024,
	incrementTokens: 1,
	ttl: [],
	promptCacheKey: false,
};

/**
 * The shortest prefix each Anthropic model will cache, as documented.
 *
 * A table rather than a family rule, because the spread is not something a rule
 * can express: 512 tokens on Opus 5, 1024 on Sonnet 5, 4096 on Haiku 4.5. The
 * earlier "the Haiku family needs twice as much" inference got both ends wrong —
 * it refused to mark short prefixes that current models cache happily, and it
 * marked Haiku prefixes half the size of what Haiku accepts, which the provider
 * then silently ignored.
 *
 * Ordered most-specific-first, and tested with a start anchor: the ids are
 * prefixes of one another, so `claude-opus-4-5` has to be matched before
 * `claude-opus-4` or an Opus 4.5 request is held to the wrong floor.
 */
const ANTHROPIC_MIN_PREFIX: ReadonlyArray<readonly [RegExp, number]> = [
	[/^claude-fable-5-1/, 512],
	[/^claude-mythos-5-1/, 512],
	[/^claude-opus-5/, 512],
	[/^claude-fable-5/, 512],
	[/^claude-mythos-5/, 512],
	[/^claude-opus-4-8/, 1024],
	[/^claude-sonnet-5/, 1024],
	[/^claude-sonnet-4-6/, 1024],
	[/^claude-sonnet-4-5/, 1024],
	[/^claude-opus-4-1/, 1024],
	[/^claude-opus-4-7/, 2048],
	[/^claude-opus-4-6/, 4096],
	[/^claude-opus-4-5/, 4096],
	[/^claude-opus-4/, 1024],
	[/^claude-sonnet-4/, 1024],
	[/^claude-haiku-4-5/, 4096],
	[/^claude-3-5-haiku/, 2048],
	[/^claude-haiku-3-5/, 2048],
];

/**
 * What to assume for an Anthropic-shaped model that is not in the table.
 *
 * The lowest floor anyone documents, deliberately. The two ways of being wrong
 * are not symmetric: a floor set too low places a breakpoint the provider
 * silently ignores, which shows up immediately as `cache_creation: 0` in the
 * usage and costs nothing but one of four breakpoint slots, while a floor set
 * too high declines to mark a prefix the provider would have cached — and that
 * is a hit rate of zero with no error anywhere to explain it. Erring low is free
 * and self-diagnosing; erring high is silent and expensive.
 */
const ANTHROPIC_UNKNOWN_MIN = ANTHROPIC.minPrefixTokens;

/** The shortest prefix this model will cache, whatever its provider calls itself. */
export function anthropicMinPrefixTokens(modelId: string): number {
	for (const [pattern, min] of ANTHROPIC_MIN_PREFIX) {
		if (pattern.test(modelId)) return min;
	}
	return ANTHROPIC_UNKNOWN_MIN;
}

/**
 * What a model's provider does about caching.
 *
 * A provider we have no row for is read through `model.api` rather than
 * `model.provider`, so a self-registered gateway that speaks `anthropic-messages`
 * still gets breakpoints instead of being treated as an unknown automatic
 * provider — the wire format is what decides whether a marker is accepted, and
 * ours says it is.
 */
export function cacheCapability(model: Model): CacheCapability {
	const base = CAPABILITIES[model.provider] ?? (model.api === "anthropic-messages" ? ANTHROPIC : UNKNOWN);
	if (base.mode !== "explicit") return base;
	return { ...base, minPrefixTokens: anthropicMinPrefixTokens(model.id) };
}

// ---------------------------------------------------------------------------
// How long an entry should live, and what the user may say about it
// ---------------------------------------------------------------------------

/** How long a written cache entry should live, where the provider lets us choose. */
export type CacheTtl = "5m" | "1h";

/**
 * What this app asks providers to do about their cache.
 *
 * `ttl: "auto"` resolves to the long one, and the cost argument is worth writing
 * down because it looks wrong at first: a one-hour write is billed at twice the
 * input price against 1.25x for five minutes, but only for the tokens actually
 * *written* at that breakpoint — the part of the prefix that was not already
 * cached. In a conversation, that is the handful of tokens added since the last
 * request, so the premium is paid on the delta and the read discount applies to
 * everything behind it. What the shorter TTL buys in exchange is an entry that
 * is gone after a five-minute pause, which turns the next turn into a full-price
 * replay of the whole transcript. For a goal measured in hit rate the long TTL
 * is not a close call.
 */
export interface CachePolicy {
	/**
	 * Place explicit breakpoints on providers that require them.
	 *
	 * Off is a real choice rather than a debugging switch: a caller whose prompts
	 * never repeat — a one-shot script, a batch of unrelated documents — writes an
	 * entry on every request and reads none of them back, and pays the write
	 * premium for the privilege.
	 */
	explicitBreakpoints?: boolean;
	/** Which TTL to ask for; "auto" means the long one, with a fallback if refused. */
	ttl?: "auto" | CacheTtl;
	/**
	 * Send the routing key that steers a prefix to one cache.
	 *
	 * "auto" follows the provider's own documentation, which is the only thing
	 * that can decide it: an OpenAI-compatible endpoint that has never heard of
	 * `prompt_cache_key` may reject the request for it, and the providers whose
	 * guides describe it are a short list. "on" is for an endpoint that turns out
	 * to want one anyway, which is a judgement about someone else's gateway that
	 * only its operator can make.
	 */
	promptCacheKey?: PromptCacheKeyMode;
	/**
	 * How long the provider should keep an entry, where it lets the caller say.
	 *
	 * Unset means the field is not sent, and that is the right default rather than
	 * a cautious one: on OpenAI, an organization without zero-data-retention
	 * already gets the long retention by default, so sending `"24h"` repeats what
	 * it would have done and sending `"in_memory"` would shorten it. Only a caller
	 * who has read their own organization's setting can want either.
	 */
	promptCacheRetention?: PromptCacheRetention;
}

/** Whether a routing key goes out: follow the docs, force one, or never. */
export type PromptCacheKeyMode = "auto" | "on" | "off";

/**
 * The values OpenAI documents for `prompt_cache_retention`.
 *
 * Deprecated on the newest models in favour of a TTL field that only exists on a
 * beta surface this adapter does not speak, and rejected outright by models that
 * support neither — which is why nothing is sent unasked.
 */
export type PromptCacheRetention = "in_memory" | "24h";

/** What an unset `ttl` means, named so the two readers below cannot drift. */
const DEFAULT_TTL: "auto" | CacheTtl = "auto";

/** What an unset key mode means; the capability row is what "auto" reads. */
const DEFAULT_KEY_MODE: PromptCacheKeyMode = "auto";

export const DEFAULT_CACHE_POLICY: CachePolicy = {
	explicitBreakpoints: true,
	ttl: DEFAULT_TTL,
	promptCacheKey: DEFAULT_KEY_MODE,
};

/** The TTL a policy asks for, resolved. */
export function resolveCacheTtl(policy?: CachePolicy): CacheTtl {
	const ttl = policy?.ttl ?? DEFAULT_TTL;
	return ttl === "auto" ? "1h" : ttl;
}

/**
 * Whether this request should carry a routing key.
 *
 * "auto" is the provider's documented answer and nothing else — the point of the
 * capability row is that an unmeasured endpoint gets nothing invented for it. A
 * key sent to a gateway that does not know the field is a 400 on every request,
 * and a key sent to one that ignores it is a field that means nothing: neither is
 * a thing to do on a guess.
 */
export function resolvePromptCacheKey(policy: CachePolicy | undefined, capability: CacheCapability): boolean {
	const mode = policy?.promptCacheKey ?? DEFAULT_KEY_MODE;
	if (mode === "on") return true;
	if (mode === "off") return false;
	return capability.promptCacheKey;
}

/**
 * The retention value to send, or undefined to send none.
 *
 * Gated on the provider rather than on a list of model ids: the field is
 * documented by one vendor, that vendor's models disagree about which values
 * they take, and a request that names a value a model does not support is a 400.
 * So the caller opts in and the provider has to be the one that documents the
 * field — which means a gateway never receives it, however the policy reads.
 */
export function resolvePromptCacheRetention(
	policy: CachePolicy | undefined,
	capability: CacheCapability,
): PromptCacheRetention | undefined {
	if (!capability.promptCacheKey) return undefined;
	return policy?.promptCacheRetention;
}

// ---------------------------------------------------------------------------
// The identity of a stable prefix
// ---------------------------------------------------------------------------

/**
 * A 53-bit-ish hash of a string, as hex.
 *
 * Two FNV-1a passes with different offset bases, concatenated. Not a
 * cryptographic hash and not trying to be: the job is telling two byte strings
 * apart within one session, where a 32-bit hash would already be adequate and
 * this makes the collision argument boring.
 */
export function hash64(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a = Math.imul(a ^ code, 16777619) >>> 0;
		b = Math.imul(b ^ code, 2166136261) >>> 0;
	}
	return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * Everything that is fixed for the whole life of a prefix, as one string.
 *
 * The wire format, the model, the tools and the system prompt: the four things
 * that are decided once and never change again within a session, and the four a
 * provider keys its cache on. Messages are deliberately absent — they are what
 * grows, and a key that moved with them would name a different cache on every
 * turn, which is the opposite of routing.
 *
 * Shared by the cache key below and by the tracker's notion of a family, so that
 * the prefix a report calls one conversation and the prefix a provider is asked
 * to route are the same prefix by construction.
 */
export function prefixIdentity(model: Pick<Model, "api" | "id">, context: Context): string {
	const tools = context.tools?.length ? JSON.stringify(context.tools) : "";
	return `${model.api}\x00${model.id}\x00${context.systemPrompt}\x00${tools}`;
}

/**
 * The value to send as `prompt_cache_key`, or undefined to send none.
 *
 * The readably-prefixed hash of {@link prefixIdentity}: readable because the key
 * turns up in a provider's own logs and a support conversation goes better when
 * it says whose it is, and a hash because the identity is a whole system prompt
 * and tool schema, which is not something to paste into a header-sized field.
 *
 * Same prefix, same key — across turns, across processes and across a resumed
 * session, which is the case the docs describe: requests that share a long prefix
 * should be routed to the machine that already has it.
 */
export function promptCacheKeyFor(model: Pick<Model, "api" | "id">, context: Context): string {
	return `labunbun-${hash64(prefixIdentity(model, context))}`;
}

/**
 * Something a provider did to the cache settings, worth telling the user.
 *
 * The reason this exists at all: a cache setting that was refused leaves no
 * trace in `usage`, so without a notice the user sees a lower hit rate and no
 * cause — and every later request quietly runs on the fallback.
 */
export interface CacheNotice {
	kind: "ttl-downgrade";
	/** The TTL that was asked for; undefined when the request left it to the API. */
	from: CacheTtl | undefined;
	/** The TTL now in force, for this and every later request. */
	to: CacheTtl | undefined;
	/** The provider's own words, so the fallback is not taken on faith. */
	reason: string;
}

/**
 * The share of a request's prompt that was served from cache, or `undefined`
 * when the request did not say.
 *
 * `undefined` rather than 0: a provider that does not report the field, and a
 * request that genuinely read nothing, are different answers, and printing 0%
 * for both is how a working cache looks broken.
 */
export function cacheHitRate(usage: Usage): number | undefined {
	const total = usage.promptTotal;
	if (total === undefined || total <= 0) return undefined;
	return usage.cacheRead / total;
}

/**
 * Read the cached-token count out of whichever field a provider used.
 *
 * Three spellings are in the wild for the same number: OpenAI and its clones
 * nest it under `prompt_tokens_details.cached_tokens`, Moonshot puts it at the
 * top level of `usage`, and DeepSeek reports `prompt_cache_hit_tokens`
 * alongside the nested copy. Reading only the first is how a Kimi session that
 * hit its cache ~99% of the time was recorded as hitting none of it.
 *
 * Where more than one of them is present and they disagree, the largest wins.
 * They name the same quantity, so the smaller one is the one under-reporting —
 * and under-reporting is the failure being fixed here. A first-wins read would
 * reintroduce it the moment a gateway emitted a stale `cached_tokens: 0` beside
 * a correct `prompt_cache_hit_tokens`.
 */
export function cachedTokensFrom(usage: {
	prompt_tokens_details?: { cached_tokens?: number } | null;
	cached_tokens?: number;
	prompt_cache_hit_tokens?: number;
}): number | undefined {
	const spellings = [usage.prompt_tokens_details?.cached_tokens, usage.cached_tokens, usage.prompt_cache_hit_tokens];
	const known = spellings.filter((value): value is number => typeof value === "number");
	return known.length > 0 ? Math.max(...known) : undefined;
}

// ---------------------------------------------------------------------------
// Estimating a prefix
// ---------------------------------------------------------------------------

/** Plain prose runs about 4 chars/token; JSON schema is denser than prose. */
const CHARS_PER_TOKEN = 4;
const CHARS_PER_TOKEN_JSON = 3;

/**
 * Characters in one message, as the wire will carry it.
 *
 * Only the text is counted. Images would need their own rule, and guessing one
 * would produce a number that looks measured; the price of leaving them out is
 * an underestimate, and everything this estimate decides (whether a prefix has
 * cleared a minimum) is a floor comparison.
 */
function messageChars(message: AgentMessage): number {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content.length
			: message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
	}
	if (message.role === "assistant") {
		return message.content.reduce((sum, block) => {
			if (block.type === "text") return sum + block.text.length;
			if (block.type === "thinking") return sum + block.thinking.length;
			return sum + block.arguments.length;
		}, 0);
	}
	return message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

/**
 * Input tokens in the whole request, estimated.
 *
 * The same shape the compaction threshold uses (`agent/src/compaction.ts`),
 * for the same reason: the last assistant message carries the provider's own
 * count of the prompt that produced it, so the unknown part is only what has
 * been appended since — and that is mostly plain text, which divides by four
 * well enough to answer "is this over a thousand tokens".
 *
 * It is an estimate and the comment says so. Nothing here is billed on it.
 */
export function estimatePrefixTokens(context: Context): number {
	return prefixTierTokens(context).messages;
}

/**
 * The prefix length at each tier a provider caches separately, in tokens.
 *
 * Anthropic rejects the whole request if the `tools` tier changes, only the
 * system tier and below if `system` does, and so on — so its breakpoints sit on
 * tier *boundaries*, and each boundary has its own length against its own
 * minimum. One number for the whole prompt cannot answer "is this position
 * worth marking": a 900-token system prompt under a 60k transcript clears no
 * minimum on its own, while the same system prompt at the end of the transcript
 * does.
 *
 * Cumulative at each boundary, since a prefix is what a breakpoint caches: a
 * breakpoint on the system prompt caches the tools as well.
 */
export interface PrefixTiers {
	/** Up to and including the last tool definition. */
	tools: number;
	/** Up to and including the system prompt; the tools are inside this. */
	system: number;
	/** Up to and including the last message: the whole request. */
	messages: number;
}

export function prefixTierTokens(context: Context): PrefixTiers {
	const schemaChars = context.tools?.length ? JSON.stringify(context.tools).length : 0;
	const tools = Math.ceil(schemaChars / CHARS_PER_TOKEN_JSON);
	const system = tools + Math.ceil(context.systemPrompt.length / CHARS_PER_TOKEN);
	return { tools, system, messages: system + estimateMessageTokens(context.messages) };
}

function estimateMessageTokens(messages: readonly AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const promptTotal = message.usage.promptTotal;
		if (promptTotal === undefined && message.usage.input === 0) continue;
		const anchor = promptTotal ?? message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		let extraChars = 0;
		for (let j = i + 1; j < messages.length; j++) {
			const later = messages[j];
			if (later) extraChars += messageChars(later);
		}
		return anchor + message.usage.output + Math.ceil(extraChars / CHARS_PER_TOKEN);
	}
	return Math.ceil(messages.reduce((sum, message) => sum + messageChars(message), 0) / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// How good a session's caching could be
// ---------------------------------------------------------------------------

/**
 * The best hit rate a sequence of requests could possibly have achieved.
 *
 * A request can only read what an earlier request wrote, and a prompt only
 * grows: request `t` can read at most the prompt of request `t-1`. So the
 * ceiling is `sum(P[t-1]) / sum(P[t])` — a number that falls as a conversation
 * grows, because the newest prompt is always the biggest one. It is what turns
 * "we are at 96%" from a verdict into a diagnosis: at the ceiling the machinery
 * is perfect and the workload is the limit; below it, tokens were thrown away.
 *
 * Measured from the provider's own prompt counts, in order. Requests that did
 * not report one are skipped rather than estimated, since a fabricated ceiling
 * would be used to excuse a real gap.
 */
export function cacheCeiling(promptTotals: readonly number[]): number | undefined {
	const known = promptTotals.filter((total) => total > 0);
	if (known.length < 2) return undefined;
	let achieved = 0;
	let total = 0;
	for (let i = 0; i < known.length; i++) {
		const current = known[i] ?? 0;
		total += current;
		// The first request has nothing before it to read.
		if (i > 0) achieved += known[i - 1] ?? 0;
	}
	return total > 0 ? achieved / total : undefined;
}

/**
 * The prompt counts of a session's requests, in order.
 *
 * One per assistant message that reported one: the assistant message is what
 * the provider answered a request with, so its usage is that request's usage.
 */
export function promptTotalsOf(messages: readonly AgentMessage[]): number[] {
	const totals: number[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (message.usage.promptTotal !== undefined) totals.push(message.usage.promptTotal);
	}
	return totals;
}

/** Summed token channels, for a session's worth of requests. */
export interface CacheTotals {
	read: number;
	write: number;
	input: number;
	output: number;
	requests: number;
}

export function cacheTotals(messages: readonly AgentMessage[]): CacheTotals {
	const totals: CacheTotals = { read: 0, write: 0, input: 0, output: 0, requests: 0 };
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		totals.read += message.usage.cacheRead;
		totals.write += message.usage.cacheWrite;
		totals.input += message.usage.input;
		totals.output += message.usage.output;
		totals.requests++;
	}
	return totals;
}

/** `read / (read + write + input)` over the totals, or undefined when empty. */
export function totalsHitRate(totals: CacheTotals): number | undefined {
	const total = totals.read + totals.write + totals.input;
	if (total <= 0) return undefined;
	return totals.read / total;
}
