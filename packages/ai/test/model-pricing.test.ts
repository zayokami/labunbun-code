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
	"anthropic/claude-fable-5-1",
	"anthropic/claude-fable-5",
	"anthropic/claude-opus-5",
	"anthropic/claude-sonnet-5",
	"anthropic/claude-haiku-4-5",
	"deepseek/deepseek-flash",
	"deepseek/deepseek-v4-pro",
	"kimi/kimi-k2.6",
	"glm/glm-4.6",
];

describe("the built-in catalog", () => {
	test("every model carries a price", () => {
		// An unpriced catalog entry reads as a free model: the cost tracker looks
		// the price up, finds nothing, and adds zero to a total nobody questions.
		const unpriced = BUILT_IN_REFS.filter((ref) => !resolveModel(ref)?.pricing);
		expect(unpriced).toEqual([]);
	});

	test("Anthropic prices are the published list rates", () => {
		// Fable 5.1 is the current Fable, and the only model in the catalog whose
		// cache reads are billed at 0.025x input rather than 0.1x.
		expect(resolveModel("anthropic/claude-fable-5-1")?.pricing).toEqual({
			input: 10,
			output: 50,
			cacheRead: 0.25,
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

	test("a cache read is a tenth of input, except on the family that is not", () => {
		// The multiplier is the rule; if a rate changes the read rate has to move
		// with it, and a hand-typed table is exactly where that goes wrong.
		const offTheRule = new Map([["anthropic/claude-fable-5-1", 0.025]]);
		for (const ref of BUILT_IN_REFS.filter((r) => r.startsWith("anthropic/"))) {
			const pricing = resolveModel(ref)?.pricing;
			expect(pricing?.cacheRead).toBeCloseTo((pricing?.input ?? 0) * (offTheRule.get(ref) ?? 0.1), 10);
			expect(pricing?.cacheWrite).toBeCloseTo((pricing?.input ?? 0) * 1.25, 10);
		}
		// The exception has to be a real one, or it is a loophole in the loop.
		expect(offTheRule.get("anthropic/claude-fable-5-1")).not.toBe(0.1);
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
			["anthropic/claude-fable-5-1", 1_000_000, 128_000],
			["anthropic/claude-fable-5", 1_000_000, 128_000],
			["anthropic/claude-opus-5", 1_000_000, 128_000],
			["anthropic/claude-sonnet-5", 1_000_000, 128_000],
			["anthropic/claude-haiku-4-5", 200_000, 64_000],
			["deepseek/deepseek-flash", 1_000_000, 384_000],
			["deepseek/deepseek-v4-pro", 1_000_000, 384_000],
			["kimi/kimi-k2.6", 262_144, 8_192],
			["glm/glm-4.6", 200_000, 128_000],
		]);
	});

	test("a provider that does not bill cached input separately says so with a zero", () => {
		// Not "unknown": these APIs charge a cache write as ordinary input, so the
		// write channel is genuinely nothing, and the read channel is discounted.
		const kimi = resolveModel("kimi/kimi-k2.6");
		expect(kimi?.pricing?.cacheWrite).toBe(0);
		expect(kimi?.pricing?.cacheRead).toBeLessThan(kimi?.pricing?.input ?? 0);
	});
});

describe("ids that were retired", () => {
	test("a retired id resolves to the model that answers to it now", () => {
		// A settings file outlives the model it names. Without this the reference
		// stops resolving, and the app reports a model that is still being served.
		expect(resolveModel("deepseek/deepseek-chat")?.id).toBe("deepseek-flash");
		expect(resolveModel("deepseek-chat")?.provider).toBe("deepseek");
		expect(resolveModel("kimi/kimi-k2-0905-preview")?.id).toBe("kimi-k2.6");
	});

	test("both retired DeepSeek ids land on the model that serves both modes", () => {
		expect(resolveModel("deepseek-reasoner")?.id).toBe("deepseek-flash");
		// And they carry the price that id is billed at, not the price they cost.
		expect(resolveModel("deepseek-reasoner")?.pricing?.output).toBe(1.2);
	});

	test("another provider's model of the same name is left alone", () => {
		// `gateway/deepseek-chat` is not this table's id to rename; a wrong model
		// served quietly is worse than one that does not resolve.
		expect(resolveModel("gateway/deepseek-chat")).toBeUndefined();
	});

	test("retired ids are not offered as models", () => {
		// The map is for references already written, not a catalog to choose from.
		const retired = ["deepseek-chat", "deepseek-reasoner", "kimi-k2-0905-preview"];
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
