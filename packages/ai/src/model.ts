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
		...(opts.thinkingMode ? { thinkingMode: opts.thinkingMode } : {}),
		...(opts.thinkingBlockBinding ? { thinkingBlockBinding: true } : {}),
		pricing: opts.pricing,
	};
}

function openAICompatModel(
	provider: string,
	baseUrl: string,
	apiKeyEnv: string,
	id: string,
	name: string,
	opts: {
		contextWindow: number;
		maxOutputTokens: number;
		reasoning?: boolean;
		apiKeyEnvFallbacks?: string[];
		/**
		 * Omitted rather than defaulted, for the reason `reasoning` cannot carry:
		 * absent says "this model never said", which is a different claim from "this
		 * model takes whatever the session asked for". A row that guesses the second
		 * about the first sends a `reasoning_effort` that costs the request its
		 * tools. See {@link Model.toolReasoningEffort}.
		 */
		toolReasoningEffort?: "low" | "medium" | "high" | "none";
		pricing: ModelPricing;
	},
): Model {
	return {
		id,
		name,
		api: "openai-completions",
		provider,
		baseUrl,
		apiKeyEnv,
		// Omitted rather than empty when there is none, so "no other variable works"
		// and "this model never said" stay distinguishable.
		...(opts.apiKeyEnvFallbacks ? { apiKeyEnvFallbacks: opts.apiKeyEnvFallbacks } : {}),
		...(opts.toolReasoningEffort ? { toolReasoningEffort: opts.toolReasoningEffort } : {}),
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
 * Every row was checked against the vendor's own page, last swept on 2026-09-27 —
 * a date on this line means "as of", not "covers every row below it". Rows added
 * between sweeps name a later date in their own comment: `claude-opus-5-5`
 * (2026-09-23); `gpt-6-sol` / `gpt-6-luna`, `glm-5.3-flashx` and the five
 * MiniMax rows (2026-09-27). The 09-27 sweep changed prices on no existing row;
 * it added those eight and re-confirmed the rest, including the DeepSeek v4-pro
 * and Kimi K2.6 rows that third-party aggregators were reporting as changed.
 * Anthropic's
 * and DeepSeek's are the vendors' USD figures; the cache channel is derived by
 * the documented multipliers rather than copied, because a hand-copied third
 * number is where a table like this goes stale first (Sonnet 5 is $2/$10 — the
 * increase to $3/$15 that was scheduled for 2026-09-01 was cancelled).
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
 * is 1.5x on top, so its row carries the standard rate at 512k or under.
 *
 * When a price matters — a proxy, a negotiated rate, a newer model — declare it
 * in `pricing` in settings.json, which overrides this table.
 */
const BUILT_IN_MODELS: Model[] = [
	// Anthropic. Every model from the 4.6 generation on carries the full 1M-token
	// window at standard pricing, so there is no long-context premium to model.
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
		// One of the two models whose thinking blocks are checked against the
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
		// The other. Mythos 5.1 records the same signatures but runs no such check,
		// so it is deliberately not flagged.
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
