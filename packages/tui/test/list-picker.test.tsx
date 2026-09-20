/**
 * The picker's two optional hooks.
 *
 * `/theme` uses them to preview the highlighted theme and to put the old one
 * back when the picker is dismissed, which only works if the highlight hook
 * fires on movement and nowhere else: firing it when the list opens would apply
 * a theme the user never reached, and not firing it on Esc would leave the
 * preview on screen after a cancel.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { ListPickerDialog } from "../src/components/ListPickerDialog.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the dialog takes: a label, and optionally the line under it. */
interface PickerItem {
	label: string;
	description?: string;
}

const ITEMS: PickerItem[] = [{ label: "dark" }, { label: "light" }, { label: "nord" }];

function open(withHooks: boolean, initialIndex?: number, items: PickerItem[] = ITEMS) {
	const highlights: number[] = [];
	let cancels = 0;
	let result: number | null | undefined;
	const { stdin, lastFrame, unmount } = render(
		(
			<ThemeContext.Provider value={DARK_THEME}>
				<ListPickerDialog
					title="Theme"
					items={items}
					initialIndex={initialIndex}
					resolve={(index) => (result = index)}
					onHighlight={withHooks ? (i) => highlights.push(i) : undefined}
					onCancel={withHooks ? () => cancels++ : undefined}
				/>
			</ThemeContext.Provider>
		) as React.ReactElement,
	);
	return {
		stdin,
		highlights,
		cancels: () => cancels,
		result: () => result,
		frame: () => (lastFrame() ?? "").replace(/\s+/g, " "),
		unmount,
	};
}

describe("ListPickerDialog preview hooks", () => {
	test("opening the list previews nothing", async () => {
		const p = open(true);
		await delay(30);
		expect(p.highlights).toEqual([]);
		p.unmount();
	});

	test("moving the highlight reports where it landed, both directions", async () => {
		const p = open(true);
		await delay(30);
		p.stdin.write("\x1b[B"); // down -> light
		await delay(30);
		p.stdin.write("\x1b[B"); // down -> nord
		await delay(30);
		p.stdin.write("\x1b[A"); // up -> light
		await delay(30);
		expect(p.highlights).toEqual([1, 2, 1]);
		expect(p.frame()).toContain("light");
		p.unmount();
	});

	test("the highlight wraps, and reports the wrapped index", async () => {
		const p = open(true);
		await delay(30);
		p.stdin.write("\x1b[A"); // up from the first entry
		await delay(30);
		expect(p.highlights).toEqual([ITEMS.length - 1]);
		p.unmount();
	});

	test("Esc hands the preview back before it resolves", async () => {
		const p = open(true);
		await delay(30);
		p.stdin.write("\x1b[B");
		await delay(30);
		p.stdin.write("\x1b");
		await delay(30);
		expect(p.cancels()).toBe(1);
		expect(p.result()).toBeNull();
		p.unmount();
	});

	test("choosing keeps the preview and does not cancel it", async () => {
		const p = open(true);
		await delay(30);
		p.stdin.write("\x1b[B");
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(1);
		expect(p.cancels()).toBe(0);
		p.unmount();
	});

	// /resume and /model pass no hooks at all; the dialog is the same dialog.
	test("a picker without hooks still picks", async () => {
		const p = open(false);
		await delay(30);
		p.stdin.write("\x1b[B");
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(1);
		p.unmount();
	});
});

/**
 * Opening on a row, for lists that have a current one: `/theme` opens on the
 * configured theme. Without it the highlight starts at the top, so Enter picks
 * the first entry — which for the theme picker wrote that entry down over the
 * setting the user actually had.
 */
describe("ListPickerDialog opening on a row", () => {
	test("Enter takes the row it opened on, and opening is not a move", async () => {
		const p = open(true, 2);
		await delay(30);
		// The preview hook must not hear about a highlight nobody moved.
		expect(p.highlights).toEqual([]);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(2);
		p.unmount();
	});

	test("the arrows move from the row it opened on, not from the top", async () => {
		const p = open(true, 2);
		await delay(30);
		p.stdin.write("\x1b[A"); // up from the last entry
		await delay(30);
		expect(p.highlights).toEqual([1]);
		p.unmount();
	});

	// A caller computing the index from a list that no longer holds it (a theme
	// file deleted since the setting was written) must not open with nothing
	// highlighted.
	test("an index outside the list opens on the nearest row", async () => {
		const past = open(false, 99);
		await delay(30);
		past.stdin.write("\r");
		await delay(30);
		expect(past.result()).toBe(ITEMS.length - 1);
		past.unmount();

		const below = open(false, -1);
		await delay(30);
		below.stdin.write("\r");
		await delay(30);
		expect(below.result()).toBe(0);
		below.unmount();
	});
});

