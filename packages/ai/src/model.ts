/**
 * Model registry — a small hand-written catalog of well-known models plus
 * user-defined OpenAI-compatible providers from settings. No generated
 * mega-catalog; users extend via `registerOpenAICompatibleProvider`.
 */
import type { ApiId, Model, ModelPricing } from "./types.ts";

const ANTHROPIC_BASE = "https://api.anthropic.com";

/** 10 * 1.25 is 1.25, but 0.1 * 3 leaves floating-point dust in a price table. */
function roundPrice(usd: number): number {
	return Number(usd.toFixed(4));
}

/**
 * Anthropic bills cache traffic as a multiplier of the input rate rather than
 * as rows of its own: a cache read costs 0.1x input, and a 5-minute cache write
 * 1.25x. Derived here so a rate change moves all three numbers together instead
 * of leaving two of them behind.
 *
 * The read multiplier is a parameter because Fable 5.1 and Mythos 5.1 are
 * priced at 0.025x instead — the one family the 0.1x rule does not cover.
 */
function anthropicPricing(input: number, output: number, cacheReadMultiplier = 0.1): ModelPricing {
	return {
		input,
		output,
		cacheRead: roundPrice(input * cacheReadMultiplier),
		cacheWrite: roundPrice(input * 1.25),
	};
}

function anthropicModel(
	id: string,
	name: string,
	opts: {
		contextWindow: number;
		maxOutputTokens: number;
		reasoning?: boolean;
		images?: boolean;
		pricing: ModelPricing;
	},
): Model {
	return {
		id,
		name,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: ANTHROPIC_BASE,
		apiKeyEnv: "ANTHROPIC_API_KEY",
		// Proxies and gateways in front of the Anthropic API commonly issue the
		// credential as ANTHROPIC_AUTH_TOKEN instead.
		apiKeyEnvFallbacks: ["ANTHROPIC_AUTH_TOKEN"],
		contextWindow: opts.contextWindow,
		maxOutputTokens: opts.maxOutputTokens,
		reasoning: opts.reasoning ?? true,
		input: opts.images === false ? ["text"] : ["text", "image"],
		pricing: opts.pricing,
	};
}

function openAICompatModel(
	provider: string,
	baseUrl: string,
	apiKeyEnv: string,
	id: string,
	name: string,
	opts: { contextWindow: number; maxOutputTokens: number; reasoning?: boolean; pricing: ModelPricing },
): Model {
	return {
		id,
		name,
		api: "openai-completions",
		provider,
		baseUrl,
		apiKeyEnv,
		contextWindow: opts.contextWindow,
		maxOutputTokens: opts.maxOutputTokens,
		reasoning: opts.reasoning ?? false,
		input: ["text"],
		pricing: opts.pricing,
	};
}

/**
 * Where the money numbers come from.
 *
 * Every row was checked against the vendor's own page on 2026-09-20. Anthropic's
 * and DeepSeek's are the vendors' USD figures; the cache channel is derived by
 * the documented multipliers rather than copied, because a hand-copied third
 * number is where a table like this goes stale first (Sonnet 5 is $2/$10 — the
 * increase to $3/$15 that was scheduled for 2026-09-01 was cancelled).
 *
 * The OpenAI-compatible rows are worth less than the Anthropic ones: they differ
 * per host, and DeepSeek has billed peak and off-peak rates since 2026-08-16 —
 * the figures below are the peak ones, so a session outside 01:00-04:00 and
 * 06:00-10:00 UTC on a weekday was charged half of what this table says. None of
 * these vendors charges separately for a cache write (populating the cache is
 * ordinary input, and DeepSeek's is free), so that channel is 0 rather than the
 * input rate. When a price matters — a proxy, a negotiated rate, a newer model —
 * declare it in `pricing` in settings.json, which overrides this table.
 */
