import type { ModelPricing, Usage } from "./types.ts";

export interface CostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

const MTOK = 1_000_000;

/**
 * The write channel, split by TTL bucket where both sides say so.
 *
 * A provider that charges its one-hour writes at their own rate (`cacheWrite1h`)
 * and a usage record that carries the bucket split get the two rates applied to
 * the two token counts; everywhere else — no separate rate, no split, every
 * other provider — the whole channel stays on the single `cacheWrite` rate, so
 * a record with no one-hour tokens bills exactly what it always did.
 *
 * The one-hour count is clamped into the total: the buckets are the provider's
 * account of a number it also states whole, and holding the two consistent here
 * means a faulty split can shift tokens between rates but never invent or lose
 * any — the remainder rides the default rate.
 */
function cacheWriteCost(usage: Usage, pricing: ModelPricing): number {
	const rate1h = pricing.cacheWrite1h;
	const split = usage.cacheWriteTtl;
	if (rate1h === undefined || split === undefined) {
		return (usage.cacheWrite / MTOK) * pricing.cacheWrite;
	}
	const oneHour = Math.min(Math.max(split["1h"], 0), usage.cacheWrite);
	const rest = usage.cacheWrite - oneHour;
	return (oneHour / MTOK) * rate1h + (rest / MTOK) * pricing.cacheWrite;
}

/** Compute USD cost from token usage and per-Mtok pricing. */
export function computeCost(usage: Usage, pricing?: ModelPricing): CostBreakdown {
	if (!pricing) {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	}
	const input = (usage.input / MTOK) * pricing.input;
	const output = (usage.output / MTOK) * pricing.output;
	const cacheRead = (usage.cacheRead / MTOK) * pricing.cacheRead;
	const cacheWrite = cacheWriteCost(usage, pricing);
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
