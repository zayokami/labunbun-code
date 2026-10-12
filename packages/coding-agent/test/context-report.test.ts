/**
 * What `/context` says, given numbers.
 *
 * The rows are formatted here and drawn by the TUI, so this is the layer that
 * can be held to the arithmetic: the free row is measured to the point where
 * the session compacts, the reserve is what sits between there and the model's
 * refusal, and the two of them together have to describe the same window the
 * bar does.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ContextBreakdown, PreservedFile } from "@labunbun/agent";
import {
	type ContextLimits,
	contextRows,
	contextSummaryLine,
	isContextLow,
	lowContextWarning,
	type PreservedFilesDrift,
	preservedFilesDrift,
} from "../src/context-report.ts";

const BREAKDOWN: ContextBreakdown = {
	usedTokens: 20_000,
	systemPromptTokens: 5_000,
	toolSchemaTokens: 3_000,
	messageTokens: 12_000,
	toolResultTokens: 8_000,
	toolResultCount: 2,
};

const LIMITS: ContextLimits = { contextWindow: 200_000, threshold: 178_808, hardLimit: 197_000 };

const rowOf = (rows: Array<[string, string]>, label: string) => rows.find(([name]) => name === label)?.[1];

describe("contextRows", () => {
	test("rows in reading order: what it is made of, then what is left", () => {
		const rows = contextRows(BREAKDOWN, LIMITS);
		expect(rows.map(([label]) => label)).toEqual([
			"System prompt",
			"Tool schemas",
			"Messages",
			"Free before auto-compact",
			"Reserved beyond that",
		]);
		expect(rowOf(rows, "System prompt")).toBe("5.0k");
		expect(rowOf(rows, "Tool schemas")).toBe("3.0k");
		expect(rowOf(rows, "Messages")).toBe("12.0k (of which 8.0k in 2 tool results)");
	});

	test("free is measured to the auto-compact point, reserve to the hard limit", () => {
		// Two different questions: how much can still be written before the session
		// acts, and how much room sits between acting and being refused.
		const rows = contextRows(BREAKDOWN, LIMITS);
		expect(rowOf(rows, "Free before auto-compact")).toBe("158.8k");
		expect(rowOf(rows, "Reserved beyond that")).toBe("18.2k");
	});

	test("a context already past the point reports no negative room", () => {
		const rows = contextRows({ ...BREAKDOWN, usedTokens: 190_000 }, LIMITS);
		expect(rowOf(rows, "Free before auto-compact")).toBe("0");
	});

	test("one tool result is not called a tool results plural", () => {
		const rows = contextRows({ ...BREAKDOWN, toolResultCount: 1 }, LIMITS);
		expect(rowOf(rows, "Messages")).toBe("12.0k (of which 8.0k in 1 tool result)");
	});

	test("no tool results means no aside about them", () => {
		const rows = contextRows({ ...BREAKDOWN, toolResultCount: 0, toolResultTokens: 0 }, LIMITS);
		expect(rowOf(rows, "Messages")).toBe("12.0k");
	});

	test("memory is called out only when there is any, and says where it lives", () => {
		// Memory is a section of the system prompt, so its tokens are already in
		// the System prompt row above; the row appears because it is the part of
		// that prompt the user wrote, and it says so rather than reading as a
		// second helping of the same tokens.
		const absent = contextRows(BREAKDOWN, LIMITS);
		expect(rowOf(absent, "Memory")).toBeUndefined();

		const present = contextRows(BREAKDOWN, LIMITS, { memoryChars: 4_400 });
		expect(rowOf(present, "Memory")).toBe("1.1k (part of the system prompt)");
	});
});

describe("what the rows say about compaction", () => {
	test("no store, no row — and a store with nothing done says exactly that", () => {
		// Absent without a session file, the way the memory row is absent without
		// memory files: a row about something that does not exist would be invented.
		// A session that has a file and has never compacted is a different answer,
		// and "none yet" is it.
		expect(rowOf(contextRows(BREAKDOWN, LIMITS), "Compactions")).toBeUndefined();
		expect(rowOf(contextRows(BREAKDOWN, LIMITS, { compactions: { count: 0 } }), "Compactions")).toBe("none yet");
	});

	test("a count, and the reason and sizes of the one that shaped the context", () => {
		const rows = contextRows(BREAKDOWN, LIMITS, {
			compactions: { count: 3, last: { trigger: "overflow", preTokens: 118_000, postTokens: 6_200 } },
		});
		expect(rowOf(rows, "Compactions")).toBe("3 this session");
		expect(rowOf(rows, "Last compaction")).toBe("overflow · 118.0k → 6.2k");
	});

	test("an imported compaction says its size was not recorded rather than reporting zero", () => {
		// Migrated records carry no measured `postTokens`, and "50.0k → 0" would
		// read as the most effective summary in the session's life.
		const rows = contextRows(BREAKDOWN, LIMITS, {
			compactions: { count: 1, last: { trigger: "manual", preTokens: 50_000, postTokens: 0 } },
		});
		expect(rowOf(rows, "Last compaction")).toBe("manual · size not recorded");
	});

	test("they sit with the numbers they are read against", () => {
		// Below what the context is made of, above what is left: the count is what
		// says whether the free rows are a number this session has already acted on.
		const rows = contextRows(BREAKDOWN, LIMITS, {
			memoryChars: 4_400,
			compactions: { count: 1, last: { trigger: "auto", preTokens: 118_000, postTokens: 6_200 } },
		});
		expect(rows.map(([label]) => label)).toEqual([
			"System prompt",
			"Tool schemas",
			"Messages",
			"Memory",
			"Compactions",
			"Last compaction",
			"Free before auto-compact",
			"Reserved beyond that",
		]);
	});
});

describe("preservedFilesDrift", () => {
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");

	test("tells an unchanged file, a changed one, and every way of not knowing apart", () => {
		// Four answers a fingerprint can give, and only one of them is agreement:
		// the same bytes, different bytes, nothing readable to compare against now,
		// and no fingerprint from before to compare with at all. Folding any two
		// of these together is how "unreadable then" would read as "unchanged".
		// Two unchanged files against one changed, on purpose: with one of each,
		// flipping the comparison swaps the buckets and leaves the counts equal —
		// this assertion would pass on the exact bug it exists to catch.
		const files: PreservedFile[] = [
			{ path: "/same.ts", hash: sha("same") },
			{ path: "/also-same.ts", hash: sha("also same") },
			{ path: "/edited.ts", hash: sha("old content") },
			{ path: "/deleted.ts", hash: sha("was here") },
			{ path: "/no-hash.ts" },
			"bare-string-legacy.ts",
		];
		const drift = preservedFilesDrift(files, (path) =>
			path === "/same.ts"
				? "same"
				: path === "/also-same.ts"
					? "also same"
					: path === "/edited.ts"
						? "new content"
						: null,
		);
		expect(drift).toEqual({ total: 6, unchanged: 2, changed: 1, unreadable: 1, unfingerprinted: 2 });
	});
});

describe("the kept-files row", () => {
	const compactions = { count: 1, last: { trigger: "auto" as const, preTokens: 118_000, postTokens: 6_200 } };
	const drift = (parts: Partial<PreservedFilesDrift>): PreservedFilesDrift => ({
		total: 0,
		unchanged: 0,
		changed: 0,
		unreadable: 0,
		unfingerprinted: 0,
		...parts,
	});

	test("says which kept files still match the summary, and which do not", () => {
		// The row a user checks before trusting the summary about a file: the
		// record's whole claim is "the summary still describes this", and this is
		// the claim tested against the disk.
		expect(
			rowOf(
				contextRows(BREAKDOWN, LIMITS, { compactions, keptFiles: drift({ total: 2, unchanged: 2 }) }),
				"Kept files",
			),
		).toBe("2 kept, unchanged since the summary");
		expect(
			rowOf(
				contextRows(BREAKDOWN, LIMITS, { compactions, keptFiles: drift({ total: 2, changed: 1, unchanged: 1 }) }),
				"Kept files",
			),
		).toBe("1 changed since the summary, 1 unchanged");
		expect(
			rowOf(
				contextRows(BREAKDOWN, LIMITS, {
					compactions,
					keptFiles: drift({ total: 3, changed: 1, unreadable: 1, unchanged: 1 }),
				}),
				"Kept files",
			),
		).toBe("1 changed since the summary, 1 unreadable now, 1 unchanged");
	});

	test("no fingerprints reads as exactly that, not as unchanged", () => {
		// A migrated record or a pass that could not read the files: there is
		// nothing to compare, and a row that said "unchanged" would be agreement
		// no one checked for.
		expect(
			rowOf(
				contextRows(BREAKDOWN, LIMITS, { compactions, keptFiles: drift({ total: 2, unfingerprinted: 2 }) }),
				"Kept files",
			),
		).toBe("2 kept, no fingerprints to compare");
	});

	test("absent without a drift, like every other row about nothing", () => {
		expect(rowOf(contextRows(BREAKDOWN, LIMITS, { compactions }), "Kept files")).toBeUndefined();
		expect(
			rowOf(
				contextRows(BREAKDOWN, LIMITS, {
					compactions,
					keptFiles: drift({ total: 0 }),
				}),
				"Kept files",
			),
		).toBeUndefined();
	});
});

describe("the low-context warning", () => {
	test("fires at the warning line, and not below it", () => {
		expect(isContextLow(800, 1_000)).toBe(true);
		expect(isContextLow(799, 1_000)).toBe(false);
	});

	test("a session with no threshold to warn about says nothing", () => {
		expect(isContextLow(10, 0)).toBe(false);
	});

	test("names what to do about it, cheapest first", () => {
		const warning = lowContextWarning(1_600, 2_000);
		expect(warning).toContain("80%");
		expect(warning).toContain("1.6k of 2.0k");
		expect(warning.indexOf("/trim")).toBeLessThan(warning.indexOf("/compact"));
	});

	test("names no command that does not exist", () => {
		// Advice is only worth printing if following it works. `/new` was in an
		// earlier draft of this line and is not a command: a user who reads it and
		// types it gets "unknown command" at the moment they most need one that works.
		const warning = lowContextWarning(1_600, 2_000);
		expect(warning).not.toContain("/new");
		expect(warning).not.toContain("/fork");
	});
});

describe("contextSummaryLine", () => {
	test("one line, the same ratio the bar draws", () => {
		expect(contextSummaryLine(BREAKDOWN, LIMITS)).toBe(
			"Context: 11% of the auto-compact point (20.0k of 178.8k; 158.8k free).",
		);
	});

	test("past the point it reports the overage rather than negative room", () => {
		const line = contextSummaryLine({ ...BREAKDOWN, usedTokens: 190_000 }, LIMITS);
		expect(line).toContain("106%");
		expect(line).toContain("0 free");
	});
});