/**
 * Indices a caller can compute without meaning to.
 *
 * `Math.max(indexOf(name), 0)` covers the -1 that a lookup miss gives, but not
 * the other ways a number goes missing: an `undefined` through `Math.floor`, an
 * arithmetic slip, a division. Clamping those the way -1 is clamped is the
 * difference between a list that opens on a row and one that opens on none —
 * with a highlight that cannot be moved off it (every arrow key moves from NaN
 * to NaN) and an answer (`NaN`, or `1.9`) that no item has, which the caller
 * then indexes its own array with.
 */
describe("ListPickerDialog given an index that is not one", () => {
	test("NaN opens on the first row instead of on no row", async () => {
		const p = open(true, Number.NaN);
		await delay(30);
		expect(p.frame()).toContain(`${DARK_THEME.marks.selected} dark`);

		// The arrows have to still work: `(NaN + 1) % 3` is NaN, so a selection
		// that starts as NaN never moves again.
		p.stdin.write("\x1b[B");
		await delay(30);
		expect(p.highlights).toEqual([1]);

		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(1);
		p.unmount();
	});

	test("a fractional index lands on a whole row", async () => {
		const p = open(false, 1.9);
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(1);
		p.unmount();
	});

	test("a fractional index past the end is clamped like a whole one", async () => {
		const p = open(false, 99.5);
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(ITEMS.length - 1);
		p.unmount();
	});

	test("an infinite index opens on a row", async () => {
		const p = open(false, Number.POSITIVE_INFINITY);
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(ITEMS.length - 1);
		p.unmount();
	});
});

/**
 * A list nobody would write, handed to a dialog that must survive it anyway.
 *
 * The theme list is built from names, and names come from files: two files can
 * carry the same `name`, and a file can carry a name a built-in already has, so
 * the picker is not entitled to assume its labels are distinct. Rows are keyed
 * by position for that reason — a label is not an identity.
 */
describe("ListPickerDialog on a list with repeats", () => {
	test("two rows labelled alike are two rows, and picking the second says so", async () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		try {
			const p = open(true, undefined, [
				{ label: "dark", description: "built-in" },
				{ label: "dark", description: "from a theme file" },
			]);
			await delay(30);
			expect(p.frame()).toContain("built-in");
			expect(p.frame()).toContain("from a theme file");

			p.stdin.write("\x1b[B");
			await delay(30);
			p.stdin.write("\r");
			await delay(30);
			expect(p.result()).toBe(1);
			p.unmount();
		} finally {
			console.error = original;
		}
		// React's own complaint, not ours: siblings keyed by the same label are
		// how a duplicate row turns into unpredictable rendering.
		expect(errors.filter((line) => line.includes("same key"))).toEqual([]);
	});
});

/** The scroll window, at the edges where an off-by-one lives. */
describe("ListPickerDialog scrolling", () => {
	const many = (count: number) => Array.from({ length: count }, (_, i) => ({ label: `t${i}` }));

	test("a list that fits shows no counter at all", async () => {
		const p = open(false, 7, many(8));
		await delay(30);
		expect(p.frame()).toContain(`${DARK_THEME.marks.selected} t7`);
		expect(p.frame()).not.toContain(" of ");
		p.unmount();
	});

	test("one row too many scrolls, and says which rows are up", async () => {
		const p = open(false, 8, many(9));
		await delay(30);
		expect(p.frame()).toContain("2-9 of 9");
		expect(p.frame()).toContain(`${DARK_THEME.marks.selected} t8`);
		// The first row is above the window, not in it.
		expect(p.frame()).not.toContain("t0");
		p.unmount();
	});

	test("an index clamped onto the last row scrolls the window with it", async () => {
		const p = open(false, 500, many(20));
		await delay(30);
		expect(p.frame()).toContain(`${DARK_THEME.marks.selected} t19`);
		expect(p.frame()).toContain("13-20 of 20");
		p.unmount();
	});
});

/**
 * An empty list is not a reason to crash or to answer.
 *
 * `pickFromList` is general, and the caller that hands it nothing gets a null —
 * the same answer as Esc — rather than a resolved `undefined` index or an
 * unhandled rejection.
 */
describe("ListPickerDialog with nothing to show", () => {
	test("Enter cancels instead of picking nothing", async () => {
		const p = open(true, undefined, []);
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBeNull();
		expect(p.cancels()).toBe(1);
		p.unmount();
	});

	test("Esc cancels, and the arrows have nothing to move", async () => {
		const p = open(true, undefined, []);
		await delay(30);
		p.stdin.write("\x1b[B");
		await delay(30);
		p.stdin.write("\x1b[A");
		await delay(30);
		expect(p.highlights).toEqual([]);
		expect(p.result()).toBeUndefined(); // still open

		p.stdin.write("\x1b");
		await delay(30);
		expect(p.result()).toBeNull();
		p.unmount();
	});

	test("a one-row list wraps onto itself instead of counting off the end", async () => {
		const p = open(false, undefined, [{ label: "only" }]);
		await delay(30);
		p.stdin.write("\x1b[A");
		await delay(30);
		p.stdin.write("\x1b[B");
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(0);
		p.unmount();
	});
});
