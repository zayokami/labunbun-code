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
import {
	MODE_BADGE_COLOR,
	modeBadgeColor,
	PromptInput,
	placeholderCaret,
	renderLineWithCursorAndSelection,
} from "../src/components/PromptInput.tsx";
import type { PadPromptRef } from "../src/pad.ts";
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

	test("Shift+Enter inserts a newline instead of submitting", async () => {
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} />));
		await delay(30);
		stdin.write("a");
		// What a kitty-protocol terminal sends for Shift+Enter: codepoint 13 with
		// the shift modifier. The legacy `\r` carries no modifier, which is why the
		// app negotiates the protocol before this key can be told from Enter.
		stdin.write("\x1b[13;2u");
		stdin.write("b");
		await delay(30);
		expect(submitted).toEqual([]);
		expect(flat(lastFrame())).toContain("│ a │");
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["a\nb"]);
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

	test("Enter runs the highlighted entry, not the bare prefix", async () => {
		// The footer promises "Enter run"; the prefix that opened the list is not a
		// command — submitting `/th` under a highlighted `/theme` answers
		// "Unknown command: /th".
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("/th");
		await delay(30);
		expect(flat(lastFrame())).toContain("/theme");
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["/theme"]);
		unmount();
	});

	test("Enter runs whichever entry is highlighted", async () => {
		const submitted: string[] = [];
		const { stdin, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("/th");
		await delay(30);
		stdin.write("\x1b[B"); // down: /think is the highlighted one now
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["/think"]);
		unmount();
	});

	test("a bare / still submits as-is: it asks for the command list", async () => {
		// The app answers `/` with the full command list (repl.test pins that).
		// Picking the first suggestion here would either run an arbitrary command
		// or make that list unreachable.
		const submitted: string[] = [];
		const { stdin, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("/");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["/"]);
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

	test("a description match finds a command whose name does not contain the query", async () => {
		const DESCRIBED: Array<[string, string]> = [
			["/theme", "Show or switch theme"],
			["/resume", "Resume an earlier session"],
			["/rename", "Title this session"],
		];
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={DESCRIBED} />),
		);
		await delay(30);
		stdin.write("/session");
		await delay(30);
		const frame = flat(lastFrame());
		expect(frame).toContain("/resume");
		expect(frame).toContain("/rename");
		expect(frame).not.toContain("/theme");
		unmount();
	});

	test("the list shows eight rows and scrolls to the highlighted one", async () => {
		const MANY: Array<[string, string]> = Array.from({ length: 12 }, (_, i) => [
			`/cmd${String(i + 1).padStart(2, "0")}`,
			"a command",
		]);
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={MANY} />),
		);
		await delay(30);
		stdin.write("/cmd");
		await delay(30);
		let frame = flat(lastFrame());
		expect(frame).toContain("1-8 of 12");
		expect(frame).toContain("/cmd08");
		expect(frame).not.toContain("/cmd12");

		for (let i = 0; i < 11; i++) {
			stdin.write("\x1b[B");
			await delay(10);
		}
		await delay(30);
		frame = flat(lastFrame());
		expect(frame).toContain("5-12 of 12");
		expect(frame).toContain("/cmd12");
		unmount();
	});

	test("a query that matches nothing says so", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} />),
		);
		await delay(30);
		stdin.write("/zzz");
		await delay(30);
		expect(flat(lastFrame())).toContain("No matching commands");
		unmount();
	});
});

/**
 * `/` under the vim editor.
 *
 * In NORMAL the key is vim's search by right, and the engine takes it as one —
 * on a buffer that has anything to search. On an *empty* buffer that search
 * finds nothing and draws nothing, so there the prompt makes the key the
 * command door its placeholder advertises: the whole point is that the key, the
 * list, and the keys after it all behave exactly as if the command had been
 * typed by hand from insert mode.
 */
