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

/**
 * The four providers above are a *route to* a model rather than a home for one,
 * and `resolveModel` treats them differently for exactly that reason: a bare id
 * never resolves to one of these rows. See the comment on that function for what
 * that costs and why the alternative is worse.
 *
 * Deliberately the four built-in ids and not a shape — a "looks like a reseller"
 * test would also catch a user who registered their own gateway, and a user
 * registering `openrouter` under that name is telling us to believe them.
 */
const GATEWAY_PROVIDERS = new Set(["opencode-zen", "opencode-go", "opencode-zen-oai", "opencode-go-oai"]);

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
 * The read multiplier is a parameter because two rows are priced at 0.025x
 * instead — Fable 5.1 and Mythos 5.1, the two ".1" releases, which is exactly why
 * the pair is where a copy-paste error would hide — and a third at 0.05x, Opus
 * 5.5. Three regimes, and the vendor's pricing page footnotes each one by name.
 */
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

/**
 * A row on the Anthropic wire, for a host that is not Anthropic's.
 *
 * This exists because the wire and the vendor are separate questions. A gateway
 * in front of Claude speaks exactly this protocol and is not this vendor: it
 * has its own host, its own credential, its own price list, and — the reason it
 * could not be expressed before — no way to be written down. The three fields
 * that say *which vendor* used to be literals inside {@link anthropicModel}, so
 * a non-Anthropic host had no constructor to call.
 *
 * It takes no `thinkingBlockBinding`. The flag and its beta header travel
 * together, to the four models that run the check, and a gateway in front of
 * those models is not evidence that it forwards either one; naming a model here
 * would send a parameter whose handling on the far side is unknown.
 */
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

/**
 * One model on an OpenAI wire.
 *
 * The two wires take the same options and differ only in which `ApiId` the row
 * carries, so they share this body. What that shares is deliberately *only* the
 * options: a field that only one wire reads (`toolReasoningEffort`, which is a
 * statement about Chat Completions) must not become available on both by being
 * written next to the shared signature — which is why it is read out of `opts`
 * below by name rather than spread.
 */
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
		/**
		 * Off unless a row asks. Almost every first-party row on this wire is a
		 * text model; the exceptions so far are Mistral's four image-taking rows,
		 * whose cards state text+image input. It is a field rather than a constant
		 * because a *gateway* in front of several vendors serves image-capable
		 * models on the same host, and a row there that said "text" would be a
		 * claim the model does not support.
		 */
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

/**
 * A model on OpenAI's Responses wire.
 *
 * For the GPT-6 generation this is the *only* wire it publishes function calling
 * on, so a row here is what makes the model an agent model rather than a text one:
 * `packages/agent/src/session.ts` sends `tools` on every request, and a wire that
 * does not accept tools is not a worse session, it is a session where the agent
 * quietly stops acting.
 */
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

