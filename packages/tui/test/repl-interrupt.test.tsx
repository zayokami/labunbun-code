/**
 * Esc must interrupt a running turn — reported from a real terminal, where the
 * spinner kept running after the key was pressed.
 *
 * Driven through the REPL's own prompt input so the path under test is the one
 * a user takes: type, submit, Esc. The provider stream here ignores the cancel
 * and finishes late (an aborted SSE body ends without an error), which is the
 * shape that used to leave the turn recorded as a completed one.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `done` holds. Much of what the REPL does lands behind a debounce
 * or a promise, and the timers belong to the whole test runner — a fixed sleep
 * that outlasts them on an idle machine loses the race on a loaded one, and
 * the assertion after it reports a missing feature instead of a slow machine.
 * On timeout the caller's own assertion is what fails.
 */
async function waitFor(done: () => boolean, timeoutMs = 2000): Promise<void> {
	for (let waited = 0; waited < timeoutMs; waited += 10) {
		if (done()) return;
		await delay(10);
	}
}

function setup(options: { vim?: boolean; completeFiles?: (query: string) => Promise<string[]> } = {}) {
	const streaming = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const faux = fauxProvider([{ text: "thinking hard" }, { text: "never reached" }]);
	const streamFn: StreamFn = async function* (model, context, options) {
		for await (const event of faux.streamFn(model, context, options)) {
			if (event.type === "done") {
				// Hold the terminal event until the test releases it: the turn is
				// still in flight while the user presses Esc.
				streaming.resolve();
				await release.promise;
			}
			yield event;
		}
	};

	const session = new AgentSession({ model: FAUX_MODEL, maxTurns: 4, deps: { streamFn } });
	// vim is store state, not a prop: the REPL reads what `/vim` toggles, so the
	// test seeds the store the same way mountRepl does.
	const store = createStore<UiState>({ ...initialUiState(options.vim ?? false), statusPhase: "responding" });
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(
		<REPL
			getSession={() => session}
			store={store}
			modelName="test"
			onExit={() => {}}
			completeFiles={options.completeFiles}
		/>,
	);

	return {
		session,
		store,
		streaming,
		release,
		stdin: view.stdin,
		frame: () => view.lastFrame() ?? "",
		unmount: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

const transcript = (store: { get: () => UiState }) =>
	store.get().entries.map((e) => (e.kind === "toolUse" ? `${e.kind}:${e.toolName}` : `${e.kind}:${e.text}`));

async function submit(stdin: { write: (text: string) => void }, text: string) {
	stdin.write(text);
	await delay(20);
	stdin.write("\r");
}

describe("Esc interrupts a run", () => {
	test("escape mid-turn stops the run and reports the interrupt", async () => {
		const h = setup();
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;
		expect(h.session.isRunning).toBe(true);

		h.stdin.write("\x1b");
		await delay(60);
		// The REPL forwarded the key to the session even though the stream is
		// still finishing.
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);

		expect(h.session.isRunning).toBe(false);
		expect(transcript(h.store)).toContain("info:[interrupted]");
		expect(h.store.get().statusPhase).toBe("idle");
		const lastAssistant = [...h.session.messages].reverse().find((m) => m.role === "assistant");
		expect(lastAssistant).toMatchObject({ stopReason: "aborted" });
		h.unmount();
	}, 20_000);

	test("escape while idle does nothing", async () => {
		const h = setup();
		await delay(40);
		expect(h.session.isRunning).toBe(false);

		h.stdin.write("\x1b");
		await delay(60);

		expect(h.session.isRunning).toBe(false);
		expect(h.session.isInterrupted).toBe(false);
		expect(transcript(h.store)).not.toContain("info:[interrupted]");
		h.unmount();
	}, 20_000);
});

/**
 * Ink hands every keypress to every active listener, so "the vim engine
 * consumed it" cannot keep the REPL's own Escape binding from firing. The
 * editor therefore gets the key first — through a ref the REPL calls — and only
 * an Escape it declines to use reaches the session.
 */
describe("Esc and the vim layer", () => {
	test("escape from insert mode leaves insert without killing the turn", async () => {
		const h = setup({ vim: true });
		await delay(40);
		// vim starts in NORMAL, where the letters are commands — the prompt has to
		// be typed into the buffer from insert mode.
		h.stdin.write("i");
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;
		expect(h.session.isRunning).toBe(true);

		h.stdin.write("half typed");
		await delay(20);
		h.stdin.write("\x1b");
		await delay(60);

		expect(h.session.isInterrupted).toBe(false); // insert mode used the key
		expect(h.frame()).toContain("[NORMAL]");

		// Nothing left to cancel: this one is the interrupt.
		h.stdin.write("\x1b");
		await delay(60);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("an idle Escape in normal mode interrupts right away", async () => {
		const h = setup({ vim: true });
		await delay(40);
		h.stdin.write("i");
		await submit(h.stdin, "run something slow");
		await delay(20);
		h.stdin.write("\x1b"); // back to NORMAL, so the next Esc is not "leave insert"
		await h.streaming.promise;
		await delay(20);

		h.stdin.write("\x1b");
		await delay(60);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("escape dismisses the @-list instead of aborting", async () => {
		const h = setup({ completeFiles: async () => ["src/index.ts"] });
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;

		h.stdin.write("@src");
		// The list loads behind a debounce, on a timer the whole test runner
		// shares: wait for the row to appear rather than betting on a duration.
		await waitFor(() => h.frame().includes("@src/index.ts"));

		h.stdin.write("\x1b");
		await waitFor(() => !h.frame().includes("@src/index.ts"));
		expect(h.session.isInterrupted).toBe(false);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);
});

/**
 * `?` and the key list behind it.
 *
 * Two presses of Escape that look identical to the terminal mean different
 * things: the first closes the overlay, the second interrupts the run. Without
 * the overlay getting first refusal on the key, opening the key list during a
 * turn and dismissing it would kill the turn — the same class of bug as the
 * dialog that used to lose its own answer to the interrupt.
 */
describe("the ? key list", () => {
	test("Esc closes it without interrupting the turn behind it", async () => {
		const h = setup();
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;
		expect(h.session.isRunning).toBe(true);

		h.stdin.write("?");
		await delay(40);
		expect(h.frame()).toContain("Keyboard shortcuts");

		h.stdin.write("\x1b");
		await delay(40);
		expect(h.frame()).not.toContain("Keyboard shortcuts");
		expect(h.session.isInterrupted).toBe(false); // the turn is still there

		// With the overlay gone, Escape means what it always did.
		h.stdin.write("\x1b");
		await delay(60);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("? closes it again, and the key never reaches the buffer", async () => {
		const h = setup();
		await delay(40);
		h.stdin.write("?");
		await delay(40);
		expect(h.frame()).toContain("Keyboard shortcuts");

		h.stdin.write("?");
		await delay(40);
		expect(h.frame()).not.toContain("Keyboard shortcuts");
		expect(h.frame()).not.toContain("?"); // not left in the prompt either
		h.unmount();
	}, 20_000);
});

/**
 * Ctrl+R and the host's Escape.
 *
 * The search is closed with the same key that interrupts a run, and an Escape
 * meant for the search must not reach the turn behind it — the editor gets the
 * key first through the same ref the vim layer uses.
 */
describe("the history search and the host", () => {
	test("Esc closes the search instead of interrupting the turn", async () => {
		const h = setup();
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;
		expect(h.session.isRunning).toBe(true);

		h.stdin.write("\x12");
		await delay(40);
		expect(h.frame()).toContain("reverse-i-search");

		h.stdin.write("\x1b");
		await delay(40);
		expect(h.frame()).not.toContain("reverse-i-search");
		expect(h.session.isInterrupted).toBe(false); // the turn is still there

		// With the search gone, Escape means what it always did.
		h.stdin.write("\x1b");
		await delay(60);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("a recalled prompt is submitted, not the search query", async () => {
		const h = setup();
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;
		h.release.resolve();
		await delay(150);

		// The earlier prompt is in this session's history, so the search finds it.
		h.stdin.write("\x12");
		await delay(40);
		h.stdin.write("slow");
		await delay(40);
		h.stdin.write("\r"); // recall it into the buffer
		await delay(40);
		expect(h.frame()).toContain("run something slow");
		expect(h.frame()).not.toContain("reverse-i-search");

		h.stdin.write("\r"); // and now send it
		await delay(60);
		const userMessages = h.session.messages.filter((m) => m.role === "user");
		expect(userMessages.length).toBe(2);
		h.unmount();
	}, 20_000);
});

/**
 * The `/status` card is on screen while the turn it describes is still running,
 * so the order in which it and the interrupt answer Escape is the whole test:
 * the card is what the user just asked to see, and pressing Escape to put it
 * away must not kill the run behind it.
 */
describe("the status card and the host", () => {
	const card = {
		model: "test/model",
		directory: "~/project",
		permissions: "default",
		session: "abc12345",
		details: [["Theme", "dark · Vim off"]] as Array<[string, string]>,
	};

	test("Esc puts the card away and leaves the turn running", async () => {
		const h = setup();
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;

		h.store.set((s) => ({ ...s, statusCard: card }));
		await delay(40);
		expect(h.frame()).toContain("Esc to dismiss");

		h.stdin.write("\x1b");
		await delay(40);
		expect(h.frame()).not.toContain("Esc to dismiss");
		expect(h.session.isInterrupted).toBe(false);

		// With the card gone, Escape means what it always did.
		h.stdin.write("\x1b");
		await delay(60);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("sending the next prompt takes it off the screen", async () => {
		const h = setup();
		await delay(40);
		h.store.set((s) => ({ ...s, statusCard: card }));
		await delay(40);
		expect(h.frame()).toContain("Esc to dismiss");

		await submit(h.stdin, "hello");
		await delay(60);
		expect(h.frame()).not.toContain("Esc to dismiss");

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);
});

/**
 * The key list has to describe the editor that is actually up. It used to be
 * built from a startup prop, so `/vim` (or anything else that changed the mode
 * mid-session) left `/help` and the `?` overlay describing an editor the user no
 * longer had.
 */
describe("what the key list says about vim", () => {
	test("/help follows the store, not the startup flag", async () => {
		const h = setup();
		await delay(40);
		await submit(h.stdin, "/help");
		await delay(60);
		expect(h.frame()).not.toContain("vim: i a insert");

		// Exactly what /vim does to the store.
		h.store.set((s) => ({ ...s, vim: true }));
		await delay(40);
		h.stdin.write("i"); // the editor is in NORMAL now, where letters are commands
		await delay(30);
		await submit(h.stdin, "/help");
		await delay(60);
		expect(h.frame()).toContain("vim: i a insert");
		h.unmount();
	}, 20_000);

	test("the ? overlay gains the vim group when the mode goes on", async () => {
		const h = setup();
		await delay(40);
		h.stdin.write("?");
		await delay(40);
		expect(h.frame()).not.toContain("redo");

		h.stdin.write("?"); // close
		await delay(40);
		h.store.set((s) => ({ ...s, vim: true }));
		await delay(40);
		h.stdin.write("i"); // NORMAL would take "?" for itself
		await delay(30);
		h.stdin.write("?");
		await delay(40);
		expect(h.frame()).toContain("redo");
		h.unmount();
	}, 20_000);
});

/** The parenthesised turn clock on the status row, e.g. "1m 05s". */
function clockOf(frame: string): string | undefined {
	return /\(([^)·]+?) ·/.exec(frame)?.[1];
}

/**
 * The turn clock against a pause for input.
 *
 * A dialog means the model is not working — it is waiting on the person in front
 * of the terminal. Charging that wait to the turn makes a run that asked for one
 * approval look like it took two minutes to do nothing, which is exactly the
 * number someone reads to decide whether the model is stuck.
 */
describe("the turn clock and dialogs", () => {
	test("the clock stops while a dialog waits for an answer", async () => {
		const h = setup();
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;
		await delay(1200);
		expect(clockOf(h.frame())).toBeDefined();

		h.store.set((state) => ({
			...state,
			dialog: { callId: "p1", toolName: "Write", inputPreview: "Allow Write?", resolve: () => {} },
		}));
		await delay(700);
		const whileWaiting = clockOf(h.frame());

		await delay(1200);
		expect(clockOf(h.frame())).toBe(whileWaiting);

		h.store.set((state) => ({ ...state, dialog: null }));
		await delay(1600);
		expect(clockOf(h.frame())).not.toBe(whileWaiting);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);
});
