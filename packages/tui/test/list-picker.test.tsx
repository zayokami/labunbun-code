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

describe("ListPickerDialog filtering", () => {
	const ITEMS: PickerItem[] = [
		{ label: "alpha", description: "the first one" },
		{ label: "beta", description: "the second match" },
		{ label: "gamma", description: "the third one" },
	];

	test("typing filters by label and description", async () => {
		const p = open(false, undefined, ITEMS);
		await delay(30);
		p.stdin.write("second");
		await delay(30);
		const frame = p.frame();
		expect(frame).toContain("Search: second");
		expect(frame).toContain("1 match");
		expect(frame).toContain("beta — the second match");
		expect(frame).not.toContain("alpha");
		p.unmount();
	});

	test("Backspace deletes one character and brings the list back", async () => {
		const p = open(false, undefined, ITEMS);
		await delay(30);
		p.stdin.write("zz");
		await delay(30);
		expect(p.frame()).toContain("No matches");
		p.stdin.write("\x7f");
		await delay(30);
		expect(p.frame()).toContain("Search: z");
		p.stdin.write("\x7f");
		await delay(30);
		expect(p.frame()).toContain("alpha");
		p.unmount();
	});

	test("Ctrl+U clears the filter", async () => {
		const p = open(false, undefined, ITEMS);
		await delay(30);
		p.stdin.write("gamma");
		await delay(30);
		expect(p.frame()).not.toContain("alpha");
		p.stdin.write("\x15");
		await delay(30);
		expect(p.frame()).toContain("alpha");
		p.unmount();
	});

	test("Enter resolves the caller's index, not the filtered row", async () => {
		const p = open(false, undefined, ITEMS);
		await delay(30);
		p.stdin.write("gamma");
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(2);
		p.unmount();
	});

	test("arrows move through the filtered list and report original indices", async () => {
		const p = open(true, undefined, ITEMS);
		await delay(30);
		p.stdin.write("one"); // alpha and gamma, in the caller's order
		await delay(30);
		expect(p.frame()).toContain("2 matches");
		p.stdin.write("\x1b[B"); // down -> gamma
		await delay(30);
		expect(p.highlights).toEqual([2]);
		p.unmount();
	});

	test("the highlight preview follows the first match when the filter moves it", async () => {
		const p = open(true, 0, ITEMS);
		await delay(30);
		p.stdin.write("gamma");
		await delay(30);
		expect(p.highlights).toEqual([2]);
		p.unmount();
	});

	test("Esc still cancels while a filter is typed", async () => {
		const p = open(true, undefined, ITEMS);
		await delay(30);
		p.stdin.write("alpha");
		await delay(30);
		p.stdin.write("\x1b");
		await delay(30);
		expect(p.result()).toBeNull();
		expect(p.cancels()).toBe(1);
		p.unmount();
	});

	test("Enter with no matches does nothing; Esc is still the way out", async () => {
		const p = open(false, undefined, ITEMS);
		await delay(30);
		p.stdin.write("zzz");
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBeUndefined();
		p.stdin.write("\x1b");
		await delay(30);
		expect(p.result()).toBeNull();
		p.unmount();
	});

	test("a space is a filter character, not a preview key, once there is a query", async () => {
		const p = open(false, undefined, ITEMS);
		await delay(30);
		p.stdin.write("second match");
		await delay(30);
		expect(p.frame()).toContain("beta");
		p.unmount();
	});
});

/**
 * The Space-opened preview panel.
 *
 * `/resume` passes a loader; the dialog owns the interaction so every caller
 * gets the same keys. The panel follows the highlight, closes before the list
 * does on Esc, and a slow answer for a row the user has left must not paint
 * over the row they are on.
 */