/**
 * One model on one of the two gateway plans, transcribed once and materialized
 * onto both wires below.
 *
 * The gateway sells the same catalog two ways: Zen, pay-as-you-go, and Go, a
 * subscription. Each plan has its own key, its own host and its own price list,
 * and the two do not agree with each other on a model they share — which is what
 * stops this collapsing into one table. `deepseek-v4-pro` is $1.74/$3.84 on Zen
 * and $0.66/$1.98 on Go, so Go is the cheaper plan there; `grok-4.7` is
 * $1.40/$4.20 on Zen and $2.00/$6.00 on Go, so it is the dearer one. Both plans
 * are cheaper and dearer depending on the model, and no rule is published for
 * converting between them, so the two lists below are separate transcriptions
 * and neither is ever filled in from the other.
 *
 * The figures are transcribed from models.dev's catalogue entries for the two
 * plans, swept 2026-09-28, filtered against the gateway's own unauthenticated
 * `/v1/models` listing the same day, and both sources re-checked on 2026-10-08.
 * Every number below is a copy of a published
 * price and must not be derived — see the cache rates below for what derivation
 * gets wrong. Both halves are needed and neither is sufficient, and each is wrong
 * on its own: the gateway proves which ids can be called and publishes no price
 * and no limit; models.dev states the money and the sizes but is hand-edited and
 * drifts in both directions. The gateway serves
 * 87 ids on Zen against the 85 priced here, and 43 on Go against 33 — while every
 * priced, undeprecated entry is served, so nothing we can state has been left
 * out. The ids the gateway serves that models.dev does not price are named at the
 * foot of this comment rather than guessed at.
 *
 * Nothing here is routed through `openAIPricing`, whose `cacheWrite` is derived
 * at 1.25x input. The gateway publishes a write rate for 34 of these 118 rows and
 * states no rate at all for 84 of the rest, and the read rates are not a fixed
 * multiple of input either: `qwen3.8-flash` reads at 0.016 against an input of
 * 0.15, which is 0.107x, while `qwen3.8-max` beside it reads at exactly 0.125x. A
 * derived figure would land close enough to pass review and wrong in the channel
 * that bills a long session. Where no rate is published the row carries 0, the
 * reading the Gemini and MiniMax M3 rows above already take.
 *
 * Two display names are the catalogue's with a promotion taken off: it lists
 * Grok 4.7 as "Grok 4.7 (30% Off)" and DeepSeek V4 Pro on Go as "DeepSeek V4 Pro
 * (New)". A discount that expires does not belong in a model picker.
 */
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
	// Sorts after `gpt-6-sol` because "-" (0x2D) precedes "." (0x2E), which is
	// the same reason `gpt-5-codex` precedes `gpt-5.1` earlier in this table.
	// Added on a re-check of both halves of the rule — Zen's own listing serves
	// the id and models.dev prices it — and with no seventh element for the same
	// reason its first-party row has no `toolReasoningEffort`: the constraint
	// rides through a reseller, and so does the absence of the value that would
	// satisfy it. Go sells no `gpt-6.1-*` id, so there is no row to add there.
	//
	// The eighth element is `toolCalling: false`, and it is the one row in this
	// table that carries it. Its first-party counterpart now sits on
	// `openai-responses`, because that is where OpenAI publishes the model's
	// function calling; this row stays on Chat Completions because that is the
	// only wire Zen's listing proves it answers, and a row on a wire nobody has
	// asked about is a row that 404s. The cost is that the model is text-only
	// here, so the flag marks it and the picker does not offer it for a session
	// that expects a tool call.
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
	// Renamed and repriced since the sweep, checked 2026-10-08: the Go listing
	// serves this model as `space-bunny` at $0.15/$0.60 with $0.03 reads and $0
	// writes, where this row carried it as the free variant. models.dev's Go
	// entry still lists both ids; the listing, the one that can reject a
	// request, carries only this one. The Zen table still serves
	// `space-bunny-free`, so the plans have stopped agreeing on the id — and an
	// old Go reference stops resolving rather than forwarding, because
	// `RETIRED_MODEL_IDS` is for ids no row carries and Zen's row still
	// carries this one: a plan rename, not a retirement.
	[
		"space-bunny",
		"Space Bunny",
		1_048_576,
		524_288,
		{ input: 0.15, output: 0.6, cacheRead: 0.03, cacheWrite: 0 },
		true,
	],
];

