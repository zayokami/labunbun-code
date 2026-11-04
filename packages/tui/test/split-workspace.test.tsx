/**
 * The split workspace: the two-column frame, and the line model that keeps the
 * transcript pane from ever needing ink to clip it.
 *
 * The rendering tests are deliberately frame-level. The bug this file exists
 * to prevent was invisible to arithmetic: ink 7.1.1 merges rows when a nested
 * box's content is taller than its fixed height, so a pane that "fit" by the
 * layout numbers still drew "0 failass" on one row. The assertions here are
 * about the frame's own rows — the count, the width of each, and the text a
 * reader would actually see.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import {
	buildConversation,
	displayWidth,
	type PaneLine,
	SplitWorkspace,
	WORKSPACE_BOTTOM_ROWS,
	WORKSPACE_MIN_COLUMNS,
	WORKSPACE_MIN_HEIGHT,
	watchColumnWidth,
	workspaceFits,
	workspaceHeight,
	wrapText,
} from "../src/components/SplitWorkspace.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import type { UiBackgroundShell, UiEntry } from "../src/ui-state.ts";

const lineText = (line: PaneLine): string => line.segments.map((segment) => segment.text).join("");
const paneRows = (lines: PaneLine[]): string[] => lines.map(lineText);

const entries: UiEntry[] = [
	{ kind: "user", text: "why does the welcome panel not show on startup?" },
	{
		kind: "assistant",
		text: "The greeting was hidden by startup notices. The banner treats any row as a conversation.",
	},
	{ kind: "toolUse", callId: "c1", toolName: "Grep", inputPreview: "conversationStarted", resultText: "REPL.tsx:930" },
	{ kind: "user", text: "run the tests" },
	{
		kind: "toolUse",
		callId: "c2",
		toolName: "Bash",
		inputPreview: "bun test packages/tui",
		resultText: "1532 pass\n0 fail",
	},
];

const shells: UiBackgroundShell[] = [
	{ id: "shell_1", command: "npm run dev", status: "running", tail: ["VITE v5 ready", "local: http://localhost:5173"] },
];

/** A conversation of `count` one-line user messages, oldest first. */
const conversation = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "user" as const, text: `message ${i + 1}` }));

describe("the workspace's budget", () => {
	test("leaves the status block and the prompt their rows, and never goes negative", () => {
		expect(workspaceHeight(24)).toBe(24 - 1 - WORKSPACE_BOTTOM_ROWS);
		expect(workspaceHeight(12)).toBe(12 - 1 - WORKSPACE_BOTTOM_ROWS);
		// A terminal shorter than the reserve has no pane rows; the split is not
		// offered there, but the arithmetic must still be safe to read.
		expect(workspaceHeight(1)).toBe(0);
		expect(workspaceHeight(0)).toBe(0);
	});

	test("the right column is a clamped share: absent when narrow, bounded when wide", () => {
		expect(watchColumnWidth(WORKSPACE_MIN_COLUMNS - 1)).toBe(0);
		expect(watchColumnWidth(WORKSPACE_MIN_COLUMNS)).toBe(40);
		expect(watchColumnWidth(100)).toBe(40);
		// 38% of 120 is 45: the transcript keeps the majority of a wide screen.
		expect(watchColumnWidth(120)).toBe(45);
		// And the panel cannot eat a wide terminal whole.
		expect(watchColumnWidth(200)).toBe(56);
		expect(watchColumnWidth(400)).toBe(56);
	});

	test("both columns need room, in both directions", () => {
		expect(workspaceFits(WORKSPACE_MIN_COLUMNS - 1, 40)).toBe(false);
		// The short side is the pane's own height, not the terminal's: the reserve
		// below the panes is the difference between the two.
		expect(workspaceFits(WORKSPACE_MIN_COLUMNS, WORKSPACE_MIN_HEIGHT + WORKSPACE_BOTTOM_ROWS + 1)).toBe(true);
		expect(workspaceFits(120, WORKSPACE_MIN_HEIGHT + WORKSPACE_BOTTOM_ROWS)).toBe(false);
		expect(workspaceFits(120, WORKSPACE_MIN_HEIGHT + WORKSPACE_BOTTOM_ROWS + 1)).toBe(true);
	});
});

describe("display width", () => {
	test("counts ASCII one, CJK two, combining marks none", () => {
		expect(displayWidth("abc")).toBe(3);
		expect(displayWidth("漢字")).toBe(4);
		expect(displayWidth("é")).toBe(1);
		expect(displayWidth("")).toBe(0);
	});
});

describe("wrapText", () => {
	test("breaks at spaces and hangs every continuation under one lead", () => {
		const lines = wrapText("one two three four", 10, "> ", "  ");
		expect(lines).toEqual(["> one two", "  three", "  four"]);
		for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(10);
	});

	test("breaks CJK at the column boundary, since it has no spaces to break at", () => {
		const lines = wrapText("漢字漢字漢字", 4);
		expect(lines).toEqual(["漢字", "漢字", "漢字"]);
	});

	test("a word longer than the pane is cut rather than allowed to overflow", () => {
		const lines = wrapText("abcdefghijklmnop", 5);
		expect(lines.every((line) => displayWidth(line) <= 5)).toBe(true);
		expect(lines.join("")).toBe("abcdefghijklmnop");
	});
});

