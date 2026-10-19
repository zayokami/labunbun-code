/**
 * The structured question dialog, and the `multiSelect` questions that used to
 * render as single-choice ones — the flag travelled all the way from the tool
 * schema to the store and was then ignored by the only component that could act
 * on it, so a question the model marked as "pick any of these" silently took one
 * answer.
 *
 * The answer shape deliberately did not change: one string per question, the
 * chosen labels joined with ", ", so neither the tool result nor the transcript
 * has to know which kind of question was asked.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { QuestionDialog } from "../src/components/QuestionDialog.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import type { UiQuestion } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTheme(node: React.ReactNode) {
	return <ThemeContext.Provider value={DARK_THEME}>{node}</ThemeContext.Provider>;
}

const SINGLE: UiQuestion = {
	question: "Which approach?",
	header: "Approach",
	options: [
		{ label: "Rewrite", description: "Start over" },
		{ label: "Patch it", description: "Smaller diff" },
	],
};

const MULTI: UiQuestion = {
	...SINGLE,
	multiSelect: true,
	question: "Which parts?",
	options: [{ label: "TUI" }, { label: "Agent" }, { label: "Tools" }],
};

/** Render one question and hand back the promise the REPL is awaiting. */
function open(question: UiQuestion) {
	let answers: string[] | null | undefined;
	const { stdin, lastFrame, unmount } = render(
		withTheme(<QuestionDialog questions={[question]} resolve={(a) => (answers = a)} />),
	);
	return {
		stdin,
		frame: () => (lastFrame() ?? "").replace(/\s+/g, " "),
		answers: () => answers,
		unmount,
	};
}

