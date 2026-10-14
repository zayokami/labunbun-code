/**
 * A change of palette has to reach the rows ink has already printed.
 *
 * `<Static>` prints its children once and then forgets them — the printed rows
 * leave the tree, so no later render asks for those bytes again and each one
 * keeps the colors it was born with. That is what makes sealing cheap, and it
 * is why a theme change used to reach only the live tail: the transcript above
 * it stayed in the old palette, two themes on one screen.
 *
 * The fix has two halves, and they fail differently, so they are asserted
 * separately. The list is remounted so ink prints the sealed rows again — get
 * that wrong and the history keeps its old colors. The screen is emptied
 * before the remount — get *that* wrong and the transcript is simply printed
 * twice, the old palette above the new.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { applyTheme, previewTheme } from "../src/app.tsx";
import { transcriptPaintKey, VirtualMessageList } from "../src/components/MessageList.tsx";
import { clearScreenSequence } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { DARK_THEME, type Theme, ThemeContext } from "../src/theme.ts";
import { initialUiState, type UiEntry, type UiState } from "../src/ui-state.ts";

/** A theme that differs from the default in one mark, so a repaint is visible. */
const LOUD: Theme = { ...DARK_THEME, marks: { ...DARK_THEME.marks, error: "@@" } };

function withTheme(node: React.ReactNode, theme: Theme = DARK_THEME) {
	return <ThemeContext.Provider value={theme}>{node}</ThemeContext.Provider>;
}

const settledRows = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `answer ${i}` }) as UiEntry);

/** Enough rows that the first one is sealed out of the live window. */
const errorThenAnswers: UiEntry[] = [{ kind: "error", text: "boom" }, ...settledRows(20)];

const oldRow = `${DARK_THEME.marks.error} boom`;
const newRow = "@@ boom";

describe("the sealed rows repaint when the palette changes", () => {
	test("a new theme reprints them in its own colors, once", () => {
		const view = render(withTheme(<VirtualMessageList entries={errorThenAnswers} />));
		expect(view.lastFrame()).toContain(oldRow);

		view.rerender(withTheme(<VirtualMessageList entries={errorThenAnswers} />, LOUD));

		const frame = view.lastFrame() ?? "";
		// Printed again, in the new palette: ink re-rendered the row it had
		// already emitted.
		expect(frame).toContain(newRow);
		// ...and the copy in the old palette is gone with it, rather than
		// sitting above it for the rest of the session.
		expect(frame).not.toContain(oldRow);
		expect(frame.match(/@@ boom/g)).toHaveLength(1);
		// And the reprint is the whole transcript: the newest row is not a
		// courtesy reprint with the rest left behind in the old palette.
		expect(frame.match(/answer \d+/g)).toHaveLength(20);
		view.unmount();
	});

	// The boundary moves at the same moment the key does: a turn that adds a row
	// while the theme changes seals one row more in that very commit. So the
	// reprint and the live tail have to partition the list — the static side
	// covering exactly the rows the tail does not. Overlap, and the row is on
	// screen twice: once where the tail redraws it, and once frozen above it in
	// the palette it was printed with.
	test("a row that seals in the same frame as the repaint is printed once", () => {
		const view = render(withTheme(<VirtualMessageList entries={settledRows(20)} />));
		view.rerender(withTheme(<VirtualMessageList entries={settledRows(21)} />, LOUD));

		const frame = view.lastFrame() ?? "";
		expect(frame.match(/answer \d+/g)).toHaveLength(21);
		view.unmount();
	});

	test("re-applying the theme that is already on screen reprints nothing", () => {
		// The picker hands back the theme the app was opened with when the user
		// presses Enter without moving: the same object, so the same key, so no
		// remount and no second copy of the transcript.
		expect(transcriptPaintKey(DARK_THEME)).toBe(transcriptPaintKey(DARK_THEME));
		// A theme the app has not painted with yet is a different palette even if
		// it was built from the same values.
		expect(transcriptPaintKey({ ...DARK_THEME })).not.toBe(transcriptPaintKey(DARK_THEME));
	});

	// The palette is not the only thing that changes; the screen is not the only
	// thing that can be wiped. Ctrl+L takes the rows off the terminal without
	// touching the list, so the counter goes in the same key and the same remount
	// brings them back.
	test("a repaint prints the sealed rows again, from the list as it is now", () => {
		const stale: UiEntry[] = [{ kind: "error", text: "boom" }, ...settledRows(20)];
		const view = render(withTheme(<VirtualMessageList entries={stale} paint={0} />));
		expect(view.lastFrame()).toContain(oldRow);

		// A sealed row can only ever change by being replaced — entries are
		// immutable — and until something asks for a repaint, the copy ink printed
		// is the copy on screen.
		const fresh: UiEntry[] = [{ kind: "error", text: "bang" }, ...settledRows(20)];
		view.rerender(withTheme(<VirtualMessageList entries={fresh} paint={0} />));
		expect(view.lastFrame()).toContain(oldRow);
		expect(view.lastFrame()).not.toContain("bang");

		view.rerender(withTheme(<VirtualMessageList entries={fresh} paint={1} />));
		const frame = view.lastFrame() ?? "";
		expect(frame).toContain(`${DARK_THEME.marks.error} bang`);
		expect(frame).not.toContain(oldRow);
		// One copy, as with the theme path: the reprint replaces what it reprints.
		expect(frame.match(/answer \d+/g)).toHaveLength(20);
		view.unmount();
	});
});