describe("slash commands under vim", () => {
	const COMMANDS: Array<[string, string]> = [
		["/theme", "Show or switch theme"],
		["/think", "Set thinking level"],
	];

	test("NORMAL / on an empty prompt opens the list and the keys after it type", async () => {
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} commandSuggestions={COMMANDS} vim />),
		);
		await delay(30);

		stdin.write("/");
		await delay(30);
		// The door opened and the editor is typing in it: the list is up and the
		// badge says the keys that follow are text, not commands.
		expect(flat(lastFrame())).toContain("/theme");
		expect(flat(lastFrame())).toContain("[INSERT]");

		// "the" only matches /theme, so a narrowing list proves the letters landed
		// in the buffer rather than being read as motions.
		stdin.write("the");
		await delay(30);
		const frame = flat(lastFrame());
		expect(frame).toContain("/theme");
		expect(frame).not.toContain("/think");

		stdin.write("\t");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["/theme"]);
		unmount();
	});

	test("NORMAL / then Enter runs the highlighted command without Tab", async () => {
		const submitted: string[] = [];
		const { stdin, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} commandSuggestions={COMMANDS} vim />),
		);
		await delay(30);
		stdin.write("/");
		await delay(30);
		stdin.write("th");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["/theme"]);
		unmount();
	});

	test("INSERT / still types into the buffer", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={() => {}} commandSuggestions={COMMANDS} vim />),
		);
		await delay(30);
		stdin.write("i");
		await delay(30);
		stdin.write("/th");
		await delay(30);
		// Both entries match "/th" — the point is only that the list is up at all.
		expect(flat(lastFrame())).toContain("/theme");
		expect(flat(lastFrame())).toContain("/think");
		unmount();
	});

	test("a buffer with text in it keeps / as the search, and the line is drawn", async () => {
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} commandSuggestions={COMMANDS} vim />),
		);
		await delay(30);
		stdin.write("i");
		stdin.write("ab");
		stdin.write("\x1b"); // leave insert: the caret steps back onto "b"
		await delay(30);

		stdin.write("/");
		await delay(30);
		stdin.write("q");
		await delay(30);
		// The search line, on screen — without it every key from the `/` on went
		// into something invisible.
		const frame = flat(lastFrame());
		expect(frame).toContain("/q");
		expect(frame).toContain("ab"); // the buffer is still there, untouched

		// Enter belongs to the search while the line is open: it must not submit.
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual([]);
		expect(flat(lastFrame())).not.toContain("/q");
		expect(flat(lastFrame())).toContain("ab");
		unmount();
	});
});

/**
 * GNU incremental search (C-s / C-r). The engine owns every key while a search
 * is running — printable characters extend the query, Enter and Escape accept,
 * C-g cancels — so these tests are about the host's half of the contract: draw
 * the frozen `isearch` snapshot, and do not submit the prompt when the search
 * consumes Enter.
 */
describe("emacs incremental search", () => {
	test("C-s starts forward and typed characters are the query, not the buffer", async () => {
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} emacs />));
		await delay(30);
		stdin.write("ab");
		await delay(30);
		stdin.write("\x01"); // C-a: put point before the text, where the match is
		await delay(30);

		stdin.write("\x13"); // C-s
		await delay(30);
		stdin.write("a");
		stdin.write("b");
		await delay(30);
		const frame = flat(lastFrame());
		expect(frame).toContain("I-search: ab");
		expect(submitted).toEqual([]);

		// The query never entered the buffer. Accepting leaves point at the end of
		// the match, so "!" lands after "ab": a buffer that had swallowed the
		// search text would submit something longer or in another place.
		stdin.write("\r");
		await delay(30);
		stdin.write("!");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["ab!"]);
		unmount();
	});

	test("a failing query says Failing I-search", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} emacs />));
		await delay(30);
		stdin.write("abc");
		await delay(30);
		stdin.write("\x13"); // C-s
		await delay(30);
		// Forward from the end of "abc": there is no "z" to find.
		stdin.write("z");
		await delay(30);
		expect(flat(lastFrame())).toContain("Failing I-search: z");
		unmount();
	});

	test("C-r starts backward and the label says so", async () => {
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} emacs />));
		await delay(30);
		stdin.write("abc abc");
		await delay(30);
		stdin.write("\x12"); // C-r
		await delay(30);
		stdin.write("b");
		await delay(30);
		expect(flat(lastFrame())).toContain("I-search backward: b");
		unmount();
	});

	test("Enter accepts without submitting, and the buffer is untouched", async () => {
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} emacs />));
		await delay(30);
		stdin.write("abc");
		await delay(30);
		stdin.write("\x01"); // C-a
		await delay(30);
		stdin.write("\x13"); // C-s
		await delay(30);
		stdin.write("b");
		await delay(30);
		expect(flat(lastFrame())).toContain("I-search: b");

		// Enter belongs to the search: it accepts at the match and must not reach
		// the prompt's submit path.
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual([]);
		expect(flat(lastFrame())).not.toContain("I-search");
		expect(flat(lastFrame())).toContain("abc");

		// Point sits at the end of the match (between "b" and "c"), so "!" proves
		// the accepted search changed neither the text nor the caret beyond that.
		stdin.write("!");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["ab!c"]);
		unmount();
	});

	test("C-g cancels: the line disappears and point returns to the activation point", async () => {
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} emacs />));
		await delay(30);
		stdin.write("abc abc");
		await delay(30);
		stdin.write("\x12"); // C-r: activated at the end, point 7
		await delay(30);
		stdin.write("b");
		await delay(30);
		expect(flat(lastFrame())).toContain("I-search backward: b");

		stdin.write("\x07"); // C-g on a successful search cancels to the origin
		await delay(30);
		expect(flat(lastFrame())).not.toContain("I-search");

		// The caret returned to the activation point (the end), so "!" appends to
		// the original buffer instead of landing on the match at point 5.
		stdin.write("!");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["abc abc!"]);
		unmount();
	});

	test("Escape accepts the search and normal editing works afterwards", async () => {
		const submitted: string[] = [];
		const { stdin, lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} emacs />));
		await delay(30);
		stdin.write("abc");
		await delay(30);
		stdin.write("\x01"); // C-a
		await delay(30);
		stdin.write("\x13"); // C-s
		await delay(30);
		stdin.write("b");
		await delay(30);
		expect(flat(lastFrame())).toContain("I-search: b");

		// A single Escape is unbound in `isearch-mode-map`, so it accepts at point
		// rather than cancelling; the host must not treat it as an interrupt.
		stdin.write("\x1b");
		await delay(30);
		expect(flat(lastFrame())).not.toContain("I-search");

		// Point is at the end of the match; typing flows into the buffer again.
		stdin.write("!");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual(["ab!c"]);
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