describe("QuestionDialog", () => {
	test("a single-choice question still takes the highlighted option", async () => {
		const d = open(SINGLE);
		await delay(30);
		d.stdin.write("\x1b[B"); // down
		await delay(30);
		d.stdin.write("\r");
		await delay(30);
		expect(d.answers()).toEqual(["Patch it"]);
		d.unmount();
	});

	// The same coalescing the picker's burst test pins, one component over: a
	// move and the Enter it earned can share one read, dispatched in one sweep
	// before React commits the move. Confirming from the rendered value would
	// answer "Rewrite" — the option the screen was still showing when the keys
	// were dispatched.
	test("a move and Enter in one read answer the moved option", async () => {
		const d = open(SINGLE);
		await delay(30);
		d.stdin.write("\x1b[B\r"); // down, then Enter, in the same read
		await delay(30);
		expect(d.answers()).toEqual(["Patch it"]);
		d.unmount();
	});

	// And the multi-select half: a move and the Space it earned, one read. A
	// stale read would tick "TUI" — the box the highlight was on a keystroke
	// ago — so the answer names a part the user never reached.
	test("a move and Space in one read tick the moved box", async () => {
		const d = open(MULTI);
		await delay(30);
		d.stdin.write("\x1b[B "); // down to Agent, then Space, in the same read
		await delay(30);
		expect(d.frame()).toContain("[x] Agent");
		expect(d.frame()).toContain("[ ] TUI");
		d.unmount();
	});

	test("a multi-select question gets checkboxes and a Space hint", async () => {
		const d = open(MULTI);
		await delay(30);
		expect(d.frame()).toContain("[ ] TUI");
		expect(d.frame()).toContain("Space select");
		d.unmount();
	});

	test("Space toggles, and Enter confirms every toggled label", async () => {
		const d = open(MULTI);
		await delay(30);
		d.stdin.write(" "); // TUI
		await delay(30);
		d.stdin.write("\x1b[B"); // down
		await delay(30);
		d.stdin.write("\x1b[B"); // down to Tools
		await delay(30);
		d.stdin.write(" ");
		await delay(30);
		expect(d.frame()).toContain("[x] TUI");
		expect(d.frame()).toContain("[x] Tools");
		expect(d.frame()).toContain("[ ] Agent");

		d.stdin.write("\r");
		await delay(30);
		expect(d.answers()).toEqual(["TUI, Tools"]);
		d.unmount();
	});

	test("Space again clears a toggle", async () => {
		const d = open(MULTI);
		await delay(30);
		d.stdin.write(" ");
		await delay(30);
		d.stdin.write(" ");
		await delay(30);
		expect(d.frame()).toContain("[ ] TUI");

		// Nothing toggled: Enter answers with the highlighted option, so
		// confirming never dead-ends on a question that has an obvious answer.
		d.stdin.write("\r");
		await delay(30);
		expect(d.answers()).toEqual(["TUI"]);
		d.unmount();
	});

	test("Esc cancels a multi-select question too", async () => {
		const d = open(MULTI);
		await delay(30);
		d.stdin.write(" ");
		await delay(30);
		d.stdin.write("\x1b");
		await delay(30);
		expect(d.answers()).toBeNull();
		d.unmount();
	});

	test("a single-choice question offers Other, and a multi-select does not", async () => {
		const single = open(SINGLE);
		await delay(30);
		expect(single.frame()).toContain("Other…");
		single.unmount();

		const multi = open(MULTI);
		await delay(30);
		expect(multi.frame()).not.toContain("Other…");
		multi.unmount();
	});

	test("Other collects the answer that was typed", async () => {
		const d = open(SINGLE);
		await delay(30);
		d.stdin.write("\x1b[B"); // down to Patch it
		await delay(30);
		d.stdin.write("\x1b[B"); // down to Other
		await delay(30);
		d.stdin.write("\r");
		await delay(30);
		expect(d.answers()).toBeUndefined();
		expect(d.frame()).toContain("Your answer:");

		d.stdin.write("something else");
		await delay(30);
		expect(d.frame()).toContain("something else");
		d.stdin.write("\r");
		await delay(30);
		expect(d.answers()).toEqual(["something else"]);
		d.unmount();
	});

	test("an empty Other is not an answer, and Esc returns to the list", async () => {
		const d = open(SINGLE);
		await delay(30);
		d.stdin.write("\x1b[B\x1b[B\r"); // to Other, open the field
		await delay(30);
		d.stdin.write("\r"); // empty submit does nothing
		await delay(30);
		expect(d.answers()).toBeUndefined();
		expect(d.frame()).toContain("type an answer first");

		// Esc backs out to the options rather than cancelling the question: the
		// person who opened the field by mistake has not answered "no answer".
		d.stdin.write("\x1b");
		await delay(30);
		expect(d.frame()).not.toContain("Your answer:");
		expect(d.answers()).toBeUndefined();

		// The highlight is still on Other, and Enter reopens the field.
		d.stdin.write("\r");
		await delay(30);
		expect(d.frame()).toContain("Your answer:");
		d.unmount();
	});

	test("a move and Enter that lands on Other opens the field, not an answer", async () => {
		// The same coalesced-read case the options themselves pin: the ref must be
		// what the Enter reads, or a quick ↓↓+Enter answers "Patch it".
		const d = open(SINGLE);
		await delay(30);
		d.stdin.write("\x1b[B\x1b[B\r");
		await delay(30);
		expect(d.answers()).toBeUndefined();
		expect(d.frame()).toContain("Your answer:");
		d.unmount();
	});

	test("the next question starts with nothing toggled", async () => {
		let answers: string[] | null | undefined;
		const { stdin, lastFrame, unmount } = render(
			withTheme(
				<QuestionDialog questions={[MULTI, { ...MULTI, question: "Which extras?" }]} resolve={(a) => (answers = a)} />,
			),
		);
		await delay(30);
		stdin.write(" "); // TUI on question 1
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("(2/2)");
		expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("[ ] TUI");

		stdin.write("\x1b[B"); // down to Agent
		await delay(30);
		stdin.write(" ");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(answers).toEqual(["TUI", "Agent"]);
		unmount();
	});
});
