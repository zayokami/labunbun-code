/**
 * The on-screen keyboard, driven by a controller.
 *
 * The assertions follow the order a person uses it: Share opens the keyboard,
 * the d-pad walks it, ✕ presses the cell under the brackets, □ deletes, △ makes
 * the next letter a capital, and the ⏎ cell sends. ✕ never sends while the
 * keyboard is up — that is what ⏎ being a cell of its own buys, and the reason a
 * prompt cannot be sent by a thumb resting on the button that means yes.
 *
 * Sending goes through `submitCurrent`, the same function Enter calls, so the
 * busy case is the prompt's own branch and not a second implementation of it.
 * One test here is about that branch specifically, because a pad that queued
 * where a key would have steered would silently reorder what the user said.
 */
import { describe, expect, test } from "bun:test";
import type { PadAction } from "@labunbun/gamepad";
import { render } from "ink-testing-library";
import type React from "react";
import { PromptInput } from "../src/components/PromptInput.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import { fakePad, padAction } from "./fake-pad.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(done: () => boolean, timeoutMs = 2000): Promise<void> {
	for (let waited = 0; waited < timeoutMs; waited += 10) {
		if (done()) return;
		await delay(10);
	}
}

interface PromptOptions {
	busy?: boolean;
	canSteer?: boolean;
	/** Started under a full-screen view, the way the REPL leaves it during Ctrl+O. */
	hidden?: boolean;
}

/**
 * A prompt with a controller and nowhere to send to.
 *
 * Every press waits for the screen to show it. Ink writes frames on a throttle
 * and `usePadAction` refreshes its handler from an effect, so a press delivered
 * on a fixed sleep is answered by the handler of a render the screen has already
 * left — the same measurement the REPL tests carry, and the same reason.
 */
async function prompt(options: PromptOptions = {}) {
	const pad = fakePad();
	const submitted: string[] = [];
	const queued: string[] = [];
	const steered: string[] = [];
	const element = (hidden: boolean) =>
		(
			<ThemeContext.Provider value={DARK_THEME}>
				<PromptInput
					onSubmit={(text) => submitted.push(text)}
					onQueue={(text) => queued.push(text)}
					onSteer={(text) => steered.push(text)}
					busy={options.busy ?? false}
					canSteer={options.canSteer ?? false}
					pad={pad}
					hidden={hidden}
				/>
			</ThemeContext.Provider>
		) as React.ReactElement;
	const view = render(element(options.hidden ?? false));
	await delay(40);

	const frame = () => (view.lastFrame() ?? "").replace(/\s+/g, " ");
	/** Which page is up, or undefined when the keyboard is closed. */
	const keyboard = () => /On-screen keyboard · (\w+)/.exec(frame())?.[1];
	/**
	 * The cell wearing the brackets, or undefined when there is no keyboard.
	 *
	 * The pattern is fussy on purpose: the symbols page draws `[` and `]` as keys
	 * of their own, so a plain `\[(.+?)\]` finds the empty pair *between* those
	 * two neighbouring cells before it finds the selection further along the row.
	 * A selection's label starts on something that is neither a bracket nor a
	 * space, which is what tells the two apart.
	 */
	const marked = () => /\[([^[\]\s][^[\]]*)\]/.exec(frame())?.[1];

	/**
	 * One press, and the screen it produced. Without `until` the wait is for the
	 * frame to change, which is the honest signal that the press landed.
	 *
	 * A wait that runs out fails here. Polling and then carrying on would let a
	 * press that never arrived pass as a test that never looked — and the next
	 * assertion, written against a cell the cursor never reached, would be about
	 * a keyboard nobody had touched.
	 */
	const push = async (action: PadAction, until?: () => boolean) => {
		const before = frame();
		pad.push(action);
		const wanted = until ?? (() => frame() !== before);
		await waitFor(wanted, 1000);
		expect(wanted()).toBe(true);
	};
	/** A move: the brackets have to have arrived at the cell named. */
	const move = (direction: "up" | "down" | "left" | "right", label: string) =>
		push(padAction(direction), () => marked() === label);
	/** A move where the cell is the caller's business — it waits for a change. */
	const step = (direction: "up" | "down" | "left" | "right") => push(padAction(direction));

	return {
		pad,
		submitted,
		queued,
		steered,
		frame,
		keyboard,
		marked,
		push,
		move,
		step,
		/** ✕ on the cell under the brackets. */
		press: () => push(padAction("confirm")),
		/** Covered, or back on screen — the two states the window puts it in. */
		cover: (hidden: boolean) => view.rerender(element(hidden)),
		unmount: view.unmount,
	};
}

