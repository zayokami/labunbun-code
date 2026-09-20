/**
 * Ctrl+L wipes the terminal, and the transcript comes back with it.
 *
 * Wiping the screen is what the key is for; what used to happen was that only
 * the wipe survived. The sealed rows are printed once and then forgotten by
 * ink, so an external clear left them nowhere — and with nothing sealed, the
 * bare write left ink holding a frame it believed was still on screen, which
 * its next render skipped as unchanged: a blank window.
 *
 * Both halves are asserted here, against the key rather than against the
 * handler, because the key is what a user presses.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { CLEAR_SCREEN, connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiEntry, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CTRL_L = "\x0c";

/** Rows with nothing left to update, so they can be sealed into scrollback. */
const settledRows = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `answer ${i}` }) as UiEntry);

function setup(rows: UiEntry[]) {
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>({ ...initialUiState(), entries: rows });
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
	// The wipe is for terminals only, and the REPL asks the stream it renders to.
	// ink-testing-library's stream does not answer that question on its own.
	(view.stdout as { isTTY?: boolean }).isTTY = true;
	return {
		store,
		view,
		finish: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

/** How many times a row's text appears in one frame. */
const appearances = (frame: string, text: string) => frame.match(new RegExp(`${text}\\b`, "g"))?.length ?? 0;

describe("Ctrl+L", () => {
	test("wipes the screen and prints the sealed transcript onto it again", async () => {
		const h = setup(settledRows(12));
		expect(h.view.lastFrame()).toContain("answer 0");

		h.view.stdin.write(CTRL_L);
		await delay(20);

		expect(h.store.get().paint).toBe(1);
		// Through ink's writer, which knows where its frame is: the clear is one of
		// the frames it produced rather than a write around its back.
		expect(h.view.frames.some((frame) => frame.includes(CLEAR_SCREEN))).toBe(true);
		// And the rows the wipe took off the screen are printed again — each once,
		// not twice (the frozen copy above the live one) and not missing.
		const frame = h.view.lastFrame() ?? "";
		for (let i = 0; i < 12; i++) expect(appearances(frame, `answer ${i}`)).toBe(1);
		h.finish();
	});

	// With nothing sealed there is no reprint to pay for, and the clear is still
	// the user's to make. What it must not do is leave the screen empty: the live
	// rows are redrawn only if ink knows its frame was taken down.
	test("nothing sealed: the screen is wiped, and what was on it is still there", async () => {
		const h = setup(settledRows(3));

		h.view.stdin.write(CTRL_L);
		await delay(20);

		expect(h.store.get().paint).toBe(1);
		expect(h.view.frames.some((frame) => frame.includes(CLEAR_SCREEN))).toBe(true);
		const frame = h.view.lastFrame() ?? "";
		for (let i = 0; i < 3; i++) expect(appearances(frame, `answer ${i}`)).toBe(1);
		h.finish();
	});

	test("the transcript is not what Ctrl+L is for: clearing leaves it in place", async () => {
		const h = setup(settledRows(12));

		h.view.stdin.write(CTRL_L);
		await delay(20);

		expect(h.store.get().entries).toHaveLength(12);
		h.finish();
	});

	// Twice in a row is two wipes, not one wipe and a stale screen.
	test("pressing it again asks for another repaint", async () => {
		const h = setup(settledRows(12));

		h.view.stdin.write(CTRL_L);
		await delay(20);
		h.view.stdin.write(CTRL_L);
		await delay(20);

		expect(h.store.get().paint).toBe(2);
		expect(h.view.frames.filter((frame) => frame.includes(CLEAR_SCREEN))).toHaveLength(2);
		h.finish();
	});
});
