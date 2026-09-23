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
	listModels,
	registerOpenAICompatibleProvider,
	resolveModel,
	setPricingOverride,
} from "../src/model.ts";

afterEach(() => {
	clearCustomModels();
	clearPricingOverrides();
});

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
	"anthropic/claude-sonnet-5",
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-haiku-4-5",
	"deepseek/deepseek-flash",
	"deepseek/deepseek-v4-pro",
	"kimi/kimi-k3",
	"kimi/kimi-k2.7-code",
	"kimi/kimi-k2.7-code-highspeed",
	"kimi/kimi-k2.6",
	"glm/glm-5.3",
	"glm/glm-5.3-flash",
	"glm/glm-4.7",
	"glm/glm-4.7-flashx",
	"glm/glm-4.6",
	"openai/gpt-6-astra",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"google/gemini-3.8-flash",
	"google/gemini-3.1-pro-preview",
];

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
		// $2/$10 is the standard price, not an introductory one: the increase to
		// $3/$15 that was scheduled for 2026-09-01 was cancelled.
		expect(resolveModel("anthropic/claude-sonnet-5")?.pricing).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
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
			["anthropic/claude-sonnet-5", "adaptive"],
			["anthropic/claude-sonnet-4-6", "adaptive"],
			["anthropic/claude-haiku-4-5", "extended"],
		]);
	});

	test("the models that check thinking-block binding are named one by one", () => {
		// The parameter the adapter sends on their behalf is one the API rejects on
		// a model that runs no such check, so this flag is not a tier: Mythos 5.1
		// records the same signatures as Fable 5.1 and runs no check, and is
		// deliberately absent.
		const flagged = BUILT_IN_REFS.filter((ref) => resolveModel(ref)?.thinkingBlockBinding);
		expect(flagged).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1"]);
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
			["glm/glm-4.7", 0.6, 2.2, 0.11, 0],
			["glm/glm-4.7-flashx", 0.07, 0.4, 0.01, 0],
			["glm/glm-4.6", 0.6, 2.2, 0.11, 0],
			// The current regime's rates: Flash doubles on 2027-01-01, and the Pro
			// row's figures are its ≤200k tier.
			["openai/gpt-6-astra", 10, 50, 1, 12.5],
			["openai/gpt-5.6-sol", 4, 20, 0.4, 5],
			["openai/gpt-5.6-terra", 2, 12, 0.2, 2.5],
			["openai/gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
			["google/gemini-3.8-flash", 0.75, 3.75, 0.075, 0],
			["google/gemini-3.1-pro-preview", 2, 12, 0.2, 0],
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
			["anthropic/claude-sonnet-5", 1_000_000, 128_000],
			["anthropic/claude-sonnet-4-6", 1_000_000, 128_000],
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
			["glm/glm-4.7", 200_000, 131_072],
			["glm/glm-4.7-flashx", 200_000, 131_072],
			["glm/glm-4.6", 200_000, 131_072],
			["openai/gpt-6-astra", 1_050_000, 128_000],
			["openai/gpt-5.6-sol", 1_050_000, 128_000],
			["openai/gpt-5.6-terra", 1_050_000, 128_000],
			["openai/gpt-5.6-luna", 1_050_000, 128_000],
			["google/gemini-3.8-flash", 1_048_576, 65_536],
			["google/gemini-3.1-pro-preview", 1_048_576, 65_536],
		]);
	});

	test("the models that always think do not claim a medium effort", () => {
		// `reasoning: true` makes the adapters ask for "medium" when the caller
		// states no level, which is only safe where "medium" is a value the vendor
		// takes. Every Anthropic row claims it and so do the four OpenAI ones, the
		// two DeepSeek ones (medium maps to high) and Gemini 3.8 Flash. What is
		// listed here is the opposite decision, and it is the interesting one: K3's
		// effort set is low/high/max and GLM-5.3's is max/high/low, so asking either
		// for "medium" asks for a depth it has no word for.
		//
		// Gemini 3.1 Pro is here for a different reason: it thinks and cannot be
		// told not to, but its page states no effort values at all, so "medium" is
		// unconfirmed for it. Saying nothing leaves the model at its own default,
		// which is the same thing we would have asked for anyway.
		const alwaysThinking = BUILT_IN_REFS.filter((ref) => !resolveModel(ref)?.reasoning);
		expect(alwaysThinking).toEqual([
			"kimi/kimi-k3",
			"kimi/kimi-k2.7-code",
			"kimi/kimi-k2.7-code-highspeed",
			"kimi/kimi-k2.6",
			"glm/glm-5.3",
			"glm/glm-5.3-flash",
			"glm/glm-4.7",
			"glm/glm-4.7-flashx",
			"glm/glm-4.6",
			"google/gemini-3.1-pro-preview",
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
		expect(listModels().filter((m) => retired.includes(m.id))).toEqual([]);
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
