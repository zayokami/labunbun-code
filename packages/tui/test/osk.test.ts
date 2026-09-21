/**
 * The on-screen keyboard's arithmetic, with no screen in it.
 *
 * A keyboard driven by a d-pad has one failure that a keyboard driven by ten
 * fingers does not: the cursor can be asked to stand somewhere there is no key.
 * Every row on the letters page is a different length — that is what a keyboard
 * looks like — so "down" from the end of `qwertyuiop` leaves the cursor past the
 * end of `asdfghjkl`. Clamping is what keeps a highlight on a cell, and these
 * tests are where that is pinned down.
 */
import { describe, expect, test } from "bun:test";
import {
	OSK_PAGES,
	type OskPage,
	oskClamp,
	oskKeyAt,
	oskLabel,
	oskMove,
	oskPage,
	oskTurn,
	oskType,
} from "../src/osk.ts";

const LETTERS = oskPage(0);

/** Where the cursor ends up after a run of pushes. */
const walk = (
	page: OskPage,
	from: { row: number; col: number },
	steps: readonly ("up" | "down" | "left" | "right")[],
) => steps.reduce((cursor, step) => oskMove(page, cursor, step), from);

describe("oskPage", () => {
	test("three pages, and the index is a ring rather than a range", () => {
		expect(OSK_PAGES.map((page) => page.name)).toEqual(["letters", "digits", "symbols"]);
		expect(oskPage(0).name).toBe("letters");
		expect(oskPage(3).name).toBe("letters");
		expect(oskPage(-1).name).toBe("symbols");
		expect(oskPage(-4).name).toBe("symbols"); // -4 and -1 are the same page
	});
});

describe("oskTurn", () => {
	test("L1 and R1 wrap at both ends", () => {
		expect(oskTurn(0, 1)).toBe(1);
		expect(oskTurn(2, 1)).toBe(0);
		expect(oskTurn(0, -1)).toBe(2);
	});
});

describe("oskClamp", () => {
	test("a cursor past the end of a short row is pulled back onto a key", () => {
		// Row 1 is nine wide; a cursor that kept the ten it had would be one cell
		// off the end of the keyboard.
		expect(oskClamp(LETTERS, { row: 1, col: 9 })).toEqual({ row: 1, col: 8 });
		expect(oskKeyAt(LETTERS, { row: 1, col: 9 }).label).toBe("l");
	});

	test("a cursor off the page entirely lands on the nearest cell", () => {
		expect(oskClamp(LETTERS, { row: -3, col: -2 })).toEqual({ row: 0, col: 0 });
		expect(oskClamp(LETTERS, { row: 99, col: 99 })).toEqual({ row: 3, col: 3 });
	});

	test("a fractional cursor is a whole one", () => {
		expect(oskClamp(LETTERS, { row: 1.7, col: 2.4 })).toEqual({ row: 1, col: 2 });
	});

	test("every position on every page holds a key", () => {
		for (const page of OSK_PAGES) {
			for (let row = -2; row <= page.rows.length + 2; row++) {
				for (let col = -2; col <= 14; col++) {
					expect(oskKeyAt(page, { row, col })).toBeDefined();
				}
			}
		}
	});
});

describe("oskMove", () => {
	test("down from the end of one row lands on a key in the next", () => {
		const at = walk(LETTERS, { row: 0, col: 9 }, ["down"]);
		expect(at).toEqual({ row: 1, col: 8 });
		// And the cell it lands on is the row's last, not a phantom tenth.
		expect(oskKeyAt(LETTERS, at).label).toBe("l");
	});

	test("the walk down the ragged edge stays on keys the whole way", () => {
		const at = walk(LETTERS, { row: 0, col: 9 }, ["down", "down", "down"]);
		expect(at).toEqual({ row: 3, col: 3 });
		// Row widths from the letters page: 10, 9, 7, 4.
		expect(oskKeyAt(LETTERS, at).command).toBe("submit");
	});

	test("there is no wrapping inside a row", () => {
		// Right from the end of a row stays there; the keyboard is a picture of
		// where the keys are, and jumping to the far end would contradict it.
		expect(walk(LETTERS, { row: 0, col: 9 }, ["right"])).toEqual({ row: 0, col: 9 });
		expect(walk(LETTERS, { row: 0, col: 0 }, ["left"])).toEqual({ row: 0, col: 0 });
		expect(walk(LETTERS, { row: 0, col: 0 }, ["up"])).toEqual({ row: 0, col: 0 });
		expect(walk(LETTERS, { row: 3, col: 0 }, ["down"])).toEqual({ row: 3, col: 0 });
	});

	test("clamping is sticky: a short row does not hand the column back", () => {
		// Down onto the narrow row, then back up. The cursor keeps the column it
		// was actually on, so the highlight is where the user last saw it.
		const down = walk(LETTERS, { row: 0, col: 9 }, ["down"]);
		expect(down).toEqual({ row: 1, col: 8 });
		expect(walk(LETTERS, down, ["up"])).toEqual({ row: 0, col: 8 });
	});
});

describe("oskType and oskLabel", () => {
	test("shift capitalises letters and nothing else", () => {
		const q = oskKeyAt(LETTERS, { row: 0, col: 0 });
		expect(oskType(q, false)).toBe("q");
		expect(oskType(q, true)).toBe("Q");
		expect(oskLabel(q, true)).toBe("Q");

		// The digits page has no letters on it, so shift is not offered there —
		// and if it were somehow on, it would type the same characters.
		const digits = oskPage(1);
		for (const row of digits.rows) {
			for (const key of row) {
				expect(oskType(key, true)).toBe(oskType(key, false));
			}
		}
	});

	test("shift leaves the keys that have no case alone", () => {
		// "space" is not a letter. If shift took it for one, the caption would
		// shout and, worse, the rule would be "shift capitalises everything it
		// can", which is not what a keyboard does to a digit either.
		expect(oskLabel(oskKeyAt(LETTERS, { row: 3, col: 1 }), true)).toBe("space");
	});

	test("the command keys type nothing", () => {
		expect(oskType(oskKeyAt(LETTERS, { row: 3, col: 0 }), false)).toBeUndefined(); // shift
		expect(oskType(oskKeyAt(LETTERS, { row: 3, col: 2 }), false)).toBeUndefined(); // ⌫
		expect(oskType(oskKeyAt(LETTERS, { row: 3, col: 3 }), false)).toBeUndefined(); // ⏎
	});

	test("space types a space, which is the point of it being a key", () => {
		expect(oskType(oskKeyAt(LETTERS, { row: 3, col: 1 }), false)).toBe(" ");
	});
});

/**
 * The two properties a keyboard you cannot walk away from has to have: every
 * page can send, and every page can delete.
 */
describe("every page stands on its own", () => {
	test("each page has a return, a backspace and a space", () => {
		for (const page of OSK_PAGES) {
			const bottom = page.rows.at(-1) ?? [];
			const commands = bottom.map((key) => key.command);
			expect(commands).toContain("submit");
			expect(commands).toContain("backspace");
			expect(bottom.some((key) => key.insert === " ")).toBe(true);
		}
	});

	test("only the page with letters on it offers shift", () => {
		const hasShift = (page: OskPage) => page.rows.some((row) => row.some((key) => key.command === "shift"));
		expect(hasShift(oskPage(0))).toBe(true);
		expect(hasShift(oskPage(1))).toBe(false);
		expect(hasShift(oskPage(2))).toBe(false);
	});
});
