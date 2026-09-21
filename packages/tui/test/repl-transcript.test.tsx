/**
 * Ctrl+O, and what the prompt is holding when it comes back.
 *
 * The transcript is a screen of its own: the window is replaced by the last
 * twenty-five rows, ↑/↓ page it and Escape leaves. What used to be true of that
 * screen is that it was built by *unmounting* the window — so a half-typed
 * sentence was gone for good, along with its undo stack, the pastes it had
 * folded and the history search open inside it, because all of those live in a
 * component that had stopped existing.
 *
 * A screen the user comes back to should be the screen they left, and the same
 * sentence is the cheapest way to say so — sent, so that what is asserted is the
 * buffer itself and not a repaint of it. The other half is the rule that makes
 * leaving it alive safe: an editor nobody can see takes no keys, so what is
 * typed at the transcript pages it or means nothing, and never lands in a buffer
 * that is off the screen.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiEntry, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CTRL_O = "\x0f";

async function waitFor(done: () => boolean, timeoutMs = 2000): Promise<void> {
	for (let waited = 0; waited < timeoutMs; waited += 10) {
		if (done()) return;
		await delay(10);
	}
}

/** Rows with nothing left to update, so they are what the transcript is made of. */
const settledRows = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `answer ${i}` }) as UiEntry);

function setup(rows: UiEntry[] = settledRows(3)) {
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>({ ...initialUiState(), entries: rows });
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
	return {
		store,
		/** Ink pads and wraps frames; the assertions are about what a user reads. */
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		write: async (keys: string) => {
			view.stdin.write(keys);
			await delay(30);
		},
		finish: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

/** What the store heard from the user, which is what a submitted buffer becomes. */
const asked = (h: ReturnType<typeof setup>) =>
	h.store
		.get()
		.entries.filter((entry) => entry.kind === "user")
		.map((entry) => entry.text);

describe("Ctrl+O and the draft", () => {
	test("the sentence in the prompt is still there after a look at the transcript", async () => {
		const h = setup();
		await h.write("a draft");
		expect(h.frame()).toContain("a draft");

		await h.write(CTRL_O);
		expect(h.frame()).toContain("Transcript ");
		// The transcript is the screen rather than an overlay: the prompt is not
		// painted under it, so nothing of the window is left claiming the next key.
		expect(h.frame()).not.toContain("a draft");

		await h.write(CTRL_O);
		expect(h.frame()).toContain("a draft");

		// And it is the buffer, not a redraw of it — the key that sends sends what
		// the user wrote, with nothing missing from the middle of it.
		await h.write("\r");
		await waitFor(() => asked(h).length > 0);
		expect(asked(h)).toEqual(["a draft"]);
		h.finish();
	}, 20_000);

	test("what is typed at the transcript stays out of the prompt", async () => {
		const h = setup();
		await h.write("a draft");
		await h.write(CTRL_O);

		// Keys the transcript has no meaning for: they page nothing, and they are
		// not the prompt's either. Every one of these would have been a character in
		// a buffer nobody could see, and the user would find them in the sentence
		// they came back to.
		await h.write("XXX");
		await h.write(CTRL_O);

		const frame = h.frame();
		expect(frame).toContain("a draft");
		expect(frame).not.toContain("X");
		h.finish();
	}, 20_000);

	// Reading back is a screen, not a state: closing it costs nothing and the
	// rows are where they were. Twenty-five of them at a time, ending at the
	// newest — the paging itself is the pad's to test.
	test("the transcript shows the last rows, and the window is whole again after", async () => {
		const h = setup(settledRows(40));
		await h.write(CTRL_O);
		expect(h.frame()).toContain("Transcript 16-40 of 40");

		await h.write("\x1b");
		expect(h.frame()).not.toContain("Transcript ");
		expect(h.frame()).toContain("answer 39");
		h.finish();
	}, 20_000);
});
