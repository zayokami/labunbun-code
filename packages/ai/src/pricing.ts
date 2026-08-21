import type { ModelPricing, Usage } from "./types.ts";

export interface CostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** Compute USD cost from token usage and per-Mtok pricing. */
export function computeCost(usage: Usage, pricing?: ModelPricing): CostBreakdown {
	if (!pricing) {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	}
	const MTOK = 1_000_000;
	const input = (usage.input / MTOK) * pricing.input;
	const output = (usage.output / MTOK) * pricing.output;
	const cacheRead = (usage.cacheRead / MTOK) * pricing.cacheRead;
	const cacheWrite = (usage.cacheWrite / MTOK) * pricing.cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
}

export function formatCost(usd: number): string {
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	if (usd > 0) return `$${usd.toFixed(4)}`;
	return "$0";
}
