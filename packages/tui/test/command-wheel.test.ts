/**
 * The wheel's ring and its window.
 *
 * Two lists become one ring: the command table, which the app already had, and
 * the phrases the user wrote in their settings. The order is the contract — a
 * ring whose entries moved around between presses would be a ring nobody could
 * learn — and the window is what keeps the highlight on screen, which is the
 * difference between pressing ✕ on a command and pressing ✕ on nothing.
 */
import { describe, expect, test } from "bun:test";
import { phraseLabel, WHEEL_ROWS, wheelEntries, wheelMove, wheelStart } from "../src/command-wheel.ts";

const COMMANDS: Array<[string, string]> = [
	["/help", "Show commands"],
	["/model", "Pick a model"],
	["/theme", "Pick a theme"],
];

describe("wheelEntries", () => {
	test("commands first, in the table's order, then the phrases", () => {
		const ring = wheelEntries(COMMANDS, ["run the tests", "explain this file"]);
		expect(ring.map((entry) => entry.label)).toEqual([
			"/help",
			"/model",
			"/theme",
			"run the tests",
			"explain this file",
		]);
		expect(ring.map((entry) => entry.kind)).toEqual(["command", "command", "command", "phrase", "phrase"]);
	});

	test("a command runs its own line, and carries its one-liner", () => {
		const [help] = wheelEntries(COMMANDS, []);
		expect(help.text).toBe("/help");
		expect(help.description).toBe("Show commands");
	});

	test("a phrase fills the prompt, so its text is the phrase itself", () => {
		const [, , , phrase] = wheelEntries(COMMANDS, ["run the tests"]);
		expect(phrase.text).toBe("run the tests");
		// Phrases have no description: the text is the description.
		expect(phrase.description).toBeUndefined();
	});

	test("an empty ring is a ring with nothing in it, not an undefined one", () => {
		expect(wheelEntries([], [])).toEqual([]);
	});
});

describe("wheelMove", () => {
	test("the selection wraps at both ends", () => {
		expect(wheelMove(3, 0, -1)).toBe(2);
		expect(wheelMove(3, 2, 1)).toBe(0);
		expect(wheelMove(3, 0, 1)).toBe(1);
	});

	test("a page-sized step moves by the page, and wraps when it runs off", () => {
		// Back five rows from the top of a twelve-entry ring: there is no room to
		// go up, so it comes round the bottom instead.
		expect(wheelMove(12, 0, -5)).toBe(7);
		expect(wheelMove(12, 11, 5)).toBe(4);
	});

	test("an empty ring has one position and stays on it", () => {
		expect(wheelMove(0, 0, 1)).toBe(0);
		expect(wheelMove(0, 0, -7)).toBe(0);
	});

	test("an index from nowhere is brought back into the ring", () => {
		// The ring is a ring: -1 and 2 are the same row of a three-entry wheel.
		expect(wheelMove(3, -1, 0)).toBe(2);
		expect(wheelMove(3, 5, 0)).toBe(2);
	});
});

describe("wheelStart", () => {
	test("the window does not scroll until the selection leaves it", () => {
		expect(wheelStart(10, 0)).toBe(0);
		expect(wheelStart(10, WHEEL_ROWS - 1)).toBe(0);
	});

	test("the window follows the selection off the bottom", () => {
		// One row past the window: the first row scrolls out.
		expect(wheelStart(10, WHEEL_ROWS)).toBe(1);
		expect(wheelStart(10, WHEEL_ROWS + 2)).toBe(3);
	});

	test("the last entry is on screen, and the window does not scroll past it", () => {
		expect(wheelStart(10, 9)).toBe(5);
		expect(wheelStart(10, 9) + WHEEL_ROWS).toBe(10);
		// The end of the ring is the end of the window: a step further does not
		// leave five blank rows under the last entry.
		expect(wheelStart(10, 999)).toBe(5);
	});

	test("a ring shorter than the window starts at the top", () => {
		expect(wheelStart(3, 2)).toBe(0);
		expect(wheelStart(1, 0)).toBe(0);
	});

	test("an empty ring has nothing to scroll", () => {
		expect(wheelStart(0, 0)).toBe(0);
	});
});

describe("phraseLabel", () => {
	test("a phrase written across lines becomes one row", () => {
		expect(phraseLabel("run\n  the   tests")).toBe("run the tests");
	});

	test("a long phrase is cut, and the cut is visible", () => {
		const long = "x".repeat(200);
		const label = phraseLabel(long, 10);
		expect(label).toBe(`${"x".repeat(9)}…`);
		expect(label.length).toBe(10);
	});

	test("a phrase exactly the width is not cut", () => {
		expect(phraseLabel("x".repeat(10), 10)).toBe("x".repeat(10));
	});
});
