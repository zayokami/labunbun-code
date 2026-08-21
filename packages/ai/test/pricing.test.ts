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
