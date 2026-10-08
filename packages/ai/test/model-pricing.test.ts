/**
 * Prices on the model catalog.
 *
 * A catalog entry without a price is not a neutral omission: cost tracking
 * looks the price up and silently reports zero, so an unpriced model reads as a
 * free one. The Anthropic numbers are held to the published table; the
 * overridable path is held to precedence, because the point of declaring a price
 * is that it wins.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	clearCustomModels,
	clearPricingOverrides,
	gatewayProvidersFor,
	listModels,
	registerOpenAICompatibleProvider,
	resolveModel,
	setPricingOverride,
} from "../src/model.ts";

afterEach(() => {
	clearCustomModels();
	clearPricingOverrides();
});

/**
 * `<PROVIDER>_BASE_URL` redirects a model at resolve time, so a developer who runs
 * the app through a gateway has the whole catalog answering somewhere else. The
 * host test below reads resolved models, so every one of these is borrowed for
 * the duration — this file otherwise asserts the shipped table, and inheriting
 * the machine's configuration would make a developer's proxy a test failure. All
 * eleven, not just the one that happened to be set: the point is that no machine
 * can change the answer.
 *
 * The `finally` is the whole restore path, and deliberately not an `afterEach`
 * alongside the two lines above: `restoreEnv` only puts back what this function
 * borrowed, and this function always empties the map, so a hook calling it would
 * run against an empty map every time — a second mechanism that can only ever be
 * a no-op, which is one more thing to believe is load-bearing.
 */
const BASE_URL_VARS = [
	"ANTHROPIC_BASE_URL",
	"DEEPSEEK_BASE_URL",
	"KIMI_BASE_URL",
	"GLM_BASE_URL",
	"OPENAI_BASE_URL",
	"GOOGLE_BASE_URL",
	"MINIMAX_BASE_URL",
	"OPENCODE_ZEN_BASE_URL",
	"OPENCODE_GO_BASE_URL",
	"OPENCODE_ZEN_OAI_BASE_URL",
	"OPENCODE_GO_OAI_BASE_URL",
];
const savedEnv = new Map<string, string | undefined>();

function restoreEnv(): void {
	for (const [name, original] of savedEnv) {
		if (original === undefined) delete process.env[name];
		else process.env[name] = original;
	}
	savedEnv.clear();
}

function withoutBaseUrlOverrides<T>(body: () => T): T {
	for (const name of BASE_URL_VARS) {
		if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
		delete process.env[name];
	}
	try {
		return body();
	} finally {
		restoreEnv();
	}
}

/** The catalog as shipped. Named rather than read off `listModels()`, which also
 * carries whatever custom providers other test files registered. */
const BUILT_IN_REFS = [
	"anthropic/claude-opus-5-5",
	"anthropic/claude-fable-5-1",
	"anthropic/claude-mythos-5-1",
	"anthropic/claude-fable-5",
	"anthropic/claude-mythos-5",
	"anthropic/claude-opus-5",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-4-7",
	"anthropic/claude-opus-4-6",
	"anthropic/claude-sonnet-5-5",
	"anthropic/claude-sonnet-5",
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-haiku-5-5",
	"anthropic/claude-haiku-4-5",
	"deepseek/deepseek-flash",
	"deepseek/deepseek-v4-pro",
	"kimi/kimi-k3",
	"kimi/kimi-k2.7-code",
	"kimi/kimi-k2.7-code-highspeed",
	"kimi/kimi-k2.6",
	"glm/glm-5.3",
	"glm/glm-5.3-flash",
	"glm/glm-5.3-flashx",
	"glm/glm-4.7",
	"glm/glm-4.7-flashx",
	"glm/glm-4.6",
	"openai/gpt-6.1-sol",
	"openai/gpt-6-astra",
	"openai/gpt-6-sol",
	"openai/gpt-6-luna",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"google/gemini-3.8-flash",
	"google/gemini-3.1-pro-preview",
	"minimax/minimax-m3",
	"minimax/minimax-m2.7",
	"minimax/minimax-m2.7-highspeed",
	"minimax/minimax-m2.5",
	"minimax/minimax-m2.5-highspeed",
	// The gateway: 85 Zen rows and 33 Go rows, each on both wires — 236 references,
	// in the order `BUILT_IN_MODELS` materializes them. The two plans are separate
	// transcriptions and neither was ever filled in from the other, which the
	// pairs below show: `deepseek-v4-pro` is 1.74/3.84 on Zen and 0.66/1.98 on Go,
	// and `grok-4.7` runs the other way at 1.4/4.2 against 2/6. Swept 2026-09-28
	// from models.dev, filtered against the gateway's own model listing, plus
	// `claude-sonnet-5-5` added 2026-09-29 on a re-check of both halves,
	// `gpt-6.1-sol` on 2026-09-30 the same way — Zen's listing serves it and
	// models.dev prices it, Go sells no `gpt-6.1-*` id at all — and
	// `claude-haiku-5-5` on 2026-10-08, Zen-only again: the Go listing carries no
	// Claude id at all — and nine rows on the same day's full re-check of both
	// halves: Zen's `mistral-large-4`, `exo-free`, `fledge-alpha-free`,
	// `ling-3.1-flash-free` and `muse-spark-1.2-contributor-free`, Go's `grok-4.5`,
	// `kimi-k2.6`, `qwen3.6-plus` and `qwen3.7-max`. The re-check also took two ids
	// off the unpriced list — `deepseek-v4-flash-free` and `mimo-v2.5-free` were
	// named there and Zen's listing no longer serves either.
	"opencode-zen/big-pickle",
	"opencode-zen/claude-fable-5",
	"opencode-zen/claude-fable-5-1",
	"opencode-zen/claude-haiku-4-5",
	"opencode-zen/claude-haiku-5-5",
	"opencode-zen/claude-opus-4-5",
	"opencode-zen/claude-opus-4-6",
	"opencode-zen/claude-opus-4-7",
	"opencode-zen/claude-opus-4-8",
	"opencode-zen/claude-opus-5",
	"opencode-zen/claude-opus-5-5",
	"opencode-zen/claude-sonnet-4",
	"opencode-zen/claude-sonnet-4-5",
	"opencode-zen/claude-sonnet-4-6",
	"opencode-zen/claude-sonnet-5",
	"opencode-zen/claude-sonnet-5-5",
	"opencode-zen/deepseek-v4-flash",
	"opencode-zen/deepseek-v4-flash-vision-exp",
	"opencode-zen/deepseek-v4-pro",
	"opencode-zen/deepseek-v4.1-flash",
	"opencode-zen/exo-free",
	"opencode-zen/fledge-alpha-free",
	"opencode-zen/gemini-3-flash",
	"opencode-zen/gemini-3.1-pro",
	"opencode-zen/gemini-3.5-flash",
	"opencode-zen/gemini-3.5-flash-lite",
	"opencode-zen/gemini-3.6-flash",
	"opencode-zen/gemini-3.7-flash",
	"opencode-zen/gemini-3.8-flash",
	"opencode-zen/glm-5",
	"opencode-zen/glm-5.1",
	"opencode-zen/glm-5.2",
	"opencode-zen/glm-5.3",
	"opencode-zen/glm-5.3-flash",
	"opencode-zen/gpt-5",
	"opencode-zen/gpt-5-codex",
	"opencode-zen/gpt-5-nano",
	"opencode-zen/gpt-5.1",
	"opencode-zen/gpt-5.1-codex",
	"opencode-zen/gpt-5.1-codex-max",
	"opencode-zen/gpt-5.1-codex-mini",
	"opencode-zen/gpt-5.2",
	"opencode-zen/gpt-5.2-codex",
	"opencode-zen/gpt-5.3-codex",
	"opencode-zen/gpt-5.3-codex-spark",
	"opencode-zen/gpt-5.4",
	"opencode-zen/gpt-5.4-mini",
	"opencode-zen/gpt-5.4-nano",
	"opencode-zen/gpt-5.4-pro",
	"opencode-zen/gpt-5.5",
	"opencode-zen/gpt-5.5-pro",
	"opencode-zen/gpt-5.6-luna",
	"opencode-zen/gpt-5.6-sol",
	"opencode-zen/gpt-5.6-terra",
	"opencode-zen/gpt-6-astra",
	"opencode-zen/gpt-6-luna",
	"opencode-zen/gpt-6-sol",
	"opencode-zen/gpt-6.1-sol",
	"opencode-zen/grok-4.5",
	"opencode-zen/grok-4.6",
	"opencode-zen/grok-4.7",
	"opencode-zen/grok-build-0.1",
	"opencode-zen/kimi-k2.5",
	"opencode-zen/kimi-k2.6",
	"opencode-zen/kimi-k2.7-code",
	"opencode-zen/kimi-k3",
	"opencode-zen/ling-3.0-flash-fin-free",
	"opencode-zen/ling-3.1-flash-free",
	"opencode-zen/longcat-2.5-preview-free",
	"opencode-zen/mimo-v2.6-flash-free",
	"opencode-zen/minimax-m2.5",
	"opencode-zen/minimax-m2.7",
	"opencode-zen/minimax-m3",
	"opencode-zen/mistral-large-4",
	"opencode-zen/muse-spark-1.2",
	"opencode-zen/muse-spark-1.2-contributor-free",
	"opencode-zen/muse-spark-1.3",
	"opencode-zen/muse-spark-1.3-contributor-free",
	"opencode-zen/nemotron-3-ultra-free",
	"opencode-zen/nemotron-3.5-lightning-free",
	"opencode-zen/qwen3.5-plus",
	"opencode-zen/qwen3.6-plus",
	"opencode-zen/qwen3.8-flash",
	"opencode-zen/qwen3.8-max",
	"opencode-zen/space-bunny-free",
	"opencode-go/deepseek-v4-flash",
	"opencode-go/deepseek-v4-flash-vision-exp",
	"opencode-go/deepseek-v4-pro",
	"opencode-go/deepseek-v4.1-flash",
	"opencode-go/glm-5.2",
	"opencode-go/glm-5.3",
	"opencode-go/glm-5.3-flash",
	"opencode-go/gpt-5.6-luna",
	"opencode-go/gpt-6-luna",
	"opencode-go/grok-4.5",
	"opencode-go/grok-4.6",
	"opencode-go/grok-4.7",
	"opencode-go/hy3",
	"opencode-go/hy4-preview",
	"opencode-go/kimi-k2.6",
	"opencode-go/kimi-k2.7-code",
	"opencode-go/kimi-k3",
	"opencode-go/longcat-2.0",
	"opencode-go/longcat-2.5-preview-free",
	"opencode-go/mimo-v2.5",
	"opencode-go/mimo-v2.5-pro",
	"opencode-go/mimo-v2.6-flash",
	"opencode-go/mimo-v2.6-pro",
	"opencode-go/minimax-m2.7",
	"opencode-go/minimax-m3",
	"opencode-go/muse-spark-1.2-contributor",
	"opencode-go/muse-spark-1.3-contributor",
	"opencode-go/qwen3.6-plus",
	"opencode-go/qwen3.7-max",
	"opencode-go/qwen3.7-plus",
	"opencode-go/qwen3.8-flash",
	"opencode-go/qwen3.8-max",
	"opencode-go/space-bunny",
	"opencode-zen-oai/big-pickle",
	"opencode-zen-oai/claude-fable-5",
	"opencode-zen-oai/claude-fable-5-1",
	"opencode-zen-oai/claude-haiku-4-5",
	"opencode-zen-oai/claude-haiku-5-5",
	"opencode-zen-oai/claude-opus-4-5",
	"opencode-zen-oai/claude-opus-4-6",
	"opencode-zen-oai/claude-opus-4-7",
	"opencode-zen-oai/claude-opus-4-8",
	"opencode-zen-oai/claude-opus-5",
	"opencode-zen-oai/claude-opus-5-5",
	"opencode-zen-oai/claude-sonnet-4",
	"opencode-zen-oai/claude-sonnet-4-5",
	"opencode-zen-oai/claude-sonnet-4-6",
	"opencode-zen-oai/claude-sonnet-5",
	"opencode-zen-oai/claude-sonnet-5-5",
	"opencode-zen-oai/deepseek-v4-flash",
	"opencode-zen-oai/deepseek-v4-flash-vision-exp",
	"opencode-zen-oai/deepseek-v4-pro",
	"opencode-zen-oai/deepseek-v4.1-flash",
	"opencode-zen-oai/exo-free",
	"opencode-zen-oai/fledge-alpha-free",
	"opencode-zen-oai/gemini-3-flash",
	"opencode-zen-oai/gemini-3.1-pro",
	"opencode-zen-oai/gemini-3.5-flash",
	"opencode-zen-oai/gemini-3.5-flash-lite",
	"opencode-zen-oai/gemini-3.6-flash",
	"opencode-zen-oai/gemini-3.7-flash",
	"opencode-zen-oai/gemini-3.8-flash",
	"opencode-zen-oai/glm-5",
	"opencode-zen-oai/glm-5.1",
	"opencode-zen-oai/glm-5.2",
	"opencode-zen-oai/glm-5.3",
	"opencode-zen-oai/glm-5.3-flash",
	"opencode-zen-oai/gpt-5",
	"opencode-zen-oai/gpt-5-codex",
	"opencode-zen-oai/gpt-5-nano",
	"opencode-zen-oai/gpt-5.1",
	"opencode-zen-oai/gpt-5.1-codex",
	"opencode-zen-oai/gpt-5.1-codex-max",
	"opencode-zen-oai/gpt-5.1-codex-mini",
	"opencode-zen-oai/gpt-5.2",
	"opencode-zen-oai/gpt-5.2-codex",
	"opencode-zen-oai/gpt-5.3-codex",
	"opencode-zen-oai/gpt-5.3-codex-spark",
	"opencode-zen-oai/gpt-5.4",
	"opencode-zen-oai/gpt-5.4-mini",
	"opencode-zen-oai/gpt-5.4-nano",
	"opencode-zen-oai/gpt-5.4-pro",
	"opencode-zen-oai/gpt-5.5",
	"opencode-zen-oai/gpt-5.5-pro",
	"opencode-zen-oai/gpt-5.6-luna",
	"opencode-zen-oai/gpt-5.6-sol",
	"opencode-zen-oai/gpt-5.6-terra",
	"opencode-zen-oai/gpt-6-astra",
	"opencode-zen-oai/gpt-6-luna",
	"opencode-zen-oai/gpt-6-sol",
	"opencode-zen-oai/gpt-6.1-sol",
	"opencode-zen-oai/grok-4.5",
	"opencode-zen-oai/grok-4.6",
	"opencode-zen-oai/grok-4.7",
	"opencode-zen-oai/grok-build-0.1",
	"opencode-zen-oai/kimi-k2.5",
	"opencode-zen-oai/kimi-k2.6",
	"opencode-zen-oai/kimi-k2.7-code",
	"opencode-zen-oai/kimi-k3",
	"opencode-zen-oai/ling-3.0-flash-fin-free",
	"opencode-zen-oai/ling-3.1-flash-free",
	"opencode-zen-oai/longcat-2.5-preview-free",
	"opencode-zen-oai/mimo-v2.6-flash-free",
	"opencode-zen-oai/minimax-m2.5",
	"opencode-zen-oai/minimax-m2.7",
	"opencode-zen-oai/minimax-m3",
	"opencode-zen-oai/mistral-large-4",
	"opencode-zen-oai/muse-spark-1.2",
	"opencode-zen-oai/muse-spark-1.2-contributor-free",
	"opencode-zen-oai/muse-spark-1.3",
	"opencode-zen-oai/muse-spark-1.3-contributor-free",
	"opencode-zen-oai/nemotron-3-ultra-free",
	"opencode-zen-oai/nemotron-3.5-lightning-free",
	"opencode-zen-oai/qwen3.5-plus",
	"opencode-zen-oai/qwen3.6-plus",
	"opencode-zen-oai/qwen3.8-flash",
	"opencode-zen-oai/qwen3.8-max",
	"opencode-zen-oai/space-bunny-free",
	"opencode-go-oai/deepseek-v4-flash",
	"opencode-go-oai/deepseek-v4-flash-vision-exp",
	"opencode-go-oai/deepseek-v4-pro",
	"opencode-go-oai/deepseek-v4.1-flash",
	"opencode-go-oai/glm-5.2",
	"opencode-go-oai/glm-5.3",
	"opencode-go-oai/glm-5.3-flash",
	"opencode-go-oai/gpt-5.6-luna",
	"opencode-go-oai/gpt-6-luna",
	"opencode-go-oai/grok-4.5",
	"opencode-go-oai/grok-4.6",
	"opencode-go-oai/grok-4.7",
	"opencode-go-oai/hy3",
	"opencode-go-oai/hy4-preview",
	"opencode-go-oai/kimi-k2.6",
	"opencode-go-oai/kimi-k2.7-code",
	"opencode-go-oai/kimi-k3",
	"opencode-go-oai/longcat-2.0",
	"opencode-go-oai/longcat-2.5-preview-free",
	"opencode-go-oai/mimo-v2.5",
	"opencode-go-oai/mimo-v2.5-pro",
	"opencode-go-oai/mimo-v2.6-flash",
	"opencode-go-oai/mimo-v2.6-pro",
	"opencode-go-oai/minimax-m2.7",
	"opencode-go-oai/minimax-m3",
	"opencode-go-oai/muse-spark-1.2-contributor",
	"opencode-go-oai/muse-spark-1.3-contributor",
	"opencode-go-oai/qwen3.6-plus",
	"opencode-go-oai/qwen3.7-max",
	"opencode-go-oai/qwen3.7-plus",
	"opencode-go-oai/qwen3.8-flash",
	"opencode-go-oai/qwen3.8-max",
	"opencode-go-oai/space-bunny",
];

