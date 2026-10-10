/**
 * Model registry — a small hand-written catalog of well-known models plus
 * user-defined OpenAI-compatible providers from settings. No generated
 * mega-catalog; users extend via `registerOpenAICompatibleProvider`.
 */
import type { ApiId, Model, ModelPricing } from "./types.ts";

const ANTHROPIC_BASE = "https://api.anthropic.com";
/** Kimi's international host; the China host serves the same ids under its own keys. */
const KIMI_BASE = "https://api.moonshot.ai/v1";
/** Google's OpenAI-compatibility shim, which its docs still call beta. */
const GOOGLE_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
/** OpenAI's own host — the API this client's compat adapter was written against. */
const OPENAI_BASE = "https://api.openai.com/v1";
/** Z.AI's international host. */
const GLM_BASE = "https://api.z.ai/api/paas/v4";
/** DeepSeek's OpenAI-compatible host. */
const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
/** MiniMax's international host; `/chat/completions` on it is OpenAI's wire. */
const MINIMAX_BASE = "https://api.minimax.io/v1";
/** Mistral's own host; `/chat/completions` on it is OpenAI's wire. */
const MISTRAL_BASE = "https://api.mistral.ai/v1";
// The gateway's two plans, on two wires each. The two spellings of one plan differ
// only by a path prefix, and the difference is the SDK's, not a convenience: the
// Anthropic client appends `/v1/messages` to whatever base it is given, so it
// needs the prefix *stripped*, while the OpenAI client appends
// `/chat/completions` and needs it *kept*. The unversioned pair is therefore not
// a typo to be tidied up — it is the value the Anthropic wire has to be given.
/** The Zen plan, pay-as-you-go, on the Anthropic wire. */
const OPENCODE_ZEN_BASE = "https://opencode.ai/zen";
/** The Go plan, the $10/month subscription, on the Anthropic wire. */
const OPENCODE_GO_BASE = "https://opencode.ai/zen/go";
/** The same two, for the OpenAI-compatible wire. */
const OPENCODE_ZEN_OAI_BASE = "https://opencode.ai/zen/v1";
const OPENCODE_GO_OAI_BASE = "https://opencode.ai/zen/go/v1";

// Long-form design notes: docs/dev/ai-layer.md
/** The four gateway provider ids: a route to a model, not a home for one. */
const GATEWAY_PROVIDERS = new Set(["opencode-zen", "opencode-go", "opencode-zen-oai", "opencode-go-oai"]);

/** 10 * 1.25 is 1.25, but 0.1 * 3 leaves floating-point dust in a price table. */
function roundPrice(usd: number): number {
	return Number(usd.toFixed(4));
}

// Long-form design notes: docs/dev/ai-layer.md
/** Cache prices derived from the input rate; the read multiplier is a parameter. */
function anthropicPricing(input: number, output: number, cacheReadMultiplier = 0.1): ModelPricing {
	return {
		input,
		output,
		cacheRead: roundPrice(input * cacheReadMultiplier),
		cacheWrite: roundPrice(input * 1.25),
	};
}

/**
 * OpenAI's cache channel: a per-model read rate, which every current row happens
 * to publish as a tenth of input, and a write OpenAI documents once as a rule
 * rather than per model. The read is passed in and the write derived — the rule
 * is the part that would silently rot, since a wrong write price is invisible
 * until a cached session is billed.
 */
function openAIPricing(input: number, output: number, cacheRead: number): ModelPricing {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: roundPrice(input * 1.25),
	};
}

// Long-form design notes: docs/dev/ai-layer.md
/** A row on the Anthropic wire, for a host that is not Anthropic's. */
function anthropicCompatModel(
	provider: string,
	baseUrl: string,
	apiKeyEnv: string,
	apiKeyEnvFallbacks: string[] | undefined,
	id: string,
	name: string,
	opts: {
		contextWindow: number;
		maxOutputTokens: number;
		reasoning?: boolean;
		images?: boolean;
		thinkingMode?: "adaptive" | "extended";
		pricing: ModelPricing;
	},
): Model {
	return {
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl,
		apiKeyEnv,
		// Omitted rather than empty when there is none, so "no other variable works"
		// and "this row never had a second name" stay distinguishable.
		...(apiKeyEnvFallbacks ? { apiKeyEnvFallbacks } : {}),
		contextWindow: opts.contextWindow,
		maxOutputTokens: opts.maxOutputTokens,
		reasoning: opts.reasoning ?? true,
		input: opts.images === false ? ["text"] : ["text", "image"],
		...(opts.thinkingMode ? { thinkingMode: opts.thinkingMode } : {}),
		pricing: opts.pricing,
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
		thinkingMode?: "adaptive" | "extended";
		thinkingBlockBinding?: boolean;
		pricing: ModelPricing;
	},
): Model {
	return {
		...anthropicCompatModel(
			"anthropic",
			ANTHROPIC_BASE,
			"ANTHROPIC_API_KEY",
			// Proxies and gateways in front of the Anthropic API commonly issue the
			// credential as ANTHROPIC_AUTH_TOKEN instead.
			["ANTHROPIC_AUTH_TOKEN"],
			id,
			name,
			opts,
		),
		...(opts.thinkingBlockBinding ? { thinkingBlockBinding: true } : {}),
	};
}