/**
 * The editor under a full-screen view.
 *
 * Ctrl+O leaves the prompt mounted, because what is in it — the buffer, the undo
 * stack, the folded pastes, the history search — cannot be rebuilt from anywhere
 * else, and the screen a user comes back to should be the screen they left. What
 * it must not be is *listening*: ink hands a key to every subscriber, so a
 * covered editor would take what is typed at the transcript, answer the Escape
 * the window asks for, and hand the window a pad handle it would use to push
 * presses into a screen nobody can see. `display: none` in the host takes it off
 * the screen; the three below are what take it out of the conversation.
 */
describe("a covered prompt", () => {
	const DRAFT = "a draft";

	test("takes no keys, and still has the draft once it is back", async () => {
		const submitted: string[] = [];
		const editor = (hidden: boolean) => withTheme(<PromptInput onSubmit={(t) => submitted.push(t)} hidden={hidden} />);
		const { stdin, lastFrame, rerender, unmount } = render(editor(false));
		await delay(30);
		stdin.write(DRAFT);
		await delay(30);

		rerender(editor(true));
		await delay(30);
		stdin.write("ZZZ");
		await delay(30);

		rerender(editor(false));
		await delay(30);
		expect(flat(lastFrame())).toContain(DRAFT);
		// The keys went to the transcript, where they paged it or meant nothing.
		// Bytes in a buffer nobody can see are worse than a lost keystroke: they
		// arrive in the message, and the draft arrives with them.
		expect(flat(lastFrame())).not.toContain("ZZZ");

		// And the buffer is the buffer, not a redraw of it: what comes back is
		// what the user wrote, submitted by the key that submits.
		stdin.write("\r");
		await delay(30);
		expect(submitted).toEqual([DRAFT]);
		unmount();
	});

	test("takes no paste either: pasted text is not inserted into a covered buffer", async () => {
		// Ink keeps pasted text on a channel of its own — it is delivered as one
		// string, never as the key presses it is made of — so turning the keyboard
		// off is not the same as turning this off. A paste that landed while the
		// transcript was up would be found in the sentence the user came back to.
		const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
		const editor = (hidden: boolean) => withTheme(<PromptInput onSubmit={() => {}} hidden={hidden} />);
		const { stdin, lastFrame, rerender, unmount } = render(editor(false));
		await delay(30);
		stdin.write(paste("first"));
		await delay(30);
		expect(flat(lastFrame())).toContain("first"); // the channel works at all

		rerender(editor(true));
		await delay(30);
		stdin.write(paste("second"));
		await delay(30);

		rerender(editor(false));
		await delay(30);
		expect(flat(lastFrame())).toContain("first");
		expect(flat(lastFrame())).not.toContain("second");
		unmount();
	});

	test("offers the window no Escape handler while it is covered", async () => {
		// The window asks this ref before it acts on Escape, and the editor's
		// Escape means "close my keyboard", "drop my @-list" — answers for a screen
		// that is not on. An empty ref is the whole of what is promised here: the
		// window is left with nothing to call rather than a handler for the screen
		// behind it.
		const escapeRef: React.RefObject<(() => boolean) | null> = { current: null };
		const editor = (hidden: boolean) =>
			withTheme(<PromptInput onSubmit={() => {}} escapeRef={escapeRef} hidden={hidden} />);
		const { rerender, unmount } = render(editor(false));
		await delay(30);
		expect(typeof escapeRef.current).toBe("function");

		rerender(editor(true));
		await delay(30);
		expect(escapeRef.current).toBeNull();

		rerender(editor(false));
		await delay(30);
		expect(typeof escapeRef.current).toBe("function");
		unmount();
	});

	test("publishes no pad handle while it is covered", async () => {
		// Same ref, same reason: the window hands a press to the editor through
		// this handle before it does anything with it, and a covered editor taking
		// that press would be the window's paging there and its own typing here.
		const padRef: PadPromptRef = { current: null };
		const editor = (hidden: boolean) => withTheme(<PromptInput onSubmit={() => {}} padRef={padRef} hidden={hidden} />);
		const { rerender, unmount } = render(editor(false));
		await delay(30);
		expect(padRef.current).not.toBeNull();

		rerender(editor(true));
		await delay(30);
		expect(padRef.current).toBeNull();

		rerender(editor(false));
		await delay(30);
		expect(padRef.current).not.toBeNull();
		unmount();
	});
});