/**
 * The preview half of the split: the picker's highlight moves recolor the
 * live rows and stop there. The transcript above is the printed record of the
 * committed palette, and it is not reprinted — or wiped, or remounted — until
 * a choice is kept (see `previewTheme`).
 */
describe("a preview dresses the live rows only", () => {
	test("moving the highlight cannot reach the sealed rows", () => {
		const view = render(withTheme(<VirtualMessageList entries={errorThenAnswers} paintedTheme={DARK_THEME} />));
		expect(view.lastFrame()).toContain(oldRow);

		// A preview: the palette in effect changed, the committed one did not.
		view.rerender(withTheme(<VirtualMessageList entries={errorThenAnswers} paintedTheme={DARK_THEME} />, LOUD));

		// The context around the printed rows changed and they did not move —
		// the list is keyed to the committed palette, not the previewed one.
		const frame = view.lastFrame() ?? "";
		expect(frame).toContain(oldRow);
		expect(frame).not.toContain(newRow);
		view.unmount();
	});

	test("committing after previews reprints them in the chosen palette, once", () => {
		const view = render(withTheme(<VirtualMessageList entries={errorThenAnswers} paintedTheme={DARK_THEME} />));
		// Three moves, as the picker would send them: none may reprint.
		for (const preview of [LOUD, DARK_THEME, LOUD]) {
			view.rerender(withTheme(<VirtualMessageList entries={errorThenAnswers} paintedTheme={DARK_THEME} />, preview));
		}
		expect(view.lastFrame() ?? "").not.toContain(newRow);

		// Enter: the committed palette moves with it, and the rows arrive in it
		// — once, and as the whole transcript.
		view.rerender(withTheme(<VirtualMessageList entries={errorThenAnswers} paintedTheme={LOUD} />, LOUD));
		const frame = view.lastFrame() ?? "";
		expect(frame.match(/@@ boom/g)).toHaveLength(1);
		expect(frame).not.toContain(oldRow);
		expect(frame.match(/answer \d+/g)).toHaveLength(20);
		view.unmount();
	});
});