const BUILT_IN_MODELS: Model[] = [
	// Anthropic. Every model from the 4.6 generation on carries the full 1M-token
	// window at standard pricing, so there is no long-context premium to model.
	anthropicModel("claude-fable-5-1", "Claude Fable 5.1", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		// The one family whose cache reads are not a tenth of input.
		pricing: anthropicPricing(10, 50, 0.025),
	}),
	// Fable 5 is legacy — still served, and still what a settings file may name.
	anthropicModel("claude-fable-5", "Claude Fable 5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		pricing: anthropicPricing(10, 50),
	}),
	anthropicModel("claude-opus-5", "Claude Opus 5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		pricing: anthropicPricing(5, 25),
	}),
	anthropicModel("claude-sonnet-5", "Claude Sonnet 5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		pricing: anthropicPricing(2, 10),
	}),
	anthropicModel("claude-haiku-4-5", "Claude Haiku 4.5", {
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		pricing: anthropicPricing(1, 5),
	}),
	// DeepSeek — peak rates; the rest of the week is half of these. Each id answers
	// in thinking or non-thinking mode (thinking by default), so the chat/reasoner
	// pair these replaced is one entry per model now, not two.
	openAICompatModel("deepseek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", "deepseek-flash", "DeepSeek Flash", {
		contextWindow: 1_000_000,
		maxOutputTokens: 384_000,
		reasoning: true,
		pricing: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	}),
	openAICompatModel(
		"deepseek",
		"https://api.deepseek.com/v1",
		"DEEPSEEK_API_KEY",
		"deepseek-v4-pro",
		"DeepSeek V4 Pro",
		{
			contextWindow: 1_000_000,
			maxOutputTokens: 384_000,
			reasoning: true,
			pricing: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
		},
	),
	// Kimi (Moonshot). The K2 series bills a cache hit at a discount and a cache
	// write as nothing; only the K3 table has a write column of its own. No Kimi
	// page publishes a maximum output, so the value here is the conservative one
	// it has always been.
	openAICompatModel("kimi", "https://api.moonshot.cn/v1", "KIMI_API_KEY", "kimi-k2.6", "Kimi K2.6", {
		contextWindow: 262_144,
		maxOutputTokens: 8_192,
		pricing: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	}),
	// GLM (Z.AI)
	openAICompatModel("glm", "https://api.z.ai/api/paas/v4", "GLM_API_KEY", "glm-4.6", "GLM-4.6", {
		contextWindow: 200_000,
		maxOutputTokens: 128_000,
		pricing: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	}),
];

/**
 * Built-in ids that were retired, and the id that answers to them now.
 *
 * A model id written into a settings file outlives the model. When a vendor
 * retires one, the choice is between mapping it here and letting the reference
 * stop resolving — which turns a working configuration into "no such model"
 * while the model the user picked is still served, under a new name. The map is
 * one-way and one-directional on purpose: nothing writes these ids back out, and
 * nothing lists them, because there is nothing left to choose.
 */
const RETIRED_MODEL_IDS = new Map<string, string>([
	// DeepSeek retired the chat/reasoner pair on 2026-07-24; both modes live on
	// under the flash id.
	["deepseek-chat", "deepseek-flash"],
	["deepseek-reasoner", "deepseek-flash"],
	// Discontinued 2026-05-25, superseded by the K2.6 release.
	["kimi-k2-0905-preview", "kimi-k2.6"],
]);

const customModels = new Map<string, Model>();

/**
 * Prices declared in settings, by reference. The built-in table is a dated
 * snapshot of public list prices, and nobody's bill is the list price — a
 * gateway, a negotiated rate or a repriced model all make it wrong. A bare model
 * id applies to every provider serving it, the same way `resolveModel` reads a
 * bare id.
 */
const pricingOverrides = new Map<string, ModelPricing>();

export function setPricingOverride(reference: string, pricing: ModelPricing): void {
	pricingOverrides.set(reference, pricing);
}

export function clearPricingOverrides(): void {
	pricingOverrides.clear();
}

function withPricingOverride(model: Model): Model {
	const override = pricingOverrides.get(`${model.provider}/${model.id}`) ?? pricingOverrides.get(model.id);
	return override ? { ...model, pricing: override } : model;
}

export interface OpenAICompatibleProviderSpec {
	/** Provider key used in "provider/model" references. */
	id: string;
	baseUrl: string;
	/** Environment variable holding the API key. */
	apiKeyEnv: string;
	models: Array<{
		id: string;
		name?: string;
		contextWindow: number;
		maxOutputTokens: number;
		reasoning?: boolean;
		/** USD per million tokens; omitted means tokens are counted but not costed. */
		pricing?: ModelPricing;
	}>;
}

/** Register user-defined OpenAI-compatible providers (from settings). */
export function registerOpenAICompatibleProvider(spec: OpenAICompatibleProviderSpec): void {
	for (const m of spec.models) {
		customModels.set(`${spec.id}/${m.id}`, {
			id: m.id,
			name: m.name ?? m.id,
			api: "openai-completions" satisfies ApiId,
			provider: spec.id,
			baseUrl: spec.baseUrl,
			apiKeyEnv: spec.apiKeyEnv,
			contextWindow: m.contextWindow,
			maxOutputTokens: m.maxOutputTokens,
			reasoning: m.reasoning ?? false,
			input: ["text"],
			pricing: m.pricing,
		});
	}
}