// Long-form design notes: docs/dev/ai-layer.md
/** One model on one OpenAI wire; both wires share this body. */
function openAIModel(
	api: "openai-completions" | "openai-responses",
	provider: string,
	baseUrl: string,
	apiKeyEnv: string,
	id: string,
	name: string,
	opts: {
		contextWindow: number;
		maxOutputTokens: number;
		reasoning?: boolean;
		// Long-form design notes: docs/dev/ai-layer.md
		/** Off unless a row asks. */
		images?: boolean;
		apiKeyEnvFallbacks?: string[];
		/**
		 * Omitted rather than defaulted, for the reason `reasoning` cannot carry:
		 * absent says "this model never said", which is a different claim from "this
		 * model takes whatever the session asked for". A row that guesses the second
		 * about the first sends a `reasoning_effort` that costs the request its
		 * tools. See {@link Model.toolReasoningEffort}.
		 */
		toolReasoningEffort?: "low" | "medium" | "high" | "none";
		/**
		 * The efforts this model accepts, when it accepts a proper subset of ours.
		 * See {@link Model.reasoningEfforts} for why the omission is the operation
		 * rather than a rounding: a level the row does not list is a value this model
		 * rejects, and substituting the nearest one it does accept would be a guess
		 * about what the session wanted made on the user's behalf.
		 */
		reasoningEfforts?: readonly ("minimal" | "low" | "medium" | "high")[];
		toolCalling?: false;
		pricing: ModelPricing;
	},
): Model {
	return {
		id,
		name,
		api,
		provider,
		baseUrl,
		apiKeyEnv,
		// Omitted rather than empty when there is none, so "no other variable works"
		// and "this model never said" stay distinguishable.
		...(opts.apiKeyEnvFallbacks ? { apiKeyEnvFallbacks: opts.apiKeyEnvFallbacks } : {}),
		...(opts.toolReasoningEffort ? { toolReasoningEffort: opts.toolReasoningEffort } : {}),
		...(opts.reasoningEfforts ? { reasoningEfforts: opts.reasoningEfforts } : {}),
		...(opts.toolCalling === false ? { toolCalling: false as const } : {}),
		contextWindow: opts.contextWindow,
		maxOutputTokens: opts.maxOutputTokens,
		reasoning: opts.reasoning ?? false,
		input: opts.images ? ["text", "image"] : ["text"],
		pricing: opts.pricing,
	};
}

/** A model on OpenAI's Chat Completions wire — the one every compat provider speaks. */
function openAICompatModel(
	provider: string,
	baseUrl: string,
	apiKeyEnv: string,
	id: string,
	name: string,
	opts: Parameters<typeof openAIModel>[6],
): Model {
	return openAIModel("openai-completions", provider, baseUrl, apiKeyEnv, id, name, opts);
}

// Long-form design notes: docs/dev/ai-layer.md
/** A model on OpenAI's Responses wire. */
function openAIResponsesModel(
	provider: string,
	baseUrl: string,
	apiKeyEnv: string,
	id: string,
	name: string,
	opts: Parameters<typeof openAIModel>[6],
): Model {
	return openAIModel("openai-responses", provider, baseUrl, apiKeyEnv, id, name, opts);
}

// Long-form design notes: docs/dev/ai-layer.md
/** One model on one gateway plan: id, name, limits, price, and the per-wire flags. */
type GatewayModel = readonly [
	id: string,
	name: string,
	contextWindow: number,
	maxOutputTokens: number,
	pricing: ModelPricing,
	images: boolean,
	toolReasoningEffort?: "none",
	/**
	 * `false` for a model whose function calling is published on an endpoint other
	 * than the one this table registers it against. Only the OpenAI rows read it —
	 * the Anthropic rows below are the same models on a different wire, where the
	 * question does not arise in the same form.
	 */
	toolCalling?: false,
];

