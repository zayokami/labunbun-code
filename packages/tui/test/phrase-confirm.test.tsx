/**
 * The YOLO phrase dialog, typed into.
 *
 * The point of a dedicated dialog is the behavior this file pins: a mismatch is
 * not an answer. The question dialog's free-text row resolves whatever was
 * typed; here the dialog stays open, says why, and keeps asking until the exact
 * sentence arrives or Escape ends it. Case matters, surrounding whitespace does
 * not.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { PhraseConfirmDialog } from "../src/components/PhraseConfirmDialog.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PHRASE = "I only live once";

function setup() {
	const answers: boolean[] = [];
	const view = render(
		<ThemeContext.Provider value={DARK_THEME}>
			<PhraseConfirmDialog
				title="YOLO mode"
				phrase={PHRASE}
				off={["Dangerous-command classifier", "Ask rules"]}
				on={["Deny rules", "The sandbox"]}
				sandbox="workspace-write"
				note="Running workers adopt it from their next decision."
				resolve={(confirmed) => answers.push(confirmed)}
			/>
		</ThemeContext.Provider>,
	);
	return {
		answers,
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		lines: () => (view.lastFrame() ?? "").split("\n"),
		type: async (text: string) => {
			view.stdin.write(text);
			await delay(40);
		},
		enter: async () => {
			view.stdin.write("\r");
			await delay(40);
		},
		unmount: () => view.unmount(),
	};
}

describe("the phrase confirmation", () => {
	test("shows what it costs, what remains, the sandbox, and the phrase verbatim", async () => {
		const h = setup();
		await delay(30);
		const frame = h.frame();
		expect(frame).toContain("YOLO mode");
		expect(frame).toContain("Dangerous-command classifier");
		expect(frame).toContain("Deny rules");
		expect(frame).toContain("workspace-write");
		expect(frame).toContain(PHRASE);
		expect(frame).toContain("case-sensitive");
		expect(frame).toContain("next decision");
		h.unmount();
	});

	test("the field reads as an input: a prompt marker and what was typed", async () => {
		// The dialog asks for the one thing a label cannot ask for — a typed
		// sentence — and without the marker and the caret the row it goes on
		// looked like another line of the list, so there was no sign the dialog
		// was listening for keys at all.
		const h = setup();
		await delay(30);
		expect(h.lines().some((line) => /│\s+>\s*│/.test(line))).toBe(true);
		await h.type("I only");
		expect(h.lines().some((line) => /│\s+> I only\s*│/.test(line))).toBe(true);
		h.unmount();
	});

	test("the exact phrase resolves true", async () => {
		const h = setup();
		await delay(30);
		await h.type(PHRASE);
		await h.enter();
		expect(h.answers).toEqual([true]);
		h.unmount();
	});

	test("surrounding whitespace is trimmed and still matches", async () => {
		const h = setup();
		await delay(30);
		await h.type(`  ${PHRASE}  `);
		await h.enter();
		expect(h.answers).toEqual([true]);
		h.unmount();
	});

	/**
	 * The case that makes the phrase a confirmation rather than a prompt: the
	 * wrong capitalisation is not a different answer, it is no answer.
	 */
	test("the wrong case keeps the dialog open and shows an error", async () => {
		const h = setup();
		await delay(30);
		await h.type("i only live once");
		await h.enter();

		expect(h.answers).toEqual([]);
		expect(h.frame()).toContain("That is not the phrase");

		// Still usable: deleting the field and typing the exact phrase answers.
		for (let i = 0; i < "i only live once".length; i++) h.type("\x7f");
		await delay(20);
		await h.type(PHRASE);
		await h.enter();
		expect(h.answers).toEqual([true]);
		h.unmount();
	});

	test("an empty field is a mismatch, not a confirmation", async () => {
		const h = setup();
		await delay(30);
		await h.enter();
		expect(h.answers).toEqual([]);
		expect(h.frame()).toContain("That is not the phrase");
		h.unmount();
	});

	test("Escape cancels", async () => {
		const h = setup();
		await delay(30);
		h.type("\x1b");
		await delay(40);
		expect(h.answers).toEqual([false]);
		h.unmount();
	});
});
