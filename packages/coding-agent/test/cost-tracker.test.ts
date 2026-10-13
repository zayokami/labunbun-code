/**
 * Cost accumulation and its per-project persistence.
 *
 * The money path is worth pinning down precisely: a usage record that lands in
 * the wrong bucket, or a reload that drops a field, is wrong in a way nobody
 * notices until the total is questioned.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assistantMessage, type Usage, userMessage } from "@labunbun/ai";
import {
	CostTracker,
	emptyCostState,
	formatCostReport,
	formatCostState,
	loadCostState,
	type ModelUsage,
} from "../src/cost-tracker.ts";

const usage = (over: Partial<Usage> = {}): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over });

function tmpFile(name = "costs.json"): string {
	return join(mkdtempSync(join(tmpdir(), "lbb-cost-")), name);
}

describe("emptyCostState", () => {
	test("starts at zero with no models", () => {
		expect(emptyCostState()).toEqual({ totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {}, roleCostUSD: {} });
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

	// Sonnet 5 is $2/$10 per Mtok: a million of each costs twelve dollars, not
	// zero. The count and the bill come from the same bucket, which is what makes
	// /cost trustworthy — an earlier version of this test pinned zero here.
	test("a model with a price is billed at it", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000, output: 1_000_000 }));
		const bucket = tracker.state.modelsUsage["anthropic/claude-sonnet-5"];
		expect(bucket.inputTokens).toBe(1_000_000);
		expect(bucket.outputTokens).toBe(1_000_000);
		expect(bucket.costUSD).toBeCloseTo(12, 10);
	});

	test("cache traffic is billed at the cache rates, not the input rate", () => {
		// Anthropic prices a cache read at 0.1x input and a 5-minute write at
		// 1.25x. Reading them as input would overcharge a cached session twelvefold,
		// which is exactly the session shape this agent runs.
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ cacheRead: 1_000_000, cacheWrite: 1_000_000 }));
		expect(tracker.state.totalCostUSD).toBeCloseTo(0.2 + 2.5, 10);
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

	test("a subagent record books the split into the same bucket", () => {
		// The seat label rides the booking: kind "subagent" (the part the ledger
		// reads) and the role whose seat answered.
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000 }), 0, {
			kind: "subagent",
			role: "light",
		});
		const bucket = tracker.state.modelsUsage["anthropic/claude-sonnet-5"];
		// The money is in the bill either way — a subagent's spend is the
		// session's spend — and the split only says whose it was.
		expect(bucket.costUSD).toBeCloseTo(2, 10);
		expect(bucket.subagentCostUSD).toBeCloseTo(2, 10);
		expect(tracker.sessionState.modelsUsage["anthropic/claude-sonnet-5"]?.subagentCostUSD).toBeCloseTo(2, 10);
	});

	test("a record without a seat leaves the subagent split at zero", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000 }));
		const bucket = tracker.state.modelsUsage["anthropic/claude-sonnet-5"];
		expect(bucket.costUSD).toBeCloseTo(2, 10);
		expect(bucket.subagentCostUSD).toBe(0);
	});

	test("the subagent split accumulates beside the session's own spend", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000 }));
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000 }), 0, { kind: "subagent" });
		const bucket = tracker.state.modelsUsage["anthropic/claude-sonnet-5"];
		expect(bucket.costUSD).toBeCloseTo(4, 10);
		expect(bucket.subagentCostUSD).toBeCloseTo(2, 10);
		// The split is a subset, never a second total: it can exceed neither the
		// bucket nor the bill it is quoted under.
		expect(bucket.subagentCostUSD).toBeLessThanOrEqual(bucket.costUSD);
	});

	test("a record that names a role adds to that role's total, in both states", () => {
		// The booking is the only place a seat's name travels beside the money, so
		// it is the only place a per-role total can be fed from — and the session
		// total is what the seat's budget gate reads.
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000 }), 0, {
			kind: "subagent",
			role: "light",
		});
		expect(tracker.state.roleCostUSD.light).toBeCloseTo(2, 10);
		expect(tracker.sessionState.roleCostUSD.light).toBeCloseTo(2, 10);
		// A subset of the totals, like every other split here — never a second,
		// additive amount.
		expect(tracker.state.roleCostUSD.light).toBeLessThanOrEqual(tracker.state.totalCostUSD);
	});

	test("a record with no role to name adds to no role's total", () => {
		// The session's own calls and a definition-modelled subagent cannot be
		// attributed: nothing on the wire says which seat asked, and inventing one
		// would be an attribution the data does not support.
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000 }));
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000 }), 0, { kind: "subagent" });
		expect(tracker.state.roleCostUSD).toEqual({});
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
				"p/m": {
					inputTokens: 1,
					outputTokens: 2,
					cacheReadTokens: 3,
					cacheWriteTokens: 4,
					reasoningTokens: 1,
					costUSD: 1.5,
					subagentCostUSD: 0.25,
				},
			},
			// Carried like any other field: a directory's recorded role spend has
			// to survive the restart that the ledger exists for.
			roleCostUSD: { light: 0.25 },
		};
		writeFileSync(path, JSON.stringify(state));
		expect(loadCostState(path)).toEqual(state);
	});

	// Entries persisted before the reasoning field existed have no such key.
	// Re-loading them used to hand `undefined` to the sums; the loader backfills
	// zero so a pre-field project reads cleanly rather than as a gap.
	test("an entry persisted before reasoningTokens existed backfills to zero", () => {
		const path = tmpFile();
		writeFileSync(
			path,
			JSON.stringify({
				totalCostUSD: 1,
				totalDurationMs: 0,
				roleCostUSD: {},
				modelsUsage: {
					"p/m": { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 1 },
				},
			}),
		);
		expect(loadCostState(path).modelsUsage["p/m"]?.reasoningTokens).toBe(0);
	});

	// The same arrival for the subagent split: an entry persisted before the
	// field existed has no such key, and the reader backfills zero so the sums
	// describe "no subagent spend recorded" rather than `undefined`.
	test("an entry persisted before subagentCostUSD existed backfills to zero", () => {
		const path = tmpFile();
		writeFileSync(
			path,
			JSON.stringify({
				totalCostUSD: 1,
				totalDurationMs: 0,
				roleCostUSD: {},
				modelsUsage: {
					"p/m": { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 1 },
				},
			}),
		);
		expect(loadCostState(path).modelsUsage["p/m"]?.subagentCostUSD).toBe(0);
	});

	// The same arrival for the role split: a ledger written before the field
	// existed has no key for it, and the reader backfills an empty map so the
	// sums describe "no role spend recorded" rather than `undefined`.
	test("a ledger persisted before roleCostUSD existed backfills to an empty map", () => {
		const path = tmpFile();
		writeFileSync(
			path,
			JSON.stringify({
				totalCostUSD: 1,
				totalDurationMs: 0,
				modelsUsage: {
					"p/m": { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 1 },
				},
			}),
		);
		expect(loadCostState(path).roleCostUSD).toEqual({});
	});

	// Cost data is a convenience, not a record of truth: a corrupt file should
	// reset the counter rather than stop the session from starting.
	test("unparseable JSON reads as the empty state instead of throwing", () => {
		const path = tmpFile();
		writeFileSync(path, "{ not json");
		expect(loadCostState(path)).toEqual(emptyCostState());
		// Moved aside rather than left where the next persist would overwrite it:
		// the corrupt file is the only copy of the history it held.
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(dirname(path)).some((name) => name.includes(".corrupt-"))).toBe(true);
	});

	test("missing fields fall back to zero rather than undefined", () => {
		const path = tmpFile();
		writeFileSync(path, JSON.stringify({ totalCostUSD: 2 }));
		expect(loadCostState(path)).toEqual({ totalCostUSD: 2, totalDurationMs: 0, modelsUsage: {}, roleCostUSD: {} });
	});

	test("an explicit null for a field falls back to zero", () => {
		const path = tmpFile();
		writeFileSync(path, JSON.stringify({ totalCostUSD: null, modelsUsage: null, roleCostUSD: null }));
		expect(loadCostState(path)).toEqual({ totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {}, roleCostUSD: {} });
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
	test("reports the total to four decimal places, under the label it was given", () => {
		expect(formatCostState(emptyCostState(), "This project, all sessions")).toBe("This project, all sessions: $0.0000");
	});

	test("lists each model with its summed token count and cost", () => {
		const text = formatCostState(
			{
				totalCostUSD: 0.5,
				totalDurationMs: 0,
				roleCostUSD: {},
				modelsUsage: {
					"p/m": {
						inputTokens: 10,
						outputTokens: 20,
						cacheReadTokens: 30,
						cacheWriteTokens: 40,
						reasoningTokens: 0,
						costUSD: 0.5,
						subagentCostUSD: 0,
					},
				},
			},
			"This project, all sessions",
		);
		expect(text).toContain("This project, all sessions: $0.5000");
		expect(text).toContain("p/m");
		expect(text).toContain("100 tokens");
		expect(text).toContain("$0.5000");
	});

	test("one line per model plus its cache channels, plus the total line", () => {
		const text = formatCostState(
			{
				totalCostUSD: 0,
				totalDurationMs: 0,
				roleCostUSD: {},
				modelsUsage: {
					"p/a": {
						inputTokens: 1,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUSD: 0,
						subagentCostUSD: 0,
					},
					"p/b": {
						inputTokens: 2,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUSD: 0,
						subagentCostUSD: 0,
					},
				},
			},
			"This project, all sessions",
		);
		const lines = text.split("\n");
		expect(lines).toHaveLength(5);
		expect(lines[0]).toBe("This project, all sessions: $0.0000");
		// The cache line belongs to the model directly above it: a reader who has to
		// work out which model a number is about has been told nothing.
		expect(lines[1]).toContain("p/a:");
		expect(lines[2]).toBe("    cache: 0 read (0.0%) · 0 written · 1 full price");
		expect(lines[3]).toContain("p/b:");
		expect(lines[4]).toBe("    cache: 0 read (0.0%) · 0 written · 2 full price");
	});

	test("the cache line reports reads, writes and full-price tokens separately", () => {
		// The summed token count cannot show whether the cache worked: these two
		// models have very different bills and identical totals.
		const text = formatCostState(
			{
				totalCostUSD: 0,
				totalDurationMs: 0,
				roleCostUSD: {},
				modelsUsage: {
					"p/cached": {
						inputTokens: 100,
						outputTokens: 0,
						cacheReadTokens: 900,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUSD: 0,
						subagentCostUSD: 0,
					},
				},
			},
			"This session",
		);
		expect(text).toContain("cache: 900 read (90.0%) · 0 written · 100 full price");
	});

	test("the subagent share rides the model line, marked as the subagents'", () => {
		const text = formatCostState(
			{
				totalCostUSD: 0.5,
				totalDurationMs: 0,
				roleCostUSD: {},
				modelsUsage: {
					"p/m": {
						inputTokens: 1,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUSD: 0.5,
						subagentCostUSD: 0.2,
					},
				},
			},
			"This session",
		);
		// Beside the money rather than on a line of its own: it is a subset of
		// the amount it follows, and a second money line would read as additive.
		expect(text).toContain("p/m: 1 tokens, $0.5000 · $0.2000 from subagents");
	});

	test("a model only the session itself used says nothing about subagents", () => {
		const text = formatCostState(
			{
				totalCostUSD: 0.5,
				totalDurationMs: 0,
				roleCostUSD: {},
				modelsUsage: {
					"p/m": {
						inputTokens: 1,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUSD: 0.5,
						subagentCostUSD: 0,
					},
				},
			},
			"This session",
		);
		expect(text).not.toContain("subagents");
	});

	test("a configured ceiling prints the seat's spend against it", () => {
		// A budget the user set and cannot see the state of is one they find out
		// about by being refused; this line is the one that lets them look first.
		const text = formatCostState(
			{ ...emptyCostState(), totalCostUSD: 0.5, roleCostUSD: { light: 0.42 } },
			"This session",
			{
				light: 2,
			},
		);

		expect(text).toContain("roles.light: $0.4200 of $2.0000");
	});

	test("a configured ceiling with nothing spent still prints", () => {
		// "$0.0000 of $2.0000" is how a user finds out the seat they budgeted for
		// never ran — the failure that silence would hide.
		const text = formatCostState(emptyCostState(), "This session", { light: 2 });

		expect(text).toContain("roles.light: $0.0000 of $2.0000");
	});

	test("no configured ceiling means no seat line, even where a role spent", () => {
		// The lines are the budget's surface. Printing spend for every seat would
		// put a second money line under every session that ever spawned a
		// subagent, whether or not its user asked for a ceiling.
		const text = formatCostState({ ...emptyCostState(), roleCostUSD: { light: 0.42 } }, "This session");

		expect(text).not.toContain("roles.");
	});
});

describe("CostTracker sessions", () => {
	test("this session counts from the moment it began, not from the project's history", () => {
		// The project total is persisted across restarts; the session one is not,
		// or "this session" would mean "every session this directory has seen".
		const tracker = new CostTracker();
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ input: 1_000_000 }));
		tracker.beginSession();
		expect(tracker.state.totalCostUSD).toBeCloseTo(2, 10);
		expect(tracker.sessionState.totalCostUSD).toBe(0);
		tracker.recordUsage("anthropic", "claude-sonnet-5", usage({ output: 1_000_000 }));
		expect(tracker.sessionState.totalCostUSD).toBeCloseTo(10, 10);
		expect(tracker.state.totalCostUSD).toBeCloseTo(12, 10);
	});

	test("a resumed conversation opens with the spend its messages record", () => {
		const tracker = new CostTracker();
		tracker.beginSession([
			userMessage("hello"),
			assistantMessage({
				provider: "anthropic",
				model: "claude-sonnet-5",
				content: [{ type: "text", text: "hi" }],
				usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		]);
		expect(tracker.sessionState.modelsUsage["anthropic/claude-sonnet-5"]?.inputTokens).toBe(1_000_000);
		expect(tracker.sessionState.totalCostUSD).toBeCloseTo(2, 10);
	});
});

describe("formatCostReport", () => {
	test("both totals, each under a label that says which one it is", () => {
		const session = { ...emptyCostState(), totalCostUSD: 0.25 };
		const project = { ...emptyCostState(), totalCostUSD: 3 };
		const text = formatCostReport(session, project);
		expect(text).toContain("This session: $0.2500");
		expect(text).toContain("This project, all sessions: $3.0000");
	});

	test("an unpriced model is named rather than shown as free", () => {
		// Tokens from a model with no price are counted and cost nothing. Without
		// this line the report would claim a spend of zero for a session that cost
		// money, which is worse than saying it does not know.
		const priced: ModelUsage = {
			inputTokens: 10,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUSD: 0,
			subagentCostUSD: 0,
		};
		const text = formatCostReport(emptyCostState(), {
			totalCostUSD: 0,
			totalDurationMs: 0,
			modelsUsage: { "nobody/nothing": priced },
			roleCostUSD: {},
		});
		expect(text).toContain("No price is known for nobody/nothing");
		expect(text).toContain("settings.json");
	});

	test("a fully priced report says nothing about prices", () => {
		const bucket: ModelUsage = {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUSD: 2,
			subagentCostUSD: 0,
		};
		const text = formatCostReport(emptyCostState(), {
			totalCostUSD: 2,
			totalDurationMs: 0,
			modelsUsage: { "anthropic/claude-sonnet-5": bucket },
			roleCostUSD: {},
		});
		expect(text).not.toContain("No price is known");
	});

	test("the ceilings reach both halves of the report, each against its own total", () => {
		// "This session" is the number the gate enforces; the project row is what
		// earlier sessions recorded, and a reader who sees one line per report
		// would take the wrong one for the ceiling in force.
		const session = { ...emptyCostState(), totalCostUSD: 0.25, roleCostUSD: { light: 0.1 } };
		const project = { ...emptyCostState(), totalCostUSD: 3, roleCostUSD: { light: 1.5 } };

		const text = formatCostReport(session, project, { light: 2 });

		expect(text).toContain("roles.light: $0.1000 of $2.0000");
		expect(text).toContain("roles.light: $1.5000 of $2.0000");
	});
});
