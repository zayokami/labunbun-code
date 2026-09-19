/**
 * The three prompt/REPL fixes that go with the markdown one: `/help` built from
 * the live command table, ↑ recall reaching earlier sessions, and a caret on an
 * empty buffer. Each is asserted against rendered output, because each was
 * reported as "the terminal looks wrong", not as a unit-level fault.
 */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { MessageList, StreamingPreview } from "../src/components/MessageList.tsx";
import { PromptInput, placeholderCaret } from "../src/components/PromptInput.tsx";
import { DARK_THEME, type Theme, ThemeContext } from "../src/theme.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTheme(node: React.ReactNode, theme: Theme = DARK_THEME) {
	return <ThemeContext.Provider value={theme}>{node}</ThemeContext.Provider>;
}

/**
 * Ink pads and wraps frames, and marks arrive as escape sequences. Comparing a
 * whitespace-collapsed frame keeps these assertions about what the user can read
 * rather than about layout.
 */
function flat(frame: string | undefined): string {
	return (frame ?? "").replace(/\s+/g, " ");
}

describe("prompt input", () => {
	// With no caret the prompt reads as unfocused, and there is nothing on screen
	// saying the REPL is accepting input. The split is asserted directly because
	// ink emits no ANSI when stdout is not a TTY, so a frame cannot show which run
	// was drawn inverse.
	test("the placeholder splits into a caret character and the rest", () => {
		expect(placeholderCaret("Type here")).toEqual({ caret: "T", rest: "ype here" });
	});

	test("an empty placeholder still yields a caret to draw", () => {
		expect(placeholderCaret("")).toEqual({ caret: " ", rest: "" });
	});

	test("an empty buffer renders the placeholder", async () => {
		const { lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} placeholder="Type here" />));
		await delay(30);
		expect(lastFrame() ?? "").toContain("Type here");
		unmount();
	});

	test("the caret is gone once there is text under it", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} placeholder="Type here" />),
		);
		await delay(30);
		stdin.write("x");
		await delay(30);
		expect(lastFrame() ?? "").not.toContain("Type here");
		unmount();
	});

	test("up arrow recalls a prompt from an earlier session", async () => {
		// The buffer used to be seeded with [], so recall could only reach prompts
		// typed in the current session — nothing at all on a fresh start.
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} history={["first prompt", "second prompt"]} />),
		);
		await delay(30);
		stdin.write("\x1b[A"); // up
		await delay(30);
		expect(flat(lastFrame())).toContain("second prompt");
		stdin.write("\x1b[A");
		await delay(30);
		expect(flat(lastFrame())).toContain("first prompt");
		unmount();
	});

	test("down arrow walks back toward the draft", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} history={["older", "newer"]} />),
		);
		await delay(30);
		stdin.write("\x1b[A");
		stdin.write("\x1b[A");
		await delay(30);
		expect(flat(lastFrame())).toContain("older");
		stdin.write("\x1b[B"); // down
		await delay(30);
		expect(flat(lastFrame())).toContain("newer");
		unmount();
	});

	test("a recalled prompt submits as-is", async () => {
		const submitted: string[] = [];
		const { stdin, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} history={["run the tests"]} />),
		);
		await delay(30);
		stdin.write("\x1b[A");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["run the tests"]);
		unmount();
	});

	test("up arrow on an empty history leaves the buffer alone", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} placeholder="ph" />));
		await delay(30);
		stdin.write("\x1b[A");
		await delay(30);
		expect(lastFrame() ?? "").toContain("ph"); // still the placeholder
		unmount();
	});

	// Escape means something different in every vim mode, and the one it does not
	// mean in insert is the one that kills the turn. A single fixed "Esc interrupt"
	// was wrong for exactly the press a user makes most.
	test("the Esc hint follows the vim mode", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} vim />));
		await delay(30);
		// NORMAL with an empty buffer: nothing to cancel, so the host keeps it.
		expect(flat(lastFrame())).toContain("Esc interrupt");

		stdin.write("i");
		await delay(30);
		expect(flat(lastFrame())).toContain("Esc normal");

		stdin.write("\x1b");
		await delay(30);
		stdin.write("v");
		await delay(30);
		expect(flat(lastFrame())).toContain("Esc cancel");

		stdin.write("\x1b");
		await delay(30);
		expect(flat(lastFrame())).toContain("Esc interrupt");
		unmount();
	});

	test("Backspace in normal mode moves instead of erasing", async () => {
		// Ink hands the key to the component either way, so the mode has to decide
		// what it means: in NORMAL it is vim's motion, in INSERT the host's delete.
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} vim />));
		await delay(30);
		stdin.write("i");
		stdin.write("abc");
		await delay(30);
		stdin.write("\x1b"); // leave insert: the caret steps back onto "c"
		await delay(30);
		stdin.write("\x7f"); // Backspace: one step left, no edit
		await delay(30);
		expect(flat(lastFrame())).toContain("abc");

		stdin.write("\x1b[3~"); // Delete: `x` on the character under the caret
		await delay(30);
		expect(flat(lastFrame())).toContain("ac"); // 'b' gone: the motion left it there
		unmount();
	});

	test("without vim the hint is always the interrupt", async () => {
		const { lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} />));
		await delay(30);
		expect(flat(lastFrame())).toContain("Esc interrupt");
		unmount();
	});

	test("`?` on an empty prompt asks for the key list", async () => {
		// `?` is an ordinary character everywhere else, so the buffer's owner has
		// to be the one to give it up — the host's key handler cannot take it back.
		let asked = 0;
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} onToggleHelp={() => asked++} />),
		);
		await delay(30);
		stdin.write("?");
		await delay(30);
		expect(asked).toBe(1);
		expect(flat(lastFrame())).toContain("Try"); // still the placeholder
		unmount();
	});

	test("`?` after a character is just a question mark", async () => {
		const submitted: string[] = [];
		const { stdin, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} onToggleHelp={() => submitted.push("HELP")} />),
		);
		await delay(30);
		stdin.write("what?");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["what?"]);
		unmount();
	});

	test("turning vim off hands the keys back to the editor", async () => {
		// The engine was created but never dropped, so the hooks went on feeding
		// it keys long after the flag went false: `r` stayed vim's redo and the
		// letter never reached the buffer.
		const { stdin, lastFrame, rerender, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} vim />));
		await delay(30);
		expect(flat(lastFrame())).toContain("[NORMAL]");

		stdin.write("r"); // normal mode: redo, and there is nothing to redo
		await delay(30);
		expect(flat(lastFrame())).toContain("Try"); // still the placeholder

		rerender(withTheme(<PromptInput onSubmit={() => {}} />));
		await delay(30);
		expect(flat(lastFrame())).not.toContain("[NORMAL]");
		expect(flat(lastFrame())).toContain("Esc interrupt");

		stdin.write("r");
		await delay(30);
		expect(flat(lastFrame())).not.toContain("Try"); // the letter landed
		unmount();
	});
});

