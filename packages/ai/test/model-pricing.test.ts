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
	"anthropic/claude-fable-5",
	"anthropic/claude-opus-5",
	"anthropic/claude-sonnet-5",
	"anthropic/claude-haiku-4-5",
	"deepseek/deepseek-chat",
	"deepseek/deepseek-reasoner",
	"kimi/kimi-k2-0905-preview",
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

	test("a cache read is a tenth of input, on every Anthropic model", () => {
		// The multiplier is the rule; if a rate changes the read rate has to move
		// with it, and a hand-typed table is exactly where that goes wrong.
		for (const ref of BUILT_IN_REFS.filter((r) => r.startsWith("anthropic/"))) {
			const pricing = resolveModel(ref)?.pricing;
			expect(pricing?.cacheRead).toBeCloseTo((pricing?.input ?? 0) * 0.1, 10);
			expect(pricing?.cacheWrite).toBeCloseTo((pricing?.input ?? 0) * 1.25, 10);
		}
	});

	test("a provider that does not bill cached input separately says so with a zero", () => {
		// Not "unknown": these APIs charge a cache write as ordinary input, so the
		// write channel is genuinely nothing, and the read channel is discounted.
		const kimi = resolveModel("kimi/kimi-k2-0905-preview");
		expect(kimi?.pricing?.cacheWrite).toBe(0);
		expect(kimi?.pricing?.cacheRead).toBeLessThan(kimi?.pricing?.input ?? 0);
	});
});

describe("declared prices", () => {
	test("a declared price overrides the catalog for a built-in model", () => {
		setPricingOverride("anthropic/claude-sonnet-5", { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.9 });
		expect(resolveModel("anthropic/claude-sonnet-5")?.pricing?.input).toBe(1.5);
		// And the rest of the entry is left alone: a price is not a model redefinition.
		expect(resolveModel("anthropic/claude-sonnet-5")?.contextWindow).toBe(200_000);
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