/**
 * Where the money numbers come from.
 *
 * Every row was checked against the vendor's own page, last swept on 2026-09-27 —
 * a date on this line means "as of", not "covers every row below it". Rows added
 * between sweeps name a later date in their own comment: `claude-opus-5-5`
 * (2026-09-23); `gpt-6-sol` / `gpt-6-luna`, `glm-5.3-flashx` and the five
 * MiniMax rows (2026-09-27); `claude-sonnet-5-5` (2026-09-29); `claude-haiku-5-5`
 * (2026-10-08).
 * The 09-27 sweep changed prices on no existing row;
 * it added those eight and re-confirmed the rest, including the DeepSeek v4-pro
 * and Kimi K2.6 rows that third-party aggregators were reporting as changed.
 * Anthropic's
 * and DeepSeek's are the vendors' USD figures; the cache channel is derived by
 * the documented multipliers rather than copied, because a hand-copied third
 * number is where a table like this goes stale first (Sonnet 5 is $2/$10 — the
 * increase to $3/$15 that was scheduled for 2026-09-01 was cancelled).
 *
 * The 118 rows above are the exception to "the vendor's own page", and they say
 * so. They are a gateway's, and a gateway has no price list of its own: what it
 * resells is priced by the resellers, so the figures are a third-party
 * catalogue's, taken 2026-09-28 and checked against what the gateway will
 * actually serve. Treat them as a tier below the rows around them, and re-sweep
 * them sooner than the rest.
 *
 * The OpenAI-compatible rows are worth less than the Anthropic ones: they differ
 * per host, and DeepSeek has billed peak and off-peak rates since 2026-08-16 —
 * the figures below are the peak ones, so a session outside 01:00-04:00 and
 * 06:00-10:00 UTC on a weekday was charged half of what this table says.
 *
 * Cache writes are the channel the vendors agree on least, so each row says what
 * its vendor says: nothing for DeepSeek and the Kimi K2 series, whose caches are
 * populated at ordinary input rates; nothing today for Z.AI, whose pricing page
 * calls cache storage "limited-time free" rather than free; 1.25x input for
 * OpenAI; K3's own stated write price; nothing for MiniMax M3, the one row on
 * its vendor's table with no write rate at all while its M2.x rows state one;
 * and for Google, nothing — it meters cache *storage* by the hour instead, a
 * charge this table cannot express, which makes a Gemini row a floor rather
 * than a ceiling.
 *
 * Two published regimes are time-boxed, and the table carries the current one:
 * Google's Flash prices roughly double on 2027-01-01, and OpenAI bills 2x input
 * and 1.5x output across a whole request over 272K input tokens. The second is a
 * premium no per-token table can express at all. MiniMax is a third shape of the
 * same kind: M3's rates double over 512k input and its `priority` service tier
 * is 1.5x on top, so its row carries the standard rate at 512k or under. Claude
 * Haiku 5.5 is a fourth: its rates step up fivefold over 100k input tokens, so
 * its row carries the rate at 100k or under.
 *
 * When a price matters — a proxy, a negotiated rate, a newer model — declare it
 * in `pricing` in settings.json, which overrides this table.
 */
