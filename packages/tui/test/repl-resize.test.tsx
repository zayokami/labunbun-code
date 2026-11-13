/**
 * A window resize is a reflow, and a reflow is not a repaint.
 *
 * Windows Terminal re-wraps its whole buffer when the width changes, so the
 * rows ink drew at the old width are not the rows it believes are on screen.
 * Its next erase counts the lines it last wrote and stops above them, leaving
 * the head of the old frame — the greeting, the key list — where it was while
 * it prints the new frame underneath. Maximizing and then restoring a window
 * sends a stream of resizes, so each one can leave another copy.
 *
 * The fix takes the screen back once the size settles: erase the viewport in
 * place and repaint the rows that were on it. The rows above the viewport were
 * reflowed by the terminal and stay in its scrollback; printing them again
 * would copy the transcript into the history a second time. Both halves are
 * asserted here — the bound on `firstVisibleEntry` against the pane walk it
 * shares, and the whole path through the REPL against a real ink render.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, ERASE_VIEWPORT, REPL, RESIZE_SETTLE_MS } from "../src/components/REPL.tsx";
import { firstVisibleEntry } from "../src/components/SplitWorkspace.tsx";
import { createStore } from "../src/store.ts";
import { DARK_THEME } from "../src/theme.ts";
import { initialUiState, type UiEntry, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const settledRows = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `answer ${i}` }) as UiEntry);

/** Rows long enough that width changes what wraps. */
const wideRows = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `answer ${i} ${"x".repeat(80)}` }) as UiEntry);

const appearances = (frame: string, text: string) => frame.match(new RegExp(`${text}\\b`, "g"))?.length ?? 0;

describe("firstVisibleEntry", () => {
	test("a transcript that fits a screen starts at the first entry", () => {
		expect(firstVisibleEntry(settledRows(3), DARK_THEME, 100, 40)).toBe(0);
	});

	// One line and one gap per row: a ten-row pane holds five entries, so the
	// screenful is entries 25..29 and the reprint starts at 25.
	test("a long transcript starts at the top of the last screenful", () => {
		expect(firstVisibleEntry(settledRows(30), DARK_THEME, 100, 10)).toBe(25);
	});

	// Wrapped lines take rows the entries would otherwise have, so a narrow
	// screenful covers fewer entries and the reprint starts closer to the tail.
	test("a narrower terminal fits fewer entries, so the reprint covers less", () => {
		const narrow = firstVisibleEntry(wideRows(30), DARK_THEME, 40, 12);
		const wide = firstVisibleEntry(wideRows(30), DARK_THEME, 100, 12);
		expect(narrow).toBeGreaterThan(wide);
		expect(narrow).toBeLessThan(30);
	});

	test("nothing to show starts at the end, never past it", () => {
		expect(firstVisibleEntry([], DARK_THEME, 100, 40)).toBe(0);
		const entries = settledRows(4);
		expect(firstVisibleEntry(entries, DARK_THEME, 100, 40)).toBe(0);
		expect(firstVisibleEntry(entries, DARK_THEME, 100, 1)).toBeLessThanOrEqual(entries.length);
	});
});

function setup(entries: UiEntry[]) {
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>({ ...initialUiState(), entries });
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
	const stream = view.stdout as { isTTY?: boolean; rows?: number };
	stream.isTTY = true;
	stream.rows = 40;
	// The testing stream's width is a getter fixed at 100; a resize test needs
	// to move it, so shadow it with one that reads this cell.
	const width = { value: 100 };
	Object.defineProperty(view.stdout, "columns", { get: () => width.value, configurable: true });
	view.stdout.emit("resize");
	return {
		store,
		view,
		width,
		resize: (columns: number, rows = 40) => {
			width.value = columns;
			stream.rows = rows;
			view.stdout.emit("resize");
		},
		finish: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

describe("a resize repaints the screen the terminal reflowed", () => {
	test("a width change erases the viewport and reprints what was on it", async () => {
		const entries = settledRows(30);
		const h = setup(entries);
		expect(h.view.lastFrame()).toContain("answer 0");

		h.resize(60);
		await delay(RESIZE_SETTLE_MS + 80);

		expect(h.store.get().paint).toBe(1);
		// The screenful a 40-row, 60-column pane shows: entries 10..29, so the
		// reprint starts at 10 and stops before the history above it.
		expect(h.store.get().paintFrom).toBe(10);
		expect(h.view.frames.some((frame) => frame.includes(ERASE_VIEWPORT))).toBe(true);

		const frame = h.view.lastFrame() ?? "";
		// What the erase took away is back, once...
		expect(appearances(frame, "answer 10")).toBe(1);
		// ...and the rows above the old viewport are not printed into the
		// scrollback a second time.
		expect(frame).not.toContain("answer 0");
		// The tail is still the live frame's job and is not duplicated either.
		expect(appearances(frame, `answer ${entries.length - 1}`)).toBe(1);
		h.finish();
	});

	// A maximize-restore drag is a stream of resize events, each reflowing the
	// buffer under a frame ink no longer matches. One repaint, on the layout the
	// user stopped at — not one per event, each printing another screenful.
	test("a drag repaints once, on the size it settles at", async () => {
		const h = setup(settledRows(30));

		h.resize(60);
		await delay(20);
		h.resize(40);
		await delay(20);
		h.resize(80);
		await delay(20);

		expect(h.store.get().paint).toBe(0);
		await delay(RESIZE_SETTLE_MS + 80);

		expect(h.store.get().paint).toBe(1);
		expect(h.view.frames.filter((frame) => frame.includes(ERASE_VIEWPORT))).toHaveLength(1);
		h.finish();
	});

	// A height change re-lays the frame out without re-wrapping the buffer, and
	// ink erases it by a count that still matches. There is nothing to take back.
	test("a height-only change erases nothing and reprints nothing", async () => {
		const h = setup(settledRows(30));

		h.resize(100, 20);
		await delay(RESIZE_SETTLE_MS + 80);

		expect(h.store.get().paint).toBe(0);
		expect(h.view.frames.some((frame) => frame.includes(ERASE_VIEWPORT))).toBe(false);
		h.finish();
	});

	// The bounded start belongs to the one repaint that wrote it. A deliberate
	// wipe empties the screen, so the transcript has to come back whole.
	test("Ctrl+L after a resize prints the whole transcript again", async () => {
		const entries = settledRows(30);
		const h = setup(entries);

		h.resize(60);
		await delay(RESIZE_SETTLE_MS + 80);
		expect(h.store.get().paintFrom).toBe(10);

		h.view.stdin.write("\x0c");
		await delay(40);

		expect(h.store.get().paint).toBe(2);
		expect(h.store.get().paintFrom).toBe(0);
		const frame = h.view.lastFrame() ?? "";
		expect(frame).toContain("answer 0");
		expect(appearances(frame, "answer 0")).toBe(1);
		h.finish();
	});
});