/**
 * Editing around characters that are more than one UTF-16 unit. Asserted on the
 * submitted text rather than a frame: a corrupted surrogate pair renders as a
 * replacement box, and the frame comparison would not tell the two apart.
 */
describe("insert-mode editing over astral characters", () => {
	/** Type keys, submit, and hand back what the REPL would have received. */
	async function submitAfter(keys: string[]): Promise<string[]> {
		const submitted: string[] = [];
		const { stdin, unmount } = render(withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} />));
		await delay(30);
		for (const k of keys) {
			stdin.write(k);
			await delay(30);
		}
		unmount();
		return submitted;
	}

	test("Backspace deletes the whole emoji, not the low surrogate half", async () => {
		expect(await submitAfter(["ab😀", "\x7f", "\r"])).toEqual(["ab"]);
	});

	test("Delete takes the whole emoji under the caret", async () => {
		// Ctrl+A to the line start, one step right (past "a"), then Delete.
		expect(await submitAfter(["a😀b", "\x01", "\x1b[C", "\x1b[3~", "\r"])).toEqual(["ab"]);
	});

	test("Left steps over the pair instead of landing inside it", async () => {
		// Two steps from the end land before the emoji, so the X goes in front of
		// it; a unit-wise step would land on the low surrogate and split the pair.
		expect(await submitAfter(["a😀", "\x1b[D", "\x1b[D", "X", "\r"])).toEqual(["Xa😀"]);
	});

	test("Right steps over the pair", async () => {
		expect(await submitAfter(["😀b", "\x01", "\x1b[C", "X", "\r"])).toEqual(["😀Xb"]);
	});
});