/**
 * The four providers that are a gateway rather than a vendor, named once because
 * four separate tests now have to carve them out. Resolved through `resolveModel`
 * and not by splitting the reference: a retired id under a bare reference resolves
 * to its replacement at some *first-party* provider, so `startsWith` would put
 * `deepseek-v4-flash` in the reseller set and quietly exempt the first-party rows
 * the carve-out exists to keep in scope.
 */
const RESELLER_PROVIDERS = new Set(["opencode-zen", "opencode-go", "opencode-zen-oai", "opencode-go-oai"]);

function isReseller(ref: string): boolean {
	return RESELLER_PROVIDERS.has(resolveModel(ref)?.provider ?? "");
}

/** A row whose output budget is its whole window, whatever that means for it. */
function isWholeWindowOutput(ref: string): boolean {
	const model = resolveModel(ref);
	return model?.maxOutputTokens === model?.contextWindow;
}

describe("the built-in catalog", () => {
	test("every model carries a price", () => {
		// An unpriced catalog entry reads as a free model: the cost tracker looks
		// the price up, finds nothing, and adds zero to a total nobody questions.
		const unpriced = BUILT_IN_REFS.filter((ref) => !resolveModel(ref)?.pricing);
		expect(unpriced).toEqual([]);
	});

	test("Anthropic prices are the published list rates", () => {
		// Opus 5.5 is the third cache-read regime and the reason the multiplier is
		// a parameter: this one reads at 0.05x, between the 0.025x pair below and
		// the tenth everywhere else. Its write rate is the standard 1.25x input.
		expect(resolveModel("anthropic/claude-opus-5-5")?.pricing).toEqual({
			input: 4,
			output: 20,
			cacheRead: 0.2,
			cacheWrite: 5,
		});
		// Fable 5.1 is the current Fable, and one of the two models in the catalog
		// whose cache reads are billed at 0.025x input rather than 0.1x.
		expect(resolveModel("anthropic/claude-fable-5-1")?.pricing).toEqual({
			input: 10,
			output: 50,
			cacheRead: 0.25,
			cacheWrite: 12.5,
		});
		// Mythos 5.1 is the other, and Mythos 5 is not: the 0.025x rate followed the
		// ".1" releases, so the pair is where a copy-paste error would hide.
		expect(resolveModel("anthropic/claude-mythos-5-1")?.pricing).toEqual({
			input: 10,
			output: 50,
			cacheRead: 0.25,
			cacheWrite: 12.5,
		});
		expect(resolveModel("anthropic/claude-mythos-5")?.pricing).toEqual({
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 12.5,
		});
		// Fable 5 is legacy — still served, still on the standard read multiplier.
		expect(resolveModel("anthropic/claude-fable-5")?.pricing).toEqual({
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 12.5,
		});
		expect(resolveModel("anthropic/claude-opus-5")?.pricing).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		// The 4.6 generation: Opus held its price, Sonnet did not.
		expect(resolveModel("anthropic/claude-opus-4-8")?.pricing).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(resolveModel("anthropic/claude-sonnet-4-6")?.pricing).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		});
		// Sonnet 5.5 launched at the same four figures as the row below it, and the
		// vendor page, models.dev's `anthropic` entry and its Zen-plan entry all
		// agree — so the cache channel here is the standard tenth and the 1.25x,
		// which is what the row's `anthropicPricing(2, 10)` spells out.
		expect(resolveModel("anthropic/claude-sonnet-5-5")?.pricing).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
		// $2/$10 is the standard price, not an introductory one: the increase to
		// $3/$15 that was scheduled for 2026-09-01 was cancelled.
		expect(resolveModel("anthropic/claude-sonnet-5")?.pricing).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
		// The one Anthropic row with two bands: Haiku 5.5 is billed by prompt
		// length, and these are the 100k-and-under figures. The vendor page,
		// models.dev's `anthropic` entry and its Zen-plan entry agree on all four
		// channels at both bands — models.dev spells the upper band as a `tiers`
		// entry — and the band above is $0.50/$2.50 with $0.05 reads and $0.625
		// writes.
		expect(resolveModel("anthropic/claude-haiku-5-5")?.pricing).toEqual({
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
		});
		expect(resolveModel("anthropic/claude-haiku-4-5")?.pricing).toEqual({
			input: 1,
			output: 5,
			cacheRead: 0.1,
			cacheWrite: 1.25,
		});
	});

	test("every Anthropic row states which thinking shape it takes", () => {
		// The one capability no row can inherit, because a wrong guess is a 400 on
		// the first request rather than a worse answer: from 4.7 on these models
		// refuse `enabled` + `budget_tokens` outright, and Haiku 4.5 is the reverse
		// — it refuses `adaptive`. The rows are listed rather than counted so that a
		// new model shows up here as a missing line instead of silently taking
		// whatever the adapter defaults to.
		const regimes = BUILT_IN_REFS.filter((ref) => ref.startsWith("anthropic/")).map((ref) => [
			ref,
			resolveModel(ref)?.thinkingMode,
		]);
		expect(regimes).toEqual([
			["anthropic/claude-opus-5-5", "adaptive"],
			["anthropic/claude-fable-5-1", "adaptive"],
			["anthropic/claude-mythos-5-1", "adaptive"],
			["anthropic/claude-fable-5", "adaptive"],
			["anthropic/claude-mythos-5", "adaptive"],
			["anthropic/claude-opus-5", "adaptive"],
			["anthropic/claude-opus-4-8", "adaptive"],
			["anthropic/claude-opus-4-7", "adaptive"],
			["anthropic/claude-opus-4-6", "adaptive"],
			["anthropic/claude-sonnet-5-5", "adaptive"],
			["anthropic/claude-sonnet-5", "adaptive"],
			["anthropic/claude-sonnet-4-6", "adaptive"],
			["anthropic/claude-haiku-5-5", "adaptive"],
			["anthropic/claude-haiku-4-5", "extended"],
		]);
	});

	test("the models that check thinking-block binding are named one by one", () => {
		// The parameter the adapter sends on their behalf is one the API rejects on
		// a model that runs no such check, so this flag is not a tier: Mythos 5.1
		// records the same signatures as Fable 5.1 and runs no check, and is
		// deliberately absent. Sonnet 5.5 joins the two that do run it — its own
		// release notes say the check is enforced by default on accounts created
		// from 2026-08-31, which is a different reason from "it is the newest".
		// Haiku 5.5 is the fourth, and read rather than inferred: the
		// preserved-thinking guide names it in the same sentence as the other
		// three, while its own migration guide states Haiku 4.5 does not run the
		// check — so the boundary between the two falls inside the family.
		const flagged = BUILT_IN_REFS.filter((ref) => resolveModel(ref)?.thinkingBlockBinding);
		expect(flagged).toEqual([
			"anthropic/claude-opus-5-5",
			"anthropic/claude-fable-5-1",
			"anthropic/claude-sonnet-5-5",
			"anthropic/claude-haiku-5-5",
		]);
	});

	test("the models that need an effort of their own when tools are on are named", () => {
		// `reasoning: true` sends "medium" and `false` sends nothing, and on these
		// two rows neither is right: their pages publish function calling as
		// available only at "none" while naming "medium" as the server default, so
		// both settings of the flag lose the tools. Naming the rows is the only way
		// a fourth OpenAI model arriving next month has to decide whether to join
		// them, rather than inheriting whatever the last one did.
		//
		// Astra is the control and the reason this is a row and not a provider: it
		// is the same price tier and the same 6-generation, and its page does not
		// carry the constraint — "none" is not one of its efforts at all.
		//
		// The three gateway rows below are the same two models reached through a
		// reseller, which is the point of the constraint being a row's: the host
		// changed and it travelled anyway. They are on the OpenAI wire only. The
		// field is read in exactly one place in this repo — the OpenAI
		// compatibility adapter — so on the Anthropic wire it would be a claim
		// about a path nothing executes, and the two providers below are the
		// negative assertion for that.
		const flagged = BUILT_IN_REFS.filter((ref) => resolveModel(ref)?.toolReasoningEffort);
		expect(flagged).toEqual([
			"openai/gpt-6-sol",
			"openai/gpt-6-luna",
			"opencode-zen-oai/gpt-6-luna",
			"opencode-zen-oai/gpt-6-sol",
			"opencode-go-oai/gpt-6-luna",
		]);
		expect(resolveModel("openai/gpt-6-sol")?.toolReasoningEffort).toBe("none");
		expect(resolveModel("openai/gpt-6-astra")?.toolReasoningEffort).toBeUndefined();
		expect(resolveModel("opencode-zen-oai/gpt-6-luna")?.toolReasoningEffort).toBe("none");
		// The third reason this is a row and not a family rule, and the one where
		// guessing is not a quiet failure. Astra is same-tier, same-generation and
		// simply has no `none` in its effort set; GPT-6.1 Sol is the case that
		// looks like it should copy Sol and must not. Its page supports
		// `low`/`medium`/`high`/`xhigh`/`max` and says outright that `none` and
		// `minimal` are not supported, and it moves tool calling to the Responses
		// API entirely. So there is no value here that both exists and works:
		// `none` is rejected rather than merely ignored, and every effort it does
		// take is one it applies on its own. Asserted by id as well as by the
		// list above because the list would stay green if a *new* row inherited
		// the field from somewhere the filter could not see.
		expect(resolveModel("openai/gpt-6.1-sol")?.toolReasoningEffort).toBeUndefined();
		expect(resolveModel("opencode-zen-oai/gpt-6.1-sol")?.toolReasoningEffort).toBeUndefined();
		expect(resolveModel("opencode-zen/gpt-6.1-sol")?.toolReasoningEffort).toBeUndefined();
		// The same two models, the same wire's other half, no field — and not a
		// row that was merely forgotten, since the id is identical.
		expect(resolveModel("opencode-zen/gpt-6-luna")?.toolReasoningEffort).toBeUndefined();
		expect(resolveModel("opencode-zen/gpt-6-sol")?.toolReasoningEffort).toBeUndefined();
		expect(resolveModel("opencode-go/gpt-6-luna")?.toolReasoningEffort).toBeUndefined();
		// They still claim the default for a request with no tools on it, which is
		// the one request where the flag is the whole story.
		expect(resolveModel("openai/gpt-6-luna")?.reasoning).toBe(true);
	});

	test("a cache read is a tenth of input, except on the models that say otherwise", () => {
		// The multiplier is the rule; if a rate changes the read rate has to move
		// with it, and a hand-typed table is exactly where that goes wrong.
		const offTheRule = new Map([
			["anthropic/claude-opus-5-5", 0.05],
			["anthropic/claude-fable-5-1", 0.025],
			["anthropic/claude-mythos-5-1", 0.025],
		]);
		for (const ref of BUILT_IN_REFS.filter((r) => r.startsWith("anthropic/"))) {
			const pricing = resolveModel(ref)?.pricing;
			expect(pricing?.cacheRead).toBeCloseTo((pricing?.input ?? 0) * (offTheRule.get(ref) ?? 0.1), 10);
			expect(pricing?.cacheWrite).toBeCloseTo((pricing?.input ?? 0) * 1.25, 10);
		}
		// Every exception has to be a real one, or it is a loophole in the loop.
		expect([...offTheRule.values()]).not.toContain(0.1);
	});

	test("GPT-6.1 Sol is half of GPT-6 Sol on one channel and identical on the rest", () => {
		// The relationship, not the four numbers: the table further down pins
		// those absolutely, and a copy of Sol's row with a different name would
		// sail straight past it. What is easy to get wrong is treating a point
		// release as a re-pricing of the whole row, and getting it wrong in the
		// direction that reads as a bargain. OpenAI halved exactly one channel —
		// the cache read, $0.20 to $0.10 — and left the other three alone. The
		// write is derived from input, so it cannot move on its own, which makes
		// input and output the only two that could have.
		const sol = resolveModel("openai/gpt-6-sol")?.pricing;
		const point = resolveModel("openai/gpt-6.1-sol")?.pricing;
		expect(sol?.input).toBe(point?.input);
		expect(sol?.output).toBe(point?.output);
		expect(sol?.cacheWrite).toBe(point?.cacheWrite);
		expect(point?.cacheRead).toBe((sol?.cacheRead ?? 0) / 2);
		// So the read rate is a twentieth of input where every other OpenAI row
		// in this catalog pays a tenth — the same "do not extrapolate from the
		// family" trap as Luna's output and FlashX's read, on a row whose two
		// neighbours both look like it.
		expect((point?.cacheRead ?? 0) / (point?.input ?? 0)).toBeCloseTo(0.05, 10);
		// The reseller carries the same figure because both wires read one
		// tuple, so this also fails if the row is ever transcribed twice.
		expect(resolveModel("opencode-zen/gpt-6.1-sol")?.pricing).toEqual(point);
		expect(resolveModel("opencode-zen-oai/gpt-6.1-sol")?.pricing).toEqual(point);
	});

	test("every other vendor's row costs what its page publishes", () => {
		// The Anthropic half is pinned above; these are pinned here, and the two
		// tests together are the only thing standing between this table and a typo.
		// Relative checks do not catch one: the write rate is derived from a row's
		// own input, so a doubled input price keeps every derived number consistent.
		//
		// Three rows read oddly and are meant to. DeepSeek bills peak and off-peak
		// since 2026-08-16 and these are the peak rates — a weekday session outside
		// 01:00-04:00 and 06:00-10:00 UTC paid half. Z.AI's zero write channel is a
		// promotion ("limited-time free"), not a permanent zero. Gemini's zero is
		// structural: it meters cache *storage* hourly, a charge this table cannot
		// express, so a Gemini row is a floor and the session may be billed more.
		expect(
			BUILT_IN_REFS.filter((ref) => !ref.startsWith("anthropic/")).map((ref) => {
				const pricing = resolveModel(ref)?.pricing;
				return [ref, pricing?.input, pricing?.output, pricing?.cacheRead, pricing?.cacheWrite];
			}),
		).toEqual([
			["deepseek/deepseek-flash", 0.3, 1.2, 0.006, 0],
			["deepseek/deepseek-v4-pro", 1.32, 3.96, 0.044, 0],
			["kimi/kimi-k3", 3, 15, 0.3, 3],
			["kimi/kimi-k2.7-code", 0.95, 4, 0.19, 0],
			["kimi/kimi-k2.7-code-highspeed", 1.9, 8, 0.38, 0],
			["kimi/kimi-k2.6", 0.95, 4, 0.16, 0],
			["glm/glm-5.3", 1.4, 4.4, 0.26, 0],
			["glm/glm-5.3-flash", 0.15, 0.5, 0.03, 0],
			// FlashX's cached rate is its own published figure, not a fifth of input
			// worked out here — it happens to land on 0.203x, and the two rows above
			// it sit at 0.2x and 0.186x, so a derived number would have been close
			// enough to pass review while billing a cached session at the wrong rate.
			["glm/glm-5.3-flashx", 0.37, 1.25, 0.075, 0],
			["glm/glm-4.7", 0.6, 2.2, 0.11, 0],
			["glm/glm-4.7-flashx", 0.07, 0.4, 0.01, 0],
			["glm/glm-4.6", 0.6, 2.2, 0.11, 0],
			// The current regime's rates: Flash doubles on 2027-01-01, and the Pro
			// row's figures are its ≤200k tier.
			["openai/gpt-6.1-sol", 2, 10, 0.1, 2.5],
			["openai/gpt-6-astra", 10, 50, 1, 12.5],
			// Sol is half of 5.6 Sol on all three channels. Luna is not: its output
			// comes down harder than its input ($1.20 → $0.50 against $0.20 → $0.10),
			// so "half the 5.6 Luna" is wrong in the channel that costs the most.
			["openai/gpt-6-sol", 2, 10, 0.2, 2.5],
			["openai/gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
			["openai/gpt-5.6-sol", 4, 20, 0.4, 5],
			["openai/gpt-5.6-terra", 2, 12, 0.2, 2.5],
			["openai/gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
			["google/gemini-3.8-flash", 0.75, 3.75, 0.075, 0],
			["google/gemini-3.1-pro-preview", 2, 12, 0.2, 0],
			// A fourth rate regime, and the only vendor here that states a cache
			// write: M3's row is a real zero because its table lists no write rate,
			// while every M2.x row states $0.375. M3's own figures are the standard
			// tier at 512k input or under, promoted to half the struck-through list.
			["minimax/minimax-m3", 0.3, 1.2, 0.06, 0],
			["minimax/minimax-m2.7", 0.3, 1.2, 0.06, 0.375],
			// The highspeed twins are not a like-for-like swap: input and output
			// double, the cached read does not.
			["minimax/minimax-m2.7-highspeed", 0.6, 2.4, 0.06, 0.375],
			["minimax/minimax-m2.5", 0.3, 1.2, 0.03, 0.375],
			["minimax/minimax-m2.5-highspeed", 0.6, 2.4, 0.03, 0.375],

			// The gateway, on the same terms and the same day. Thirty-four of these rows
			// state a cache-write rate and the rest state none, so nearly three quarters
			// of the table ends in 0 — which is the reading Gemini and MiniMax M3 already
			// take, not a claim that writing the cache is free everywhere on the gateway.
			// Nothing here is derived: `qwen3.8-flash` reads at 0.107x input beside
			// `qwen3.8-max`'s exact 0.125x, so a multiplier would be wrong on one of
			// the two and would still read as plausible.
			["opencode-zen/big-pickle", 0, 0, 0, 0],
			["opencode-zen/claude-fable-5", 10, 50, 1, 12.5],
			["opencode-zen/claude-fable-5-1", 10, 50, 0.25, 12.5],
			["opencode-zen/claude-haiku-4-5", 1, 5, 0.1, 1.25],
			["opencode-zen/claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125],
			["opencode-zen/claude-opus-4-5", 5, 25, 0.5, 6.25],
			["opencode-zen/claude-opus-4-6", 5, 25, 0.5, 6.25],
			["opencode-zen/claude-opus-4-7", 5, 25, 0.5, 6.25],
			["opencode-zen/claude-opus-4-8", 5, 25, 0.5, 6.25],
			["opencode-zen/claude-opus-5", 5, 25, 0.5, 6.25],
			["opencode-zen/claude-opus-5-5", 4, 20, 0.2, 5],
			["opencode-zen/claude-sonnet-4", 3, 15, 0.3, 3.75],
			["opencode-zen/claude-sonnet-4-5", 3, 15, 0.3, 3.75],
			["opencode-zen/claude-sonnet-4-6", 3, 15, 0.3, 3.75],
			["opencode-zen/claude-sonnet-5", 2, 10, 0.2, 2.5],
			["opencode-zen/claude-sonnet-5-5", 2, 10, 0.2, 2.5],
			["opencode-zen/deepseek-v4-flash", 0.14, 0.28, 0.028, 0],
			["opencode-zen/deepseek-v4-flash-vision-exp", 0.14, 0.28, 0.028, 0],
			["opencode-zen/deepseek-v4-pro", 1.74, 3.84, 0.145, 0],
			["opencode-zen/deepseek-v4.1-flash", 0.3, 1.2, 0.006, 0],
			["opencode-zen/exo-free", 0, 0, 0, 0],
			["opencode-zen/fledge-alpha-free", 0, 0, 0, 0],
			["opencode-zen/gemini-3-flash", 0.5, 3, 0.05, 0],
			["opencode-zen/gemini-3.1-pro", 2, 12, 0.2, 0],
			["opencode-zen/gemini-3.5-flash", 1.5, 9, 0.15, 0],
			["opencode-zen/gemini-3.5-flash-lite", 0.3, 2.5, 0.03, 0],
			["opencode-zen/gemini-3.6-flash", 1.5, 7.5, 0.15, 0],
			["opencode-zen/gemini-3.7-flash", 1.5, 7.5, 0.15, 0],
			["opencode-zen/gemini-3.8-flash", 1.5, 7.5, 0.15, 0],
			["opencode-zen/glm-5", 1, 3.2, 0.2, 0],
			["opencode-zen/glm-5.1", 1.4, 4.4, 0.26, 0],
			["opencode-zen/glm-5.2", 1.4, 4.4, 0.26, 0],
			["opencode-zen/glm-5.3", 1.4, 4.4, 0.26, 0],
			["opencode-zen/glm-5.3-flash", 0.15, 0.5, 0.03, 0],
			["opencode-zen/gpt-5", 1.07, 8.5, 0.107, 0],
			["opencode-zen/gpt-5-codex", 1.07, 8.5, 0.107, 0],
			["opencode-zen/gpt-5-nano", 0.05, 0.4, 0.005, 0],
			["opencode-zen/gpt-5.1", 1.07, 8.5, 0.107, 0],
			["opencode-zen/gpt-5.1-codex", 1.07, 8.5, 0.107, 0],
			["opencode-zen/gpt-5.1-codex-max", 1.25, 10, 0.125, 0],
			["opencode-zen/gpt-5.1-codex-mini", 0.25, 2, 0.025, 0],
			["opencode-zen/gpt-5.2", 1.75, 14, 0.175, 0],
			["opencode-zen/gpt-5.2-codex", 1.75, 14, 0.175, 0],
			["opencode-zen/gpt-5.3-codex", 1.75, 14, 0.175, 0],
			["opencode-zen/gpt-5.3-codex-spark", 1.75, 14, 0.175, 0],
			["opencode-zen/gpt-5.4", 2.5, 15, 0.25, 0],
			["opencode-zen/gpt-5.4-mini", 0.75, 4.5, 0.075, 0],
			["opencode-zen/gpt-5.4-nano", 0.2, 1.25, 0.02, 0],
			["opencode-zen/gpt-5.4-pro", 30, 180, 30, 0],
			["opencode-zen/gpt-5.5", 5, 30, 0.5, 0],
			["opencode-zen/gpt-5.5-pro", 30, 180, 30, 0],
			["opencode-zen/gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
			["opencode-zen/gpt-5.6-sol", 4, 20, 0.4, 5],
			["opencode-zen/gpt-5.6-terra", 2.5, 15, 0.25, 3.125],
			["opencode-zen/gpt-6-astra", 10, 50, 1, 12.5],
			["opencode-zen/gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
			["opencode-zen/gpt-6-sol", 2, 10, 0.2, 2.5],
			["opencode-zen/gpt-6.1-sol", 2, 10, 0.1, 2.5],
			["opencode-zen/grok-4.5", 2, 6, 0.3, 0],
			["opencode-zen/grok-4.6", 2, 6, 0.5, 0],
			["opencode-zen/grok-4.7", 1.4, 4.2, 0.35, 0],
			["opencode-zen/grok-build-0.1", 1, 2, 0.2, 0],
			["opencode-zen/kimi-k2.5", 0.6, 3, 0.08, 0],
			["opencode-zen/kimi-k2.6", 0.95, 4, 0.16, 0],
			["opencode-zen/kimi-k2.7-code", 0.95, 4, 0.19, 0],
			["opencode-zen/kimi-k3", 3, 15, 0.3, 0],
			["opencode-zen/ling-3.0-flash-fin-free", 0, 0, 0, 0],
			["opencode-zen/ling-3.1-flash-free", 0, 0, 0, 0],
			["opencode-zen/longcat-2.5-preview-free", 0, 0, 0, 0],
			["opencode-zen/mimo-v2.6-flash-free", 0, 0, 0, 0],
			["opencode-zen/minimax-m2.5", 0.3, 1.2, 0.06, 0],
			["opencode-zen/minimax-m2.7", 0.3, 1.2, 0.06, 0],
			["opencode-zen/minimax-m3", 0.3, 1.2, 0.06, 0],
			["opencode-zen/mistral-large-4", 0.68, 2.09, 0.07, 0],
			["opencode-zen/muse-spark-1.2", 1.25, 4.25, 0.15, 0],
			["opencode-zen/muse-spark-1.2-contributor-free", 0, 0, 0, 0],
			["opencode-zen/muse-spark-1.3", 1.25, 4.25, 0.15, 0],
			["opencode-zen/muse-spark-1.3-contributor-free", 0, 0, 0, 0],
			["opencode-zen/nemotron-3-ultra-free", 0, 0, 0, 0],
			["opencode-zen/nemotron-3.5-lightning-free", 0, 0, 0, 0],
			["opencode-zen/qwen3.5-plus", 0.2, 1.2, 0.02, 0.25],
			["opencode-zen/qwen3.6-plus", 0.5, 3, 0.05, 0.625],
			["opencode-zen/qwen3.8-flash", 0.15, 0.47, 0.016, 0.2],
			["opencode-zen/qwen3.8-max", 2, 6, 0.25, 2.5],
			["opencode-zen/space-bunny-free", 0, 0, 0, 0],
			["opencode-go/deepseek-v4-flash", 0.15, 0.6, 0.003, 0],
			["opencode-go/deepseek-v4-flash-vision-exp", 0.15, 0.6, 0.003, 0],
			["opencode-go/deepseek-v4-pro", 0.66, 1.98, 0.022, 0],
			["opencode-go/deepseek-v4.1-flash", 0.15, 0.6, 0.003, 0],
			["opencode-go/glm-5.2", 1.4, 4.4, 0.26, 0],
			["opencode-go/glm-5.3", 1.4, 4.4, 0.26, 0],
			["opencode-go/glm-5.3-flash", 0.15, 0.5, 0.03, 0],
			["opencode-go/gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
			["opencode-go/gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
			["opencode-go/grok-4.5", 2, 6, 0.3, 0],
			["opencode-go/grok-4.6", 2, 6, 0.5, 0],
			["opencode-go/grok-4.7", 2, 6, 0.5, 0],
			["opencode-go/hy3", 0.14, 0.58, 0.035, 0],
			["opencode-go/hy4-preview", 0.834, 2.501, 0.042, 0],
			["opencode-go/kimi-k2.6", 0.95, 4, 0.16, 0],
			["opencode-go/kimi-k2.7-code", 0.95, 4, 0.19, 0],
			["opencode-go/kimi-k3", 3, 15, 0.3, 0],
			["opencode-go/longcat-2.0", 0.3, 1.2, 0.006, 0],
			["opencode-go/longcat-2.5-preview-free", 0, 0, 0, 0],
			["opencode-go/mimo-v2.5", 0.14, 0.28, 0.0028, 0],
			["opencode-go/mimo-v2.5-pro", 0.435, 0.87, 0.003625, 0],
			["opencode-go/mimo-v2.6-flash", 0.14, 0.28, 0.0028, 0],
			["opencode-go/mimo-v2.6-pro", 0.435, 0.87, 0.003625, 0],
			["opencode-go/minimax-m2.7", 0.3, 1.2, 0.06, 0.375],
			["opencode-go/minimax-m3", 0.3, 1.2, 0.06, 0],
			["opencode-go/muse-spark-1.2-contributor", 0.1, 0.2, 0.002, 0],
			["opencode-go/muse-spark-1.3-contributor", 0.1, 0.2, 0.002, 0],
			["opencode-go/qwen3.6-plus", 0.5, 3, 0.05, 0.625],
			["opencode-go/qwen3.7-max", 2.5, 7.5, 0.5, 3.125],
			["opencode-go/qwen3.7-plus", 0.4, 1.6, 0.04, 0.5],
			["opencode-go/qwen3.8-flash", 0.15, 0.47, 0.016, 0.2],
			["opencode-go/qwen3.8-max", 2, 6, 0.25, 2.5],
			["opencode-go/space-bunny", 0.15, 0.6, 0.03, 0],
			["opencode-zen-oai/big-pickle", 0, 0, 0, 0],
			["opencode-zen-oai/claude-fable-5", 10, 50, 1, 12.5],
			["opencode-zen-oai/claude-fable-5-1", 10, 50, 0.25, 12.5],
			["opencode-zen-oai/claude-haiku-4-5", 1, 5, 0.1, 1.25],
			["opencode-zen-oai/claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125],
			["opencode-zen-oai/claude-opus-4-5", 5, 25, 0.5, 6.25],
			["opencode-zen-oai/claude-opus-4-6", 5, 25, 0.5, 6.25],
			["opencode-zen-oai/claude-opus-4-7", 5, 25, 0.5, 6.25],
			["opencode-zen-oai/claude-opus-4-8", 5, 25, 0.5, 6.25],
			["opencode-zen-oai/claude-opus-5", 5, 25, 0.5, 6.25],
			["opencode-zen-oai/claude-opus-5-5", 4, 20, 0.2, 5],
			["opencode-zen-oai/claude-sonnet-4", 3, 15, 0.3, 3.75],
			["opencode-zen-oai/claude-sonnet-4-5", 3, 15, 0.3, 3.75],
			["opencode-zen-oai/claude-sonnet-4-6", 3, 15, 0.3, 3.75],
			["opencode-zen-oai/claude-sonnet-5", 2, 10, 0.2, 2.5],
			["opencode-zen-oai/claude-sonnet-5-5", 2, 10, 0.2, 2.5],
			["opencode-zen-oai/deepseek-v4-flash", 0.14, 0.28, 0.028, 0],
			["opencode-zen-oai/deepseek-v4-flash-vision-exp", 0.14, 0.28, 0.028, 0],
			["opencode-zen-oai/deepseek-v4-pro", 1.74, 3.84, 0.145, 0],
			["opencode-zen-oai/deepseek-v4.1-flash", 0.3, 1.2, 0.006, 0],
			["opencode-zen-oai/exo-free", 0, 0, 0, 0],
			["opencode-zen-oai/fledge-alpha-free", 0, 0, 0, 0],
			["opencode-zen-oai/gemini-3-flash", 0.5, 3, 0.05, 0],
			["opencode-zen-oai/gemini-3.1-pro", 2, 12, 0.2, 0],
			["opencode-zen-oai/gemini-3.5-flash", 1.5, 9, 0.15, 0],
			["opencode-zen-oai/gemini-3.5-flash-lite", 0.3, 2.5, 0.03, 0],
			["opencode-zen-oai/gemini-3.6-flash", 1.5, 7.5, 0.15, 0],
			["opencode-zen-oai/gemini-3.7-flash", 1.5, 7.5, 0.15, 0],
			["opencode-zen-oai/gemini-3.8-flash", 1.5, 7.5, 0.15, 0],
			["opencode-zen-oai/glm-5", 1, 3.2, 0.2, 0],
			["opencode-zen-oai/glm-5.1", 1.4, 4.4, 0.26, 0],
			["opencode-zen-oai/glm-5.2", 1.4, 4.4, 0.26, 0],
			["opencode-zen-oai/glm-5.3", 1.4, 4.4, 0.26, 0],
			["opencode-zen-oai/glm-5.3-flash", 0.15, 0.5, 0.03, 0],
			["opencode-zen-oai/gpt-5", 1.07, 8.5, 0.107, 0],
			["opencode-zen-oai/gpt-5-codex", 1.07, 8.5, 0.107, 0],
			["opencode-zen-oai/gpt-5-nano", 0.05, 0.4, 0.005, 0],
			["opencode-zen-oai/gpt-5.1", 1.07, 8.5, 0.107, 0],
			["opencode-zen-oai/gpt-5.1-codex", 1.07, 8.5, 0.107, 0],
			["opencode-zen-oai/gpt-5.1-codex-max", 1.25, 10, 0.125, 0],
			["opencode-zen-oai/gpt-5.1-codex-mini", 0.25, 2, 0.025, 0],
			["opencode-zen-oai/gpt-5.2", 1.75, 14, 0.175, 0],
			["opencode-zen-oai/gpt-5.2-codex", 1.75, 14, 0.175, 0],
			["opencode-zen-oai/gpt-5.3-codex", 1.75, 14, 0.175, 0],
			["opencode-zen-oai/gpt-5.3-codex-spark", 1.75, 14, 0.175, 0],
			["opencode-zen-oai/gpt-5.4", 2.5, 15, 0.25, 0],
			["opencode-zen-oai/gpt-5.4-mini", 0.75, 4.5, 0.075, 0],
			["opencode-zen-oai/gpt-5.4-nano", 0.2, 1.25, 0.02, 0],
			["opencode-zen-oai/gpt-5.4-pro", 30, 180, 30, 0],
			["opencode-zen-oai/gpt-5.5", 5, 30, 0.5, 0],
			["opencode-zen-oai/gpt-5.5-pro", 30, 180, 30, 0],
			["opencode-zen-oai/gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
			["opencode-zen-oai/gpt-5.6-sol", 4, 20, 0.4, 5],
			["opencode-zen-oai/gpt-5.6-terra", 2.5, 15, 0.25, 3.125],
			["opencode-zen-oai/gpt-6-astra", 10, 50, 1, 12.5],
			["opencode-zen-oai/gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
			["opencode-zen-oai/gpt-6-sol", 2, 10, 0.2, 2.5],
			["opencode-zen-oai/gpt-6.1-sol", 2, 10, 0.1, 2.5],
			["opencode-zen-oai/grok-4.5", 2, 6, 0.3, 0],
			["opencode-zen-oai/grok-4.6", 2, 6, 0.5, 0],
			["opencode-zen-oai/grok-4.7", 1.4, 4.2, 0.35, 0],
			["opencode-zen-oai/grok-build-0.1", 1, 2, 0.2, 0],
			["opencode-zen-oai/kimi-k2.5", 0.6, 3, 0.08, 0],
			["opencode-zen-oai/kimi-k2.6", 0.95, 4, 0.16, 0],
			["opencode-zen-oai/kimi-k2.7-code", 0.95, 4, 0.19, 0],
			["opencode-zen-oai/kimi-k3", 3, 15, 0.3, 0],
			["opencode-zen-oai/ling-3.0-flash-fin-free", 0, 0, 0, 0],
			["opencode-zen-oai/ling-3.1-flash-free", 0, 0, 0, 0],
			["opencode-zen-oai/longcat-2.5-preview-free", 0, 0, 0, 0],
			["opencode-zen-oai/mimo-v2.6-flash-free", 0, 0, 0, 0],
			["opencode-zen-oai/minimax-m2.5", 0.3, 1.2, 0.06, 0],
			["opencode-zen-oai/minimax-m2.7", 0.3, 1.2, 0.06, 0],
			["opencode-zen-oai/minimax-m3", 0.3, 1.2, 0.06, 0],
			["opencode-zen-oai/mistral-large-4", 0.68, 2.09, 0.07, 0],
			["opencode-zen-oai/muse-spark-1.2", 1.25, 4.25, 0.15, 0],
			["opencode-zen-oai/muse-spark-1.2-contributor-free", 0, 0, 0, 0],
			["opencode-zen-oai/muse-spark-1.3", 1.25, 4.25, 0.15, 0],
			["opencode-zen-oai/muse-spark-1.3-contributor-free", 0, 0, 0, 0],
			["opencode-zen-oai/nemotron-3-ultra-free", 0, 0, 0, 0],
			["opencode-zen-oai/nemotron-3.5-lightning-free", 0, 0, 0, 0],
			["opencode-zen-oai/qwen3.5-plus", 0.2, 1.2, 0.02, 0.25],
			["opencode-zen-oai/qwen3.6-plus", 0.5, 3, 0.05, 0.625],
			["opencode-zen-oai/qwen3.8-flash", 0.15, 0.47, 0.016, 0.2],
			["opencode-zen-oai/qwen3.8-max", 2, 6, 0.25, 2.5],
			["opencode-zen-oai/space-bunny-free", 0, 0, 0, 0],
			["opencode-go-oai/deepseek-v4-flash", 0.15, 0.6, 0.003, 0],
			["opencode-go-oai/deepseek-v4-flash-vision-exp", 0.15, 0.6, 0.003, 0],
			["opencode-go-oai/deepseek-v4-pro", 0.66, 1.98, 0.022, 0],
			["opencode-go-oai/deepseek-v4.1-flash", 0.15, 0.6, 0.003, 0],
			["opencode-go-oai/glm-5.2", 1.4, 4.4, 0.26, 0],
			["opencode-go-oai/glm-5.3", 1.4, 4.4, 0.26, 0],
			["opencode-go-oai/glm-5.3-flash", 0.15, 0.5, 0.03, 0],
			["opencode-go-oai/gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
			["opencode-go-oai/gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
			["opencode-go-oai/grok-4.5", 2, 6, 0.3, 0],
			["opencode-go-oai/grok-4.6", 2, 6, 0.5, 0],
			["opencode-go-oai/grok-4.7", 2, 6, 0.5, 0],
			["opencode-go-oai/hy3", 0.14, 0.58, 0.035, 0],
			["opencode-go-oai/hy4-preview", 0.834, 2.501, 0.042, 0],
			["opencode-go-oai/kimi-k2.6", 0.95, 4, 0.16, 0],
			["opencode-go-oai/kimi-k2.7-code", 0.95, 4, 0.19, 0],
			["opencode-go-oai/kimi-k3", 3, 15, 0.3, 0],
			["opencode-go-oai/longcat-2.0", 0.3, 1.2, 0.006, 0],
			["opencode-go-oai/longcat-2.5-preview-free", 0, 0, 0, 0],
			["opencode-go-oai/mimo-v2.5", 0.14, 0.28, 0.0028, 0],
			["opencode-go-oai/mimo-v2.5-pro", 0.435, 0.87, 0.003625, 0],
			["opencode-go-oai/mimo-v2.6-flash", 0.14, 0.28, 0.0028, 0],
			["opencode-go-oai/mimo-v2.6-pro", 0.435, 0.87, 0.003625, 0],
			["opencode-go-oai/minimax-m2.7", 0.3, 1.2, 0.06, 0.375],
			["opencode-go-oai/minimax-m3", 0.3, 1.2, 0.06, 0],
			["opencode-go-oai/muse-spark-1.2-contributor", 0.1, 0.2, 0.002, 0],
			["opencode-go-oai/muse-spark-1.3-contributor", 0.1, 0.2, 0.002, 0],
			["opencode-go-oai/qwen3.6-plus", 0.5, 3, 0.05, 0.625],
			["opencode-go-oai/qwen3.7-max", 2.5, 7.5, 0.5, 3.125],
			["opencode-go-oai/qwen3.7-plus", 0.4, 1.6, 0.04, 0.5],
			["opencode-go-oai/qwen3.8-flash", 0.15, 0.47, 0.016, 0.2],
			["opencode-go-oai/qwen3.8-max", 2, 6, 0.25, 2.5],
			["opencode-go-oai/space-bunny", 0.15, 0.6, 0.03, 0],
		]);
	});

	test("windows and output caps are the published ones", () => {
		// Not decoration: the compaction threshold is derived from the window, so a
		// 1M model declared as 200k compacts five times too early, and an output cap
		// below the published one stops an answer the model would have finished.
		expect(
			BUILT_IN_REFS.map((ref) => {
				const model = resolveModel(ref);
				return [ref, model?.contextWindow, model?.maxOutputTokens];
			}),
		).toEqual([
			["anthropic/claude-opus-5-5", 1_000_000, 128_000],
			["anthropic/claude-fable-5-1", 1_000_000, 128_000],
			["anthropic/claude-mythos-5-1", 1_000_000, 128_000],
			["anthropic/claude-fable-5", 1_000_000, 128_000],
			["anthropic/claude-mythos-5", 1_000_000, 128_000],
			["anthropic/claude-opus-5", 1_000_000, 128_000],
			["anthropic/claude-opus-4-8", 1_000_000, 128_000],
			["anthropic/claude-opus-4-7", 1_000_000, 128_000],
			["anthropic/claude-opus-4-6", 1_000_000, 128_000],
			["anthropic/claude-sonnet-5-5", 1_000_000, 128_000],
			["anthropic/claude-sonnet-5", 1_000_000, 128_000],
			["anthropic/claude-sonnet-4-6", 1_000_000, 128_000],
			["anthropic/claude-haiku-5-5", 1_000_000, 128_000],
			["anthropic/claude-haiku-4-5", 200_000, 64_000],
			["deepseek/deepseek-flash", 1_000_000, 384_000],
			["deepseek/deepseek-v4-pro", 1_000_000, 384_000],
			// K3's published default, not its 1M settable maximum.
			["kimi/kimi-k3", 1_048_576, 131_072],
			["kimi/kimi-k2.7-code", 262_144, 32_768],
			["kimi/kimi-k2.7-code-highspeed", 262_144, 32_768],
			["kimi/kimi-k2.6", 262_144, 32_768],
			["glm/glm-5.3", 1_000_000, 131_072],
			["glm/glm-5.3-flash", 1_000_000, 131_072],
			["glm/glm-5.3-flashx", 1_000_000, 131_072],
			["glm/glm-4.7", 200_000, 131_072],
			["glm/glm-4.7-flashx", 200_000, 131_072],
			["glm/glm-4.6", 200_000, 131_072],
			["openai/gpt-6.1-sol", 1_050_000, 128_000],
			["openai/gpt-6-astra", 1_050_000, 128_000],
			["openai/gpt-6-sol", 1_050_000, 128_000],
			["openai/gpt-6-luna", 1_050_000, 128_000],
			["openai/gpt-5.6-sol", 1_050_000, 128_000],
			["openai/gpt-5.6-terra", 1_050_000, 128_000],
			["openai/gpt-5.6-luna", 1_050_000, 128_000],
			["google/gemini-3.8-flash", 1_048_576, 65_536],
			["google/gemini-3.1-pro-preview", 1_048_576, 65_536],
			// MiniMax publishes a window per model and no output cap for any of
			// them, so the third column is the window itself rather than a
			// published limit. Both consumers clamp it (20k for the compaction
			// reserve, 64k for escalation), which is what makes a row that says
			// "not an output cap" safe to carry at all.
			["minimax/minimax-m3", 1_000_000, 1_000_000],
			["minimax/minimax-m2.7", 204_800, 204_800],
			["minimax/minimax-m2.7-highspeed", 204_800, 204_800],
			["minimax/minimax-m2.5", 204_800, 204_800],
			["minimax/minimax-m2.5-highspeed", 204_800, 204_800],

			// The gateway, swept 2026-09-28. These are the numbers the compaction threshold
			// is derived from, so they are transcribed rather than rounded:
			// `hy4-preview` on Go is 1,024,000 rather than 1M.
			["opencode-zen/big-pickle", 200_000, 32_000],
			["opencode-zen/claude-fable-5", 1_000_000, 128_000],
			["opencode-zen/claude-fable-5-1", 1_000_000, 128_000],
			["opencode-zen/claude-haiku-4-5", 200_000, 64_000],
			["opencode-zen/claude-haiku-5-5", 1_000_000, 128_000],
			["opencode-zen/claude-opus-4-5", 200_000, 64_000],
			["opencode-zen/claude-opus-4-6", 1_000_000, 128_000],
			["opencode-zen/claude-opus-4-7", 1_000_000, 128_000],
			["opencode-zen/claude-opus-4-8", 1_000_000, 128_000],
			["opencode-zen/claude-opus-5", 1_000_000, 128_000],
			["opencode-zen/claude-opus-5-5", 1_000_000, 128_000],
			["opencode-zen/claude-sonnet-4", 1_000_000, 64_000],
			["opencode-zen/claude-sonnet-4-5", 1_000_000, 64_000],
			["opencode-zen/claude-sonnet-4-6", 1_000_000, 64_000],
			["opencode-zen/claude-sonnet-5", 1_000_000, 128_000],
			["opencode-zen/claude-sonnet-5-5", 1_000_000, 128_000],
			["opencode-zen/deepseek-v4-flash", 1_000_000, 384_000],
			["opencode-zen/deepseek-v4-flash-vision-exp", 1_000_000, 384_000],
			["opencode-zen/deepseek-v4-pro", 1_000_000, 384_000],
			["opencode-zen/deepseek-v4.1-flash", 1_000_000, 384_000],
			["opencode-zen/exo-free", 1_048_576, 131_072],
			["opencode-zen/fledge-alpha-free", 1_048_576, 131_072],
			["opencode-zen/gemini-3-flash", 1_048_576, 65_536],
			["opencode-zen/gemini-3.1-pro", 1_048_576, 65_536],
			["opencode-zen/gemini-3.5-flash", 1_048_576, 65_536],
			["opencode-zen/gemini-3.5-flash-lite", 1_048_576, 65_536],
			["opencode-zen/gemini-3.6-flash", 1_048_576, 65_536],
			["opencode-zen/gemini-3.7-flash", 1_048_576, 65_536],
			["opencode-zen/gemini-3.8-flash", 1_048_576, 65_536],
			["opencode-zen/glm-5", 204_800, 131_072],
			["opencode-zen/glm-5.1", 204_800, 131_072],
			["opencode-zen/glm-5.2", 1_000_000, 131_072],
			["opencode-zen/glm-5.3", 1_000_000, 131_072],
			["opencode-zen/glm-5.3-flash", 1_000_000, 131_072],
			["opencode-zen/gpt-5", 400_000, 128_000],
			["opencode-zen/gpt-5-codex", 400_000, 128_000],
			["opencode-zen/gpt-5-nano", 400_000, 128_000],
			["opencode-zen/gpt-5.1", 400_000, 128_000],
			["opencode-zen/gpt-5.1-codex", 400_000, 128_000],
			["opencode-zen/gpt-5.1-codex-max", 400_000, 128_000],
			["opencode-zen/gpt-5.1-codex-mini", 400_000, 128_000],
			["opencode-zen/gpt-5.2", 400_000, 128_000],
			["opencode-zen/gpt-5.2-codex", 400_000, 128_000],
			["opencode-zen/gpt-5.3-codex", 400_000, 128_000],
			["opencode-zen/gpt-5.3-codex-spark", 128_000, 128_000],
			["opencode-zen/gpt-5.4", 1_050_000, 128_000],
			["opencode-zen/gpt-5.4-mini", 400_000, 128_000],
			["opencode-zen/gpt-5.4-nano", 400_000, 128_000],
			["opencode-zen/gpt-5.4-pro", 1_050_000, 128_000],
			["opencode-zen/gpt-5.5", 1_050_000, 128_000],
			["opencode-zen/gpt-5.5-pro", 1_050_000, 128_000],
			["opencode-zen/gpt-5.6-luna", 1_050_000, 128_000],
			["opencode-zen/gpt-5.6-sol", 1_050_000, 128_000],
			["opencode-zen/gpt-5.6-terra", 1_050_000, 128_000],
			["opencode-zen/gpt-6-astra", 1_050_000, 128_000],
			["opencode-zen/gpt-6-luna", 1_050_000, 128_000],
			["opencode-zen/gpt-6-sol", 1_050_000, 128_000],
			["opencode-zen/gpt-6.1-sol", 1_050_000, 128_000],
			["opencode-zen/grok-4.5", 500_000, 500_000],
			["opencode-zen/grok-4.6", 500_000, 500_000],
			["opencode-zen/grok-4.7", 500_000, 500_000],
			["opencode-zen/grok-build-0.1", 256_000, 256_000],
			["opencode-zen/kimi-k2.5", 262_144, 65_536],
			["opencode-zen/kimi-k2.6", 262_144, 65_536],
			["opencode-zen/kimi-k2.7-code", 262_144, 262_144],
			["opencode-zen/kimi-k3", 1_048_576, 131_072],
			["opencode-zen/ling-3.0-flash-fin-free", 262_144, 32_768],
			["opencode-zen/ling-3.1-flash-free", 262_144, 32_768],
			["opencode-zen/longcat-2.5-preview-free", 1_000_000, 131_072],
			["opencode-zen/mimo-v2.6-flash-free", 200_000, 32_000],
			["opencode-zen/minimax-m2.5", 204_800, 131_072],
			["opencode-zen/minimax-m2.7", 204_800, 131_072],
			["opencode-zen/minimax-m3", 512_000, 128_000],
			["opencode-zen/mistral-large-4", 524_288, 262_144],
			["opencode-zen/muse-spark-1.2", 1_048_576, 131_072],
			["opencode-zen/muse-spark-1.2-contributor-free", 1_048_576, 131_072],
			["opencode-zen/muse-spark-1.3", 1_048_576, 131_072],
			["opencode-zen/muse-spark-1.3-contributor-free", 1_048_576, 131_072],
			["opencode-zen/nemotron-3-ultra-free", 1_000_000, 128_000],
			["opencode-zen/nemotron-3.5-lightning-free", 262_144, 262_144],
			["opencode-zen/qwen3.5-plus", 262_144, 65_536],
			["opencode-zen/qwen3.6-plus", 262_144, 65_536],
			["opencode-zen/qwen3.8-flash", 1_000_000, 131_072],
			["opencode-zen/qwen3.8-max", 262_144, 131_072],
			["opencode-zen/space-bunny-free", 1_048_576, 524_288],
			["opencode-go/deepseek-v4-flash", 1_000_000, 384_000],
			["opencode-go/deepseek-v4-flash-vision-exp", 1_000_000, 384_000],
			["opencode-go/deepseek-v4-pro", 1_000_000, 384_000],
			["opencode-go/deepseek-v4.1-flash", 1_000_000, 384_000],
			["opencode-go/glm-5.2", 1_000_000, 131_072],
			["opencode-go/glm-5.3", 1_000_000, 131_072],
			["opencode-go/glm-5.3-flash", 1_000_000, 131_072],
			["opencode-go/gpt-5.6-luna", 1_050_000, 128_000],
			["opencode-go/gpt-6-luna", 1_050_000, 128_000],
			["opencode-go/grok-4.5", 500_000, 500_000],
			["opencode-go/grok-4.6", 500_000, 500_000],
			["opencode-go/grok-4.7", 500_000, 500_000],
			["opencode-go/hy3", 256_000, 128_000],
			["opencode-go/hy4-preview", 1_024_000, 64_000],
			["opencode-go/kimi-k2.6", 262_144, 65_536],
			["opencode-go/kimi-k2.7-code", 262_144, 262_144],
			["opencode-go/kimi-k3", 1_048_576, 131_072],
			["opencode-go/longcat-2.0", 1_000_000, 131_072],
			["opencode-go/longcat-2.5-preview-free", 1_000_000, 131_072],
			["opencode-go/mimo-v2.5", 1_000_000, 128_000],
			["opencode-go/mimo-v2.5-pro", 1_048_576, 128_000],
			["opencode-go/mimo-v2.6-flash", 1_048_576, 131_072],
			["opencode-go/mimo-v2.6-pro", 1_048_576, 131_072],
			["opencode-go/minimax-m2.7", 204_800, 131_072],
			["opencode-go/minimax-m3", 1_000_000, 131_072],
			["opencode-go/muse-spark-1.2-contributor", 1_048_576, 131_072],
			["opencode-go/muse-spark-1.3-contributor", 1_048_576, 131_072],
			["opencode-go/qwen3.6-plus", 1_000_000, 65_536],
			["opencode-go/qwen3.7-max", 1_000_000, 65_536],
			["opencode-go/qwen3.7-plus", 1_000_000, 65_536],
			["opencode-go/qwen3.8-flash", 1_000_000, 131_072],
			["opencode-go/qwen3.8-max", 1_000_000, 131_072],
			["opencode-go/space-bunny", 1_048_576, 524_288],
			["opencode-zen-oai/big-pickle", 200_000, 32_000],
			["opencode-zen-oai/claude-fable-5", 1_000_000, 128_000],
			["opencode-zen-oai/claude-fable-5-1", 1_000_000, 128_000],
			["opencode-zen-oai/claude-haiku-4-5", 200_000, 64_000],
			["opencode-zen-oai/claude-haiku-5-5", 1_000_000, 128_000],
			["opencode-zen-oai/claude-opus-4-5", 200_000, 64_000],
			["opencode-zen-oai/claude-opus-4-6", 1_000_000, 128_000],
			["opencode-zen-oai/claude-opus-4-7", 1_000_000, 128_000],
			["opencode-zen-oai/claude-opus-4-8", 1_000_000, 128_000],
			["opencode-zen-oai/claude-opus-5", 1_000_000, 128_000],
			["opencode-zen-oai/claude-opus-5-5", 1_000_000, 128_000],
			["opencode-zen-oai/claude-sonnet-4", 1_000_000, 64_000],
			["opencode-zen-oai/claude-sonnet-4-5", 1_000_000, 64_000],
			["opencode-zen-oai/claude-sonnet-4-6", 1_000_000, 64_000],
			["opencode-zen-oai/claude-sonnet-5", 1_000_000, 128_000],
			["opencode-zen-oai/claude-sonnet-5-5", 1_000_000, 128_000],
			["opencode-zen-oai/deepseek-v4-flash", 1_000_000, 384_000],
			["opencode-zen-oai/deepseek-v4-flash-vision-exp", 1_000_000, 384_000],
			["opencode-zen-oai/deepseek-v4-pro", 1_000_000, 384_000],
			["opencode-zen-oai/deepseek-v4.1-flash", 1_000_000, 384_000],
			["opencode-zen-oai/exo-free", 1_048_576, 131_072],
			["opencode-zen-oai/fledge-alpha-free", 1_048_576, 131_072],
			["opencode-zen-oai/gemini-3-flash", 1_048_576, 65_536],
			["opencode-zen-oai/gemini-3.1-pro", 1_048_576, 65_536],
			["opencode-zen-oai/gemini-3.5-flash", 1_048_576, 65_536],
			["opencode-zen-oai/gemini-3.5-flash-lite", 1_048_576, 65_536],
			["opencode-zen-oai/gemini-3.6-flash", 1_048_576, 65_536],
			["opencode-zen-oai/gemini-3.7-flash", 1_048_576, 65_536],
			["opencode-zen-oai/gemini-3.8-flash", 1_048_576, 65_536],
			["opencode-zen-oai/glm-5", 204_800, 131_072],
			["opencode-zen-oai/glm-5.1", 204_800, 131_072],
			["opencode-zen-oai/glm-5.2", 1_000_000, 131_072],
			["opencode-zen-oai/glm-5.3", 1_000_000, 131_072],
			["opencode-zen-oai/glm-5.3-flash", 1_000_000, 131_072],
			["opencode-zen-oai/gpt-5", 400_000, 128_000],
			["opencode-zen-oai/gpt-5-codex", 400_000, 128_000],
			["opencode-zen-oai/gpt-5-nano", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.1", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.1-codex", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.1-codex-max", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.1-codex-mini", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.2", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.2-codex", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.3-codex", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.3-codex-spark", 128_000, 128_000],
			["opencode-zen-oai/gpt-5.4", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-5.4-mini", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.4-nano", 400_000, 128_000],
			["opencode-zen-oai/gpt-5.4-pro", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-5.5", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-5.5-pro", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-5.6-luna", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-5.6-sol", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-5.6-terra", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-6-astra", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-6-luna", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-6-sol", 1_050_000, 128_000],
			["opencode-zen-oai/gpt-6.1-sol", 1_050_000, 128_000],
			["opencode-zen-oai/grok-4.5", 500_000, 500_000],
			["opencode-zen-oai/grok-4.6", 500_000, 500_000],
			["opencode-zen-oai/grok-4.7", 500_000, 500_000],
			["opencode-zen-oai/grok-build-0.1", 256_000, 256_000],
			["opencode-zen-oai/kimi-k2.5", 262_144, 65_536],
			["opencode-zen-oai/kimi-k2.6", 262_144, 65_536],
			["opencode-zen-oai/kimi-k2.7-code", 262_144, 262_144],
			["opencode-zen-oai/kimi-k3", 1_048_576, 131_072],
			["opencode-zen-oai/ling-3.0-flash-fin-free", 262_144, 32_768],
			["opencode-zen-oai/ling-3.1-flash-free", 262_144, 32_768],
			["opencode-zen-oai/longcat-2.5-preview-free", 1_000_000, 131_072],
			["opencode-zen-oai/mimo-v2.6-flash-free", 200_000, 32_000],
			["opencode-zen-oai/minimax-m2.5", 204_800, 131_072],
			["opencode-zen-oai/minimax-m2.7", 204_800, 131_072],
			["opencode-zen-oai/minimax-m3", 512_000, 128_000],
			["opencode-zen-oai/mistral-large-4", 524_288, 262_144],
			["opencode-zen-oai/muse-spark-1.2", 1_048_576, 131_072],
			["opencode-zen-oai/muse-spark-1.2-contributor-free", 1_048_576, 131_072],
			["opencode-zen-oai/muse-spark-1.3", 1_048_576, 131_072],
			["opencode-zen-oai/muse-spark-1.3-contributor-free", 1_048_576, 131_072],
			["opencode-zen-oai/nemotron-3-ultra-free", 1_000_000, 128_000],
			["opencode-zen-oai/nemotron-3.5-lightning-free", 262_144, 262_144],
			["opencode-zen-oai/qwen3.5-plus", 262_144, 65_536],
			["opencode-zen-oai/qwen3.6-plus", 262_144, 65_536],
			["opencode-zen-oai/qwen3.8-flash", 1_000_000, 131_072],
			["opencode-zen-oai/qwen3.8-max", 262_144, 131_072],
			["opencode-zen-oai/space-bunny-free", 1_048_576, 524_288],
			["opencode-go-oai/deepseek-v4-flash", 1_000_000, 384_000],
			["opencode-go-oai/deepseek-v4-flash-vision-exp", 1_000_000, 384_000],
			["opencode-go-oai/deepseek-v4-pro", 1_000_000, 384_000],
			["opencode-go-oai/deepseek-v4.1-flash", 1_000_000, 384_000],
			["opencode-go-oai/glm-5.2", 1_000_000, 131_072],
			["opencode-go-oai/glm-5.3", 1_000_000, 131_072],
			["opencode-go-oai/glm-5.3-flash", 1_000_000, 131_072],
			["opencode-go-oai/gpt-5.6-luna", 1_050_000, 128_000],
			["opencode-go-oai/gpt-6-luna", 1_050_000, 128_000],
			["opencode-go-oai/grok-4.5", 500_000, 500_000],
			["opencode-go-oai/grok-4.6", 500_000, 500_000],
			["opencode-go-oai/grok-4.7", 500_000, 500_000],
			["opencode-go-oai/hy3", 256_000, 128_000],
			["opencode-go-oai/hy4-preview", 1_024_000, 64_000],
			["opencode-go-oai/kimi-k2.6", 262_144, 65_536],
			["opencode-go-oai/kimi-k2.7-code", 262_144, 262_144],
			["opencode-go-oai/kimi-k3", 1_048_576, 131_072],
			["opencode-go-oai/longcat-2.0", 1_000_000, 131_072],
			["opencode-go-oai/longcat-2.5-preview-free", 1_000_000, 131_072],
			["opencode-go-oai/mimo-v2.5", 1_000_000, 128_000],
			["opencode-go-oai/mimo-v2.5-pro", 1_048_576, 128_000],
			["opencode-go-oai/mimo-v2.6-flash", 1_048_576, 131_072],
			["opencode-go-oai/mimo-v2.6-pro", 1_048_576, 131_072],
			["opencode-go-oai/minimax-m2.7", 204_800, 131_072],
			["opencode-go-oai/minimax-m3", 1_000_000, 131_072],
			["opencode-go-oai/muse-spark-1.2-contributor", 1_048_576, 131_072],
			["opencode-go-oai/muse-spark-1.3-contributor", 1_048_576, 131_072],
			["opencode-go-oai/qwen3.6-plus", 1_000_000, 65_536],
			["opencode-go-oai/qwen3.7-max", 1_000_000, 65_536],
			["opencode-go-oai/qwen3.7-plus", 1_000_000, 65_536],
			["opencode-go-oai/qwen3.8-flash", 1_000_000, 131_072],
			["opencode-go-oai/qwen3.8-max", 1_000_000, 131_072],
			["opencode-go-oai/space-bunny", 1_048_576, 524_288],
		]);
	});

	test("the models that always think do not claim a medium effort", () => {
		// `reasoning: true` makes the adapters ask for "medium" when the caller
		// states no level, which is only safe where "medium" is a value the vendor
		// takes. Every Anthropic row claims it and so do the seven OpenAI ones, the
		// two DeepSeek ones (medium maps to high) and Gemini 3.8 Flash. What is
		// listed here is the opposite decision, and it is the interesting one: K3's
		// effort set is low/high/max and GLM-5.3's is max/high/low, so asking either
		// for "medium" asks for a depth it has no word for.
		//
		// Gemini 3.1 Pro is here for a different reason: it thinks and cannot be
		// told not to, but its page states no effort values at all, so "medium" is
		// unconfirmed for it. Saying nothing leaves the model at its own default,
		// which is the same thing we would have asked for anyway.
		// Split in two, and the split is a partition rather than an exception: the
		// rows below are the ones whose vendor published an effort vocabulary, and
		// the resellers are the ones whose vendor published nothing about thinking
		// at all. Both are right to say "not medium", for reasons that have nothing
		// to do with each other, and the second group is 236 rows long — a third of
		// the catalog — which would bury the first. The gateway rows are held by
		// the assertion directly below, which is exhaustive over the same set.
		const alwaysThinking = BUILT_IN_REFS.filter((ref) => !resolveModel(ref)?.reasoning && !isReseller(ref));
		expect(alwaysThinking).toEqual([
			"kimi/kimi-k3",
			"kimi/kimi-k2.7-code",
			"kimi/kimi-k2.7-code-highspeed",
			"kimi/kimi-k2.6",
			"glm/glm-5.3",
			"glm/glm-5.3-flash",
			"glm/glm-5.3-flashx",
			"glm/glm-4.7",
			"glm/glm-4.7-flashx",
			"glm/glm-4.6",
			"google/gemini-3.1-pro-preview",
			// MiniMax: M3 states that its thinking is off unless a request asks,
			// which is what sending nothing gets, and the M2.x line documents no
			// effort control on the OpenAI wire at all. So every one of them is
			// right here by asking for nothing.
			"minimax/minimax-m3",
			"minimax/minimax-m2.7",
			"minimax/minimax-m2.7-highspeed",
			"minimax/minimax-m2.5",
			"minimax/minimax-m2.5-highspeed",
		]);
		// The other half of the partition, exhaustive over the same rows. Every
		// gateway row claims no thinking at all, and the reason is a model in the
		// list: Zen carries `claude-opus-5-5`, and on the Anthropic wire
		// `reasoning: true` sends `thinking: {type: "enabled", budget_tokens}` —
		// the shape Claude 4.6 and later answer with a 400. Nothing documents that
		// the gateway forwards `thinking: {type: "adaptive"}` either, so the
		// adaptive shape is no safer than the budget one and sending nothing is the
		// only request known to work. That costs real thinking depth on a Claude
		// model reached this way, which is the trade being made in writing.
		//
		// This is the claim that would be easiest to lose: `reasoning` defaults to
		// true inside `anthropicCompatModel`, so a row added to those tables
		// without the flag set is a 400 on its first request, and nothing else in
		// the suite would notice.
		const gateway = BUILT_IN_REFS.filter(isReseller);
		expect(gateway).toHaveLength(236);
		expect(gateway.filter((ref) => resolveModel(ref)?.reasoning)).toEqual([]);
		// And none of them claims a thinking shape either, for the same reason:
		// the shape is what the 400 is about.
		expect(gateway.filter((ref) => resolveModel(ref)?.thinkingMode)).toEqual([]);
	});

	test("every vendor is reached at the host its API actually lives on", () => {
		// A mistyped host fails every request for that vendor and nothing else:
		// no table above lists a URL, so before this one existed a wrong base was
		// invisible to the suite in a way a wrong price never is. One host per
		// provider rather than per row, so a vendor that moves gets one edit.
		withoutBaseUrlOverrides(() => {
			const host = (ref: string) => resolveModel(ref)?.baseUrl;
			expect([
				host("anthropic/claude-opus-5-5"),
				host("deepseek/deepseek-flash"),
				host("kimi/kimi-k3"),
				host("glm/glm-5.3"),
				host("openai/gpt-6-sol"),
				host("google/gemini-3.8-flash"),
				host("minimax/minimax-m3"),
				host("opencode-zen/claude-opus-5-5"),
				host("opencode-go/deepseek-v4-pro"),
				host("opencode-zen-oai/gpt-6-sol"),
				host("opencode-go-oai/kimi-k3"),
			]).toEqual([
				"https://api.anthropic.com",
				"https://api.deepseek.com/v1",
				// The international host, and the reason it is not the China one: the
				// two serve the same ids priced in CNY, and the keys are not
				// interchangeable.
				"https://api.moonshot.ai/v1",
				"https://api.z.ai/api/paas/v4",
				"https://api.openai.com/v1",
				"https://generativelanguage.googleapis.com/v1beta/openai/",
				"https://api.minimax.io/v1",
				// The gateway's four, and the pairs are not interchangeable: the
				// Anthropic client appends `/v1/messages` to whatever base it is
				// given, so the pair of rows above must arrive without a `/v1`; the
				// OpenAI client appends `/chat/completions`, which does need it. A
				// base with the wrong prefix is not a 404 on the models endpoint —
				// it is a 404 on every request, forever.
				"https://opencode.ai/zen",
				"https://opencode.ai/zen/go",
				"https://opencode.ai/zen/v1",
				"https://opencode.ai/zen/go/v1",
			]);
			// One host each, not one per row: a provider that serves several of the
			// rows above under different URLs is a shape this table does not have.
			const perProvider = new Map<string, Set<string>>();
			for (const ref of BUILT_IN_REFS) {
				const model = resolveModel(ref);
				if (!model) continue;
				if (!perProvider.has(model.provider)) perProvider.set(model.provider, new Set());
				perProvider.get(model.provider)?.add(model.baseUrl);
			}
			const split = [...perProvider].filter(([, urls]) => urls.size > 1).map(([p]) => p);
			expect(split).toEqual([]);
		});
	});

	test("a row that carries the window as its output budget says so mechanically", () => {
		// MiniMax publishes no per-model output limit and no default for one, so
		// these rows carry the window — the only bound the vendor states, that the
		// maximum token count is input plus output together. Asserting the equality
		// is what keeps the comment honest: a row that later gets a real published
		// cap breaks this, which is the point, because that is the day the two
		// numbers stop being the same claim.
		const minimax = BUILT_IN_REFS.filter((ref) => ref.startsWith("minimax/"));
		expect(minimax.length).toBeGreaterThan(0);
		for (const ref of minimax) {
			const model = resolveModel(ref);
			expect(model?.maxOutputTokens).toBe(model?.contextWindow);
		}
		// And no other first-party vendor is in that situation, so the rule stays a
		// fact about MiniMax rather than a description of the whole table.
		const others = BUILT_IN_REFS.filter((ref) => !ref.startsWith("minimax/") && !isReseller(ref)).filter(
			(ref) => resolveModel(ref)?.maxOutputTokens === resolveModel(ref)?.contextWindow,
		);
		expect(others).toEqual([]);
		// The resellers are the third case, and the one this test had to be widened
		// for: seven gateway ids carry a *published* output cap equal to the window
		// — `grok-4.5` at 500000/500000, `gpt-5.3-codex-spark` at 128000 all three
		// ways. That is not the MiniMax stand-in; it is a number somebody states.
		// The distinction cannot be derived from the row, so it is written down
		// instead, and naming the ids is what makes the list checkable: a model
		// appearing or disappearing here is the catalogue moving, and it breaks
		// this test on purpose.
		expect(BUILT_IN_REFS.filter((ref) => isReseller(ref)).filter(isWholeWindowOutput)).toEqual([
			"opencode-zen/gpt-5.3-codex-spark",
			"opencode-zen/grok-4.5",
			"opencode-zen/grok-4.6",
			"opencode-zen/grok-4.7",
			"opencode-zen/grok-build-0.1",
			"opencode-zen/kimi-k2.7-code",
			"opencode-zen/nemotron-3.5-lightning-free",
			"opencode-go/grok-4.5",
			"opencode-go/grok-4.6",
			"opencode-go/grok-4.7",
			"opencode-go/kimi-k2.7-code",
			"opencode-zen-oai/gpt-5.3-codex-spark",
			"opencode-zen-oai/grok-4.5",
			"opencode-zen-oai/grok-4.6",
			"opencode-zen-oai/grok-4.7",
			"opencode-zen-oai/grok-build-0.1",
			"opencode-zen-oai/kimi-k2.7-code",
			"opencode-zen-oai/nemotron-3.5-lightning-free",
			"opencode-go-oai/grok-4.5",
			"opencode-go-oai/grok-4.6",
			"opencode-go-oai/grok-4.7",
			"opencode-go-oai/kimi-k2.7-code",
		]);
	});

	test("a provider that does not bill cached input separately says so with a zero", () => {
		// Not "unknown": these APIs charge a cache write as ordinary input, so the
		// write channel is genuinely nothing, and the read channel is discounted.
		const kimi = resolveModel("kimi/kimi-k2.6");
		expect(kimi?.pricing?.cacheWrite).toBe(0);
		expect(kimi?.pricing?.cacheRead).toBeLessThan(kimi?.pricing?.input ?? 0);
	});

	test("OpenAI writes cost 1.25x input, and K3 states a write price of its own", () => {
		// The two rows where the write channel is neither zero nor the input rate:
		// OpenAI documents the multiplier once for every model, Kimi states a figure
		// per model — and it happens to equal K3's input rate, which is why it is
		// written as a number rather than derived.
		const luna = resolveModel("openai/gpt-5.6-luna")?.pricing;
		expect(luna?.cacheWrite).toBeCloseTo((luna?.input ?? 0) * 1.25, 10);
		expect(resolveModel("kimi/kimi-k3")?.pricing?.cacheWrite).toBe(3);
	});
});

describe("ids that were retired", () => {
	test("a retired id resolves to the model that answers to it now", () => {
		// A settings file outlives the model it names. Without this the reference
		// stops resolving, and the app reports a model that is still being served.
		expect(resolveModel("deepseek/deepseek-chat")?.id).toBe("deepseek-flash");
		expect(resolveModel("deepseek-chat")?.provider).toBe("deepseek");
		expect(resolveModel("kimi/kimi-k2-0905-preview")?.id).toBe("kimi-k2.6");
		// Anthropic's are forwarded by the successor named at deprecation, which is
		// not always the same tier: the 3.x Opus ids land on a much cheaper model.
		expect(resolveModel("anthropic/claude-3-5-sonnet-20241022")?.id).toBe("claude-sonnet-4-6");
		expect(resolveModel("anthropic/claude-3-7-sonnet-20250219")?.id).toBe("claude-sonnet-4-6");
		expect(resolveModel("anthropic/claude-opus-4-20250514")?.id).toBe("claude-opus-4-8");
		expect(resolveModel("anthropic/claude-opus-4-1-20250805")?.id).toBe("claude-opus-4-8");
		expect(resolveModel("anthropic/claude-3-haiku-20240307")?.id).toBe("claude-haiku-4-5");
		// Kimi's line ran twice: the K2 ids stay in the family, the moonshot-v1 ids
		// have no survivor and follow the notice to K3.
		expect(resolveModel("kimi/kimi-k2.5")?.id).toBe("kimi-k2.6");
		expect(resolveModel("kimi/moonshot-v1-128k")?.id).toBe("kimi-k3");
	});

	test("an id a vendor still answers as an alias forwards like a retired one", () => {
		// Retiring an id and continuing to answer it are two different vendor
		// decisions with the same consequence here: no row carries the name, so the
		// reference would stop resolving while the model is still being served.
		expect(resolveModel("deepseek/deepseek-v4-flash")?.id).toBe("deepseek-flash");
		expect(resolveModel("deepseek-v4-flash-vision-exp")?.id).toBe("deepseek-flash");
	});

	test("both retired DeepSeek ids land on the model that serves both modes", () => {
		expect(resolveModel("deepseek-reasoner")?.id).toBe("deepseek-flash");
		// And they carry the price that id is billed at, not the price they cost.
		expect(resolveModel("deepseek-reasoner")?.pricing?.output).toBe(1.2);
	});

	test("a forwarded reference costs what the model it lands on costs", () => {
		// Forwarding is not price-preserving, and one of these is a large jump: a
		// moonshot-v1 id retires to a model fifteen times its input rate. The
		// session should be billed the landing model's price, and be told so.
		expect(resolveModel("kimi/moonshot-v1-8k")?.pricing?.input).toBe(3);
		expect(resolveModel("anthropic/claude-3-opus-20240229")?.pricing?.input).toBe(5);
	});

	test("another provider's model of the same name is left alone", () => {
		// `gateway/deepseek-chat` is not this table's id to rename; a wrong model
		// served quietly is worse than one that does not resolve.
		expect(resolveModel("gateway/deepseek-chat")).toBeUndefined();
		expect(resolveModel("gateway/claude-3-opus-20240229")).toBeUndefined();
	});

	test("retired ids are not offered as models", () => {
		// The map is for references already written, not a catalog to choose from.
		//
		// Scoped away from the four gateway providers, and the scoping is the point
		// rather than a concession: an id is retired *at a vendor*, not everywhere.
		// `deepseek-v4-flash` and `kimi-k2.5` are ids DeepSeek and Kimi no longer
		// serve under that name, and they are also the names of models a reseller
		// sells today at its own rates. Excluding the resellers by name keeps the
		// original invariant intact and still fails the day a *first-party* row
		// re-lists an id its own vendor retired.
		const retired = [
			"deepseek-chat",
			"deepseek-reasoner",
			"deepseek-v4-flash",
			"kimi-k2-0905-preview",
			"kimi-k2.5",
			"moonshot-v1-8k",
			"claude-3-5-sonnet-20241022",
			"claude-opus-4-1-20250805",
		];
		expect(listModels().filter((m) => !RESELLER_PROVIDERS.has(m.provider) && retired.includes(m.id))).toEqual([]);
	});

	test("a reseller's model under a retired name is still offered, and is asked for by name", () => {
		// The other half of the rule above, and the reason that rule is scoped the
		// way it is. These are live models on a host that is serving them today; a
		// picker that hid them would be hiding something the user can buy. They are
		// reachable only qualified, because a bare one means the retirement — see
		// the three that collide, which is the whole reason the two tests sit apart.
		expect(resolveModel("opencode-zen/deepseek-v4-flash")?.id).toBe("deepseek-v4-flash");
		expect(resolveModel("opencode-zen/kimi-k2.5")?.id).toBe("kimi-k2.5");
		expect(resolveModel("opencode-zen-oai/kimi-k2.5")?.provider).toBe("opencode-zen-oai");
		// Zen only, and that is worth saying out loud: the Go plan serves an id by
		// that name today, but nobody publishes a price for it, so the Go tables
		// carry no row and this reference correctly resolves to nothing. An id
		// working on one plan and not the other is what a name collision looks like
		// when only one side of it is priced.
		expect(resolveModel("opencode-go/kimi-k2.5")).toBeUndefined();
		// Priced as the reseller sells them, not as the vendor whose id it borrows:
		// $0.14/$0.28 on Zen against a `deepseek-flash` row that is not this.
		expect(resolveModel("opencode-zen/deepseek-v4-flash")?.pricing?.output).toBe(0.28);
		// The forwarding is untouched, and it is what a bare reference still gets.
		expect(resolveModel("deepseek-v4-flash")?.id).toBe("deepseek-flash");
		expect(resolveModel("kimi-k2.5")?.id).toBe("kimi-k2.6");
	});

	test("a gateway row needs both a price and a listing that serves it", () => {
		// The gate from the other side, one test up: there a served model with no
		// published price stays out of the Go tables (`kimi-k2.5`); here a
		// published price does not earn a row either. models.dev prices
		// `claude-haiku-5-5` on both plans, but the Go listing carries no Claude id
		// at all, so the Go tables stay silent — a row invented from the price
		// alone would be a picker entry whose every request the gateway rejects.
		// Zen passes both gates.
		expect(resolveModel("opencode-go/claude-haiku-5-5")).toBeUndefined();
		expect(resolveModel("opencode-zen/claude-haiku-5-5")?.provider).toBe("opencode-zen");
	});

	test("a plan rename is not a retirement, and the old gateway reference fails loudly", () => {
		// The Go plan stopped serving `space-bunny-free` and carries the paid
		// `space-bunny` now (the Go row in `model.ts`, renamed and repriced); the
		// Zen plan still serves `space-bunny-free`. The old Go reference stops
		// resolving, and that is a choice rather than an omission: an entry in
		// `RETIRED_MODEL_IDS` is keyed by bare id and its branch runs before the
		// gateway scoping, so `space-bunny-free` there would forward *bare*
		// references to a subscription plan — the one landing site the resolver
		// deliberately refuses — for an id no vendor retired, since Zen's row
		// carries it today.
		expect(resolveModel("opencode-go/space-bunny-free")).toBeUndefined();
		// The bare form resolves to nothing today — a gateway row, so the bare
		// reference is refused — and the map entry is exactly what would change
		// that, whichever wire answers first.
		expect(resolveModel("space-bunny-free")).toBeUndefined();
		expect(resolveModel("opencode-zen/space-bunny-free")?.id).toBe("space-bunny-free");
	});

	test("a gateway row says what it takes, and the text-only set is named", () => {
		// `openAICompatModel` grew an `images` flag for the gateway, and nothing
		// else in the catalog has to say this: every first-party row on that wire is
		// a text model, and the two that could take an image are reached by their
		// own native client. So 48 of 236 rows are the only place the claim lives,
		// and before this one nothing in the suite could see it — flipping `false`
		// to `true` on any row was a silent edit.
		//
		// What makes it a claim about the model rather than about us: `input` is
		// what the tool layer asks before it offers a file, so a row that says
		// `image` for a model that takes none produces a picker entry that fails
		// on first use, and the reverse hides a capability. The list is the
		// transcription from the catalogue, and is exhaustive in both directions.
		const textOnly = [
			...new Set(
				BUILT_IN_REFS.filter(isReseller)
					.filter((ref) => resolveModel(ref)?.input.length === 1)
					.map((ref) => ref.slice(ref.indexOf("/") + 1)),
			),
		].sort();
		expect(textOnly).toEqual([
			"big-pickle",
			"deepseek-v4-flash",
			"deepseek-v4-pro",
			"glm-5",
			"glm-5.1",
			"glm-5.2",
			"glm-5.3",
			"gpt-5.3-codex-spark",
			"hy3",
			"hy4-preview",
			"ling-3.0-flash-fin-free",
			"ling-3.1-flash-free",
			"longcat-2.0",
			"mimo-v2.5-pro",
			"minimax-m2.5",
			"minimax-m2.7",
			"nemotron-3-ultra-free",
			"nemotron-3.5-lightning-free",
			"qwen3.7-max",
		]);
		// 48 of 236: 14 Zen rows and 10 Go rows, each on both wires. Asserted as a
		// count rather than derived, so a row that silently joins the list below
		// cannot do it by also quietly leaving it here.
		const rows = BUILT_IN_REFS.filter(isReseller);
		expect(rows.filter((ref) => resolveModel(ref)?.input.length === 1)).toHaveLength(48);
		expect(rows.filter((ref) => resolveModel(ref)?.input.length === 2)).toHaveLength(188);
		// The two wires agree about the model, which is a check on the *tuple*
		// being shared rather than transcribed twice — a per-wire table could
		// disagree and both halves would look right.
		expect(resolveModel("opencode-zen/deepseek-v4-pro")?.input).toEqual(
			resolveModel("opencode-zen-oai/deepseek-v4-pro")?.input,
		);
		expect(resolveModel("opencode-zen/claude-opus-5-5")?.input).toEqual(["text", "image"]);
	});

	test("a bare id no vendor makes is not quietly served by a gateway", () => {
		// The other half of "reachable only qualified", and the half with no
		// collision behind it: `gpt-5-codex` is not retired anywhere, it simply
		// belongs to a vendor this build does not carry, and only the gateway
		// sells it. Left to the plain id match it resolves — to the Zen plan, at
		// Zen's price, on a host whose key is `OPENCODE_API_KEY`.
		//
		// What that costs is not a failed lookup but a silently changed meaning,
		// and the blast radius is the whole app rather than the picker: a
		// `model` in any source's config file is resolved through this function
		// before it is written, so a config that pinned `gpt-5-codex` and used to
		// be reported as an unrecognised model would instead be written out as a
		// working reference to a subscription the user may not hold. Both migrate
		// tests that pin such an id are what found this.
		expect(resolveModel("gpt-5-codex")).toBeUndefined();
		expect(resolveModel("grok-4.6")).toBeUndefined();
		expect(resolveModel("hy3")).toBeUndefined();
		// Qualified, all three still resolve — the rule is about the bare name
		// only, and the picker hands out exactly the qualified form.
		expect(resolveModel("opencode-zen/gpt-5-codex")?.pricing?.output).toBe(8.5);
		expect(resolveModel("opencode-zen/grok-4.6")?.provider).toBe("opencode-zen");
		expect(resolveModel("opencode-go/hy3")?.provider).toBe("opencode-go");
		// And the rule does not reach past the four gateway ids: a vendor that
		// makes the model still answers for it, first-party rows sit ahead of the
		// gateway ones, and a model on both is still the vendor's.
		expect(resolveModel("claude-opus-5-5")?.provider).toBe("anthropic");
		expect(resolveModel("deepseek-v4-pro")?.provider).toBe("deepseek");
		expect(resolveModel("kimi-k3")?.provider).toBe("kimi");
		// A first instance of that collision on the OpenAI wire, where the bare
		// name is also a name a gateway sells. First-party rows sit ahead of the
		// gateway ones, so the answer is OpenAI's row at OpenAI's price — and
		// dropping the first-party row is exactly what would turn this into a
		// subscription plan the user never chose.
		expect(resolveModel("gpt-6.1-sol")?.provider).toBe("openai");
		expect(resolveModel("gpt-6.1-sol")?.pricing?.cacheRead).toBe(0.1);
		// Exhaustive, and about the right thing: no bare id may *land on* a gateway
		// row. Most of the 236 do resolve bare — to the vendor that makes the model
		// — which is the rule working, not the rule failing, so the check is on
		// where the resolution goes rather than on whether one happens. A fifth
		// gateway added to the table without a decision here fails this.
		const landing = BUILT_IN_REFS.filter(isReseller)
			.map((ref) => ref.slice(ref.indexOf("/") + 1))
			.filter((id) => RESELLER_PROVIDERS.has(resolveModel(id)?.provider ?? ""));
		expect([...new Set(landing)]).toEqual([]);
	});
});

describe("declared prices", () => {
	test("a declared price overrides the catalog for a built-in model", () => {
		setPricingOverride("anthropic/claude-sonnet-5", { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.9 });
		expect(resolveModel("anthropic/claude-sonnet-5")?.pricing?.input).toBe(1.5);
		// And the rest of the entry is left alone: a price is not a model redefinition.
		expect(resolveModel("anthropic/claude-sonnet-5")?.contextWindow).toBe(1_000_000);
	});

	test("a bare model id applies to whichever provider serves it", () => {
		setPricingOverride("claude-sonnet-5", { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 });
		expect(resolveModel("claude-sonnet-5")?.pricing?.input).toBe(0.01);
	});

	test("the full reference wins over the bare id", () => {
		// Otherwise a broad "everything costs this" entry would quietly undo a
		// specific one, which is the opposite of what a user typing it expects.
		setPricingOverride("claude-sonnet-5", { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 });
		setPricingOverride("anthropic/claude-sonnet-5", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
		expect(resolveModel("anthropic/claude-sonnet-5")?.pricing?.input).toBe(1);
	});

	test("listModels carries the override, so a listing shows what is billed", () => {
		setPricingOverride("anthropic/claude-opus-5", { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 });
		expect(listModels().find((m) => m.id === "claude-opus-5")?.pricing?.input).toBe(0.5);
	});

	test("clearing the overrides puts the catalog back", () => {
		setPricingOverride("anthropic/claude-sonnet-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		clearPricingOverrides();
		expect(resolveModel("anthropic/claude-sonnet-5")?.pricing?.input).toBe(2);
	});
});

describe("custom providers", () => {
	test("a declared price travels with the model", () => {
		registerOpenAICompatibleProvider({
			id: "custom",
			baseUrl: "https://api.example.com/v1",
			apiKeyEnv: "CUSTOM_KEY",
			models: [
				{
					id: "m1",
					contextWindow: 8_000,
					maxOutputTokens: 1_000,
					pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
				},
			],
		});
		expect(resolveModel("custom/m1")?.pricing?.output).toBe(2);
	});

	test("a provider registered without prices is unpriced, not free", () => {
		// The distinction the cost report depends on: no table means the tokens
		// cannot be costed, and /cost says so instead of printing $0.
		registerOpenAICompatibleProvider({
			id: "custom",
			baseUrl: "https://api.example.com/v1",
			apiKeyEnv: "CUSTOM_KEY",
			models: [{ id: "m1", contextWindow: 8_000, maxOutputTokens: 1_000 }],
		});
		expect(resolveModel("custom/m1")?.pricing).toBeUndefined();
	});
});

describe("where a bare id can be bought", () => {
	test("names the gateway that sells it, and only when it is bare", () => {
		// The `/model` picker lists `opencode-zen/gpt-5-codex`, and `resolveModel`
		// answers "nothing" to the bare `gpt-5-codex` on purpose. This is the
		// third half that makes that a rule rather than a dead end: the rejection
		// says where the model went.
		expect(gatewayProvidersFor("gpt-5-codex")).toEqual(["opencode-zen", "opencode-zen-oai"]);
		expect(gatewayProvidersFor("grok-4.6")).toEqual([
			"opencode-zen",
			"opencode-go",
			"opencode-zen-oai",
			"opencode-go-oai",
		]);
		expect(gatewayProvidersFor("hy3")).toEqual(["opencode-go", "opencode-go-oai"]);
		// Not for a model a first-party vendor makes. The gateway sells
		// `claude-opus-5-5` too, and redirecting someone who typed the name that
		// already works at Anthropic would send them off to buy a plan they do not
		// need. The contract is "ask after a resolution has already failed", and a
		// hint that fires when it should not is worse than no hint.
		expect(gatewayProvidersFor("claude-opus-5-5")).toEqual([]);
		expect(gatewayProvidersFor("kimi-k3")).toEqual([]);
		// Nor for an id that forwards to its replacement: `deepseek-v4-flash`
		// resolves, so a caller never gets as far as asking.
		expect(gatewayProvidersFor("deepseek-v4-flash")).toEqual([]);
		// And not for a typo in a provider name, which is a different mistake with
		// the same empty answer.
		expect(gatewayProvidersFor("opencode-zen/gpt-5-codex")).toEqual([]);
		expect(gatewayProvidersFor("opencode-ze/gpt-5-codex")).toEqual([]);
		expect(gatewayProvidersFor("nope")).toEqual([]);
	});
});