const OPENCODE_ZEN_MODELS: GatewayModel[] = [
	["big-pickle", "Big Pickle", 200_000, 32_000, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, false],
	[
		"claude-fable-5",
		"Claude Fable 5",
		1_000_000,
		128_000,
		{ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		true,
	],
	[
		"claude-fable-5-1",
		"Claude Fable 5.1",
		1_000_000,
		128_000,
		{ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
		true,
	],
	[
		"claude-haiku-4-5",
		"Claude Haiku 4.5",
		200_000,
		64_000,
		{ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		true,
	],
	// Added 2026-10-08, the day after it shipped. Same sourcing as the
	// `claude-sonnet-5-5` row below — the gateway lists it and models.dev prices
	// it — and the same figures as the vendor page's 100k-and-under band, which
	// is the band models.dev's Zen entry states before its own `tiers` step. No
	// Go twin: the Go listing carries no Claude id at all, so both Go tables
	// stay silent even though models.dev prices the model on the Go plan too.
	[
		"claude-haiku-5-5",
		"Claude Haiku 5.5",
		1_000_000,
		128_000,
		{ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
		true,
	],
	[
		"claude-opus-4-5",
		"Claude Opus 4.5",
		200_000,
		64_000,
		{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		true,
	],
	[
		"claude-opus-4-6",
		"Claude Opus 4.6",
		1_000_000,
		128_000,
		{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		true,
	],
	[
		"claude-opus-4-7",
		"Claude Opus 4.7",
		1_000_000,
		128_000,
		{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		true,
	],
	[
		"claude-opus-4-8",
		"Claude Opus 4.8",
		1_000_000,
		128_000,
		{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		true,
	],
	[
		"claude-opus-5",
		"Claude Opus 5",
		1_000_000,
		128_000,
		{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		true,
	],
	[
		"claude-opus-5-5",
		"Claude Opus 5.5",
		1_000_000,
		128_000,
		{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		true,
	],
	[
		"claude-sonnet-4",
		"Claude Sonnet 4",
		1_000_000,
		64_000,
		{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		true,
	],
	[
		"claude-sonnet-4-5",
		"Claude Sonnet 4.5",
		1_000_000,
		64_000,
		{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		true,
	],
	[
		"claude-sonnet-4-6",
		"Claude Sonnet 4.6",
		1_000_000,
		64_000,
		{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		true,
	],
	[
		"claude-sonnet-5",
		"Claude Sonnet 5",
		1_000_000,
		128_000,
		{ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		true,
	],
	// Added 2026-09-29, the day after it shipped. The gateway lists it and
	// models.dev prices it at the same figures as its own predecessor, which is
	// also the vendor's — three sources agreeing is why this row is a copy rather
	// than a derivation. It is the first row here added on a re-check of the
	// listing rather than on the 09-28 sweep the rest of the table was taken on.
	[
		"claude-sonnet-5-5",
		"Claude Sonnet 5.5",
		1_000_000,
		128_000,
		{ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		true,
	],
	[
		"deepseek-v4-flash",
		"DeepSeek V4 Flash",
		1_000_000,
		384_000,
		{ input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
		false,
	],
	[
		"deepseek-v4-flash-vision-exp",
		"DeepSeek V4 Flash Vision Exp",
		1_000_000,
		384_000,
		{ input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
		true,
	],
	[
		"deepseek-v4-pro",
		"DeepSeek V4 Pro",
		1_000_000,
		384_000,
		{ input: 1.74, output: 3.84, cacheRead: 0.145, cacheWrite: 0 },
		false,
	],
	[
		"deepseek-v4.1-flash",
		"DeepSeek V4.1 Flash",
		1_000_000,
		384_000,
		{ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		true,
	],
	["exo-free", "Exo Free", 1_048_576, 131_072, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, true],
	[
		"fledge-alpha-free",
		"Fledge Alpha Free",
		1_048_576,
		131_072,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		true,
	],
	[
		"gemini-3-flash",
		"Gemini 3 Flash",
		1_048_576,
		65_536,
		{ input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
		true,
	],
	[
		"gemini-3.1-pro",
		"Gemini 3.1 Pro Preview",
		1_048_576,
		65_536,
		{ input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
		true,
	],
	[
		"gemini-3.5-flash",
		"Gemini 3.5 Flash",
		1_048_576,
		65_536,
		{ input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
		true,
	],
	[
		"gemini-3.5-flash-lite",
		"Gemini 3.5 Flash Lite",
		1_048_576,
		65_536,
		{ input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		true,
	],
	[
		"gemini-3.6-flash",
		"Gemini 3.6 Flash",
		1_048_576,
		65_536,
		{ input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
		true,
	],
	[
		"gemini-3.7-flash",
		"Gemini 3.7 Flash",
		1_048_576,
		65_536,
		{ input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
		true,
	],
	[
		"gemini-3.8-flash",
		"Gemini 3.8 Flash",
		1_048_576,
		65_536,
		{ input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
		true,
	],
	["glm-5", "GLM-5", 204_800, 131_072, { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 }, false],
	["glm-5.1", "GLM-5.1", 204_800, 131_072, { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }, false],
	["glm-5.2", "GLM-5.2", 1_000_000, 131_072, { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }, false],
	["glm-5.3", "GLM-5.3", 1_000_000, 131_072, { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }, false],
	[
		"glm-5.3-flash",
		"GLM-5.3-Flash",
		1_000_000,
		131_072,
		{ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
		true,
	],
	["gpt-5", "GPT-5", 400_000, 128_000, { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 }, true],
	["gpt-5-codex", "GPT-5 Codex", 400_000, 128_000, { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 }, true],
	["gpt-5-nano", "GPT-5 Nano", 400_000, 128_000, { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 }, true],
	["gpt-5.1", "GPT-5.1", 400_000, 128_000, { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 }, true],
	[
		"gpt-5.1-codex",
		"GPT-5.1 Codex",
		400_000,
		128_000,
		{ input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
		true,
	],
	[
		"gpt-5.1-codex-max",
		"GPT-5.1 Codex Max",
		400_000,
		128_000,
		{ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		true,
	],
	[
		"gpt-5.1-codex-mini",
		"GPT-5.1 Codex Mini",
		400_000,
		128_000,
		{ input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
		true,
	],
	["gpt-5.2", "GPT-5.2", 400_000, 128_000, { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }, true],
	[
		"gpt-5.2-codex",
		"GPT-5.2 Codex",
		400_000,
		128_000,
		{ input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		true,
	],
	[
		"gpt-5.3-codex",
		"GPT-5.3 Codex",
		400_000,
		128_000,
		{ input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		true,
	],
	[
		"gpt-5.3-codex-spark",
		"GPT-5.3 Codex Spark",
		128_000,
		128_000,
		{ input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		false,
	],
	["gpt-5.4", "GPT-5.4", 1_050_000, 128_000, { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }, true],
	[
		"gpt-5.4-mini",
		"GPT-5.4 Mini",
		400_000,
		128_000,
		{ input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		true,
	],
	[
		"gpt-5.4-nano",
		"GPT-5.4 Nano",
		400_000,
		128_000,
		{ input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
		true,
	],
	["gpt-5.4-pro", "GPT-5.4 Pro", 1_050_000, 128_000, { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 }, true],
	["gpt-5.5", "GPT-5.5", 1_050_000, 128_000, { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }, true],
	["gpt-5.5-pro", "GPT-5.5 Pro", 1_050_000, 128_000, { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 }, true],
	[
		"gpt-5.6-luna",
		"GPT-5.6 Luna",
		1_050_000,
		128_000,
		{ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
		true,
	],
	["gpt-5.6-sol", "GPT-5.6 Sol", 1_050_000, 128_000, { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, true],
	[
		"gpt-5.6-terra",
		"GPT-5.6 Terra",
		1_050_000,
		128_000,
		{ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
		true,
	],
	["gpt-6-astra", "GPT-6 Astra", 1_050_000, 128_000, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, true],
	[
		"gpt-6-luna",
		"GPT-6 Luna",
		1_050_000,
		128_000,
		{ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
		true,
		"none",
	],
	[
		"gpt-6-sol",
		"GPT-6 Sol",
		1_050_000,
		128_000,
		{ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		true,
		"none",
	],
	// Sorts after `gpt-6-sol` ("-" before "."); no `toolReasoningEffort`; the one gateway row with `toolCalling: false`.
	// Long-form design notes: docs/dev/ai-layer.md
	[
		"gpt-6.1-sol",
		"GPT-6.1 Sol",
		1_050_000,
		128_000,
		{ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		true,
		undefined,
		false,
	],
	["grok-4.5", "Grok 4.5", 500_000, 500_000, { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 }, true],
	["grok-4.6", "Grok 4.6", 500_000, 500_000, { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }, true],
	["grok-4.7", "Grok 4.7", 500_000, 500_000, { input: 1.4, output: 4.2, cacheRead: 0.35, cacheWrite: 0 }, true],
	["grok-build-0.1", "Grok Build 0.1", 256_000, 256_000, { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 }, true],
	["kimi-k2.5", "Kimi K2.5", 262_144, 65_536, { input: 0.6, output: 3, cacheRead: 0.08, cacheWrite: 0 }, true],
	["kimi-k2.6", "Kimi K2.6", 262_144, 65_536, { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 }, true],
	[
		"kimi-k2.7-code",
		"Kimi K2.7 Code",
		262_144,
		262_144,
		{ input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
		true,
	],
	["kimi-k3", "Kimi K3", 1_048_576, 131_072, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, true],
	[
		"ling-3.0-flash-fin-free",
		"Ling 3.0 Flash Fin Free",
		262_144,
		32_768,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		false,
	],
	[
		"ling-3.1-flash-free",
		"Ling 3.1 Flash Free",
		262_144,
		32_768,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		false,
	],
	[
		"longcat-2.5-preview-free",
		"LongCat 2.5 Preview Free",
		1_000_000,
		131_072,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		true,
	],
	[
		"mimo-v2.6-flash-free",
		"MiMo-V2.6-Flash Free",
		200_000,
		32_000,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		true,
	],
	[
		"minimax-m2.5",
		"MiniMax-M2.5",
		204_800,
		131_072,
		{ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		false,
	],
	[
		"minimax-m2.7",
		"MiniMax-M2.7",
		204_800,
		131_072,
		{ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		false,
	],
	["minimax-m3", "MiniMax-M3", 512_000, 128_000, { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 }, true],
	[
		"mistral-large-4",
		"Mistral Large 4",
		524_288,
		262_144,
		{ input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0 },
		true,
	],
	[
		"muse-spark-1.2",
		"Muse Spark 1.2",
		1_048_576,
		131_072,
		{ input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		true,
	],
	[
		"muse-spark-1.2-contributor-free",
		"Muse Spark 1.2 Free",
		1_048_576,
		131_072,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		true,
	],
	[
		"muse-spark-1.3",
		"Muse Spark 1.3",
		1_048_576,
		131_072,
		{ input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		true,
	],
	[
		"muse-spark-1.3-contributor-free",
		"Muse Spark 1.3 Free",
		1_048_576,
		131_072,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		true,
	],
	[
		"nemotron-3-ultra-free",
		"Nemotron 3 Ultra Free",
		1_000_000,
		128_000,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		false,
	],
	[
		"nemotron-3.5-lightning-free",
		"Nemotron 3.5 Lightning Free",
		262_144,
		262_144,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		false,
	],
	[
		"qwen3.5-plus",
		"Qwen3.5 Plus",
		262_144,
		65_536,
		{ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
		true,
	],
	[
		"qwen3.6-plus",
		"Qwen3.6 Plus",
		262_144,
		65_536,
		{ input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
		true,
	],
	[
		"qwen3.8-flash",
		"Qwen3.8 Flash",
		1_000_000,
		131_072,
		{ input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 },
		true,
	],
	["qwen3.8-max", "Qwen3.8 Max", 262_144, 131_072, { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 }, true],
	[
		"space-bunny-free",
		"Space Bunny Free",
		1_048_576,
		524_288,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		true,
	],
];
const OPENCODE_GO_MODELS: GatewayModel[] = [
	[
		"deepseek-v4-flash",
		"DeepSeek V4 Flash",
		1_000_000,
		384_000,
		{ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		false,
	],
	[
		"deepseek-v4-flash-vision-exp",
		"DeepSeek V4 Flash Vision Exp",
		1_000_000,
		384_000,
		{ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		true,
	],
	[
		"deepseek-v4-pro",
		"DeepSeek V4 Pro",
		1_000_000,
		384_000,
		{ input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
		false,
	],
	[
		"deepseek-v4.1-flash",
		"DeepSeek V4.1 Flash",
		1_000_000,
		384_000,
		{ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		true,
	],
	["glm-5.2", "GLM-5.2", 1_000_000, 131_072, { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }, false],
	["glm-5.3", "GLM-5.3", 1_000_000, 131_072, { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }, false],
	[
		"glm-5.3-flash",
		"GLM-5.3-Flash",
		1_000_000,
		131_072,
		{ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
		true,
	],
	[
		"gpt-5.6-luna",
		"GPT-5.6 Luna",
		1_050_000,
		128_000,
		{ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
		true,
	],
	[
		"gpt-6-luna",
		"GPT-6 Luna",
		1_050_000,
		128_000,
		{ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
		true,
		"none",
	],
	["grok-4.5", "Grok 4.5", 500_000, 500_000, { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 }, true],
	["grok-4.6", "Grok 4.6", 500_000, 500_000, { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }, true],
	["grok-4.7", "Grok 4.7", 500_000, 500_000, { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }, true],
	["hy3", "Hy3", 256_000, 128_000, { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 }, false],
	[
		"hy4-preview",
		"Hy4 preview",
		1_024_000,
		64_000,
		{ input: 0.834, output: 2.501, cacheRead: 0.042, cacheWrite: 0 },
		false,
	],
	["kimi-k2.6", "Kimi K2.6", 262_144, 65_536, { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 }, true],
	[
		"kimi-k2.7-code",
		"Kimi K2.7 Code",
		262_144,
		262_144,
		{ input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
		true,
	],
	["kimi-k3", "Kimi K3", 1_048_576, 131_072, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, true],
	[
		"longcat-2.0",
		"LongCat-2.0",
		1_000_000,
		131_072,
		{ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		false,
	],
	[
		"longcat-2.5-preview-free",
		"LongCat 2.5 Preview Free",
		1_000_000,
		131_072,
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		true,
	],
	["mimo-v2.5", "MiMo V2.5", 1_000_000, 128_000, { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 }, true],
	[
		"mimo-v2.5-pro",
		"MiMo V2.5 Pro",
		1_048_576,
		128_000,
		{ input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
		false,
	],
	[
		"mimo-v2.6-flash",
		"MiMo-V2.6-Flash",
		1_048_576,
		131_072,
		{ input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		true,
	],
	[
		"mimo-v2.6-pro",
		"MiMo-V2.6-Pro",
		1_048_576,
		131_072,
		{ input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
		true,
	],
	[
		"minimax-m2.7",
		"MiniMax-M2.7",
		204_800,
		131_072,
		{ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
		false,
	],
	["minimax-m3", "MiniMax-M3", 1_000_000, 131_072, { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 }, true],
	[
		"muse-spark-1.2-contributor",
		"Muse Spark 1.2 Contributor",
		1_048_576,
		131_072,
		{ input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		true,
	],
	[
		"muse-spark-1.3-contributor",
		"Muse Spark 1.3 Contributor",
		1_048_576,
		131_072,
		{ input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		true,
	],
	// Zen's entry for this id states a 262,144 window where Go's states a
	// million, so each plan's row carries the figure its own catalogue states —
	// the header's "neither is ever filled in from the other" rule, applied to a
	// window rather than a price, because nothing here tells which figure the
	// model itself takes.
	[
		"qwen3.6-plus",
		"Qwen3.6 Plus",
		1_000_000,
		65_536,
		{ input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
		true,
	],
	[
		"qwen3.7-max",
		"Qwen3.7 Max",
		1_000_000,
		65_536,
		{ input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
		false,
	],
	[
		"qwen3.7-plus",
		"Qwen3.7 Plus",
		1_000_000,
		65_536,
		{ input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
		true,
	],
	[
		"qwen3.8-flash",
		"Qwen3.8 Flash",
		1_000_000,
		131_072,
		{ input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 },
		true,
	],
	["qwen3.8-max", "Qwen3.8 Max", 1_000_000, 131_072, { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 }, true],
	// Renamed and repriced since the sweep, checked 2026-10-08: the Go listing serves `space-bunny`, this row carried the free variant.
	// Long-form design notes: docs/dev/ai-layer.md
	[
		"space-bunny",
		"Space Bunny",
		1_048_576,
		524_288,
		{ input: 0.15, output: 0.6, cacheRead: 0.03, cacheWrite: 0 },
		true,
	],
];

// Long-form design notes: docs/dev/ai-layer.md
/** Where the money numbers come from: vendor pages, sweep dates, and the gateway exception. */
const BUILT_IN_MODELS: Model[] = [
	// Anthropic. 1M window from 4.6 on; adaptive thinking from 4.7 on (Haiku 4.5 stays on `extended`); every row states `thinkingMode`.
	// Long-form design notes: docs/dev/ai-layer.md
	anthropicModel("claude-opus-5-5", "Claude Opus 5.5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		// One of the four models whose thinking blocks are checked against the
		// conversation that produced them; see `thinkingBlockBinding`.
		thinkingBlockBinding: true,
		// The 0.05x cache-read regime, between the 0.025x pair below and the
		// standard tenth everywhere else.
		pricing: anthropicPricing(4, 20, 0.05),
	}),
	anthropicModel("claude-fable-5-1", "Claude Fable 5.1", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		// One of the other three. Mythos 5.1 records the same signatures but runs no
		// such check, so it is deliberately not flagged.
		thinkingBlockBinding: true,
		// One of the two rows whose cache reads are not a tenth of input.
		pricing: anthropicPricing(10, 50, 0.025),
	}),
	anthropicModel("claude-mythos-5-1", "Claude Mythos 5.1", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(10, 50, 0.025),
	}),
	// Fable 5 is legacy — still served, and still what a settings file may name.
	anthropicModel("claude-fable-5", "Claude Fable 5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(10, 50),
	}),
	anthropicModel("claude-mythos-5", "Claude Mythos 5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(10, 50),
	}),
	anthropicModel("claude-opus-5", "Claude Opus 5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(5, 25),
	}),
	// The 4.6-generation rows: legacy, still served, and what a settings file
	// written before the 5 series names. Opus held its $5/$25 across the
	// generation; Sonnet 4.6 is still at the $3/$15 that Sonnet 5 cut to $2/$10.
	anthropicModel("claude-opus-4-8", "Claude Opus 4.8", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(5, 25),
	}),
	anthropicModel("claude-opus-4-7", "Claude Opus 4.7", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(5, 25),
	}),
	// The 4.6 pair is the one place the regime is a choice: both shapes are
	// accepted, `enabled` is deprecated, and the vendor's guidance is adaptive.
	anthropicModel("claude-opus-4-6", "Claude Opus 4.6", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(5, 25),
	}),
	// Sonnet 5.5, checked 2026-09-29: runs the thought-block check (default for accounts created on or after 2026-08-31); price unchanged from Sonnet 5.
	// Long-form design notes: docs/dev/ai-layer.md
	anthropicModel("claude-sonnet-5-5", "Claude Sonnet 5.5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		// The third model that runs the prefix check. See `thinkingBlockBinding`.
		thinkingBlockBinding: true,
		pricing: anthropicPricing(2, 10),
	}),
	anthropicModel("claude-sonnet-5", "Claude Sonnet 5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(2, 10),
	}),
	anthropicModel("claude-sonnet-4-6", "Claude Sonnet 4.6", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		pricing: anthropicPricing(3, 15),
	}),
	// A Haiku in name only: 1M/128K window, adaptive thinking, and the first Anthropic prompt-length band, $0.10/$0.50 at 100k input or under.
	// Long-form design notes: docs/dev/ai-layer.md
	anthropicModel("claude-haiku-5-5", "Claude Haiku 5.5", {
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		thinkingMode: "adaptive",
		// The fourth model that runs the prefix check. See `thinkingBlockBinding`.
		thinkingBlockBinding: true,
		pricing: anthropicPricing(0.1, 0.5),
	}),
	// The only row on the other regime: Haiku 4.5 rejects `adaptive` and is the
	// last model with a user-set thinking budget.
	anthropicModel("claude-haiku-4-5", "Claude Haiku 4.5", {
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		thinkingMode: "extended",
		pricing: anthropicPricing(1, 5),
	}),
	// The OpenAI-compatible half: `reasoning` is true only where "medium" is a documented value; DeepSeek carries peak rates.
	// Long-form design notes: docs/dev/ai-layer.md
	openAICompatModel("deepseek", DEEPSEEK_BASE, "DEEPSEEK_API_KEY", "deepseek-flash", "DeepSeek Flash", {
		contextWindow: 1_000_000,
		maxOutputTokens: 384_000,
		reasoning: true,
		pricing: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	}),
	openAICompatModel("deepseek", DEEPSEEK_BASE, "DEEPSEEK_API_KEY", "deepseek-v4-pro", "DeepSeek V4 Pro", {
		contextWindow: 1_000_000,
		maxOutputTokens: 384_000,
		reasoning: true,
		pricing: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
	}),
	// Kimi (Moonshot), international host; another host needs `KIMI_BASE_URL`; K2.x and K3 publish no output cap, only the "window minus prompt" rule.
	// Long-form design notes: docs/dev/ai-layer.md
	openAICompatModel("kimi", KIMI_BASE, "KIMI_API_KEY", "kimi-k3", "Kimi K3", {
		contextWindow: 1_048_576,
		maxOutputTokens: 131_072,
		apiKeyEnvFallbacks: ["MOONSHOT_API_KEY"],
		pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	}),
	openAICompatModel("kimi", KIMI_BASE, "KIMI_API_KEY", "kimi-k2.7-code", "Kimi K2.7 Code", {
		contextWindow: 262_144,
		maxOutputTokens: 32_768,
		apiKeyEnvFallbacks: ["MOONSHOT_API_KEY"],
		pricing: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	}),
	openAICompatModel("kimi", KIMI_BASE, "KIMI_API_KEY", "kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed", {
		contextWindow: 262_144,
		maxOutputTokens: 32_768,
		apiKeyEnvFallbacks: ["MOONSHOT_API_KEY"],
		pricing: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	}),
	openAICompatModel("kimi", KIMI_BASE, "KIMI_API_KEY", "kimi-k2.6", "Kimi K2.6", {
		contextWindow: 262_144,
		maxOutputTokens: 32_768,
		apiKeyEnvFallbacks: ["MOONSHOT_API_KEY"],
		pricing: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	}),
	// GLM (Z.AI). 5.3 leads the family on a 1M window; 4.7 is the same price as
	// 4.6 with a thinking mode that cannot be turned off.
	openAICompatModel("glm", GLM_BASE, "GLM_API_KEY", "glm-5.3", "GLM-5.3", {
		contextWindow: 1_000_000,
		maxOutputTokens: 131_072,
		pricing: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	}),
	openAICompatModel("glm", GLM_BASE, "GLM_API_KEY", "glm-5.3-flash", "GLM-5.3-Flash", {
		contextWindow: 1_000_000,
		maxOutputTokens: 131_072,
		pricing: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
	}),
	// The 5.3 generation's answer to the 4.7 tier's FlashX, on the same 1M window the
	// rest of the 5.3 family carries. Where the 4.7 pair leaves a wide gap between
	// its tiers (4.7 at $0.60, 4.7-FlashX at $0.07), the 5.3 gap is narrow: 2.5x down
	// to the FlashX, against 9.3x down to the Flash. The cached rate holds the whole
	// family at about a fifth of input (0.075/0.37, next to 0.03/0.15 and 0.26/1.4).
	openAICompatModel("glm", GLM_BASE, "GLM_API_KEY", "glm-5.3-flashx", "GLM-5.3-FlashX", {
		contextWindow: 1_000_000,
		maxOutputTokens: 131_072,
		pricing: { input: 0.37, output: 1.25, cacheRead: 0.075, cacheWrite: 0 },
	}),
	openAICompatModel("glm", GLM_BASE, "GLM_API_KEY", "glm-4.7", "GLM-4.7", {
		contextWindow: 200_000,
		maxOutputTokens: 131_072,
		pricing: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	}),
	openAICompatModel("glm", GLM_BASE, "GLM_API_KEY", "glm-4.7-flashx", "GLM-4.7-FlashX", {
		contextWindow: 200_000,
		maxOutputTokens: 131_072,
		pricing: { input: 0.07, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
	}),
	openAICompatModel("glm", GLM_BASE, "GLM_API_KEY", "glm-4.6", "GLM-4.6", {
		contextWindow: 200_000,
		maxOutputTokens: 131_072,
		pricing: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	}),
	// OpenAI itself: the compat wire is OpenAI's, so only rows are needed; `gpt-5.3-codex` is absent on purpose, and `gpt-6.1-sol` halves one channel only.
	// Long-form design notes: docs/dev/ai-layer.md
	openAIResponsesModel("openai", OPENAI_BASE, "OPENAI_API_KEY", "gpt-6.1-sol", "GPT-6.1 Sol", {
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		reasoning: true,
		// Published as supporting neither `minimal` nor `none`. Left off
		// `toolReasoningEffort` because that field is a statement about Chat
		// Completions — it exists to name the one effort at which a *different*
		// model keeps its tools on that wire, a constraint that does not exist
		// here. On Responses nothing forces an effort for tools, so the row
		// carries what this model does accept and the adapter omits the rest.
		reasoningEfforts: ["low", "medium", "high"],
		pricing: openAIPricing(2, 10, 0.1),
	}),
	openAICompatModel("openai", OPENAI_BASE, "OPENAI_API_KEY", "gpt-6-astra", "GPT-6 Astra", {
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		reasoning: true,
		pricing: openAIPricing(10, 50, 1),
	}),
	// Sol and Luna are a price cut of the 5.6 tier, not a new family; both need `reasoning_effort: "none"` for tools on Chat Completions.
	// Long-form design notes: docs/dev/ai-layer.md
	openAICompatModel("openai", OPENAI_BASE, "OPENAI_API_KEY", "gpt-6-sol", "GPT-6 Sol", {
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		reasoning: true,
		toolReasoningEffort: "none",
		pricing: openAIPricing(2, 10, 0.2),
	}),
	openAICompatModel("openai", OPENAI_BASE, "OPENAI_API_KEY", "gpt-6-luna", "GPT-6 Luna", {
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		reasoning: true,
		toolReasoningEffort: "none",
		pricing: openAIPricing(0.1, 0.5, 0.01),
	}),
	openAICompatModel("openai", OPENAI_BASE, "OPENAI_API_KEY", "gpt-5.6-sol", "GPT-5.6 Sol", {
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		reasoning: true,
		pricing: openAIPricing(4, 20, 0.4),
	}),
	openAICompatModel("openai", OPENAI_BASE, "OPENAI_API_KEY", "gpt-5.6-terra", "GPT-5.6 Terra", {
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		reasoning: true,
		pricing: openAIPricing(2, 12, 0.2),
	}),
	openAICompatModel("openai", OPENAI_BASE, "OPENAI_API_KEY", "gpt-5.6-luna", "GPT-5.6 Luna", {
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		reasoning: true,
		pricing: openAIPricing(0.2, 1.2, 0.02),
	}),
	// Google, over its OpenAI-compatibility endpoint — which its docs still call
	// beta and which drops parameters it does not recognise, so these rows promise
	// a little less than a native integration would. 3.8 Flash is the current Flash
	// and 3.1 Pro the only published Pro-tier Gemini 3; the Flash row carries the
	// price in force today, which its page says roughly doubles on 2027-01-01.
	openAICompatModel("google", GOOGLE_OPENAI_BASE, "GEMINI_API_KEY", "gemini-3.8-flash", "Gemini 3.8 Flash", {
		contextWindow: 1_048_576,
		maxOutputTokens: 65_536,
		reasoning: true,
		pricing: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
	}),
	openAICompatModel("google", GOOGLE_OPENAI_BASE, "GEMINI_API_KEY", "gemini-3.1-pro-preview", "Gemini 3.1 Pro", {
		contextWindow: 1_048_576,
		maxOutputTokens: 65_536,
		pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
	}),
	// MiniMax: five rows; `maxOutputTokens` carries the window and both consumers clamp it; M3 has no cache-write rate, and 512k/tier premiums apply.
	// Long-form design notes: docs/dev/ai-layer.md
	openAICompatModel("minimax", MINIMAX_BASE, "MINIMAX_API_KEY", "minimax-m3", "minimax-M3", {
		contextWindow: 1_000_000,
		maxOutputTokens: 1_000_000,
		pricing: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
	}),
	openAICompatModel("minimax", MINIMAX_BASE, "MINIMAX_API_KEY", "minimax-m2.7", "minimax-M2.7", {
		contextWindow: 204_800,
		maxOutputTokens: 204_800,
		pricing: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
	}),
	openAICompatModel("minimax", MINIMAX_BASE, "MINIMAX_API_KEY", "minimax-m2.7-highspeed", "minimax-M2.7-highspeed", {
		contextWindow: 204_800,
		maxOutputTokens: 204_800,
		pricing: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
	}),
	openAICompatModel("minimax", MINIMAX_BASE, "MINIMAX_API_KEY", "minimax-m2.5", "minimax-M2.5", {
		contextWindow: 204_800,
		maxOutputTokens: 204_800,
		pricing: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
	}),
	openAICompatModel("minimax", MINIMAX_BASE, "MINIMAX_API_KEY", "minimax-m2.5-highspeed", "minimax-M2.5-highspeed", {
		contextWindow: 204_800,
		maxOutputTokens: 204_800,
		pricing: { input: 0.6, output: 2.4, cacheRead: 0.03, cacheWrite: 0.375 },
	}),
	// M2.1 and M2 are absent on purpose (two generations behind); Mistral rows carry the window in the output column and the Large 4 card price.
	// Long-form design notes: docs/dev/ai-layer.md
	openAICompatModel("mistral", MISTRAL_BASE, "MISTRAL_API_KEY", "mistral-large-4", "Mistral Large 4", {
		contextWindow: 1_048_576,
		maxOutputTokens: 1_048_576,
		images: true,
		pricing: { input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0 },
	}),
	openAICompatModel("mistral", MISTRAL_BASE, "MISTRAL_API_KEY", "mistral-large-2512", "Mistral Large 3", {
		contextWindow: 262_144,
		maxOutputTokens: 262_144,
		images: true,
		pricing: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
	}),
	openAICompatModel("mistral", MISTRAL_BASE, "MISTRAL_API_KEY", "mistral-medium-3-5", "Mistral Medium 3.5", {
		contextWindow: 262_144,
		maxOutputTokens: 262_144,
		images: true,
		pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
	}),
	openAICompatModel("mistral", MISTRAL_BASE, "MISTRAL_API_KEY", "mistral-small-2603", "Mistral Small 4", {
		contextWindow: 262_144,
		maxOutputTokens: 262_144,
		images: true,
		pricing: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
	}),
	openAICompatModel("mistral", MISTRAL_BASE, "MISTRAL_API_KEY", "codestral-2508", "Codestral", {
		contextWindow: 131_072,
		maxOutputTokens: 131_072,
		pricing: { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0 },
	}),
	// The gateway, last: two plans, two wires, four provider ids; `reasoning: false` everywhere (no documented thinking shape), plus the unpriced-id list.
	// Long-form design notes: docs/dev/ai-layer.md
	...OPENCODE_ZEN_MODELS.map(([id, name, contextWindow, maxOutputTokens, pricing, images]) =>
		anthropicCompatModel("opencode-zen", OPENCODE_ZEN_BASE, "OPENCODE_API_KEY", undefined, id, name, {
			contextWindow,
			maxOutputTokens,
			reasoning: false,
			images,
			pricing,
		}),
	),
	...OPENCODE_GO_MODELS.map(([id, name, contextWindow, maxOutputTokens, pricing, images]) =>
		anthropicCompatModel("opencode-go", OPENCODE_GO_BASE, "OPENCODE_API_KEY", undefined, id, name, {
			contextWindow,
			maxOutputTokens,
			reasoning: false,
			images,
			pricing,
		}),
	),
	...OPENCODE_ZEN_MODELS.map(
		([id, name, contextWindow, maxOutputTokens, pricing, images, toolReasoningEffort, toolCalling]) =>
			openAICompatModel("opencode-zen-oai", OPENCODE_ZEN_OAI_BASE, "OPENCODE_API_KEY", id, name, {
				contextWindow,
				maxOutputTokens,
				reasoning: false,
				images,
				toolReasoningEffort,
				...(toolCalling === false ? { toolCalling: false as const } : {}),
				pricing,
			}),
	),
	...OPENCODE_GO_MODELS.map(([id, name, contextWindow, maxOutputTokens, pricing, images, toolReasoningEffort]) =>
		openAICompatModel("opencode-go-oai", OPENCODE_GO_OAI_BASE, "OPENCODE_API_KEY", id, name, {
			contextWindow,
			maxOutputTokens,
			reasoning: false,
			images,
			toolReasoningEffort,
			pricing,
		}),
	),
];

// Long-form design notes: docs/dev/ai-layer.md
/** Ids no row carries, and the row that answers to them now. */
const RETIRED_MODEL_IDS = new Map<string, string>([
	// Anthropic, by the replacement each notice named — a 4.6-generation id or
	// later in every case. The ids whose notice named a whole group's successors
	// rather than their own (claude-2.x and claude-3-sonnet) are left out: a
	// reference that fails loudly beats one forwarded to a guess.
	["claude-3-5-sonnet-20240620", "claude-sonnet-4-6"],
	["claude-3-5-sonnet-20241022", "claude-sonnet-4-6"],
	["claude-3-7-sonnet-20250219", "claude-sonnet-4-6"],
	["claude-sonnet-4-20250514", "claude-sonnet-4-6"],
	["claude-3-opus-20240229", "claude-opus-4-8"],
	["claude-opus-4-20250514", "claude-opus-4-8"],
	["claude-opus-4-1-20250805", "claude-opus-4-8"],
	["claude-3-5-haiku-20241022", "claude-haiku-4-5"],
	["claude-3-haiku-20240307", "claude-haiku-4-5"],
	// DeepSeek retired the chat/reasoner pair on 2026-07-24; both modes live on
	// under the flash id. The two V4 flash ids are different — the API still
	// answers them as compatibility aliases, at flash prices — but they name the
	// same row, so a reference to either resolves to it.
	["deepseek-chat", "deepseek-flash"],
	["deepseek-reasoner", "deepseek-flash"],
	["deepseek-v4-flash", "deepseek-flash"],
	["deepseek-v4-flash-vision-exp", "deepseek-flash"],
	// Kimi, where the line of succession ran twice. The K2 previews and K2.5 stay
	// in the family, since K2.6 is its surviving member at the price they had;
	// the moonshot-v1 ids have no survivor to land on and follow their notice to
	// K3, a far more expensive model than the one they named.
	["kimi-k2-0711-preview", "kimi-k2.6"],
	["kimi-k2-0905-preview", "kimi-k2.6"],
	["kimi-k2-turbo-preview", "kimi-k2.6"],
	["kimi-k2-thinking", "kimi-k2.6"],
	["kimi-k2-thinking-turbo", "kimi-k2.6"],
	["kimi-k2.5", "kimi-k2.6"],
	["moonshot-v1-8k", "kimi-k3"],
	["moonshot-v1-32k", "kimi-k3"],
	["moonshot-v1-128k", "kimi-k3"],
	["moonshot-v1-auto", "kimi-k3"],
	["moonshot-v1-8k-vision-preview", "kimi-k3"],
	["moonshot-v1-32k-vision-preview", "kimi-k3"],
	["moonshot-v1-128k-vision-preview", "kimi-k3"],
	["kimi-latest", "kimi-k3"],
	["kimi-thinking-preview", "kimi-k3"],
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
 * cap, Kimi's reports a window, and the rest report ids and nothing else.
 */
export interface DiscoveredModel {
	id: string;
	displayName?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
}

// Long-form design notes: docs/dev/ai-layer.md
/** What the providers said they serve, filled in once at startup. */
const providerCatalogue = new Map<string, Set<string>>();

// Long-form design notes: docs/dev/ai-layer.md
/** Limits a provider stated for an id, keyed "provider/id"; they beat the table. */
const liveLimits = new Map<string, { contextWindow?: number; maxOutputTokens?: number }>();

/** Models discovery added because a vendor serves one the table has never heard of. */
const discoveredModels = new Map<string, Model>();

// Long-form design notes: docs/dev/ai-layer.md
/** Build a row from what the provider said; both limits needed, and no price. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** Record what one provider reported it serves; returns the ids gained and lost. */
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
		// Either limit on its own is worth recording. The both-limits rule lives in
		// synthesizeModel, and it is about adding a row, not correcting one.
		const limits: { contextWindow?: number; maxOutputTokens?: number } = {};
		if (model.contextWindow !== undefined) limits.contextWindow = model.contextWindow;
		if (model.maxOutputTokens !== undefined) limits.maxOutputTokens = model.maxOutputTokens;
		if (limits.contextWindow !== undefined || limits.maxOutputTokens !== undefined) {
			liveLimits.set(prefix + model.id, limits);
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
	if (!limits) return model;
	// Like the price override above: the stored entry names only the limits the
	// listing actually stated, which is what lets the table's other number stand.
	// The store is the only writer, so that is the invariant to keep.
	return { ...model, ...limits };
}

// Long-form design notes: docs/dev/ai-layer.md
/** Everything this process knows, including models a provider no longer lists. */
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

// Long-form design notes: docs/dev/ai-layer.md
/** Gateway providers that sell this bare id, for a "no such model, but it is here" hint. */
export function gatewayProvidersFor(reference: string): string[] {
	if (resolveModel(reference)) return [];
	return [
		...new Set(
			allModels()
				.filter((m) => m.id === reference)
				.map((m) => m.provider),
		),
	].filter((p) => GATEWAY_PROVIDERS.has(p));
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

// Long-form design notes: docs/dev/ai-layer.md
/** A model whose key the environment does not hold; raised before a request is built. */
export class MissingApiKeyError extends Error {
	readonly provider: string;
	readonly envNames: string[];

	constructor(model: Model) {
		const envNames = apiKeyEnvNames(model);
		super(`Missing API key for ${model.provider}: set ${envNames.join(" or ")} in your environment.`);
		this.name = "MissingApiKeyError";
		this.provider = model.provider;
		this.envNames = envNames;
	}
}

// Long-form design notes: docs/dev/ai-layer.md
/** Resolve a `provider/model` or bare id reference; retired ids are tried once more. */
export function resolveModel(reference: string): Model | undefined {
	// A bare id means the vendor that makes the model, and only that vendor: a retired bare id stays retired, and an id no vendor carries resolves to nothing rather than to the gateway.
	// Long-form design notes: docs/dev/ai-layer.md
	if (!reference.includes("/")) {
		if (RETIRED_MODEL_IDS.has(reference)) return lookupReplacement(reference);
		const bare = lookupModel(reference);
		return bare && !GATEWAY_PROVIDERS.has(bare.provider) ? bare : undefined;
	}
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
