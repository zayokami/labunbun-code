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
import { applyTheme } from "../src/app.tsx";
import { transcriptPaintKey, VirtualMessageList } from "../src/components/MessageList.tsx";
import { CLEAR_SCREEN } from "../src/components/REPL.tsx";
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

		expect(writes).toEqual([CLEAR_SCREEN]);
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

	test("applying the theme that is already there changes nothing at all", () => {
		const store = storeWith(errorThenAnswers);
		const before = store.get();
		const { stream, writes } = fakeStdout();

		applyTheme(store, DARK_THEME, stream);

		expect(writes).toEqual([]);
		expect(store.get()).toBe(before);
	});

	test("output that is not a terminal has no screen to take back", () => {
		const store = storeWith(errorThenAnswers);
		const { stream, writes } = fakeStdout(false);

		applyTheme(store, LOUD, stream);

		expect(writes).toEqual([]);
		expect(store.get().theme).toBe(LOUD);
	});
});
