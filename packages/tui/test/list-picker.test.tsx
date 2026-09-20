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

const ITEMS = [{ label: "dark" }, { label: "light" }, { label: "nord" }];

function open(withHooks: boolean, initialIndex?: number) {
	const highlights: number[] = [];
	let cancels = 0;
	let result: number | null | undefined;
	const { stdin, lastFrame, unmount } = render(
		(
			<ThemeContext.Provider value={DARK_THEME}>
				<ListPickerDialog
					title="Theme"
					items={ITEMS}
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