describe("the conversation pane's line model", () => {
	test("always returns exactly the rows it was given, each no wider than the pane", () => {
		const view = buildConversation({
			entries,
			theme: DARK_THEME,
			width: 32,
			rows: 12,
			offset: 0,
			streamingText: "",
			thinkingText: "",
		});
		expect(view.lines).toHaveLength(12);
		for (const line of view.lines) expect(displayWidth(lineText(line))).toBeLessThanOrEqual(32);
	});

	test("the newest entry sits at the bottom, and the streaming answer after it", () => {
		const view = paneRows(
			buildConversation({
				entries,
				theme: DARK_THEME,
				width: 40,
				rows: 14,
				offset: 0,
				streamingText: "the answer is still arriving",
				thinkingText: "",
			}).lines,
		);
		const joined = view.join("\n");
		expect(joined).toContain("the answer is still arriving");
		expect(joined).toContain("1532 pass");
		expect(joined).toContain("0 fail");
		// The streaming block is the last content row; what follows it is padding,
		// never an older entry.
		const lastContent = view.reduce((last, line, index) => (line.trim() === "" ? last : index), 0);
		expect(view[lastContent]).toContain("the answer is still arriving");
	});

	test("a result keeps the call row it answers, and shows the tail of its output", () => {
		const output = Array.from({ length: 40 }, (_, i) => `out ${i + 1}`).join("\n");
		const view = paneRows(
			buildConversation({
				entries: [{ kind: "toolUse", callId: "c", toolName: "Bash", inputPreview: "make", resultText: output }],
				theme: DARK_THEME,
				width: 30,
				rows: 8,
				offset: 0,
				streamingText: "",
				thinkingText: "",
			}).lines,
		);
		const joined = view.join("\n");
		expect(joined).toContain("Bash");
		expect(joined).toContain("out 40");
		// The head of the output is what the tail window spends first.
		expect(joined).not.toContain("out 1 ");
	});

	test("an error result keeps its mark and its rows inside the pane", () => {
		const view = buildConversation({
			entries: [
				{
					kind: "toolUse",
					callId: "e",
					toolName: "Bash",
					inputPreview: "false",
					resultText: "boom went the build",
					isError: true,
				},
			],
			theme: DARK_THEME,
			width: 16,
			rows: 6,
			offset: 0,
			streamingText: "",
			thinkingText: "",
		});
		const joined = paneRows(view.lines).join("\n");
		expect(joined).toContain("✗ boom");
		for (const line of view.lines) expect(displayWidth(lineText(line))).toBeLessThanOrEqual(16);
	});

	test("scrolling back hides the streaming answer and names the window's entries", () => {
		const many = conversation(30);
		const live = buildConversation({
			entries: many,
			theme: DARK_THEME,
			width: 30,
			rows: 10,
			offset: 0,
			streamingText: "STILL STREAMING",
			thinkingText: "",
		});
		expect(paneRows(live.lines).join("\n")).toContain("STILL STREAMING");
		expect(live.lastEntry).toBe(30);

		const back = buildConversation({
			entries: many,
			theme: DARK_THEME,
			width: 30,
			rows: 10,
			offset: 5,
			streamingText: "STILL STREAMING",
			thinkingText: "",
		});
		expect(paneRows(back.lines).join("\n")).not.toContain("STILL STREAMING");
		expect(back.lastEntry).toBe(25);
		expect(back.firstEntry).toBeLessThan(25);
		expect(paneRows(back.lines).join("\n")).toContain("message 25");
		expect(paneRows(back.lines).join("\n")).not.toContain("message 30");
	});

	test("a terminal with no conversation paints blank rows rather than collapsing", () => {
		const view = buildConversation({
			entries: [],
			theme: DARK_THEME,
			width: 20,
			rows: 4,
			offset: 0,
			streamingText: "",
			thinkingText: "",
		});
		expect(view.lines).toHaveLength(4);
		expect(view.firstEntry).toBe(0);
		expect(view.lastEntry).toBe(0);
		for (const line of paneRows(view.lines)) expect(line.trim()).toBe("");
	});
});

/** Render the workspace at a terminal size the fake stdout can represent (it caps at 100). */
function draw(columns: number, height: number) {
	const view = render(
		<ThemeContext.Provider value={DARK_THEME}>
			<SplitWorkspace
				entries={entries}
				streamingText="The fixed panel keeps"
				thinkingText=""
				shells={shells}
				columns={columns}
				height={height}
				offset={0}
			/>
		</ThemeContext.Provider>,
	);
	const frame = view.lastFrame() ?? "";
	view.unmount();
	return frame;
}

describe("the split frame", () => {
	test("draws both panes in exactly the rows it was given, at a readable width", () => {
		const frame = draw(100, 16);
		const rows = frame.split("\n").filter((line) => line.length > 0);
		expect(rows).toHaveLength(16);
		for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(100);
		// Side by side, not stacked: the transcript's right border and the panel's
		// left border share the first row.
		expect(rows[0]).toContain("╮┌");
		expect(frame).toContain("Conversation");
		expect(frame).toContain("PgUp/PgDn scroll");
		expect(frame).toContain("ctrl+v cycles");
		expect(frame).toContain("VITE v5 ready");
	});

	test("the transcript pane carries the conversation, with no merged rows", () => {
		const frame = draw(100, 18);
		expect(frame).toContain("run the tests");
		expect(frame).toContain("1532 pass");
		expect(frame).toContain("0 fail");
		// The failure mode the line model replaced: content overflowing its box and
		// ink writing two rows into one ("pass 1532" + "fail 0" -> "0 failass").
		expect(frame).not.toContain("failass");
		expect(frame).not.toContain("pass0 fail");
	});

	test("at the minimum split size the panes still hold their budgets", () => {
		const frame = draw(WORKSPACE_MIN_COLUMNS, WORKSPACE_MIN_HEIGHT);
		const rows = frame.split("\n").filter((line) => line.length > 0);
		expect(rows).toHaveLength(WORKSPACE_MIN_HEIGHT);
		for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(WORKSPACE_MIN_COLUMNS);
		expect(frame).toContain("ctrl+v cycles");
		expect(frame).toContain("The fixed panel keeps");
	});
});