describe("ListPickerDialog preview panel", () => {
	const ITEMS: PickerItem[] = [{ label: "one" }, { label: "two" }, { label: "three" }];

	function openPreview(
		loader: (index: number) => Promise<{ title?: string; lines: string[]; notice?: string } | null>,
		options: { items?: PickerItem[] } = {},
	) {
		let result: number | null | undefined;
		const requests: number[] = [];
		const { stdin, lastFrame, unmount } = render(
			(
				<ThemeContext.Provider value={DARK_THEME}>
					<ListPickerDialog
						title="Resume a session"
						items={options.items ?? ITEMS}
						resolve={(index) => (result = index)}
						preview={(index) => {
							requests.push(index);
							return loader(index);
						}}
					/>
				</ThemeContext.Provider>
			) as React.ReactElement,
		);
		const frame = () => (lastFrame() ?? "").replace(/\s+/g, " ");
		/**
		 * Poll to the invariant, not to a fixed window: the loader resolves in a
		 * microtask, but the render it causes is a timer away, and this file runs
		 * beside every other suite.
		 */
		const waitUntil = async (check: () => boolean, what: string) => {
			const started = Date.now();
			while (!check()) {
				if (Date.now() - started > 3_000) throw new Error(`never saw ${what}`);
				await delay(10);
			}
		};
		return {
			stdin,
			requests,
			result: () => result,
			frame,
			waitFor: (needle: string) => waitUntil(() => frame().includes(needle), needle),
			waitForGone: (needle: string) => waitUntil(() => !frame().includes(needle), `no ${needle}`),
			unmount,
		};
	}

	const immediate = async (index: number) => ({
		title: `Session ${index}`,
		lines: [`You: message ${index}`, `Assistant: reply ${index}`],
	});

	test("Space opens the highlighted row's preview", async () => {
		const p = openPreview(immediate);
		await p.waitFor("space preview");
		p.stdin.write(" ");
		await p.waitFor("You: message 0");
		expect(p.requests).toEqual([0]);
		const frame = p.frame();
		expect(frame).toContain("Session 0");
		expect(frame).toContain("Esc closes preview");
		p.unmount();
	});

	test("Space again closes the panel without leaving the list", async () => {
		const p = openPreview(immediate);
		await delay(30);
		p.stdin.write(" ");
		await p.waitFor("You: message 0");
		p.stdin.write(" ");
		await p.waitForGone("You: message 0");
		expect(p.result()).toBeUndefined();
		p.unmount();
	});

	test("arrows reload the preview for the row they land on", async () => {
		const p = openPreview(immediate);
		await delay(30);
		p.stdin.write(" ");
		await p.waitFor("Session 0");
		p.stdin.write("\x1b[B");
		await p.waitFor("Session 1");
		expect(p.requests).toEqual([0, 1]);
		expect(p.frame()).not.toContain("Session 0");
		p.unmount();
	});

	test("Esc closes the preview first and cancels the list on the second press", async () => {
		const p = openPreview(immediate);
		await delay(30);
		p.stdin.write(" ");
		await p.waitFor("You: message 0");
		p.stdin.write("\x1b");
		await p.waitForGone("You: message 0");
		expect(p.result()).toBeUndefined();

		p.stdin.write("\x1b");
		await delay(30);
		expect(p.result()).toBeNull();
		p.unmount();
	});

	test("typing closes the preview and filters as usual", async () => {
		const p = openPreview(immediate);
		await delay(30);
		p.stdin.write(" ");
		await p.waitFor("You: message 0");
		p.stdin.write("t");
		await p.waitForGone("You: message 0");
		expect(p.frame()).toContain("Search: t");
		p.unmount();
	});

	test("Enter still resolves the highlighted row while the panel is open", async () => {
		const p = openPreview(immediate);
		await delay(30);
		p.stdin.write("\x1b[B");
		await delay(30);
		p.stdin.write(" ");
		await delay(30);
		p.stdin.write("\r");
		await delay(30);
		expect(p.result()).toBe(1);
		p.unmount();
	});

	test("Space after a query is a filter character and never opens the panel", async () => {
		const p = openPreview(immediate, {
			items: [{ label: "alpha" }, { label: "beta", description: "beta match" }, { label: "gamma" }],
		});
		await delay(30);
		p.stdin.write("beta");
		await p.waitFor("Search: beta");
		p.stdin.write(" ");
		await delay(30);
		// The space belongs to the search text; a search field that eats spaces
		// cannot search for a phrase.
		expect(p.requests).toEqual([]);
		expect(p.frame()).toContain("Search: beta");
		expect(p.frame()).toContain("1 match");
		p.unmount();
	});

	test("a slow answer for a row already left cannot paint over the current one", async () => {
		let resolveFirst: (value: { title?: string; lines: string[] } | null) => void = () => {};
		let resolveSecond: (value: { title?: string; lines: string[] } | null) => void = () => {};
		const p = openPreview(
			(index) =>
				new Promise((resolve) => {
					if (index === 0) resolveFirst = resolve;
					else resolveSecond = resolve;
				}),
		);
		await delay(30);
		p.stdin.write(" ");
		await delay(30);
		p.stdin.write("\x1b[B");
		await delay(30);

		resolveSecond({ title: "Second", lines: ["You: second row"] });
		await p.waitFor("You: second row");

		resolveFirst({ title: "First", lines: ["You: stale row"] });
		// The stale answer is dropped in a microtask; give it a window to land
		// wrongly, then assert it did not.
		await delay(30);
		expect(p.frame()).toContain("You: second row");
		expect(p.frame()).not.toContain("You: stale row");
		p.unmount();
	});

	test("a loader that fails is reported as unavailable, not as a stuck panel", async () => {
		const p = openPreview(async () => {
			throw new Error("no file");
		});
		await delay(30);
		p.stdin.write(" ");
		await p.waitFor("Preview unavailable.");
		p.unmount();
	});

	test("an empty preview says so instead of showing an empty box", async () => {
		const p = openPreview(async () => ({ title: "Empty session", lines: [] }));
		await delay(30);
		p.stdin.write(" ");
		await p.waitFor("No messages to preview.");
		p.unmount();
	});

	test("a picker with no loader never mentions previews", async () => {
		const p = open(false);
		await delay(30);
		expect(p.frame()).not.toContain("space preview");
		p.unmount();
	});
});
