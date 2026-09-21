/**
 * The window's share of the controller.
 *
 * The REPL is the last listener in the chain: the dialogs listen on their own,
 * the editor is asked first through the same ref Escape uses, and only an action
 * nobody else wanted lands here. That ordering is what these tests are about.
 *
 * The one that matters most is the permission dialog's ○. Ink hands every key to
 * every listener, and a pad has no key events to hand anywhere — so the REPL's
 * own ○ branch, which aborts a running turn, is reached by a press that was
 * meant for the dialog unless the dialog is asked first. A person answering
 * "allow this?" and losing the turn to the same button is the bug Esc had, and
 * it does not get a second life on a controller.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import type { PadAction } from "@labunbun/gamepad";
import { render } from "ink-testing-library";
import { CLEAR_SCREEN, connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { DARK_THEME } from "../src/theme.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";
import { type FakePad, fakePad, padAction } from "./fake-pad.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `done` holds. The REPL's work lands behind promises and timers the
 * whole test runner shares, so a fixed sleep long enough on an idle machine is
 * a coin flip on a loaded one — and the assertion after it would then report a
 * missing feature instead of a slow one. On timeout the caller's own assertion
 * is what fails, which is the honest error.
 */
async function waitFor(done: () => boolean, timeoutMs = 2000): Promise<void> {
	for (let waited = 0; waited < timeoutMs; waited += 10) {
		if (done()) return;
		await delay(10);
	}
}

/**
 * A turn that is genuinely in flight.
 *
 * The stream is held open at its terminal event, so `session.isRunning` is true
 * while the test drives the pad — the only state in which "did that button
 * interrupt the turn?" has an answer.
 */