export function clearCustomModels(): void {
	customModels.clear();
}

/**
 * A model a provider listed about itself. Only `id` is guaranteed: Anthropic's
 * models endpoint also reports a display name, a context window and an output
 * cap, while the OpenAI-compatible one reports ids and nothing else.
 */
export interface DiscoveredModel {
	id: string;
	displayName?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
}

/**
 * What the providers said they serve, filled in once at startup by
 * `refreshModelCatalog`. Empty until then, and empty forever on a machine that
 * is offline or has no key — in which case the table above is the whole truth,
 * exactly as it was before any of this existed.
 *
 * `providerCatalogue` holds only listings that came back complete and non-empty.
 * The empty set means something here — it is what hides a model — so a provider
 * we could not reach must not be recorded as a provider that serves nothing.
 */
const providerCatalogue = new Map<string, Set<string>>();

/** Limits a provider stated for an id, keyed "provider/id". Beats the table. */
const liveLimits = new Map<string, { contextWindow: number; maxOutputTokens: number }>();

/** Models discovery added because a vendor serves one the table has never heard of. */
const discoveredModels = new Map<string, Model>();

/**
 * Build a model from what the provider said, borrowing the transport fields —
 * api, base URL, key variable — from a model of the same provider we already
 * know.
 *
 * Only reachable when the provider stated both limits, which is the whole rule:
 * a window we would have to guess is a compaction threshold we would be guessing
 * at, and a wrong threshold is worse than a missing row. In practice that means
 * Anthropic's unknowns are added and the OpenAI-compatible ones are not, but the
 * rule is about the data, not about which vendors are trusted.
 *
 * No price, deliberately. The table is keyed by id and this id is not in it, so
 * the honest answer is "not priced" — which the cost report already knows how to
 * print — rather than $0, which reads as free.
 */
function synthesizeModel(provider: string, discovered: DiscoveredModel): Model | undefined {
	const { contextWindow, maxOutputTokens } = discovered;
	if (contextWindow === undefined || maxOutputTokens === undefined) return undefined;
	const template = [...BUILT_IN_MODELS, ...customModels.values()].find((model) => model.provider === provider);
	if (!template) return undefined;
	return {
		...template,
		id: discovered.id,
		name: discovered.displayName ?? discovered.id,
		contextWindow,
		maxOutputTokens,
		pricing: undefined,
	};
}

/**
 * Record what one provider reported it serves.
 *
 * `complete` says whether the listing is the provider's whole catalog. A listing
 * cut short by the page cap still carries usable limits — each row describes
 * itself — but it may be missing ids, so it must not hide anything.
 *
 * Returns the ids the visible catalog gained and lost, so the caller can say so.
 */