describe("slash command suggestions", () => {
	const COMMANDS: Array<[string, string]> = [
		["/theme", "Show or switch theme"],
		["/think", "Set thinking level"],
		["/tools", "List tools"],
	];

	test("Tab writes the highlighted suggestion into the buffer", async () => {
		// Cycling alone left the user staring at a list they could not accept.
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("/th");
		await delay(30);
		stdin.write("\t");
		await delay(30);
		expect(flat(lastFrame())).toContain("/theme");
		unmount();
	});

	test("Tab again moves to the next match once the buffer already holds one", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("/th");
		await delay(30);
		stdin.write("\t");
		await delay(30);
		stdin.write("\t");
		await delay(30);
		expect(flat(lastFrame())).toContain("/think");
		unmount();
	});

	test("a completed command submits without further editing", async () => {
		const submitted: string[] = [];
		const { stdin, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("/the");
		await delay(30);
		stdin.write("\t");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["/theme"]);
		unmount();
	});

	test("Tab with no suggestions open does not insert anything", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("hello");
		await delay(30);
		stdin.write("\t");
		await delay(30);
		expect(flat(lastFrame())).toContain("hello");
		expect(flat(lastFrame())).not.toContain("/theme");
		unmount();
	});

	test("arrows move through the list instead of recalling history", async () => {
		// Recalling history here would replace the half-typed command with an old
		// prompt, which is the opposite of what someone browsing commands wants.
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} history={["an old prompt"]} />),
		);
		await delay(30);
		stdin.write("/t");
		await delay(30);
		stdin.write("\x1b[B"); // down
		await delay(30);
		const frame = flat(lastFrame());
		expect(frame).not.toContain("an old prompt");
		expect(frame).toContain("/t");
		// The second entry is now the one Tab would accept.
		stdin.write("\t");
		await delay(30);
		expect(flat(lastFrame())).toContain("/think");
		unmount();
	});

	test("up arrow wraps to the last suggestion", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("/t");
		await delay(30);
		stdin.write("\x1b[A"); // up from the first entry
		await delay(30);
		stdin.write("\t");
		await delay(30);
		expect(flat(lastFrame())).toContain("/tools");
		unmount();
	});

	test("history recall still works once the list is closed", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} history={["an old prompt"]} />),
		);
		await delay(30);
		stdin.write("\x1b[A");
		await delay(30);
		expect(flat(lastFrame())).toContain("an old prompt");
		unmount();
	});
});

/**
 * Ctrl+R. The rule about vim is not re-implemented here — the vim engine claims
 * Ctrl+R for redo in normal and visual mode before this component sees it, and
 * that is the whole rule.
 */
