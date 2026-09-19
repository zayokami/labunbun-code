/**
 * Reverse history search.
 *
 * ↑ walks history one entry at a time, which is the wrong tool for the case
 * people actually have: they remember a few words of a prompt from an hour ago,
 * not how many prompts ago it was. What is pinned here is which entries match,
 * which one is selected, and that walking off the end comes back around rather
 * than dead-ending on a key that does nothing.
 */
import { describe, expect, test } from "bun:test";
import { HISTORY_SEARCH_MAX, historyMatches, searchSelection, searchSelectionIndex } from "../src/history-search.ts";

describe("historyMatches", () => {
	test("matches a substring and returns the newest first", () => {
		expect(historyMatches(["run the tests", "fix the build", "run the linter"], "run")).toEqual([
			"run the linter",
			"run the tests",
		]);
	});

	test("ignores case in both directions", () => {
		expect(historyMatches(["Fix The Build"], "fix the")).toEqual(["Fix The Build"]);
		expect(historyMatches(["fix the build"], "FIX THE")).toEqual(["fix the build"]);
	});

	test("an empty query matches everything, which is how the search opens", () => {
		expect(historyMatches(["a", "b", "c"], "")).toEqual(["c", "b", "a"]);
	});

	test("keeps the newest few, not the oldest", () => {
		const history = Array.from({ length: 20 }, (_, i) => `prompt ${i}`);
		const matches = historyMatches(history, "prompt");
		expect(matches).toHaveLength(HISTORY_SEARCH_MAX);
		expect(matches[0]).toBe("prompt 19");
	});

	test("no match is an empty list, not everything", () => {
		expect(historyMatches(["run the tests"], "deploy")).toEqual([]);
	});
});

describe("searchSelectionIndex", () => {
	test("wraps in both directions instead of dead-ending", () => {
		expect(searchSelectionIndex(["a", "b", "c"], 0)).toBe(0);
		expect(searchSelectionIndex(["a", "b", "c"], 3)).toBe(0);
		expect(searchSelectionIndex(["a", "b", "c"], 4)).toBe(1);
		expect(searchSelectionIndex(["a", "b", "c"], -1)).toBe(2);
	});

	test("nothing to select is -1, not 0", () => {
		expect(searchSelectionIndex([], 0)).toBe(-1);
		expect(searchSelection([], 0)).toBeUndefined();
	});

	test("selects the entry the index points at", () => {
		expect(searchSelection(["newest", "older"], 1)).toBe("older");
	});
});
