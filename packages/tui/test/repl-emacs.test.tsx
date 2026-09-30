/**
 * `/emacs on` has to reach the prompt.
 *
 * The setting was plumbed everywhere except the one place it mattered: `app.tsx`
 * seeded the store, `/emacs` wrote the settings file, and the REPL read `s.emacs`
 * to build `/help` and the `?` overlay — but `<PromptInput>` was never given the
 * prop, and the prompt is the only thing in the tree that constructs an editor
 * engine. Every key those two surfaces advertised was a no-op in the buffer,
 * because the engine behind them did not exist.
 *
 * Two things here are not style but correctness, and both were arrived at by a
 * green that meant nothing:
 *
 *   - The keys are the ones the **host** does not own. `C-a`, `C-e`, `C-k`, `C-u`,
 *     `C-w`, `C-y`, `M-b`, `M-f` and `M-d` are already a readline layer in
 *     `PromptInput` (`:555`-`:594`) that runs whatever the editor is, so a test
 *     pressing `C-a` and watching the caret move passes with the engine deleted.
 *     `C-b` and `C-f` exist only in `EmacsEngine`.
 *   - The buffer is compared as an **exact string**, not by substring. `"hello
 *     world"` contains `"ello world"`, so the negative half of a `not.toContain`
 *     can fail on the value it was meant to be contrasted with, and the positive
 *     half happily matches a buffer that has two extra characters somewhere.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Emacs is store state, not a prop — the REPL reads what `/emacs` toggles, so the
 * test seeds the store the same way `mountRepl` does. Nothing here streams: the only
 * thing submitted is `/help`, which is answered without the session. The provider is
 * a real one rather than a throwing stub so that a submit that *should* never reach
 * the model fails as a test rather than as a hang.
 */
function setup(options: { emacs?: boolean } = {}) {
	const faux = fauxProvider([{ text: "unused" }]);
	const session = new AgentSession({
		model: FAUX_MODEL,
		maxTurns: 2,
		deps: { streamFn: (model, context, streamOptions) => faux.streamFn(model, context, streamOptions) },
	});
	const store = createStore<UiState>(initialUiState(false, options.emacs ?? false));
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
	return {
		store,
		stdin: view.stdin,
		/**
		 * The prompt's own text, out of the rounded box Ink draws it in. Exact rather
		 * than "contains the frame somewhere": the frame also carries the hint line, the
		 * transcript and the border, and three of the assertions below are about a
		 * character being *absent*, which a substring search cannot state.
		 */
		buffer: () => {
			const match = /│([^│]*)│/.exec((view.lastFrame() ?? "").replace(/\s+/g, " "));
			return match?.[1]?.trim();
		},
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		unmount: () => view.unmount(),
	};
}

/** Type, then submit — the two writes a send is, spaced the way Ink reads them. */
async function submit(stdin: { write: (text: string) => void }, text: string): Promise<void> {
	stdin.write(text);
	await delay(30);
	stdin.write("\r");
	await delay(60);
}

/**
 * Caret to offset 1 of an 11-character line, with the Left arrow rather than `C-a`:
 * both `EmacsEngine` and `PromptInput`'s readline layer answer `C-a`, so using it to
 * *set up* a test about a third key would blur which of them did what.
 */
async function caretToOne(stdin: { write: (text: string) => void }): Promise<void> {
	for (let i = 0; i < 10; i++) {
		stdin.write("\x1b[D");
		await delay(20);
	}
	await delay(30);
}