describe("reverse history search", () => {
	const HISTORY = ["run the tests", "fix the build", "run the linter"];

	test("Ctrl+R opens the search and filters as the query is typed", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} history={HISTORY} />));
		await delay(30);
		stdin.write("\x12");
		await delay(30);
		expect(flat(lastFrame())).toContain("(reverse-i-search)`':");

		stdin.write("fix");
		await delay(30);
		const frame = flat(lastFrame());
		expect(frame).toContain("`fix'");
		expect(frame).toContain("fix the build");
		expect(frame).not.toContain("run the tests");
		unmount();
	});

	test("Enter puts the match in the buffer without submitting it", async () => {
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} history={HISTORY} />),
		);
		await delay(30);
		stdin.write("\x12");
		await delay(30);
		stdin.write("linter");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual([]); // still editable, not sent
		expect(flat(lastFrame())).not.toContain("reverse-i-search");
		expect(flat(lastFrame())).toContain("run the linter");
		unmount();
	});

	test("Esc closes the search and leaves the buffer alone", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} history={HISTORY} placeholder="ph" />),
		);
		await delay(30);
		stdin.write("\x12");
		await delay(30);
		stdin.write("\x1b");
		await delay(30);
		const frame = flat(lastFrame());
		expect(frame).not.toContain("reverse-i-search");
		expect(frame).toContain("ph"); // the buffer was never written
		unmount();
	});

	test("up walks to the next older match, and wraps", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} history={HISTORY} />));
		await delay(30);
		stdin.write("\x12");
		await delay(30);
		stdin.write("run");
		await delay(30);
		// Newest match first: "run the linter".
		expect(flat(lastFrame())).toContain("`run': run the linter");
		stdin.write("\x1b[A");
		await delay(30);
		expect(flat(lastFrame())).toContain("`run': run the tests");
		unmount();
	});

	test("a query with no match says so instead of promising an entry", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} history={HISTORY} />));
		await delay(30);
		stdin.write("\x12");
		await delay(30);
		stdin.write("zzz");
		await delay(30);
		expect(flat(lastFrame())).toContain("no match");
		unmount();
	});

	test("history typed in this session is searchable too", async () => {
		// The prop only seeds the list; what ↑ recall walks is the live one.
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} />));
		await delay(30);
		stdin.write("deploy the thing");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		stdin.write("\x12");
		await delay(30);
		stdin.write("deploy");
		await delay(30);
		expect(flat(lastFrame())).toContain("`deploy': deploy the thing");
		unmount();
	});

	test("in vim normal mode Ctrl+R is redo, so no search opens", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} history={HISTORY} vim />));
		await delay(30);
		expect(flat(lastFrame())).toContain("[NORMAL]");
		stdin.write("\x12");
		await delay(30);
		expect(flat(lastFrame())).not.toContain("reverse-i-search");
		unmount();
	});

	test("in vim insert mode it is the search again", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} history={HISTORY} vim />));
		await delay(30);
		stdin.write("i");
		await delay(30);
		stdin.write("\x12");
		await delay(30);
		expect(flat(lastFrame())).toContain("reverse-i-search");
		unmount();
	});
});

