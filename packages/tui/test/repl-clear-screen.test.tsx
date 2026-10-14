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
 *
 * The wipe also has to survive the terminal it lands in. A Windows console
 * reads 3J literally — the scrollback goes and a scrolled-up reader is pulled
 * to the top — so there the clear stops at the screen. And the reprint of a
 * long transcript is one write; past the console's buffer budget the host
 * stops following the cursor and the reader is stranded, so the chunks are
 * capped. Both are measured below, the oversized write first.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { CLEAR_SCREEN, clearScreenSequence, connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { chunkWritesForConPTY, MAX_CONPTY_WRITE, stripScrollbackErase } from "../src/conpty.ts";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiEntry, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CTRL_L = "\x0c";

/** Rows with nothing left to update, so they can be sealed into scrollback. */
const settledRows = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `answer ${i}` }) as UiEntry);

/** Rows wide enough that their joint reprint is one write past the console budget. */
const bigRows = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `answer ${i} ${"x".repeat(120)}` }) as UiEntry);

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
		expect(h.view.frames.some((frame) => frame.includes(clearScreenSequence()))).toBe(true);
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
		expect(h.view.frames.some((frame) => frame.includes(clearScreenSequence()))).toBe(true);
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
		expect(h.view.frames.filter((frame) => frame.includes(clearScreenSequence()))).toHaveLength(2);
		h.finish();
	});
});

describe("the wipe a Windows console gets", () => {
	test("stops at the screen: 3J would clear the scrollback and jerk the reader to the top", () => {
		expect(clearScreenSequence(true)).toBe("\x1b[2J\x1b[H");
	});

	test("is the full wipe everywhere else", () => {
		expect(clearScreenSequence(false)).toBe(CLEAR_SCREEN);
	});

	// The bridge between the two forms: a full wipe written for anywhere passes
	// through the ConPTY writer and lands as the screen-stop one. The two sides
	// above follow the host, but this equality may not — it has to hold on the
	// host the writer runs on and in a fixture running anywhere else.
	test("a full wipe becomes the console-takeable one on the way out", () => {
		expect(stripScrollbackErase(clearScreenSequence(false))).toBe(clearScreenSequence(true));
	});
});

// The reprint of a long transcript is one write, and a Windows console stops
// following the cursor past its buffer budget: the reader ends up parked over
// the old screen while the reprint fills in below. The oversized write is
// measured first — on a fixture this size the second half would otherwise
// pass without anything having tripped the bug.
test("a reprint leaves in pieces a Windows console can follow", async () => {
	const rows = bigRows(200);
	const h = setup(rows);

	h.view.stdin.write(CTRL_L);
	await delay(40);

	const oversized = h.view.frames.filter((frame) => frame.length > MAX_CONPTY_WRITE);
	expect(oversized.length).toBeGreaterThan(0);

	const mark = h.view.frames.length;
	chunkWritesForConPTY(h.view.stdout);

	h.view.stdin.write(CTRL_L);
	await delay(40);

	const after = h.view.frames.slice(mark);
	// Every write stays within the budget the console follows...
	for (const frame of after) expect(frame.length).toBeLessThanOrEqual(MAX_CONPTY_WRITE);
	// ...the clear still leaves — in the form a console behind this writer can
	// take. ink appends the reprint to it, so it opens the first chunk of its
	// write; and the wipe that lands is the screen-stop one whatever form the
	// host wrote, because the writer drops the scrollback erase on the way out.
	expect(after.some((frame) => frame.includes(clearScreenSequence(true)))).toBe(true);
	// ...no row is lost to a cut (side-by-side: the unit tests prove chunks join
	// back byte for byte; this is the same stream through real ink)...
	const joined = after.join("");
	for (let i = 0; i < rows.length; i++) expect(appearances(joined, `answer ${i}`)).toBeGreaterThanOrEqual(1);
	// ...and ink still knows where its frame is: the last write carries the
	// newest row.
	expect(h.view.lastFrame()).toContain(`answer ${rows.length - 1}`);
	h.finish();
}, 20_000);
