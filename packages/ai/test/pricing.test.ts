import { describe, expect, test } from "bun:test";
import { computeCost, formatCost } from "../src/pricing.ts";

const PRICING = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

describe("computeCost", () => {
	test("per-Mtok math with cache tokens", () => {
		const cost = computeCost({ input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 400_000 }, PRICING);
		expect(cost.input).toBeCloseTo(3);
		expect(cost.output).toBeCloseTo(1.5);
		expect(cost.cacheRead).toBeCloseTo(0.6);
		expect(cost.cacheWrite).toBeCloseTo(1.5);
		expect(cost.total).toBeCloseTo(6.6);
	});

	test("a one-hour cache write is billed at its own rate where the row states one", () => {
		const split = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 400_000,
			cacheWriteTtl: { "5m": 100_000, "1h": 300_000 },
		};
		// A row with a single write rate bills the whole channel at it, bucket
		// split or no: that is every provider but Anthropic.
		expect(computeCost(split, PRICING).cacheWrite).toBeCloseTo(1.5);

		const anthropic = { ...PRICING, cacheWrite1h: 6 };
		// 300k tokens at $6, the remaining 100k at $3.75.
		expect(computeCost(split, anthropic).cacheWrite).toBeCloseTo(2.175);
		// No split means no evidence of a one-hour write: the channel stays on the
		// default rate.
		const plain = { input: 0, output: 0, cacheRead: 0, cacheWrite: 400_000 };
		expect(computeCost(plain, anthropic).cacheWrite).toBeCloseTo(1.5);
		// A bucket the record also counts whole cannot exceed that total: the
		// one-hour part is clamped, so a faulty split misplaces tokens between
		// rates but never loses or duplicates any.
		const overfull = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 200_000,
			cacheWriteTtl: { "5m": 0, "1h": 250_000 },
		};
		expect(computeCost(overfull, anthropic).cacheWrite).toBeCloseTo(1.2);
		// A shortfall rides the default rate the same way.
		const short = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 400_000,
			cacheWriteTtl: { "5m": 100_000, "1h": 100_000 },
		};
		expect(computeCost(short, anthropic).cacheWrite).toBeCloseTo(1.725);
	});

	test("zero usage costs nothing; missing pricing yields zeros", () => {
		const zero = computeCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, PRICING);
		expect(zero.total).toBe(0);
		const unpriced = computeCost({ input: 999_999, output: 1, cacheRead: 0, cacheWrite: 0 }, undefined);
		expect(unpriced.total).toBe(0);
	});
});

describe("formatCost", () => {
	test("tiers by magnitude", () => {
		expect(formatCost(0)).toBe("$0");
		expect(formatCost(0.0042)).toBe("$0.0042");
		expect(formatCost(2.5)).toBe("$2.50");
	});
});