function setup(options: { commands?: Array<[string, string]>; phrases?: string[] } = {}) {
	const streaming = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const faux = fauxProvider([{ text: "thinking hard" }, { text: "never reached" }]);
	const streamFn: StreamFn = async function* (model, context, opts) {
		for await (const event of faux.streamFn(model, context, opts)) {
			if (event.type === "done") {
				streaming.resolve();
				await release.promise;
			}
			yield event;
		}
	};

	const session = new AgentSession({ model: FAUX_MODEL, maxTurns: 4, deps: { streamFn } });
	const store = createStore<UiState>({ ...initialUiState(), statusPhase: "responding" });
	const unsubscribe = connectSessionToStore(session, store);
	const pad = fakePad({ phrases: options.phrases ?? ["run the tests"] });
	const ran: string[] = [];
	const view = render(
		<REPL
			getSession={() => session}
			store={store}
			modelName="test"
			onExit={() => {}}
			onCommand={(text) => {
				ran.push(text);
				return true;
			}}
			commandSuggestions={
				options.commands ?? [
					["/help", "Show commands"],
					["/theme", "Pick a theme"],
				]
			}
			pad={pad}
		/>,
	);
	// The wipe is for terminals only, and the REPL asks the stream it renders to.
	(view.stdout as { isTTY?: boolean }).isTTY = true;

	const answers: Array<[boolean, boolean]> = [];
	const openDialog = (toolName = "Write") =>
		store.set((state) => ({
			...state,
			dialog: {
				callId: `perm-${toolName}`,
				toolName,
				inputPreview: `Allow ${toolName}?`,
				resolve: (allow: boolean, alwaysAllow: boolean) => answers.push([allow, alwaysAllow]),
			},
		}));

	return {
		session,
		store,
		pad,
		ran,
		answers,
		openDialog,
		streaming,
		release,
		stdin: view.stdin,
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		frames: view.frames,
		unmount: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

/** Hand one action to the pad and let the app catch up. See pad-dialogs. */
async function press(pad: FakePad, action: PadAction): Promise<void> {
	pad.push(action);
	await delay(60);
}

/** The permission dialog, on screen. The text a press has to find there. */
const permissionDialog = (h: ReturnType<typeof setup>) => h.frame().includes("Permission required");

/**
 * Put a permission dialog up, and wait until it is really answering.
 *
 * The dialog's own state is a component local and it subscribes to the pad
 * itself, so until its first commit runs there is nothing on screen that hears
 * ○ — and the press would go to the window behind it, which is exactly the
 * mistake these tests exist to catch. Waiting on the frame is waiting on that
 * commit: ink writes it from the same task React commits in.
 */
async function showPermission(h: ReturnType<typeof setup>) {
	h.openDialog();
	await waitFor(() => permissionDialog(h));
}

/**
 * Press, then wait for the screen to show it. Without `until`, for any change.
 *
 * A wait that runs out fails here rather than falling through to the next line:
 * a press that never arrived would otherwise pass as a test that never looked.
 */
async function push(h: ReturnType<typeof setup>, action: PadAction, until?: () => boolean) {
	const before = h.frame();
	h.pad.push(action);
	const wanted = until ?? (() => h.frame() !== before);
	await waitFor(wanted);
	expect(wanted()).toBe(true);
}

/**
 * A press and the release that follows it, which is what the mapper sends.
 *
 * Every press the pad reports is followed by its own release, and the tests
 * above press without one — which is an arrangement no controller ever produces,
 * and it hid two buttons that answered the same action twice. The release needs
 * no wait of its own: `push` runs the subscribers synchronously, so whatever it
 * changed has changed by the time it returns. Nothing on screen moves for one,
 * which is the whole of what a release means.
 */
async function tap(h: ReturnType<typeof setup>, action: PadAction, until?: () => boolean) {
	await push(h, action, until);
	h.pad.push({ ...action, phase: "release" });
}

/** Start a turn and wait until the model is mid-response. */
async function startTurn(h: ReturnType<typeof setup>, text = "run something slow") {
	await delay(40);
	h.stdin.write(text);
	await delay(20);
	h.stdin.write("\r");
	await h.streaming.promise;
	await delay(40);
	expect(h.session.isRunning).toBe(true);
}

describe("○ and the running turn", () => {
	test("○ with no dialog interrupts the run", async () => {
		const h = setup();
		await startTurn(h);

		await press(h.pad, padAction("cancel", { button: "circle" }));
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	/**
	 * The parallel of `dialog-escape.test.tsx`, and the whole reason the REPL's
	 * pad branch asks about dialogs before it does anything.
	 */
	test("○ inside a permission dialog denies and leaves the turn running", async () => {
		const h = setup();
		await startTurn(h);

		await showPermission(h);
		await press(h.pad, padAction("cancel", { button: "circle" }));

		expect(h.answers).toEqual([[false, false]]);
		// The decision the user just made has to land on a live turn.
		expect(h.session.isInterrupted).toBe(false);
		expect(h.session.isRunning).toBe(true);

		// With the dialog gone, ○ means what it always meant — and the same wait
		// applies in reverse: the dialog is not gone until the screen says so.
		h.store.set((state) => ({ ...state, dialog: null }));
		await waitFor(() => !permissionDialog(h));
		await press(h.pad, padAction("cancel", { button: "circle" }));
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("□ with a dialog up does not repaint the screen behind it", async () => {
		const h = setup();
		await startTurn(h);
		const paints = h.store.get().paint;

		await showPermission(h);
		await press(h.pad, padAction("clear", { button: "square" }));

		// Clearing is not an answer, and a question is not the place for it.
		expect(h.store.get().paint).toBe(paints);
		expect(h.answers).toEqual([]);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);
});

/**
 * What the editor claims before the window does.
 *
 * Ink hands an action to every subscriber and there is no way to consume one, so
 * the hand-off — the editor's answer, asked for before the window's own switch —
 * is the only thing keeping a button the keyboard used from meaning something
 * else behind it. Both of these are that line, and both would pass on a keyboard
 * with no controller: ○ closes the keyboard and the run keeps going, □ deletes a
 * character and the transcript stays on screen.
 */
describe("the editor is asked first", () => {
	const keyboard = (h: ReturnType<typeof setup>) => h.frame().includes("On-screen keyboard");

	test("○ with the keyboard open closes it instead of interrupting the run", async () => {
		const h = setup();
		await startTurn(h);

		await push(h, padAction("osk", { button: "share" }), () => keyboard(h));
		await push(h, padAction("cancel", { button: "circle" }), () => !keyboard(h));

		// The run the user was watching is the thing ○ would have killed.
		expect(h.session.isInterrupted).toBe(false);
		expect(h.session.isRunning).toBe(true);

		// And with the keyboard gone, ○ means what it always meant.
		await push(h, padAction("cancel", { button: "circle" }), () => h.session.isInterrupted);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("□ with the keyboard open is a backspace, not a screen wipe", async () => {
		const h = setup();
		await delay(40);
		const paints = h.store.get().paint;

		await push(h, padAction("osk", { button: "share" }), () => keyboard(h));
		// A character to delete, so the press has something the screen can show.
		await push(h, padAction("confirm"));
		await push(h, padAction("clear", { button: "square" }));

		// Backspacing is not clearing: the transcript behind the prompt is intact,
		// and the keyboard is still up.
		expect(h.store.get().paint).toBe(paints);
		expect(keyboard(h)).toBe(true);

		// With the keyboard closed the same button is Ctrl+L again.
		await push(h, padAction("cancel", { button: "circle" }), () => !keyboard(h));
		await push(h, padAction("clear", { button: "square" }), () => h.store.get().paint === paints + 1);
		expect(h.store.get().paint).toBe(paints + 1);

		h.unmount();
	}, 20_000);
});

/**
 * The keyboard with the window around it.
 *
 * The editor's own tests drive it alone, which is the one arrangement where a
 * press is heard once. Inside the REPL the window asks the editor before it acts
 * — and while the editor also listened on its own, both answers were acted on:
 * one ✕ typed two letters and one step of the d-pad moved the brackets two keys,
 * so every press went one too far. Nothing in either file could see it, because
 * no test put the two together.
 */
describe("the keyboard inside the window", () => {
	/** The cell under the brackets, or undefined when there is no keyboard. */
	const marked = (h: ReturnType<typeof setup>) => /\[([^[\]\s][^[\]]*)\]/.exec(h.frame())?.[1];

	test("one ✕ types one letter, and the walk to ⏎ moves one key at a time", async () => {
		const h = setup();
		await delay(40);
		await push(h, padAction("osk", { button: "share" }), () => h.frame().includes("On-screen keyboard"));

		// The letter typed by one press. Where a double press shows is the walk
		// below: every step names the cell it lands on, and the ⏎ cell is only
		// reachable one key at a time.
		await tap(h, padAction("confirm"));
		expect(marked(h)).toBe("q");
		for (const [direction, cell] of [
			["down", "a"],
			["down", "z"],
			["down", "⇧"],
			["right", "space"],
			["right", "⌫"],
			["right", "⏎"],
		] as const) {
			await push(h, padAction(direction), () => marked(h) === cell);
		}

		// ⏎ is the cell that sends, and what it sends is the one letter that was
		// typed — a second one would have shown up here and nowhere else.
		await push(h, padAction("confirm"), () => h.store.get().entries.some((entry) => entry.kind === "user"));
		const asked = h.store
			.get()
			.entries.filter((entry) => entry.kind === "user")
			.map((entry) => entry.text);
		expect(asked).toEqual(["q"]);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	/**
	 * Options, from the prompt and back to it.
	 *
	 * The window it shows is a screen of its own, and the button that opens it
	 * has to be the button that closes it: a person who pressed Options to get
	 * here should not have to find a second, different button to get back.
	 */
	test("Options opens the transcript, and a second tap closes it", async () => {
		const h = setup();
		await delay(40);

		await tap(h, padAction("transcript", { button: "options" }), () => h.frame().includes("Transcript "));
		await tap(h, padAction("transcript", { button: "options" }), () => !h.frame().includes("Transcript "));
		expect(h.ran).toEqual([]); // nothing was run on the way

		// That the prompt is back is asked of the prompt, not of the frame: the
		// write after this one can be ink turning bracketed paste back on — the
		// editor mounting is what does it — so reading the screen here would be
		// reading a control sequence as often as a window. A press cannot be
		// misread. (A transcript still up would swallow this one.)
		await tap(h, padAction("osk", { button: "share" }), () => h.frame().includes("On-screen keyboard"));

		h.unmount();
	}, 20_000);
});

/**
 * The buttons whose whole job is to run a command.
 *
 * They go through `onCommand`, the same door a typed `/status` goes through, so
 * the app layer's registry answers both and nothing in this package has to know
 * what any of them do. What is asserted here is the mapping — which button asks
 * for which command — because that is the part `/gamepad` prints and a person
 * rebinds.
 *
 * A tap, not a press: these are the buttons whose command is a picker, and one
 * that ran twice would have opened two of them — which is what a handler that
 * read the release as a second press did.
 */
describe("the buttons that are commands", () => {
	const RUNS: Array<[PadAction["kind"], string]> = [
		["status", "/status"],
		["model", "/model"],
		["mode", "/mode"],
		// The theme pair opens the picker rather than stepping a theme: the list
		// lives upstream of this package, and the picker previews as it moves, so
		// choosing by looking at the result stays possible from a couch.
		["theme-next", "/theme"],
		["theme-prev", "/theme"],
	];

	test("each one runs the command it stands for, once per tap", async () => {
		const h = setup();
		await delay(40);

		for (const [kind, command] of RUNS) {
			const before = h.ran.length;
			await tap(h, padAction(kind), () => h.ran.length > before);
			expect(h.ran.slice(before)).toEqual([command]);
		}

		h.unmount();
	}, 30_000);

	/**
	 * Options is the transcript, and the way out is any of the ways out.
	 *
	 * The window it shows is 25 rows, so scrolling is only visible on a transcript
	 * longer than that — which is the only case where it matters.
	 */
	test("Options opens the transcript, L1 pages it, and ○ leaves", async () => {
		const h = setup();
		h.store.set((state) => ({
			...state,
			entries: Array.from({ length: 40 }, (_, i) => ({ kind: "user" as const, text: `line ${i + 1}` })),
		}));
		await delay(40);

		await push(h, padAction("transcript", { button: "options" }), () => h.frame().includes("Transcript "));
		expect(h.frame()).toContain("Transcript 16-40 of 40");

		// Toward the beginning, which is up — the same direction ↑ pages a key
		// press, and a page is ten entries.
		await push(h, padAction("up"), () => h.frame().includes("Transcript 6-30 of 40"));
		// And a shoulder is the same thing under another name.
		await push(h, padAction("page-prev", { button: "l1" }), () => h.frame().includes("Transcript 16-40 of 40"));

		await push(h, padAction("cancel", { button: "circle" }), () => !h.frame().includes("Transcript "));
		expect(h.ran).toEqual([]); // ○ closes; it does not run anything

		h.unmount();
	}, 20_000);
});

describe("□ clears the screen", () => {
	test("the pad's □ is Ctrl+L, character for character", async () => {
		const h = setup();
		await delay(40);
		expect(h.store.get().paint).toBe(0);

		await press(h.pad, padAction("clear", { button: "square" }));
		expect(h.store.get().paint).toBe(1);
		expect(h.frames.some((frame) => frame.includes(CLEAR_SCREEN))).toBe(true);

		await press(h.pad, padAction("clear", { button: "square" }));
		expect(h.store.get().paint).toBe(2);

		h.unmount();
	}, 20_000);
});

/**
 * The command wheel, from the button that opens it to the command it runs.
 *
 * Entries come from the same command table `/help` is built from, plus the
 * phrases the user wrote, so a command added to the app cannot go missing from
 * the wheel — which is the property the assertions are on.
 *
 * These press and then wait for the row they expect, rather than pressing on a
 * timer. The REPL is the whole window: a render plus the effect that hands the
 * next press its handler takes longer here than it does around a three-row
 * dialog, and a test that pressed on a fixed sleep would be measuring the
 * machine. `/help` is not a marker for the wheel — the prompt's own hint line
 * says it — so the assertions read the wheel's title and its ❯ row.
 */
describe("△ and the command wheel", () => {
	const RING = ["/help", "/theme", "run the tests"];
	/** Which ring row wears the mark, or -1 when the wheel is not up. */
	const rowOf = (frame: string) => RING.findIndex((label) => frame.includes(`${DARK_THEME.marks.selected} ${label}`));

	const shape = (h: ReturnType<typeof setup>) => () => h.frame().includes("Commands");

	test("△ opens it, and ✕ runs the command under the highlight", async () => {
		const h = setup();
		await delay(40);

		await push(h, padAction("wheel", { button: "triangle" }), shape(h));
		expect(rowOf(h.frame())).toBe(0);

		await push(h, padAction("down"), () => rowOf(h.frame()) === 1);
		await push(h, padAction("confirm"), () => !h.frame().includes("Commands"));
		expect(h.ran).toEqual(["/theme"]);

		h.unmount();
	}, 20_000);

	test("○ closes it without running anything", async () => {
		const h = setup();
		await delay(40);

		await push(h, padAction("wheel", { button: "triangle" }), shape(h));
		await push(h, padAction("cancel", { button: "circle" }), () => !h.frame().includes("Commands"));

		expect(h.ran).toEqual([]);
		expect(rowOf(h.frame())).toBe(-1);

		h.unmount();
	}, 20_000);

	test("△ closes it again, because the button that opens a thing closes it", async () => {
		const h = setup();
		await delay(40);

		await push(h, padAction("wheel", { button: "triangle" }), shape(h));
		await push(h, padAction("wheel", { button: "triangle" }), () => !h.frame().includes("Commands"));

		expect(h.ran).toEqual([]);

		h.unmount();
	}, 20_000);

	test("a phrase fills the prompt instead of running", async () => {
		const h = setup();
		await delay(40);

		await push(h, padAction("wheel", { button: "triangle" }), shape(h));
		// Commands first, then the phrases: two downs from the top is the phrase.
		await push(h, padAction("down"), () => rowOf(h.frame()) === 1);
		await push(h, padAction("down"), () => rowOf(h.frame()) === 2);
		await push(h, padAction("confirm"), () => !h.frame().includes("Commands"));

		expect(h.ran).toEqual([]);
		// Nothing was sent: the phrase is in the prompt, where the user can edit it.
		expect(h.frame()).toContain("run the tests");
		expect(h.session.messages.filter((m) => m.role === "user")).toHaveLength(0);

		h.unmount();
	}, 20_000);

	test("an empty wheel says so rather than showing an empty box", async () => {
		const h = setup({ commands: [], phrases: [] });
		await delay(40);

		await push(h, padAction("wheel", { button: "triangle" }), () => h.frame().includes("Nothing to offer"));
		// Saying so is not the same as running something.
		await press(h.pad, padAction("confirm"));
		expect(h.ran).toEqual([]);

		h.unmount();
	}, 20_000);
});