type Prompt = Awaited<ReturnType<typeof prompt>>;

/** The letters page as a grid — walking it is the test, so the grid is data. */
const LETTERS: Record<string, { row: number; col: number }> = {};
for (const [row, characters] of ["qwertyuiop", "asdfghjkl", "zxcvbnm"].entries()) {
	for (const [col, character] of [...characters].entries()) LETTERS[character] = { row, col };
}

/**
 * Walk to each character and press it, one axis of the grid at a time.
 *
 * Every step is checked against the walk's own arithmetic rather than against a
 * label in advance: the column is clamped on the way down a ragged row, so where
 * a step lands is the keyboard's answer, not this helper's. A step that moves
 * nothing is thrown rather than repeated — a keyboard that stopped answering
 * would otherwise spin here until the test itself timed out.
 */
async function type(p: Prompt, text: string) {
	for (const character of text) {
		const target = LETTERS[character];
		if (!target) throw new Error(`${character} is not on the letters page`);
		const where = () => LETTERS[p.marked() ?? ""];
		while (where()?.row !== target.row) {
			const here = where();
			if (!here) throw new Error(`the cursor left the letters page: ${p.marked()}`);
			const was = p.marked();
			await p.step(here.row < target.row ? "down" : "up");
			if (p.marked() === was) throw new Error(`a step from ${was} went nowhere`);
		}
		while (p.marked() !== character) {
			const here = where();
			if (!here) throw new Error(`the cursor left the letters page: ${p.marked()}`);
			const was = p.marked();
			await p.step(here.col < target.col ? "right" : "left");
			if (p.marked() === was) throw new Error(`a step from ${was} went nowhere`);
		}
		await p.press();
	}
}

