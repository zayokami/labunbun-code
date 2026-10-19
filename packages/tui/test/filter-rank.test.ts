import { describe, expect, test } from "bun:test";
import { rankItems } from "../src/filter-rank.ts";

interface Row {
	label: string;
	description?: string;
}

const fields = (row: Row) => [row.label, row.description ?? ""];

describe("rankItems", () => {
	test("an empty query keeps every row in the caller's order", () => {
		const rows: Row[] = [{ label: "beta" }, { label: "alpha" }, { label: "gamma" }];
		expect(rankItems(rows, "", fields)).toEqual([0, 1, 2]);
		expect(rankItems(rows, "   ", fields)).toEqual([0, 1, 2]);
	});

	test("the four tiers come in order: prefix, word start, substring, subsequence", () => {
		const rows: Row[] = [
			{ label: "beta" },
			{ label: "alpha-test" },
			{ label: "xtestx" },
			{ label: "t-e-s-t" },
			{ label: "test" },
		];
		expect(rankItems(rows, "test", fields)).toEqual([4, 1, 2, 3]);
	});

	test("matches at the same tier stay in the caller's order", () => {
		const rows: Row[] = [{ label: "x-one" }, { label: "x-two" }, { label: "x-three" }];
		expect(rankItems(rows, "x-", fields)).toEqual([0, 1, 2]);
	});

	test("a description match counts, and a better tier in one field wins", () => {
		const rows: Row[] = [
			{ label: "/resume", description: "Resume an earlier session" },
			{ label: "/rename", description: "Title this session" },
			{ label: "/theme", description: "Show or switch the theme" },
		];
		expect(rankItems(rows, "session", fields)).toEqual([0, 1]);
		// /rename is a word-start prefix; /resume only matches as a subsequence
		// of "Resume an earlier session", so it sorts last.
		expect(rankItems(rows, "ren", fields)).toEqual([1, 0]);
		// The slash menu turns the loose tier off; the same query is now one row.
		expect(rankItems(rows, "ren", fields, { subsequence: false })).toEqual([1]);
	});

	test("matching ignores case", () => {
		const rows: Row[] = [{ label: "Alpha" }, { label: "beta" }];
		expect(rankItems(rows, "ALP", fields)).toEqual([0]);
	});

	test("punctuation counts as a word boundary", () => {
		const rows: Row[] = [{ label: "/rename" }, { label: "/resume" }];
		// "rename" starts a word after the slash; "sume" in resume does not.
		expect(rankItems(rows, "rename", fields)).toEqual([0]);
	});

	test("rows that match no field are left out", () => {
		const rows: Row[] = [{ label: "alpha" }, { label: "beta" }];
		expect(rankItems(rows, "zzz", fields)).toEqual([]);
	});

	test("an empty list stays empty", () => {
		expect(rankItems([], "x", fields)).toEqual([]);
	});
});