/**
 * The permission mode badge. The colours are asserted on the lookup rather than
 * on a frame: ink draws no colour without a TTY, and the case that needs
 * pinning hardest — a label the picker has no row for — is exactly the one a
 * frame cannot show. What the frame is good for is the other half: the badge
 * still renders, as text, in front of the hint it shares its line with.
 */
describe("the permission mode badge", () => {
	test("each named mode has its own colour, and an unnamed pair is muted", () => {
		expect(MODE_BADGE_COLOR.Ask).toBe("textMuted");
		expect(MODE_BADGE_COLOR.Plan).toBe("accent");
		expect(MODE_BADGE_COLOR.Agent).toBe("warning");
		expect(MODE_BADGE_COLOR["Agent 无沙箱"]).toBe("permission");
		expect(modeBadgeColor("Ask", DARK_THEME)).toBe(DARK_THEME.textMuted);
		expect(modeBadgeColor("Plan", DARK_THEME)).toBe(DARK_THEME.accent);
		// `describeModeChoice` spells out a pair the picker has no row for. It is
		// still a mode, and the badge does not invent a colour for it.
		expect(modeBadgeColor("plan · danger-full-access", DARK_THEME)).toBe(DARK_THEME.textMuted);
	});

	test("the badge reaches the row, in front of the hint it shares the line with", async () => {
		const { lastFrame, unmount } = render(withTheme(<PromptInput onSubmit={() => {}} modeLabel="Plan" />));
		await delay(30);
		expect(flat(lastFrame())).toContain("[Plan] Enter send");
		unmount();
	});
});

describe("the caret is one whole character", () => {
	// Written as a code point: a combining mark typed into source is one save away from
	// being folded into its letter by an editor.
	const ACUTE = String.fromCharCode(0x301);
	/** The pieces the line is drawn as: text before, the highlighted run, text after. */
	function pieces(node: unknown): unknown[] {
		return (node as { props: { children: unknown[] } }).props.children;
	}
	const inverse = (node: unknown) => (node as { props: { children: string } }).props.children;

	test("an emoji under the caret is highlighted as a pair, never as its first half", () => {
		// Highlighting one code unit put the escape codes between the halves of the
		// pair, and the terminal received two broken characters in place of one.
		const [before, caret, after] = pieces(renderLineWithCursorAndSelection({ text: "a😀b", cursor: 1 }, 0, 1, null));
		expect(before).toBe("a");
		expect(inverse(caret)).toBe("😀");
		expect(after).toBe("b");
	});

	test("a base letter and its combining mark are one character", () => {
		const [before, caret, after] = pieces(
			renderLineWithCursorAndSelection({ text: `e${ACUTE}x`, cursor: 0 }, 0, 0, null),
		);
		expect(before).toBe("");
		expect(inverse(caret)).toBe(`e${ACUTE}`);
		expect(after).toBe("x");
	});

	test("past the last character the caret is still a blank cell", () => {
		const [before, caret, after] = pieces(renderLineWithCursorAndSelection({ text: "ab", cursor: 2 }, 0, 2, null));
		expect(before).toBe("ab");
		expect(inverse(caret)).toBe(" ");
		expect(after).toBe("");
	});

	test("inside a selection the caret keeps its whole character too", () => {
		// A selection comes back as a flat list of pieces rather than a fragment. The
		// emoji is selected whole and the caret stands on it, so everything
		// highlighted is the pair and nothing of it is left outside.
		const out = renderLineWithCursorAndSelection({ text: "a😀b", cursor: 1 }, 0, 1, { start: 1, end: 3 });
		const highlighted = (out as unknown[]).filter((piece) => typeof piece === "object" && piece !== null);
		expect(highlighted.map(inverse)).toEqual(["😀"]);
		expect(out).toContain("b");
	});
});
