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
 */
function anthropicPricing(input: number, output: number): ModelPricing {
	return {
		input,
		output,
		cacheRead: roundPrice(input * 0.1),
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
 * Anthropic's are exact: taken from the model pricing table in the Claude
 * platform docs on 2026-09-20, with the cache rates derived by the documented
 * multipliers (Sonnet 5 is $2/$10 — the increase to $3/$15 that was scheduled
 * for 2026-09-01 was cancelled).
 *
 * The OpenAI-compatible ones are list rates on the same date and are worth less:
 * they are quoted in CNY by the first-party APIs, differ per host, and DeepSeek
 * has billed peak and off-peak rates since 2026-08-16 — the figures below are the
 * peak ones, so an off-peak session was charged half of what this table says.
 * None of these APIs charges separately for a cache write (populating the cache
 * is ordinary input, and DeepSeek's is free), so that channel is 0 rather than
 * the input rate. When a price matters — a proxy, a negotiated rate, a newer
 * model — declare it in `pricing` in settings.json, which overrides this table.
 */
const BUILT_IN_MODELS: Model[] = [
	// Anthropic
	anthropicModel("claude-fable-5", "Claude Fable 5", {
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		pricing: anthropicPricing(10, 50),
	}),
	anthropicModel("claude-opus-5", "Claude Opus 5", {
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		pricing: anthropicPricing(5, 25),
	}),
	anthropicModel("claude-sonnet-5", "Claude Sonnet 5", {
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		pricing: anthropicPricing(2, 10),
	}),
	anthropicModel("claude-haiku-4-5", "Claude Haiku 4.5", {
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		pricing: anthropicPricing(1, 5),
	}),
	// DeepSeek — peak rates; off-peak (16 of 24 hours) is half of these.
	openAICompatModel("deepseek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat", {
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		pricing: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
	}),
	openAICompatModel(
		"deepseek",
		"https://api.deepseek.com/v1",
		"DEEPSEEK_API_KEY",
		"deepseek-reasoner",
		"DeepSeek Reasoner",
		{
			contextWindow: 128_000,
			maxOutputTokens: 8_192,
			reasoning: true,
			pricing: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
		},
	),
	// Kimi (Moonshot) — first-party list is ¥4/¥16 with cache hits at ¥1, which is
	// the same quarter-of-input ratio these USD figures come from.
	openAICompatModel("kimi", "https://api.moonshot.cn/v1", "KIMI_API_KEY", "kimi-k2-0905-preview", "Kimi K2", {
		contextWindow: 256_000,
		maxOutputTokens: 8_192,
		pricing: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
	}),
	// GLM (Z.AI)
	openAICompatModel("glm", "https://api.z.ai/api/paas/v4", "GLM_API_KEY", "glm-4.6", "GLM-4.6", {
		contextWindow: 200_000,
		maxOutputTokens: 8_192,
		pricing: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	}),
];

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
 * All known models: built-ins first, then custom, each carrying the price it is
 * actually billed at.
 */
export function listModels(): Model[] {
	const models = [...BUILT_IN_MODELS, ...customModels.values()];
	if (pricingOverrides.size === 0) return models;
	return models.map(withPricingOverride);
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
 */
export function resolveModel(reference: string): Model | undefined {
	const slash = reference.indexOf("/");
	if (slash > 0) {
		const provider = reference.slice(0, slash);
		const id = reference.slice(slash + 1);
		const match = listModels().find((m) => m.provider === provider && m.id === id);
		return match ? applyBaseUrlOverrides(match) : undefined;
	}
	const matches = listModels().filter((m) => m.id === reference);
	return matches.length > 0 ? applyBaseUrlOverrides(matches[0]) : undefined;
}