describe("the screen is taken back before the reprint", () => {
	function fakeStdout(isTTY = true) {
		const writes: string[] = [];
		return {
			stream: {
				isTTY,
				write: (data: string) => {
					writes.push(data);
				},
			},
			writes,
		};
	}

	function storeWith(entries: UiEntry[], theme: Theme = DARK_THEME) {
		return createStore<UiState>({ ...initialUiState(), entries, theme });
	}

	test("a theme change with a transcript behind it wipes the screen and applies", () => {
		const store = storeWith(errorThenAnswers);
		const { stream, writes } = fakeStdout();

		applyTheme(store, LOUD, stream);

		expect(writes).toEqual([clearScreenSequence()]);
		expect(store.get().theme).toBe(LOUD);
	});

	test("nothing sealed means nothing to reprint, so nothing is wiped", () => {
		// The rows on screen are all live: they redraw in the new palette by
		// themselves, and the screen still holds whatever the shell printed
		// before labunbun started.
		const store = storeWith(settledRows(3));
		const { stream, writes } = fakeStdout();

		applyTheme(store, LOUD, stream);

		expect(writes).toEqual([]);
		expect(store.get().theme).toBe(LOUD);
	});

	// The wipe is what pays for the reprint, so it is spent on the exact
	// boundary: a full live window has nothing sealed, one row past it has one.
	test("one row past the live window is one row to reprint", () => {
		const { stream, writes } = fakeStdout();

		applyTheme(storeWith(settledRows(8)), LOUD, stream);
		expect(writes).toEqual([]);

		applyTheme(storeWith(settledRows(9)), LOUD, stream);
		expect(writes).toEqual([clearScreenSequence()]);
	});

	test("applying the theme that is already there changes nothing at all", () => {
		const store = storeWith(errorThenAnswers);
		const before = store.get();
		const { stream, writes } = fakeStdout();

		applyTheme(store, DARK_THEME, stream);

		expect(writes).toEqual([]);
		expect(store.get()).toBe(before);
	});

	// The picker previews on every move, and a move is not a choice. A preview
	// must not wipe, and must not stamp the transcript: the sealed rows are
	// still the committed palette's until one is kept.
	test("a preview changes the palette without touching the screen or the stamp", () => {
		const store = storeWith(errorThenAnswers);
		const { writes } = fakeStdout();

		previewTheme(store, LOUD);

		expect(writes).toEqual([]);
		expect(store.get().theme).toBe(LOUD);
		expect(store.get().themeCommit).toBe(DARK_THEME);
	});

	test("undone previews leave nothing behind, and the kept one pays once", () => {
		const store = storeWith(errorThenAnswers);
		const { stream, writes } = fakeStdout();

		previewTheme(store, LOUD);
		previewTheme(store, DARK_THEME);
		previewTheme(store, LOUD);
		applyTheme(store, LOUD, stream);

		expect(writes).toEqual([clearScreenSequence()]);
		expect(store.get().theme).toBe(LOUD);
		expect(store.get().themeCommit).toBe(LOUD);
	});

	// The previewer can also land on the theme already committed — opening the
	// list and pressing Enter without moving does exactly that — and that is
	// not a change: nothing may be wiped for a transcript that already matches.
	test("previewing the committed theme and committing it again is a no-op", () => {
		const store = storeWith(errorThenAnswers);
		const before = store.get();
		const { stream, writes } = fakeStdout();

		previewTheme(store, DARK_THEME);
		applyTheme(store, DARK_THEME, stream);

		expect(writes).toEqual([]);
		expect(store.get()).toBe(before);
	});

	// Coming back to the first palette is a change like any other: the rows on
	// screen are in the second one and ink prints them again for the first. A
	// "have we painted this before" test that answered yes here would leave the
	// transcript in the palette the user just left.
	test("a theme that has been on screen before is still a change", () => {
		const store = storeWith(errorThenAnswers);
		const { stream, writes } = fakeStdout();

		applyTheme(store, LOUD, stream);
		applyTheme(store, DARK_THEME, stream);

		expect(writes).toEqual([clearScreenSequence(), clearScreenSequence()]);
		expect(store.get().theme).toBe(DARK_THEME);
	});

	test("output that is not a terminal has no screen to take back", () => {
		const store = storeWith(errorThenAnswers);
		const { stream, writes } = fakeStdout(false);

		applyTheme(store, LOUD, stream);

		expect(writes).toEqual([]);
		expect(store.get().theme).toBe(LOUD);
	});

	// `isTTY` is a property of a stream that might not have one at all: a stream
	// that cannot say what it is is not a terminal, and the wipe goes nowhere.
	test("a stream that does not say whether it is a terminal is not one", () => {
		const store = storeWith(errorThenAnswers);
		const writes: string[] = [];

		applyTheme(store, LOUD, { write: (data: string) => writes.push(data) });

		expect(writes).toEqual([]);
		expect(store.get().theme).toBe(LOUD);
	});
});