describe("/emacs and the prompt", () => {
	/**
	 * The plainest evidence the engine exists: a key it owns and the host does not,
	 * moving the caret. With no editor the same keystrokes land at the end, because a
	 * ctrl-modified character is never inserted and nothing else claims `C-b`.
	 */
	test("C-b moves the caret, so the next character lands inside the line", async () => {
		const h = setup({ emacs: true });
		await delay(40);

		h.stdin.write("hello");
		await delay(30);
		h.stdin.write("\x02"); // C-b: `backward-char` (`subr.el:1777`)
		await delay(30);
		h.stdin.write("X");
		await delay(30);

		expect(h.buffer()).toBe("hellXo");
		h.unmount();
	}, 20_000);

	/**
	 * The control for the test above, and the one that catches the version of this bug
	 * where a key works by accident. If the engine were absent, or present but not
	 * consuming, this reads "helloX".
	 */
	test("with no editor C-b does nothing at all", async () => {
		const h = setup();
		await delay(40);

		h.stdin.write("hello");
		await delay(30);
		h.stdin.write("\x02");
		await delay(30);
		h.stdin.write("X");
		await delay(30);

		expect(h.buffer()).toBe("helloX");
		h.unmount();
	}, 20_000);

	/**
	 * Where the engine and the host both have an answer, and the answer changes.
	 *
	 * `PromptInput:587` reads `C-u` as readline's kill-to-start; `EmacsEngine` reads it
	 * as `universal-argument` (`bindings.el:1298`), and the engine is asked first
	 * (`:451` runs before `:555`). So with emacs on, `C-u` stops erasing the line —
	 * which is what the `?` overlay has been promising all along ("count prefix (×4 per
	 * press)") and what it could not deliver while the engine was never built. The
	 * three keys below are the same sequence under two engines and land in two
	 * different buffers, so this is a difference in behaviour, not an absence of one.
	 */
	test("C-u arms a count rather than killing to the start of the line", async () => {
		const withEmacs = setup({ emacs: true });
		await delay(40);
		withEmacs.stdin.write("hello world");
		await delay(30);
		await caretToOne(withEmacs.stdin);
		withEmacs.stdin.write("\x15"); // C-u
		await delay(40);
		expect(withEmacs.buffer()).toBe("hello world");
		withEmacs.unmount();

		const without = setup();
		await delay(40);
		without.stdin.write("hello world");
		await delay(30);
		await caretToOne(without.stdin);
		without.stdin.write("\x15");
		await delay(40);
		expect(without.buffer()).toBe("ello world");
		without.unmount();
	}, 20_000);

	/**
	 * The other half of that conflict, and the reason `C-u` is not simply a key with two
	 * meanings: a count that is armed and then *used*. From offset 1 of the same line,
	 * `C-u C-f` moves four characters and a bare `C-f` moves one — two different
	 * strings, so the assertion tells "counted" apart from "not counted" rather than
	 * only from "nothing happened".
	 */
	test("a count armed with C-u is applied to the command that follows", async () => {
		const h = setup({ emacs: true });
		await delay(40);
		h.stdin.write("hello world");
		await delay(30);
		await caretToOne(h.stdin);

		h.stdin.write("\x15"); // C-u: ×4
		await delay(30);
		h.stdin.write("\x06"); // C-f: `forward-char` (`subr.el:1776`)
		await delay(30);
		h.stdin.write("X");
		await delay(30);

		expect(h.buffer()).toBe("helloX world");
		h.unmount();
	}, 20_000);

	/**
	 * The two surfaces that advertise Emacs, and the prompt that has to honour it.
	 *
	 * Asserted in one test on purpose: before the fix the first half passed and the second
	 * did not, which is the shape of the bug — a help screen that is right and a prompt
	 * that does not listen to it.
	 */
	test("what /help promises is what the prompt does, after `/emacs on` mid-session", async () => {
		const h = setup();
		await delay(40);

		// Before: no editor, so no emacs line at all.
		await submit(h.stdin, "/help");
		expect(h.frame()).not.toContain("emacs: Ctrl-A/E");

		// Exactly what `/emacs on` does to the store.
		h.store.set((s) => ({ ...s, emacs: true }));
		await delay(40);

		await submit(h.stdin, "/help");
		expect(h.frame()).toContain("emacs: Ctrl-A/E");

		// And the promise it just made is one the buffer keeps. The submit cleared it, so
		// this starts from empty.
		h.stdin.write("hello");
		await delay(30);
		h.stdin.write("\x02");
		await delay(30);
		h.stdin.write("X");
		await delay(30);
		expect(h.buffer()).toBe("hellXo");
		h.unmount();
	}, 20_000);

	/** The overlay is built from the same answer, and it was right while the prompt was not. */
	test("the ? overlay's emacs group lists keys the prompt now answers to", async () => {
		const h = setup({ emacs: true });
		await delay(40);

		h.stdin.write("?");
		await delay(60);
		expect(h.frame()).toContain("M-C-w"); // `make the next kill append`
		expect(h.frame()).toContain("C-x u");
		h.unmount();
	}, 20_000);

	/**
	 * The overlay's `C-x u`, pressed.
	 *
	 * The last test asserts the *list* says it; this asserts the buffer does it, and the two were
	 * different things for the whole life of the wiring bug. The sequence also had a second fault
	 * underneath the first: `emacs.ts` compared the member as `C-u`, so `C-x` followed by the
	 * bare `u` the binding actually spells was read and dropped — a `u` that went nowhere and
	 * said nothing. A key that is swallowed is harder to notice than one that is wrong, which is
	 * why this presses it rather than trusting the row.
	 *
	 * The `Z` is load-bearing rather than padding. A run of typing is **one** undo step
	 * (`#reconcileTyped` coalesces it), so the undo below empties the buffer, and an empty prompt
	 * renders the hint line where the text row was — so `buffer()` would read that line rather
	 * than an empty string, and "did the undo happen" would be indistinguishable from "did the
	 * hint change". Typing past it puts the evidence back where it can be compared: had the undo
	 * done nothing, this box reads `helloXZ`.
	 */
	test("C-x u undoes in the prompt, and C-x C-u is not a second way to spell it", async () => {
		const h = setup({ emacs: true });
		await delay(40);

		h.stdin.write("helloX");
		await delay(30);
		expect(h.buffer()).toBe("helloX");

		// `C-x` is a prefix key: consumed, nothing run, the key after it is still a member.
		h.stdin.write("\x18");
		await delay(30);
		expect(h.buffer()).toBe("helloX");

		h.stdin.write("u");
		await delay(40);
		h.stdin.write("Z");
		await delay(30);
		expect(h.buffer()).toBe("Z");

		// And the control, one modifier away: with ctrl on the member it is `upcase-region` in
		// Emacs (`subr.el:1748`), which this engine does not implement, so it runs nothing rather
		// than undoing. A dispatch comparing `key.ctrl && input === "u"` passes every assertion
		// above and fails exactly here.
		h.stdin.write("\x18");
		await delay(30);
		h.stdin.write("\x15"); // C-u
		await delay(30);
		expect(h.buffer()).toBe("Z");
		h.unmount();
	}, 20_000);
});
