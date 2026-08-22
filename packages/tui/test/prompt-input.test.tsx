/**
 * The three prompt/REPL fixes that go with the markdown one: `/help` built from
 * the live command table, ↑ recall reaching earlier sessions, and a caret on an
 * empty buffer. Each is asserted against rendered output, because each was
 * reported as "the terminal looks wrong", not as a unit-level fault.
 */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { MessageList } from "../src/components/MessageList.tsx";
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
});
