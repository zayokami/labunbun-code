// Long-form design notes: docs/dev/ai-layer.md
/** Prompt caching as facts rather than hopes: capability, policy, and measurement. */

import type { AgentMessage, Context, Model, Usage } from "./types.ts";

/** Whether the caller marks the prefix, or the provider decides by itself. */
export type CacheMode = "explicit" | "automatic";

// Long-form design notes: docs/dev/ai-layer.md
/** What one provider does about caching, and what a caller may do about it. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** The shortest prefix each Anthropic model will cache, as documented. */
export const ANTHROPIC_MIN_PREFIX: ReadonlyArray<readonly [RegExp, number]> = [
	// Ahead of the Sonnet 5 row below, and the reason the ordering note exists in
	// its sharpest form: a *newer* model in a family whose floor went **down**.
	// Sonnet 5.5 caches from 512 where Sonnet 5 needs 1024, so the row that
	// matches both is the one that would be wrong, and inheriting it is the
	// expensive direction — see the note on `ANTHROPIC_UNKNOWN_MIN`.
	[/^claude-sonnet-5-5/, 512],
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
	// The Sonnet 5.5 reversal one generation over, and not an ordering fix as
	// that one was: the two Haiku patterns overlap in nothing. 512 is also the
	// fallback for unknown ids, so this row moves no lookup on its own today —
	// the pattern-reading test is what holds it in place.
	[/^claude-haiku-5-5/, 512],
	[/^claude-haiku-4-5/, 4096],
	[/^claude-3-5-haiku/, 2048],
	[/^claude-haiku-3-5/, 2048],
];

// Long-form design notes: docs/dev/ai-layer.md
/** What to assume for an Anthropic-shaped model that is not in the table. */
const ANTHROPIC_UNKNOWN_MIN = ANTHROPIC.minPrefixTokens;

/** The shortest prefix this model will cache, whatever its provider calls itself. */
export function anthropicMinPrefixTokens(modelId: string): number {
	for (const [pattern, min] of ANTHROPIC_MIN_PREFIX) {
		if (pattern.test(modelId)) return min;
	}
	return ANTHROPIC_UNKNOWN_MIN;
}

// Long-form design notes: docs/dev/ai-layer.md
/** What a model's provider does about caching. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** What this app asks providers to do about their cache. */
export interface CachePolicy {
	// Long-form design notes: docs/dev/ai-layer.md
	/** Place explicit breakpoints on providers that require them. */
	explicitBreakpoints?: boolean;
	/** Which TTL to ask for; "auto" means the long one, with a fallback if refused. */
	ttl?: "auto" | CacheTtl;
	// Long-form design notes: docs/dev/ai-layer.md
	/** Send the routing key that steers a prefix to one cache. */
	promptCacheKey?: PromptCacheKeyMode;
	// Long-form design notes: docs/dev/ai-layer.md
	/** How long the provider should keep an entry, where it lets the caller say. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** Whether this request should carry a routing key. */
export function resolvePromptCacheKey(policy: CachePolicy | undefined, capability: CacheCapability): boolean {
	const mode = policy?.promptCacheKey ?? DEFAULT_KEY_MODE;
	if (mode === "on") return true;
	if (mode === "off") return false;
	return capability.promptCacheKey;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The retention value to send, or undefined to send none. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** A hash of a string, as hex: two FNV-1a passes with different offset bases. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** Everything that is fixed for the whole life of a prefix, as one string. */
export function prefixIdentity(model: Pick<Model, "api" | "id">, context: Context): string {
	const tools = context.tools?.length ? JSON.stringify(context.tools) : "";
	return `${model.api}\x00${model.id}\x00${context.systemPrompt}\x00${tools}`;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The value to send as `prompt_cache_key`, or undefined to send none. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** The share of a request's prompt that was served from cache, or `undefined`. */
export function cacheHitRate(usage: Usage): number | undefined {
	const total = usage.promptTotal;
	if (total === undefined || total <= 0) return undefined;
	return usage.cacheRead / total;
}

// Long-form design notes: docs/dev/ai-layer.md
/** Read the cached-token count out of whichever field a provider used. */
export function cachedTokensFrom(usage: {
	prompt_tokens_details?: { cached_tokens?: number } | null;
	input_tokens_details?: { cached_tokens?: number } | null;
	cached_tokens?: number;
	prompt_cache_hit_tokens?: number;
}): number | undefined {
	const spellings = [
		usage.prompt_tokens_details?.cached_tokens,
		usage.input_tokens_details?.cached_tokens,
		usage.cached_tokens,
		usage.prompt_cache_hit_tokens,
	];
	const known = spellings.filter((value): value is number => typeof value === "number");
	return known.length > 0 ? Math.max(...known) : undefined;
}

// ---------------------------------------------------------------------------
// Estimating a prefix
// ---------------------------------------------------------------------------

/** Plain prose runs about 4 chars/token; JSON schema is denser than prose. */
const CHARS_PER_TOKEN = 4;
const CHARS_PER_TOKEN_JSON = 3;

// Long-form design notes: docs/dev/ai-layer.md
/** Characters in one message, as the wire will carry it. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** Input tokens in the whole request, estimated. */
export function estimatePrefixTokens(context: Context): number {
	return prefixTierTokens(context).messages;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The prefix length at each tier a provider caches separately, in tokens. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** The best hit rate a sequence of requests could possibly have achieved. */
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
