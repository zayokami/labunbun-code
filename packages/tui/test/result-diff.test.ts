/**
 * The two functions behind a tool result's diff coloring: whether a block reads
 * as a diff at all ({@link looksLikeDiff}), and what each line wears once it
 * does ({@link resultLineColor}).
 *
 * Asserted as values rather than through a frame: ink draws no color without a
 * TTY, which is every test run. The cases that carry the weight are the
 * negatives — a lone marker, plain output — because a detector that says yes to
 * everything turns prose red, and prose is most of what a tool prints.
 */
import { describe, expect, test } from "bun:test";
import { looksLikeDiff, resultLineColor } from "../src/components/MessageList.tsx";
import { DARK_THEME } from "../src/theme.ts";

describe("looksLikeDiff", () => {
	test("a hunk header is a claim on its own", () => {
		expect(looksLikeDiff(["@@ -1,3 +1,4 @@"])).toBe(true);
		expect(looksLikeDiff(["unchanged context", "@@ -1 +1 @@", "+one", "-two"])).toBe(true);
	});

	test("a top-level diff is a diff even with no space after the marker", () => {
		// The old test asked for `\n+ ` — a marker followed by a space — which is
		// not what a diff looks like: git writes `+const x`, and the whole point
		// of the new rule is that these lines count.
		expect(looksLikeDiff(["-old()", "+new()", "+also()"])).toBe(true);
		expect(looksLikeDiff(["-old()", "-also()"])).toBe(true);
	});

	test("a marker has to repeat before it counts", () => {
		// A lone `- item` is a markdown bullet, and a lone `+` is prose about
		// arithmetic far more often than either is a diff line. A real diff that
		// short still carries its `@@` header, so nothing that is a diff is lost.
		expect(looksLikeDiff(["Here is the list:", "- item"])).toBe(false);
		expect(looksLikeDiff(["total is 1", "+ 2"])).toBe(false);
		// Even two markers are not enough when they share no prefix: `- a` then
		// `+ b` is a list with an aside, not a change.
		expect(looksLikeDiff(["- a", "+ b"])).toBe(false);
	});

	test("output with no markers at all is not a diff", () => {
		expect(looksLikeDiff([])).toBe(false);
		expect(looksLikeDiff(["a.txt", "b.txt", "dir/"])).toBe(false);
		// A line that merely contains a marker is not a line that starts on one.
		expect(looksLikeDiff(["use flag -v", "prefix ++", "mail a@b"])).toBe(false);
	});
});

describe("resultLineColor", () => {
	test("in a diff, each marker wears its own diff token", () => {
		expect(resultLineColor("+added", false, true, DARK_THEME)).toBe(DARK_THEME.diffAdded);
		expect(resultLineColor("-gone", false, true, DARK_THEME)).toBe(DARK_THEME.diffRemoved);
		expect(resultLineColor("@@ -1 +1 @@", false, true, DARK_THEME)).toBe(DARK_THEME.diffHeader);
	});

	test("everything else is the tool output, however the block was judged", () => {
		// The context lines around a change, and every line of a block that is not
		// a diff at all — including the markdown list the detector just refused.
		expect(resultLineColor(" unchanged", false, true, DARK_THEME)).toBe(DARK_THEME.toolOutput);
		expect(resultLineColor("- item", false, false, DARK_THEME)).toBe(DARK_THEME.toolOutput);
		expect(resultLineColor("+added", false, false, DARK_THEME)).toBe(DARK_THEME.toolOutput);
	});

	test("a failed call's lines are the error's, markers included", () => {
		// `git diff` that failed prints markers on stderr; a green line inside a
		// result the caller already flagged as failed would contradict the flag.
		expect(resultLineColor("+added", true, true, DARK_THEME)).toBe(DARK_THEME.error);
		expect(resultLineColor("-gone", true, false, DARK_THEME)).toBe(DARK_THEME.error);
	});
});
