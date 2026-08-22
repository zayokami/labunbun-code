/**
 * Cost accumulation and its per-project persistence.
 *
 * The money path is worth pinning down precisely: a usage record that lands in
 * the wrong bucket, or a reload that drops a field, is wrong in a way nobody
 * notices until the total is questioned.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@labunbun/ai";
import { CostTracker, emptyCostState, formatCostState, loadCostState } from "../src/cost-tracker.ts";

const usage = (over: Partial<Usage> = {}): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over });

function tmpFile(name = "costs.json"): string {
	return join(mkdtempSync(join(tmpdir(), "lbb-cost-")), name);
}

describe("emptyCostState", () => {
	test("starts at zero with no models", () => {
		expect(emptyCostState()).toEqual({ totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} });
	});

	test("returns a fresh object each call, so callers cannot alias the zero state", () => {
		const a = emptyCostState();
		a.totalCostUSD = 5;
		expect(emptyCostState().totalCostUSD).toBe(0);
	});
});

describe("CostTracker.recordUsage", () => {
	test("keys usage by provider and model", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 100, output: 50 }));
		expect(Object.keys(tracker.state.modelsUsage)).toEqual(["anthropic/claude-sonnet-5"]);
	});

	test("accumulates every token channel across calls", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("p", "m", usage({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }));
		tracker.recordUsage("p", "m", usage({ input: 20, output: 7, cacheRead: 3, cacheWrite: 4 }));
		expect(tracker.state.modelsUsage["p/m"]).toMatchObject({
			inputTokens: 30,
			outputTokens: 12,
			cacheReadTokens: 5,
			cacheWriteTokens: 5,
		});
	});

	test("keeps models in separate buckets", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("p", "a", usage({ input: 10 }));
		tracker.recordUsage("p", "b", usage({ input: 20 }));
		expect(tracker.state.modelsUsage["p/a"].inputTokens).toBe(10);
		expect(tracker.state.modelsUsage["p/b"].inputTokens).toBe(20);
	});

	test("the same model id under different providers stays separate", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("one", "shared", usage({ input: 1 }));
		tracker.recordUsage("two", "shared", usage({ input: 2 }));
		expect(Object.keys(tracker.state.modelsUsage).sort()).toEqual(["one/shared", "two/shared"]);
	});

	test("sums durations independently of tokens", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("p", "m", usage({ input: 1 }), 1200);
		tracker.recordUsage("p", "m", usage({ input: 1 }), 800);
		expect(tracker.state.totalDurationMs).toBe(2000);
	});

	test("duration defaults to zero when not supplied", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("p", "m", usage({ input: 1 }));
		expect(tracker.state.totalDurationMs).toBe(0);
	});

	// An unresolvable model has no pricing to look up, so it must contribute
	// tokens without inventing a cost.
	test("an unknown model records tokens at zero cost", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("nobody", "nothing", usage({ input: 1_000_000, output: 1_000_000 }));
		expect(tracker.state.modelsUsage["nobody/nothing"].inputTokens).toBe(1_000_000);
		expect(tracker.state.modelsUsage["nobody/nothing"].costUSD).toBe(0);
		expect(tracker.state.totalCostUSD).toBe(0);
	});

	// No catalog model carries a pricing table yet, so a resolvable model is
	// costed the same as an unknown one. Tokens are still counted, which is what
	// the status line and /cost read. This pins the current behaviour so that
	// adding pricing to the catalog shows up here as a failure rather than as a
	// silent change in what users are billed.
	test("a resolvable model is counted in tokens and costed at zero", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000, output: 1_000_000 }));
		const bucket = tracker.state.modelsUsage["anthropic/claude-sonnet-5"];
		expect(bucket.inputTokens).toBe(1_000_000);
		expect(bucket.outputTokens).toBe(1_000_000);
		expect(bucket.costUSD).toBe(0);
	});

	// Holds whatever the pricing table says: the invariant is that the total is
	// never independent of the buckets it summarizes.
	test("the total equals the sum of the per-model costs", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 500_000 }));
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ output: 250_000 }));
		tracker.recordUsage("nobody", "nothing", usage({ input: 999 }));
		const sum = Object.values(tracker.state.modelsUsage).reduce((n, u) => n + u.costUSD, 0);
		expect(tracker.state.totalCostUSD).toBeCloseTo(sum, 10);
	});

	test("zero usage adds a bucket without moving the total", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage());
		expect(tracker.state.modelsUsage["anthropic/claude-sonnet-5"].inputTokens).toBe(0);
		expect(tracker.state.totalCostUSD).toBe(0);
	});

	test("a tracker with no cwd keeps state in memory and persists nothing", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("p", "m", usage({ input: 5 }));
		expect(() => tracker.persist()).not.toThrow();
		expect(tracker.state.modelsUsage["p/m"].inputTokens).toBe(5);
	});
});

describe("loadCostState", () => {
	test("a missing file reads as the empty state", () => {
		expect(loadCostState(tmpFile("absent.json"))).toEqual(emptyCostState());
	});

	test("round-trips a written state", () => {
		const path = tmpFile();
		const state = {
			totalCostUSD: 1.5,
			totalDurationMs: 4200,
			modelsUsage: {
				"p/m": { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUSD: 1.5 },
			},
		};
		writeFileSync(path, JSON.stringify(state));
		expect(loadCostState(path)).toEqual(state);
	});

	// Cost data is a convenience, not a record of truth: a corrupt file should
	// reset the counter rather than stop the session from starting.
	test("unparseable JSON reads as the empty state instead of throwing", () => {
		const path = tmpFile();
		writeFileSync(path, "{ not json");
		expect(loadCostState(path)).toEqual(emptyCostState());
	});

	test("missing fields fall back to zero rather than undefined", () => {
		const path = tmpFile();
		writeFileSync(path, JSON.stringify({ totalCostUSD: 2 }));
		expect(loadCostState(path)).toEqual({ totalCostUSD: 2, totalDurationMs: 0, modelsUsage: {} });
	});

	test("an explicit null for a field falls back to zero", () => {
		const path = tmpFile();
		writeFileSync(path, JSON.stringify({ totalCostUSD: null, modelsUsage: null }));
		expect(loadCostState(path)).toEqual({ totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} });
	});
});

describe("CostTracker persistence", () => {
	test("persists to the project directory and reloads on the next tracker", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-cost-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-cost-cwd-"));
		const previous = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		try {
			const first = new CostTracker(cwd);
			first.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1000, output: 2000, cacheRead: 30 }), 500);
			first.persist();

			const second = new CostTracker(cwd);
			expect(second.state.modelsUsage["anthropic/claude-sonnet-5"]).toEqual(
				first.state.modelsUsage["anthropic/claude-sonnet-5"],
			);
			expect(second.state.totalDurationMs).toBe(500);
			expect(second.state.totalCostUSD).toBeCloseTo(first.state.totalCostUSD, 10);
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
			if (previousProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousProfile;
		}
	});

	test("a fresh project starts from zero", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-cost-home2-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-cost-cwd2-"));
		const previous = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		try {
			expect(new CostTracker(cwd).state).toEqual(emptyCostState());
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
			if (previousProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousProfile;
		}
	});
});

describe("formatCostState", () => {
	test("reports the total to four decimal places", () => {
		expect(formatCostState(emptyCostState())).toBe("Total cost: $0.0000");
	});

	test("lists each model with its summed token count and cost", () => {
		const text = formatCostState({
			totalCostUSD: 0.5,
			totalDurationMs: 0,
			modelsUsage: {
				"p/m": { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUSD: 0.5 },
			},
		});
		expect(text).toContain("Total cost: $0.5000");
		expect(text).toContain("p/m");
		expect(text).toContain("100 tokens");
		expect(text).toContain("$0.5000");
	});

	test("one line per model, plus the total line", () => {
		const text = formatCostState({
			totalCostUSD: 0,
			totalDurationMs: 0,
			modelsUsage: {
				"p/a": { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 },
				"p/b": { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 },
			},
		});
		expect(text.split("\n")).toHaveLength(3);
	});
});