describe("assistant markdown rendering", () => {
	test("bold markers are consumed, not printed", async () => {
		// The end-to-end form of the reported bug: the asterisks reached the screen.
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "assistant", text: "**LaBunbun Code** is ready" }]} />),
		);
		const frame = flat(lastFrame());
		expect(frame).toContain("LaBunbun Code is ready");
		expect(frame).not.toContain("**");
	});

	test("a fenced code block renders its contents without the fence", () => {
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "assistant", text: "```ts\nconst a = 1;\n```" }]} />),
		);
		const frame = flat(lastFrame());
		expect(frame).toContain("const a = 1;");
		expect(frame).not.toContain("```");
	});

	test("list items get a bullet and headings drop their hashes", () => {
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "assistant", text: "## Steps\n- do this\n- then that" }]} />),
		);
		const frame = flat(lastFrame());
		expect(frame).toContain("Steps");
		expect(frame).not.toContain("##");
		expect(frame).toContain("• do this");
		expect(frame).toContain("• then that");
	});

	test("a link shows its label, not its markup", () => {
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "assistant", text: "see [the docs](https://example.com)" }]} />),
		);
		const frame = flat(lastFrame());
		expect(frame).toContain("the docs");
		expect(frame).not.toContain("](");
	});

	test("inline code inside a sentence keeps only its contents", () => {
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "assistant", text: "run `bun test` first" }]} />),
		);
		const frame = flat(lastFrame());
		expect(frame).toContain("run bun test first");
		expect(frame).not.toContain("`");
	});

	// A user prompt is shown verbatim: if someone types asterisks, that is what
	// they typed, and rewriting it would misquote them.
	test("user text is not markdown-parsed", () => {
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "user", text: "what does **this** do" }]} />),
		);
		expect(flat(lastFrame())).toContain("**this**");
	});

	test("a table renders as aligned columns, not as pipes", () => {
		const text = "| Name | Size |\n|------|-----:|\n| a | 1 |\n| bbbb | 22 |";
		const { lastFrame } = render(withTheme(<MessageList entries={[{ kind: "assistant", text }]} />));
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Name");
		expect(frame).toContain("bbbb");
		expect(frame).not.toContain("|---");
		// The column separator is the theme's, and the header rule is drawn.
		expect(frame).toContain(DARK_THEME.marks.tableColumn);
		expect(frame).toContain("─");
	});

	test("table columns line up across rows", () => {
		const text = "| Name | N |\n|------|---|\n| a | 1 |\n| bbbb | 22 |";
		const { lastFrame } = render(withTheme(<MessageList entries={[{ kind: "assistant", text }]} />));
		const lines = (lastFrame() ?? "").split("\n");
		const separator = DARK_THEME.marks.tableColumn;
		const columns = lines.filter((l) => l.includes(separator)).map((l) => l.indexOf(separator));
		// Header, rule, and both body rows: four lines, one shared column.
		expect(columns).toHaveLength(4);
		expect(new Set(columns).size).toBe(1);
	});

	test("code in a fence is syntax highlighted without altering the text", () => {
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "assistant", text: '```ts\nconst a = "x"; // note\n```' }]} />),
		);
		expect(flat(lastFrame())).toContain('const a = "x"; // note');
	});
});

describe("streaming preview", () => {
	// The reported bug: formatting snapped into place only once the response
	// finished, because the preview printed raw text and the markdown path ran
	// just on sealed entries.
	test("markdown renders while the text is still arriving", () => {
		const { lastFrame } = render(withTheme(<StreamingPreview text={"## Result\n- **done**"} thinking="" />));
		const frame = flat(lastFrame());
		expect(frame).toContain("Result");
		expect(frame).toContain("• done");
		expect(frame).not.toContain("##");
		expect(frame).not.toContain("**");
	});

	test("a half-arrived mark stays literal instead of flickering", () => {
		// Eating the characters until the closing mark lands would make the
		// transcript rewrite itself on every delta.
		const { lastFrame } = render(withTheme(<StreamingPreview text="almost **bol" thinking="" />));
		expect(flat(lastFrame())).toContain("almost **bol");
	});

	test("an unterminated fence renders the code that arrived", () => {
		const { lastFrame } = render(withTheme(<StreamingPreview text={"```ts\nconst a = 1;"} thinking="" />));
		const frame = flat(lastFrame());
		expect(frame).toContain("const a = 1;");
		expect(frame).not.toContain("```");
	});

	test("thinking shows only until real text arrives", () => {
		const thinking = render(withTheme(<StreamingPreview text="" thinking="pondering" />));
		expect(flat(thinking.lastFrame())).toContain("pondering");
		const answering = render(withTheme(<StreamingPreview text="the answer" thinking="pondering" />));
		const frame = flat(answering.lastFrame());
		expect(frame).toContain("the answer");
		expect(frame).not.toContain("pondering");
	});

	test("nothing to show renders nothing", () => {
		const { lastFrame } = render(withTheme(<StreamingPreview text="" thinking="" />));
		expect((lastFrame() ?? "").trim()).toBe("");
	});
});
