/**
 * The picker as the REPL actually runs it: the list lives in the store, the
 * dialog reads the keys, and the caller hears about every move.
 *
 * The dialog's own tests mount it with props in hand; what they cannot see is
 * the store-shaped half of the contract — `pickFromList` puts a
 * {@link ListPickerState} in the store and the REPL renders it from there. A
 * field that stops short on that trip is invisible to both sides: the caller
 * passed it, the dialog supports it, and the row still opens at the top.
 *
 * The coalescing test replays what a held key looks like on a real terminal:
 * autorepeat arrives as several escape sequences inside one read, dispatched
 * in one synchronous sweep before React has committed anything the first of
 * them asked for.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const SELECTED = "❯";

const LABELS = ["one", "two", "three", "four"];

function setup() {
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>(initialUiState());
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
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

/** What `pickFromList` puts in the store, field for field. */
function openPicker(
	h: { store: ReturnType<typeof setup>["store"] },
	options: {
		initialIndex?: number;
		onHighlight?: (i: number) => void;
		onCancel?: () => void;
		resolved?: Array<number | null>;
	},
) {
	h.store.set((s) => ({
		...s,
		picker: {
			title: "Pick one",
			items: LABELS.map((label) => ({ label })),
			initialIndex: options.initialIndex,
			onHighlight: options.onHighlight,
			onCancel: options.onCancel,
			resolve: (index) => {
				options.resolved?.push(index);
				h.store.set((st) => ({ ...st, picker: null }));
			},
		},
	}));
}

/** The label the selection mark is on, or null when the list is not up. */
function markedRow(frame: string): string | null {
	for (const label of LABELS) {
		if (frame.includes(`${SELECTED} ${label}`)) return label;
	}
	return null;
}

describe("the picker the REPL renders from the store", () => {
	test("opens on the row the caller asked for", async () => {
		const h = setup();
		openPicker(h, { initialIndex: 2 });
		await delay(20);

		expect(markedRow(h.view.lastFrame() ?? "")).toBe("three");
		h.finish();
	});

	test("an arrow moves the highlight and tells the caller once per press", async () => {
		const h = setup();
		const moved: number[] = [];
		openPicker(h, { initialIndex: 2, onHighlight: (i) => moved.push(i) });
		await delay(20);

		h.view.stdin.write(DOWN);
		await delay(20);
		expect(moved).toEqual([3]);
		expect(markedRow(h.view.lastFrame() ?? "")).toBe("four");

		h.view.stdin.write(UP);
		await delay(20);
		h.view.stdin.write(UP);
		await delay(20);
		expect(moved).toEqual([3, 2, 1]);
		expect(markedRow(h.view.lastFrame() ?? "")).toBe("two");
		h.finish();
	});

	// A held key on a real terminal: several repeats can share one read, and
	// the dispatcher hands them to the same handler before React has committed
	// the row the first of them asked for. A step computed from the rendered
	// value instead of from where the last step left it would collapse the
	// whole burst into one move — a key that looks dead however long it is held.
	test("a burst of arrows in one read is that many moves", async () => {
		const h = setup();
		const moved: number[] = [];
		openPicker(h, { initialIndex: 0, onHighlight: (i) => moved.push(i) });
		await delay(20);

		h.view.stdin.write(`${DOWN}${DOWN}${DOWN}`);
		await delay(20);

		expect(moved).toEqual([1, 2, 3]);
		expect(markedRow(h.view.lastFrame() ?? "")).toBe("four");
		h.finish();
	});

	test("Enter hands back the row the highlight is on", async () => {
		const h = setup();
		const resolved: Array<number | null> = [];
		openPicker(h, { initialIndex: 3, resolved });
		await delay(20);

		h.view.stdin.write("\r");
		await delay(20);

		expect(resolved).toEqual([3]);
		expect(h.view.lastFrame()).not.toContain(SELECTED);
		h.finish();
	});

	// The same coalescing, one key later: a move and the confirmation it earned
	// in one read must choose the row the move reached, not the row the render
	// was still showing when Enter was dispatched.
	test("a move and Enter in one read choose the moved row", async () => {
		const h = setup();
		const resolved: Array<number | null> = [];
		openPicker(h, { initialIndex: 0, resolved });
		await delay(20);

		h.view.stdin.write(`${DOWN}\r`);
		await delay(20);

		expect(resolved).toEqual([1]);
		h.finish();
	});
});