describe("the on-screen keyboard", () => {
	test("Share opens it, ○ closes it, and nothing is typed in between", async () => {
		const p = await prompt();
		expect(p.keyboard()).toBeUndefined();

		await p.push(padAction("osk", { button: "share" }), () => p.keyboard() !== undefined);
		expect(p.keyboard()).toBe("letters");
		expect(p.marked()).toBe("q"); // the cursor stands on the first key

		await p.push(padAction("cancel", { button: "circle" }), () => p.keyboard() === undefined);
		expect(p.frame()).not.toContain("[");

		// ○ closed the keyboard; it did not send the empty buffer on its way out.
		expect(p.submitted).toEqual([]);
		p.unmount();
	}, 20_000);

	test("the d-pad walks the keyboard and the highlight follows the keys", async () => {
		const p = await prompt();
		await p.push(padAction("osk", { button: "share" }), () => p.keyboard() !== undefined);

		await p.move("right", "w");
		await p.move("down", "s");
		// The rows are ragged, so a column that ran off a long row is clamped
		// onto a key that exists rather than onto nothing.
		await p.move("down", "x");
		await p.move("down", "space");
		await p.move("right", "⌫");
		await p.move("right", "⏎");
		// The bottom row is the end of the keyboard: there is nothing below it.
		await p.move("down", "⏎");

		p.unmount();
	}, 20_000);

	test("R1 and L1 turn the pages, and every page brings its own ⏎", async () => {
		const p = await prompt();
		await p.push(padAction("osk", { button: "share" }), () => p.keyboard() !== undefined);

		await p.push(padAction("page-next", { button: "r1" }), () => p.keyboard() === "digits");
		await p.push(padAction("page-next", { button: "r1" }), () => p.keyboard() === "symbols");
		await p.push(padAction("page-next", { button: "r1" }), () => p.keyboard() === "letters");
		await p.push(padAction("page-prev", { button: "l1" }), () => p.keyboard() === "symbols");

		// Down the symbols page, which has no shift key of its own.
		await p.move("down", "-");
		await p.move("down", "/");
		await p.move("down", "space");
		await p.move("right", "⌫");
		await p.move("right", "⏎");

		p.unmount();
	}, 20_000);

	test("✕ presses the key under the brackets, and the release under it does nothing", async () => {
		const p = await prompt();
		await p.push(padAction("osk", { button: "share" }), () => p.keyboard() !== undefined);

		await p.press(); // "q"
		// Every press the mapper sends is followed by a release. A keyboard that
		// read the release as a second press would type every character twice —
		// and the only place that shows is what finally gets sent.
		await p.push(padAction("confirm", { phase: "release" }), () => p.keyboard() !== undefined);
		await p.push(padAction("cancel", { button: "circle" }), () => p.keyboard() === undefined);
		await p.press();
		expect(p.submitted).toEqual(["q"]);

		p.unmount();
	}, 20_000);

	/**
	 * □ and △ mean something else while the keyboard is up.
	 *
	 * There is no other way to delete a character with a controller, and no other
	 * way to type a capital. "Clear the screen" and "open the command wheel" are
	 * not things anyone does mid-word, so the two buttons are re-read here — the
	 * one place in the feature that judges by button rather than by action kind,
	 * which is exactly why it is asserted rather than assumed.
	 */
	test("□ is a backspace and △ is shift, while the keyboard is up", async () => {
		const p = await prompt();
		await p.push(padAction("osk", { button: "share" }), () => p.keyboard() !== undefined);

		await type(p, "hi");
		// The prompt row loses a letter, which is the change this waits for.
		await p.push(padAction("clear", { button: "square" }));
		// Deleting is not clearing: the keyboard is still up.
		expect(p.keyboard()).toBe("letters");

		await p.push(padAction("wheel", { button: "triangle" }), () => p.marked() === "I");
		await p.press();
		await p.push(padAction("cancel", { button: "circle" }), () => p.keyboard() === undefined);
		// "h", then the backspace took the "i", then shift made the next one upper.
		await p.press();
		expect(p.submitted).toEqual(["hI"]);

		p.unmount();
	}, 20_000);

	test("the ⏎ cell sends what was typed, through the prompt's own submit", async () => {
		const p = await prompt();
		await p.push(padAction("osk", { button: "share" }), () => p.keyboard() !== undefined);
		await type(p, "hi");

		// From the "i" the long way down: the row below is shorter, so the column
		// is clamped twice on the way to the ⏎.
		await p.move("down", "k");
		await p.move("down", "m");
		await p.move("down", "⏎");
		await p.push(padAction("confirm"), () => p.submitted.length > 0);

		expect(p.submitted).toEqual(["hi"]);
		p.unmount();
	}, 20_000);

	test("a ⏎ in a busy run steers, and a busy run that cannot steer queues", async () => {
		const steer = await prompt({ busy: true, canSteer: true });
		await steer.push(padAction("osk", { button: "share" }), () => steer.keyboard() !== undefined);
		await type(steer, "hi");
		await steer.move("down", "k");
		await steer.move("down", "m");
		await steer.move("down", "⏎");
		await steer.push(padAction("confirm"), () => steer.steered.length > 0);

		expect(steer.steered).toEqual(["hi"]);
		expect(steer.queued).toEqual([]);
		expect(steer.submitted).toEqual([]);
		steer.unmount();

		const queue = await prompt({ busy: true });
		await queue.push(padAction("osk", { button: "share" }), () => queue.keyboard() !== undefined);
		await type(queue, "hi");
		await queue.move("down", "k");
		await queue.move("down", "m");
		await queue.move("down", "⏎");
		await queue.push(padAction("confirm"), () => queue.queued.length > 0);

		expect(queue.queued).toEqual(["hi"]);
		expect(queue.submitted).toEqual([]);
		queue.unmount();
	}, 20_000);

	test("✕ with the keyboard closed sends, which is the button that means yes", async () => {
		const p = await prompt();
		await p.push(padAction("osk", { button: "share" }), () => p.keyboard() !== undefined);
		await type(p, "hi");
		await p.push(padAction("cancel", { button: "circle" }), () => p.keyboard() === undefined);

		await p.push(padAction("confirm"), () => p.submitted.length > 0);
		expect(p.submitted).toEqual(["hi"]);

		p.unmount();
	}, 20_000);
});

/**
 * The editor under a full-screen view, with a controller.
 *
 * Ink hands an action to every subscriber and the window asks the editor
 * *first*, so a covered editor that went on answering would be the worse half of
 * both: it would open its keyboard behind the transcript, and from then on every
 * press that followed — a page, a row of them — would be swallowed by a screen
 * nobody is looking at. The press that must go on working is the same press, on
 * the same editor, one render later.
 */
describe("a covered prompt and the buttons", () => {
	test("answers no buttons while it is covered, and the same one works once it is back", async () => {
		const p = await prompt({ hidden: true });

		p.pad.push(padAction("osk", { button: "share" }));
		await delay(120);
		expect(p.keyboard()).toBeUndefined();

		p.cover(false);
		await delay(40);
		await p.push(padAction("osk", { button: "share" }), () => p.keyboard() !== undefined);
		expect(p.keyboard()).toBe("letters");

		p.unmount();
	}, 20_000);
});