export function setProviderCatalogue(
	provider: string,
	models: DiscoveredModel[],
	options?: { complete?: boolean },
): { added: string[]; dropped: string[] } {
	const prefix = `${provider}/`;
	const known = new Set(
		[...BUILT_IN_MODELS, ...customModels.values()]
			.filter((model) => model.provider === provider)
			.map((model) => model.id),
	);
	const before = new Set(
		[...discoveredModels.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
	);

	// Replace rather than merge: this is what the provider serves now.
	for (const key of [...liveLimits.keys()]) {
		if (key.startsWith(prefix)) liveLimits.delete(key);
	}
	for (const key of [...discoveredModels.keys()]) {
		if (key.startsWith(prefix)) discoveredModels.delete(key);
	}

	const ids = new Set<string>();
	const added: string[] = [];
	for (const model of models) {
		ids.add(model.id);
		if (model.contextWindow !== undefined && model.maxOutputTokens !== undefined) {
			liveLimits.set(prefix + model.id, {
				contextWindow: model.contextWindow,
				maxOutputTokens: model.maxOutputTokens,
			});
		}
		if (known.has(model.id) || before.has(model.id)) continue;
		const synthesized = synthesizeModel(provider, model);
		if (!synthesized) continue;
		discoveredModels.set(prefix + model.id, synthesized);
		added.push(model.id);
	}

	// Only a complete, non-empty listing may hide anything.
	const hiding = options?.complete === true && ids.size > 0;
	if (hiding) providerCatalogue.set(provider, ids);
	else providerCatalogue.delete(provider);
	const dropped = hiding ? [...known, ...before].filter((id) => !ids.has(id)) : [];
	return { added, dropped };
}

/** Undo discovery, for tests that need to start from the table alone. */
export function clearDiscovery(): void {
	providerCatalogue.clear();
	liveLimits.clear();
	discoveredModels.clear();
}

function withLiveLimits(model: Model): Model {
	const limits = liveLimits.get(`${model.provider}/${model.id}`);
	return limits ? { ...model, ...limits } : model;
}

/**
 * Everything this process knows about, including models a provider has since
 * stopped listing.
 *
 * Resolution reads this, not `listModels`. A model a vendor retired this morning
 * is still the model yesterday's session recorded, and that transcript has to
 * resolve and cost with the row it was written against. Discovery narrows what
 * can be *chosen*; it never narrows what can be *named*.
 */
export function allModels(): Model[] {
	const models = [...BUILT_IN_MODELS, ...customModels.values(), ...discoveredModels.values()];
	if (liveLimits.size === 0 && pricingOverrides.size === 0) return models;
	return models.map(withLiveLimits).map(withPricingOverride);
}

/**
 * The models a user may choose: everything known, minus what a provider's own
 * listing has disowned. An enumeration — the `/model` picker — rather than a
 * lookup; `allModels` is what resolution is built on.
 */
export function listModels(): Model[] {
	const models = allModels();
	if (providerCatalogue.size === 0) return models;
	return models.filter((model) => providerCatalogue.get(model.provider)?.has(model.id) ?? true);
}

/**
 * Environment variable that overrides a provider's base URL, e.g.
 * `ANTHROPIC_BASE_URL` for the anthropic provider.
 */
export function baseUrlEnvVar(provider: string): string {
	return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`;
}

/**
 * Point a model at a proxy or gateway via `<PROVIDER>_BASE_URL`.
 *
 * Applied on the `resolveModel` path so every consumer sees the redirected
 * URL: both provider adapters already build their client from `model.baseUrl`,
 * so nothing downstream needs to know an override happened.
 */
export function applyBaseUrlOverrides(model: Model): Model {
	const override = process.env[baseUrlEnvVar(model.provider)]?.trim();
	if (!override) return model;
	return { ...model, baseUrl: override };
}

/**
 * The API key for a model: `apiKeyEnv` first, then `apiKeyEnvFallbacks` in
 * order. Returns undefined when none of them is set, so callers can tell
 * "missing" apart from "empty".
 */
export function resolveApiKey(model: Model): string | undefined {
	for (const name of [model.apiKeyEnv, ...(model.apiKeyEnvFallbacks ?? [])]) {
		const value = process.env[name];
		if (value) return value;
	}
	return undefined;
}

/** Env var names a model will accept its key from, in precedence order. */
export function apiKeyEnvNames(model: Model): string[] {
	return [model.apiKeyEnv, ...(model.apiKeyEnvFallbacks ?? [])];
}

/**
 * Resolve a model reference:
 * - "provider/model" → exact match on provider + id
 * - "model-id" → unique id match across providers
 *
 * A reference that matches nothing is tried once more against the ids that have
 * been retired, so a settings file written before a model was renamed keeps
 * resolving to the model that answers to it today.
 */
export function resolveModel(reference: string): Model | undefined {
	return lookupModel(reference) ?? lookupReplacement(reference);
}

function lookupModel(reference: string): Model | undefined {
	const slash = reference.indexOf("/");
	if (slash > 0) {
		const provider = reference.slice(0, slash);
		const id = reference.slice(slash + 1);
		const match = allModels().find((m) => m.provider === provider && m.id === id);
		return match ? applyBaseUrlOverrides(match) : undefined;
	}
	const matches = allModels().filter((m) => m.id === reference);
	return matches.length > 0 ? applyBaseUrlOverrides(matches[0]) : undefined;
}

/**
 * The model a retired id means now. A provider-qualified reference only counts
 * when it names the provider that serves the replacement: `deepseek/deepseek-chat`
 * is the id this table retired, while `gateway/deepseek-chat` is a model somebody
 * else may still be serving, and answering it with ours would be a guess.
 */
function lookupReplacement(reference: string): Model | undefined {
	const slash = reference.indexOf("/");
	const replacement = RETIRED_MODEL_IDS.get(slash > 0 ? reference.slice(slash + 1) : reference);
	if (!replacement) return undefined;
	const model = lookupModel(replacement);
	if (model && slash > 0 && model.provider !== reference.slice(0, slash)) return undefined;
	return model;
}