const BUILT_IN_MODELS: Model[] = [
	// Anthropic. Every model from the 4.6 generation on carries the full 1M-token
	// window, and all but one are billed the same at any prompt length: the
	// pricing page names Haiku 5.5 as its exception, priced by prompt length, so
	// its row carries the band at 100k input tokens or under and its comment the
	// rest.
	//
	// `thinkingMode` is the capability the rows disagree on, and every row states
	// it rather than inheriting a default: from 4.7 on — and, on the vendor's
	// recommendation, for the 4.6 pair as well — the only shape these models take
	// is adaptive thinking, with `output_config.effort` setting the depth and
	// `enabled` + `budget_tokens` refused outright. Haiku 4.5 is the reverse and
	// rejects `adaptive`. The wrong shape for a row is a 400 on the first request,
	// which is why a row that guesses is worse than one that says nothing.
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
	// Sonnet 5.5, checked against the vendor's own model page on 2026-09-29, the
	// day after it shipped. Two facts here are read rather than carried over, and
	// the flag is the one that must be: its breaking-change list says the API
	// checks a replayed thinking block against the conversation that produced it,
	// enforced by default for accounts created on or after 2026-08-31, so it runs
	// the check the pair above runs and belongs beside them. It is not inferred
	// from "the newest model" — Mythos 5.1 is newer than the pair and runs none.
	//
	// The price is unchanged from Sonnet 5, and the vendor, models.dev's `anthropic`
	// entry and models.dev's entry for the Zen plan all say the same four figures,
	// so this is a copy of an agreement rather than a derivation. Its own default
	// effort is `high`, which is what we send for a session that asked for nothing.
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
	// A Haiku in name only: the 5.5 generation moved it onto the same 1M/128K
	// window the rest of its family carries, from 200K/64K, and onto adaptive
	// thinking from 4.5's `extended` — none of these numbers is inherited from
	// the row below. The vendor also rejects `temperature`, `top_p` and `top_k`
	// on it unless they are the defaults, which costs nothing here because the
	// adapter sends none of the three on any row.
	//
	// The fourth shape the pricing note above lists, and the first on an
	// Anthropic row: the vendor bills Haiku 5.5 by prompt length, and this row
	// carries the band at 100k input tokens or under — $0.10/$0.50 with $0.01
	// reads and $0.125 writes. Above 100k the rates step up to $0.50/$2.50 with
	// $0.05 reads and $0.625 writes; a single per-token table cannot express the
	// step, so the comment carries it, and the vendor page, models.dev's
	// `anthropic` entry and its Zen entry agree on all four channels at both
	// bands.
	//
	// Its place among the checked models is read rather than inferred: the
	// preserved-thinking guide names it beside the other three, while its own
	// migration guide says Haiku 4.5 runs no check.
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
	// The OpenAI-compatible half of the table.
	//
	// `reasoning` decides what the adapter asks for by default: true sends
	// `reasoning_effort: "medium"`, false sends nothing and lets the model's own
	// default stand. Only the rows where "medium" is a documented value are true —
	// OpenAI's six and Gemini 3.8 Flash. It is false for every model that always
	// thinks, which reads backwards until you see the failure it avoids: K3's
	// effort set is low/high/max and Z.AI's 5.3 takes max/high/low, so asking
	// either for "medium" is asking for a depth it has no word for. DeepSeek
	// documents the mapping medium → high, which is why its rows stay true.
	//
	// On a row that also carries `toolReasoningEffort` this default governs
	// tool-less requests only, and the tool-less request is the one the flag is
	// even about.
	//
	// DeepSeek — peak rates; the rest of the week is half of these. Each id answers
	// in thinking or non-thinking mode (thinking by default), so the chat/reasoner
	// pair these replaced is one entry per model now, not two.
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
	// Kimi (Moonshot), on the international host, because the ids and the USD
	// figures below are the ones platform.kimi.ai publishes — the China platform
	// serves the same ids priced in CNY. Keys are not interchangeable between the
	// two, so a key from platform.kimi.com has to name its host:
	// KIMI_BASE_URL=https://api.moonshot.cn/v1. MOONSHOT_API_KEY is the variable
	// Kimi's own documentation uses; KIMI_API_KEY leads only because it is what
	// this table shipped first.
	//
	// K2.x publishes no output ceiling, only the rule — the maximum is the window
	// minus the prompt, and a request whose two lengths would exceed the window is
	// refused — so the number here is the documented default it falls back to. K3
	// publishes a default too, and its settable maximum is not a cap a session
	// should assume.
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
	// OpenAI itself: no adapter was ever needed, only these rows, because the compat
	// wire this file talks is OpenAI's. gpt-5.3-codex is current and deliberately
	// absent — it answers only on /v1/responses, and a row that 404s on the wire we
	// speak is worse than no row.
	//
	// GPT-6.1 Sol is a point release inside the 6-generation rather than a new
	// family, and it is *not* a rename of `gpt-6-sol`: same $2/$10, but its cache
	// read is $0.10 where Sol's is $0.20, so it is half price on exactly one
	// channel and unchanged on the other three. Luna is the same shape and the
	// same trap — "half of the 6-generation row" is wrong in the channel that
	// costs the most for Luna and wrong in the one nobody watches for 6.1.
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
	// Sol and Luna are the 6-generation's answer to the 5.6 tier, and they arrived
	// as a price cut rather than a new family. Sol is exactly half of 5.6 Sol on all
	// three channels ($4/$0.40/$20 → $2/$0.20/$10); Luna halves its input and cache
	// read ($0.20/$0.02 → $0.10/$0.01) and takes its output down harder, $1.20 to
	// $0.50. The 5.6 ids are still served at what they always cost, so those rows
	// stay rather than being forwarded.
	//
	// Both carry `toolReasoningEffort`, and neither carries it lightly. Their model
	// pages say function calling over Chat Completions — the wire this file speaks —
	// is available *only* at `reasoning_effort: "none"`, and name `medium` as the
	// server-side default. `reasoning: true` would send `medium` and `reasoning:
	// false` would send nothing, and both land on the same default. Neither returns
	// an error: the turn comes back with no `tool_calls` in it. Astra's page does
	// not carry that constraint, which is why the field is a row's and not a
	// provider's.
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
	// MiniMax. Five rows because the vendor sells five, and the two highspeed
	// twins are not a like-for-like swap: each costs twice the input and twice the
	// output of the row it shadows, and the *same* cached read. Nothing here is
	// derived — every figure is off the vendor's own pages. What the vendor does
	// not publish is called out below rather than filled in.
	//
	// `maxOutputTokens` is the one number here that is not an output cap, because
	// MiniMax publishes no per-model output limit and no default for one. The only
	// bound it states is that the maximum token count is the *total* of input and
	// output, so output cannot exceed the window — which is what this carries, and
	// it is why the Kimi rows above use a documented default instead and this one
	// cannot. Two things keep the value from being taken at face value: the
	// compaction reserve is `min(maxOutputTokens, 20k)` and the escalation ceiling
	// `min(maxOutputTokens * 2, 64k)`, so both consumers clamp it and no number
	// above 32k behaves differently from any other; and on the OpenAI wire this
	// adapter only sends `max_tokens` when a caller passes one.
	//
	// `reasoning` is false throughout, which for M3 is a stated default rather
	// than an absence: its thinking control is off unless the request asks. The
	// control lives on MiniMax's Anthropic endpoint, not on the one these rows
	// speak, so nothing here sends it.
	//
	// M3's rates are the standard tier at 512k input or under, and they are a
	// promotional halving of the struck-through list prices ($0.60/$0.12/$2.40):
	// over 512k input they double, and the `priority` service tier is 1.5x on top.
	// That is a four-regime table the way OpenAI's >272k premium is, and it is
	// carried the same way — one rate, with the rest named here.
	//
	// Its cache-write channel is a real zero, not a missing one: M3's rows are the
	// only ones on the pricing page with no write rate at all, while every M2.x
	// row states $0.375.
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
	// M2.1 and M2 are absent on purpose: both are two generations behind, and
	// M2 is the one row on the vendor's model list that states an output cap
	// (128k, counting CoT) — which is not a number that transfers to a successor.
	//
	// Mistral, on its own host. The reasoning flag needs the most words here:
	// Large 4, Medium 3.5 and Small 4 all take a `reasoning_effort`, and the
	// endpoint's schema enumerates six depths — but that is the whole vocabulary
	// the vendor publishes. The guide assigns behavior to the ends only (`high`
	// returns the full thinking trace as chunks, `none` drops it) and recommends
	// `high` for agentic and code work, which is what this app does; what
	// `medium` would ask of these models is written nowhere. So all five rows
	// send nothing by default and let each model stand at its own default, and
	// the documented recommendation is one `/think high` away. The other two
	// rows have nothing to ask at all: Large 3 and Codestral state text output
	// only. Large 4 itself is the newest row here, still in public preview.
	//
	// No output ceiling is published for any of the five — a `contextLength` and
	// no `outputTokenLimit` on every card, no stated default for `max_tokens` —
	// so they carry the window in the output column the way the MiniMax rows do,
	// for the same bound in writing: the prompt plus `max_tokens` cannot exceed
	// the context length. No cache-write rate is published either, so that
	// channel is a real zero, and cached input rides the vendor's stated rule —
	// a tenth of the input price — except on Large 4, where the card prints
	// $0.07 against a tenth of $0.68 being $0.068; the card wins. Large 4 is
	// also at half its struck-through list ($1.36/$2.09) while that runs, the
	// shape M3's promotion is in.
	//
	// Magistral and Devstral are absent on purpose: both are deprecated with
	// Mistral Medium 3.5 named as the replacement, so they are rows this table
	// would have to retire on purpose later.
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
	//
	// The gateway, last. Two plans, two wires, four provider ids, from the two
	// transcriptions above: a gateway is not a vendor, so one plan on one wire is
	// one provider, and the base URL is the only thing that distinguishes them.
	// Writing these out as four separate call sites would be 118 rows that differ
	// in one string each, and the copy that drifted.
	//
	// `reasoning: false` on every one of them, and the reason is a model that is
	// on the list: Zen carries `claude-opus-5-5`, and on the Anthropic wire
	// `reasoning: true` makes the adapter send `thinking: {type: "enabled",
	// budget_tokens}` — the shape Claude 4.6 and later reject with a 400. There is
	// no documentation that the gateway forwards `thinking: {type: "adaptive"}`
	// or `output_config` either, so the adaptive shape is no safer than the
	// budget one; sending nothing is the only request known to work. The cost is
	// real and worth stating: a Claude model reached through a gateway thinks
	// less than the same model reached directly, and `thinkingMode` is left off
	// on purpose rather than set optimistically.
	//
	// The one hazard this arrangement used to leave open is closed in the
	// adapter, not on these rows. `thinkingLevel` from the session used to win
	// over `model.reasoning` there, so a session that picked a level sent the
	// budget shape through the gateway — a 400 against a 4.6-or-later Claude
	// row. `buildAnthropicRequest` now honours a session level only on a row
	// that declares a thinking shape (`reasoning: true` or a `thinkingMode`),
	// and these rows declare neither, so whatever the session asks for they go
	// out with no thinking field at all. `anthropic.test.ts` pins that answer
	// against a row of exactly this shape, and the partition in
	// `model-pricing.test.ts` keeps every one of these rows on the no-thinking
	// side.
	//
	// `toolReasoningEffort` reaches only the two OpenAI-wire providers, and that
	// is where the two ids that need it are. The field is read in exactly one
	// place in this repo — the OpenAI compatibility adapter — so on the Anthropic
	// wire it would be a claim about a code path nothing executes. `gpt-6-sol` and
	// `gpt-6-luna` publish function calling as available only at
	// `reasoning_effort: "none"` and name `medium` as the server default, which
	// returns a turn with no tool calls in it and no error; the constraint is the
	// model's, not the host's, so it rides through the gateway with them. That
	// `gpt-6-astra` is on the same list without it is the reason the field is a
	// row's and not a provider's.
	//
	// What the gateway serves and this table does not, because models.dev states
	// no price or no limit for them: on Zen `jev-1.13` and `jev-1.13-free` (which
	// models.dev does not know at all), and on Go `deepseek-flash`, `glm-5`,
	// `glm-5.1`, `hy3-preview`, `kimi-k2.5`, `mimo-v2-omni`, `mimo-v2-pro`,
	// `minimax-m2.5`, `omen-alpha` and `qwen3.5-plus`. A user who
	// sees one of these in the gateway's own picker is not seeing a mistake here, and
	// an entry added for any of them would be a price invented to fill a gap.
	//
	// A fourth wire exists that some of a vendor's rows deliberately do not
	// reach: several of Zen's OpenAI models answer only on `/v1/responses`, which
	// is not a wire `ApiId` can name. The same reason `gpt-5.3-codex` is absent
	// from OpenAI's own rows above applies here, and a row that 404s on the wire
	// we speak is worse than no row.
	//
	// This used to name "the `gpt-6-*` and `grok-*` families" as the members that
	// answer only there, which stopped being true and became actively misleading:
	// every `grok-*` id Zen serves is in this table, and so are `gpt-6-astra`,
	// `gpt-6-sol` and `gpt-6-luna`, all three on the OpenAI wire below. The
	// id-level check that replaces the family claim is the listing itself —
	// everything Zen serves is in these two tables or in the unpriced list above —
	// and `gpt-6.1-sol` was added on that basis on 2026-09-30, alongside its three
	// siblings rather than on a family rule. Reachability on the wire is the one
	// thing here that listing does not prove; it takes a request, which this
	// checkout cannot make.
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

/**
 * Ids no row in this table carries, and the row that answers to them now.
 *
 * A model id written into a settings file outlives the model. When a vendor
 * retires one, the choice is between mapping it here and letting the reference
 * stop resolving — which turns a working configuration into "no such model"
 * while the model the user picked is still served, under a new name. The map is
 * one-way and one-directional on purpose: nothing writes these ids back out, and
 * nothing lists them, because there is nothing left to choose.
 *
 * Retirement is the usual reason an id lands here, not the only one: vendors also
 * keep answering compatibility aliases long after the release they named, and an
 * alias the table cannot match is as unreachable as a retired id.
 *
 * Forwarding is not price-preserving. A target is chosen for family and tier, but
 * where a family has ended — Kimi's moonshot-v1 ids — the retirement notice is
 * the only guide, and what a session costs can change with the reference. That is
 * the reason to write the mapping down rather than guess at it twice.
 */
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

/**
 * Limits a provider stated for an id, keyed "provider/id". Beats the table.
 *
 * Partial, because a listing can restate one limit and stay silent on the other:
 * Kimi publishes a window and no output cap at all, and a window on its own is
 * worth having — it is what the compaction threshold is measured against, and a
 * stale one is worse than a missing one.
 */
const liveLimits = new Map<string, { contextWindow?: number; maxOutputTokens?: number }>();

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
 * The gateway providers that sell a model under exactly this bare id, for a
 * "no such model, but it is here" message.
 *
 * Exists because of the rule `resolveModel` enforces and cannot itself report: a
 * bare id no vendor makes resolves to nothing, while the `/model` picker lists it
 * a screen away as `opencode-zen/gpt-5-codex`. Without this the user is told a
 * model is unknown while looking at it.
 *
 * Empty whenever the bare name would have worked, which is two cases beyond the
 * obvious one: a model a first-party vendor makes (`claude-opus-5-5` is sold by
 * the gateway too, and the bare name is the one the user should keep typing),
 * and an id that forwards to its replacement. The contract is "consult this after
 * a resolution has already failed", and a hint that fires when it should not is
 * worse than none — it would send a user off to buy a plan they did not need.
 *
 * A qualified reference needs no guard of its own, which a falsification run
 * pointed out by holding every attempt to break one: the id below is compared
 * whole, so `opencode-ze/gpt-5-codex` matches no row and a correct one already
 * returned empty from the test above. An earlier version spelled `includes("/")`
 * out here to be safe against a model id that contained a slash; if one ever
 * does, the guard would suppress a hint that is the right thing to give, so it
 * is not worth having.
 */
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

/**
 * A model whose key could not be resolved from the environment.
 *
 * Raised before a request is built, in place of handing an empty key to the
 * provider's SDK: the SDKs report that as an authentication failure, which reads
 * like something a later attempt might fix. It is not — no attempt can supply a
 * credential the environment does not hold — so the type is what lets the retry
 * wrapper end the turn on the first try and say which variable is missing.
 */
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

/**
 * Resolve a model reference:
 * - "provider/model" → exact match on provider + id
 * - "model-id" → unique id match across providers, at the vendor that makes it
 *
 * A reference that matches nothing is tried once more against the ids that have
 * been retired, so a settings file written before a model was renamed keeps
 * resolving to the model that answers to it today.
 */
export function resolveModel(reference: string): Model | undefined {
	// A bare id means the vendor that makes the model, and only that vendor. Two
	// ways a row breaks that promise, both of them created by the gateway tables
	// and neither visible in the row itself:
	//
	// A bare id a vendor has since *retired* still means the retirement, even
	// where some other host is selling a model of that name today. The reference
	// was written when exactly one row carried it, so answering it with a
	// reseller's row would move the session to a different vendor on a different
	// host at a different price without anything having asked for that —
	// `deepseek-v4-flash` is exactly the case: retired at DeepSeek in favour of
	// `deepseek-flash`, and sold under its own name and its own rates by four
	// gateway providers.
	//
	// And an id *no* first-party vendor carries resolves to nothing at all rather
	// than to the gateway. `gpt-5-codex` is the case that shaped this: before the
	// gateway tables it was an unknown model, which is a fact a migration reports;
	// with them it is a Zen row, so a user's `model` setting silently becomes a
	// subscription plan they may hold no key for, on a host whose prices are not
	// OpenAI's, and the only symptom is a request that fails at the auth header.
	// The rule the picker already follows is the one worth following here too: a
	// model at a gateway is chosen by picking it, under the name it is offered
	// under. Nothing about `gpt-5-codex` says "on the Zen plan".
	//
	// A qualified reference is exempt from both, and has to be:
	// `opencode-zen/deepseek-v4-flash` names the reseller, and resolving it to
	// DeepSeek would be the guess this whole function exists to avoid.
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
