import { describe, expect, test } from "bun:test";
import type { AgentMessage, Usage } from "@labunbun/ai";
import { render } from "ink-testing-library";
import type React from "react";
import { MessageList } from "../src/components/MessageList.tsx";
import { PermissionDialog } from "../src/components/PermissionDialog.tsx";
import { ShortcutOverlay } from "../src/components/ShortcutOverlay.tsx";
import { CONTEXT_BAR_SEGMENTS, contextBar, StatusCard } from "../src/components/StatusCard.tsx";
import {
	backgroundShellRow,
	CONTEXT_LOW_FREE_PERCENT,
	StatusLine,
	toolSummary,
} from "../src/components/StatusLine.tsx";
import { RESULT_LEAD, TOOL_DOT } from "../src/figures.ts";
import { permissionDiff } from "../src/permission-diff.ts";
import { permissionOptions } from "../src/permission-options.ts";
import { shortcutGroups } from "../src/shortcuts.ts";
import { createStore } from "../src/store.ts";
import { DARK_THEME, HIGH_CONTRAST_DARK, type Theme, ThemeContext } from "../src/theme.ts";
import {
	entriesFromMessages,
	initialUiState,
	RESULT_TEXT_CAP,
	reduceEvent,
	toolPreview,
	type UiBackgroundShell,
	type UiState,
} from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One line, single-spaced: ink wraps at the terminal width, which splits long labels. */
const flatFrame = (frame: string) => frame.replace(/\s+/g, " ");

function withTheme(node: React.ReactNode, theme: Theme = DARK_THEME) {
	return <ThemeContext.Provider value={theme}>{node}</ThemeContext.Provider>;
}

describe("MessageList", () => {
	test("renders user, assistant, tool, and error entries", () => {
		const { lastFrame } = render(
			withTheme(
				<MessageList
					entries={[
						{ kind: "user", text: "list the files" },
						{ kind: "toolUse", callId: "c1", toolName: "Bash", inputPreview: "ls", resultText: "a.txt" },
						{ kind: "assistant", text: "Here are the files." },
						{ kind: "error", text: "Error: boom" },
					]}
				/>,
			),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("list the files");
		// The dot and the call share a row — no `[name] args` header, no box — and
		// the result opens under the lead on the next one.
		expect(frame).toContain(`${TOOL_DOT} Bash(ls)`);
		expect(frame).toContain(`${RESULT_LEAD}a.txt`);
		expect(frame).toContain("Here are the files.");
		expect(frame).toContain("Error: boom");
	});

	test("an answered row prints the turn's cache share, and a row without cache prints nothing", () => {
		const { lastFrame } = render(
			withTheme(
				<MessageList
					entries={[
						{ kind: "assistant", text: "done", cache: { read: 3000, write: 500, prompt: 4000 } },
						{ kind: "assistant", text: "plain" },
					]}
				/>,
			),
		);
		const frame = flatFrame(lastFrame() ?? "");
		expect(frame).toContain("cache 75% of 4.0k · 3.0k read · 500 written");
		// A row the provider charged no cache for is not annotated with zeros.
		expect(frame.match(/cache /g)).toHaveLength(1);
	});

	// The parens are the arguments: a call that has no preview to show gets
	// none at all, because `Bash()` would read as a call passed nothing.
	test("a call with no arguments shows no parens at all", () => {
		const { lastFrame } = render(
			withTheme(
				<MessageList
					entries={[{ kind: "toolUse", callId: "c1", toolName: "Bash", inputPreview: "", resultText: "ok" }]}
				/>,
			),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain(`${TOOL_DOT} Bash`);
		expect(frame).not.toContain("()");
	});

	test("tool result preview truncates long output", () => {
		const long = "x".repeat(1000);
		const { lastFrame } = render(
			withTheme(
				<MessageList
					entries={[{ kind: "toolUse", callId: "c1", toolName: "Read", inputPreview: "f.txt", resultText: long }]}
				/>,
			),
		);
		const frame = lastFrame() ?? "";
		// The preview says how much it is not showing, and where the rest is.
		expect(frame).toContain("600 more characters · Ctrl+O for transcript");
		expect(frame).not.toContain("x".repeat(500)); // full output never rendered
	});

	test("transcript mode says the reducer capped the stored output", () => {
		// Ctrl+O lifts the *preview* cap; it cannot lift the reducer's, because the
		// rest of the string was never kept. Saying which cap is in force is the
		// difference between "scroll further" and "this is all there is".
		const { lastFrame } = render(
			withTheme(
				<MessageList
					full
					entries={[
						{
							kind: "toolUse",
							callId: "c1",
							toolName: "Bash",
							inputPreview: "cat big.log",
							resultText: "x".repeat(RESULT_TEXT_CAP),
							resultTotalChars: RESULT_TEXT_CAP + 25,
							resultTruncated: true,
						},
					]}
				/>,
			),
		);
		expect(lastFrame() ?? "").toContain("(output capped at 16,000 characters)");
	});

	test("a response that ended early says so instead of looking finished", () => {
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "assistant", text: "half an ans", incomplete: true }]} />),
		);
		expect(lastFrame() ?? "").toContain("(response ended early; output is partial)");
	});

	test("an interrupted tool result reads as stopped, not as failed", () => {
		// `isError` is true on the wire because pairing needs it, but the call did
		// not fail — it was stopped. The row must not wear the failure mark.
		const { lastFrame } = render(
			withTheme(
				<MessageList
					entries={[
						{
							kind: "toolUse",
							callId: "c1",
							toolName: "Bash",
							inputPreview: "sleep 99",
							resultText: "half a line",
							isError: true,
							interrupted: true,
						},
					]}
				/>,
			),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("(interrupted; output is partial)");
		expect(frame).not.toContain(DARK_THEME.marks.error);
	});

	// State cannot rely on color alone: a colorblind reader, or anyone piping the
	// output through something that strips ANSI, still has to be able to tell an
	// error from a success.
	test("marks state with a symbol, so it survives without color", () => {
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ kind: "error", text: "boom" }]} />, HIGH_CONTRAST_DARK),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain(HIGH_CONTRAST_DARK.marks.error);
		expect(frame).toContain("boom");
	});

	test("takes the error mark from the active theme", () => {
		const custom: Theme = { ...DARK_THEME, marks: { ...DARK_THEME.marks, error: "[FAIL]" } };
		const { lastFrame } = render(withTheme(<MessageList entries={[{ kind: "error", text: "boom" }]} />, custom));
		expect(lastFrame() ?? "").toContain("[FAIL]");
	});

	// The store has been writing these updates all along; nothing read them, so a
	// long command looked frozen from start to finish.
	test("a running tool shows the tail of what it has printed", () => {
		const streamed = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		const { lastFrame } = render(
			withTheme(
				<MessageList
					entries={[{ kind: "toolUse", callId: "c1", toolName: "Bash", inputPreview: "build" }]}
					liveOutputs={{ c1: streamed }}
				/>,
			),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("line 9"); // the newest line is the point of the window
		expect(frame).toContain("… 5 lines omitted");
		expect(frame).not.toContain("line 4"); // the oldest is dropped, not scrolled past
	});

	// A failed MCP call has no output to stream and is not over yet: the client
	// sends the reason on the same update channel, and it was the one shape the
	// reducer dropped — so the call that timed out told the screen nothing.
	test("an MCP error arrives on the update channel instead of being dropped", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, {
			type: "tool_execution_start",
			callId: "c1",
			toolName: "mcp__fixture__sleep",
			input: { ms: 60_000 },
		});
		state = reduceEvent(state, {
			type: "tool_execution_update",
			callId: "c1",
			toolName: "mcp__fixture__sleep",
			partial: { mcpError: "fixture/sleep timed out after 300ms" },
		});
		expect(state.liveOutputs.c1).toBe("fixture/sleep timed out after 300ms");

		const { lastFrame } = render(withTheme(<MessageList entries={state.entries} liveOutputs={state.liveOutputs} />));
		expect(flatFrame(lastFrame() ?? "")).toContain("fixture/sleep timed out after 300ms");
	});

	test("the result replaces the stream", () => {
		const entry = { kind: "toolUse" as const, callId: "c1", toolName: "Bash", inputPreview: "build" };
		// The reducer drops the stream when the result lands, but a renderer that
		// trusted the map alone would still be holding a stale copy.
		const { lastFrame } = render(
			withTheme(<MessageList entries={[{ ...entry, resultText: "done" }]} liveOutputs={{ c1: "half a line" }} />),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("done");
		expect(frame).not.toContain("half a line");
	});

	test("a tool with nothing to show renders exactly as it did before", () => {
		const entries = [{ kind: "toolUse" as const, callId: "c1", toolName: "Bash", inputPreview: "ls" }];
		const withEmptyMap = render(withTheme(<MessageList entries={entries} liveOutputs={{ c1: "" }} />));
		const withoutMap = render(withTheme(<MessageList entries={entries} />));
		expect(withEmptyMap.lastFrame()).toBe(withoutMap.lastFrame());
	});

	test("only the newest two running tools get a preview", () => {
		// Without the cap, a batch of concurrent commands each streaming output
		// pushes the prompt off the bottom of the screen.
		const entries = ["c1", "c2", "c3"].map((callId) => ({
			kind: "toolUse" as const,
			callId,
			toolName: "Bash",
			inputPreview: `run ${callId}`,
		}));
		const { lastFrame } = render(
			withTheme(<MessageList entries={entries} liveOutputs={{ c1: "oldest", c2: "middle", c3: "newest" }} />),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("newest");
		expect(frame).toContain("middle");
		expect(frame).not.toContain("oldest");
	});
});

describe("StatusLine", () => {
	test("spells a long turn in hours and minutes, not as a pile of seconds", () => {
		const { lastFrame } = render(withTheme(<StatusLine phase="tools" modelName="test-model" elapsedMs={3_661_000} />));
		const frame = lastFrame() ?? "";
		expect(frame).toContain("1h 01m 01s");
		expect(frame).toContain("Running tools…");
	});

	test("an idle status line reports no duration at all", () => {
		const { lastFrame } = render(withTheme(<StatusLine phase="idle" modelName="test-model" elapsedMs={5000} />));
		expect(lastFrame() ?? "").not.toContain("5s");
	});

	test("the idle row's context figure reads the same with the percentage split out", () => {
		// The percentage left the dim so a low one can wear `warning`; what reaches
		// the screen is the same sentence it was, parentheses and all. The color
		// itself is not assertable — ink draws no color without a TTY — which is
		// why the threshold below is checked as a value.
		const { lastFrame, unmount } = render(
			withTheme(
				<StatusLine
					phase="idle"
					modelName="test-model"
					elapsedMs={0}
					contextInfo={{ usedTokens: 55_000, threshold: 100_000 }}
				/>,
			),
		);
		expect(flatFrame(lastFrame() ?? "")).toContain("ctx 55.0k (45% free)");
		unmount();
	});

	test("the low-free threshold is twenty percent, and the comparison is strict", () => {
		// Pinned as a value: the row's own use of it is `free < threshold`, and a
		// reader deciding what "low" means needs the number, not the expression.
		expect(CONTEXT_LOW_FREE_PERCENT).toBe(20);
	});

	test("a compaction in flight takes the label and leaves the rest of the row", () => {
		// The wait it names happens inside a turn, so the clock and the model are
		// still the ones on screen — and Esc still ends the turn it is part of.
		// Without the activity the row would say "Thinking…", which is true and is
		// not what the half-minute is being spent on.
		const { lastFrame, unmount } = render(
			withTheme(
				<StatusLine phase="thinking" modelName="test-model" elapsedMs={12_000} activity="Compacting context…" />,
			),
		);
		const frame = flatFrame(lastFrame() ?? "");
		expect(frame).toContain("Compacting context…");
		expect(frame).not.toContain("Thinking…");
		expect(frame).toContain("12s");
		expect(frame).toContain("test-model");
		expect(frame).toContain("esc to interrupt");
		// Unmounted, unlike its neighbours: this row spins, and a live interval
		// belongs to the whole test process — every later file shares it.
		unmount();
	});

	test("a compaction's own seconds ride in its label, next to the turn's clock", () => {
		// The row already carries how long the turn has run; the number the wait
		// needs is how long *this* pass has been going — a summary can be most of
		// the turn, and "Summarizing…" alone cannot tell a slow call from a stuck
		// one. Two numbers, two spans, told apart by which one the parenthesis
		// belongs to.
		const { lastFrame, unmount } = render(
			withTheme(
				<StatusLine
					phase="thinking"
					modelName="test-model"
					elapsedMs={3_000}
					activity="Summarizing context…"
					activitySince={Date.now() - 12_000}
				/>,
			),
		);
		const frame = flatFrame(lastFrame() ?? "");
		expect(frame).toContain("Summarizing context… (12s)");
		expect(frame).toContain("3s");
		unmount();
	});

	test("a long thought climbs the ladder, on its own clock", () => {
		// Two numbers, two spans: the parenthesis keeps counting the turn, the
		// label counts the thinking run inside it.
		const { lastFrame, unmount } = render(
			withTheme(<StatusLine phase="thinking" modelName="test-model" elapsedMs={60_000} thinkingMs={50_000} />),
		);
		const frame = flatFrame(lastFrame() ?? "");
		expect(frame).toContain("Deep in the groove");
		expect(frame).not.toContain("Thinking…");
		expect(frame).toContain("1m 00s");
		unmount();
	});

	test("a thought under the first threshold — or without a clock at all — reads the base word", () => {
		const young = render(
			withTheme(<StatusLine phase="thinking" modelName="test-model" elapsedMs={2_000} thinkingMs={9_999} />),
		);
		expect(flatFrame(young.lastFrame() ?? "")).toContain("Thinking…");
		young.unmount();
		const missing = render(withTheme(<StatusLine phase="thinking" modelName="test-model" elapsedMs={2_000} />));
		expect(flatFrame(missing.lastFrame() ?? "")).toContain("Thinking…");
		missing.unmount();
	});

	test("the ladder is the thinking label's alone", () => {
		const { lastFrame, unmount } = render(
			withTheme(<StatusLine phase="tools" modelName="test-model" elapsedMs={60_000} thinkingMs={50_000} />),
		);
		const frame = flatFrame(lastFrame() ?? "");
		expect(frame).toContain("Running tools…");
		expect(frame).not.toContain("Deep in the groove");
		unmount();
	});

	test("and at an idle prompt it still spins, without promising Esc", () => {
		// `/compact` typed at a prompt that is not running anything: the row would
		// otherwise be the dim idle one, which says nothing while a summarization
		// is being paid for. Esc is not offered because there is no run to end —
		// the idle REPL does not read the key at all.
		const { lastFrame, unmount } = render(
			withTheme(<StatusLine phase="idle" modelName="test-model" elapsedMs={0} activity="Compacting context…" />),
		);
		const frame = flatFrame(lastFrame() ?? "");
		expect(frame).toContain("Compacting context…");
		expect(frame).not.toContain("esc to interrupt");
		// No duration either: the clock measures turns, and this is not one.
		expect(frame).not.toContain("0s");
		unmount();
	});

	// Three parallel Bash calls listed as "Bash · Bash · Bash" make the reader do
	// the counting; the row is there to be read at a glance.
	test("repeated tools are counted instead of repeated", () => {
		const tools = (names: string[]) => names.map((toolName, i) => ({ callId: `c${i}`, toolName }));
		expect(toolSummary(tools(["Bash", "Bash", "Read"]))).toBe("Bash ×2 · Read");
		expect(toolSummary(tools(["Grep"]))).toBe("Grep");
		expect(toolSummary([])).toBe("");
	});
});

describe("background shell row", () => {
	const shell = (id: string, status: UiBackgroundShell["status"]): UiBackgroundShell => ({
		id,
		command: `run ${id}`,
		status,
		tail: [],
	});

	test("says nothing at all until something is actually running", () => {
		expect(backgroundShellRow([])).toBeNull();
		// A finished shell is not news: the row exists to answer "is anything
		// still going", and answering it forever would make the row permanent.
		expect(backgroundShellRow([shell("shell_1", "completed"), shell("shell_2", "killed")])).toBeNull();
	});

	test("counts only the running ones, and points at both commands", () => {
		const row = backgroundShellRow([shell("shell_1", "running"), shell("shell_2", "completed")]);
		expect(row).toContain("1 background shell running");
		expect(row).toContain("/ps to view");
		expect(row).toContain("/stop to close");
	});

	test("one shell is singular, two are plural", () => {
		expect(backgroundShellRow([shell("shell_1", "running"), shell("shell_2", "running")])).toContain(
			"2 background shells running",
		);
	});
});

describe("StatusCard", () => {
	const data = {
		model: "anthropic/claude-sonnet-5",
		directory: "~/projects/thing",
		permissions: "default",
		session: "abc12345",
		details: [["Cost", "$0.1234 (this project, all sessions)"]] as Array<[string, string]>,
	};

	test("one row per fact, and a hint for the key that closes it", () => {
		const frame = flatFrame(
			render(
				withTheme(<StatusCard data={{ ...data, context: { usedTokens: 76_000, threshold: 200_000 } }} />),
			).lastFrame() ?? "",
		);
		for (const text of [
			"Model",
			"anthropic/claude-sonnet-5",
			"Directory",
			"~/projects/thing",
			"Permissions",
			"abc12345",
			"Cost",
		]) {
			expect(frame).toContain(text);
		}
		expect(frame).toContain("38%");
		expect(frame).toContain("Esc to dismiss");
	});

	test("before anything is measured it says so instead of drawing an empty bar", () => {
		const frame = flatFrame(render(withTheme(<StatusCard data={data} />)).lastFrame() ?? "");
		expect(frame).toContain("measured after the first turn");
		expect(frame).not.toContain("░");
	});

	test("the bar is proportional, and clamps when the context is over the line", () => {
		const empty = contextBar(0, 100);
		expect(empty.filled).toBe(0);
		expect(empty.percent).toBe(0);
		expect(empty.bar).toBe("░".repeat(CONTEXT_BAR_SEGMENTS));

		const half = contextBar(50, 100);
		expect(half.filled).toBe(CONTEXT_BAR_SEGMENTS / 2);
		expect(half.percent).toBe(50);

		// Past the threshold the bar is full, not overflowing: the card is a
		// rectangle whose width cannot depend on how far past the limit it is.
		const over = contextBar(250, 100);
		expect(over.filled).toBe(CONTEXT_BAR_SEGMENTS);
		expect(over.percent).toBe(100);
		expect(over.bar).toBe("█".repeat(CONTEXT_BAR_SEGMENTS));

		// An unmeasured threshold must not divide by zero.
		expect(contextBar(10, 0).filled).toBe(0);
	});

	test("a card with no session rows is a card about one other thing", () => {
		// `/context` draws its breakdown on the same card. It has no model or
		// directory to report, and a blank row for each would be two rows of noise
		// on a card whose whole point is the numbers.
		const frame = flatFrame(
			render(
				withTheme(
					<StatusCard
						data={{
							title: "Context",
							context: { usedTokens: 20_000, threshold: 100_000 },
							details: [["System prompt", "5.0k"]],
						}}
					/>,
				),
			).lastFrame() ?? "",
		);
		expect(frame).toContain("Context");
		expect(frame).toContain("System prompt");
		expect(frame).not.toContain("Status");
		expect(frame).not.toContain("Model");
	});
});

describe("ShortcutOverlay", () => {
	const groups = () => shortcutGroups({ editor: "none", commands: [["/status", "Show status"]] });

	test("lists the keys and what they do, commands included", () => {
		const { lastFrame } = render(withTheme(<ShortcutOverlay groups={groups()} columns={100} />));
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Keyboard shortcuts");
		expect(frame).toContain("Enter");
		expect(frame).toContain("send");
		expect(frame).toContain("/status");
		expect(frame).toContain("Esc or ? to close");
	});

	test("a narrow terminal stacks the groups instead of wrapping them", () => {
		// Two headings sharing a screen row is the two-column layout; under it,
		// side by side would push each description onto a line of its own.
		const sideBySide = (frame: string) =>
			frame.split("\n").some((line) => line.includes("Prompt") && line.includes("Commands"));
		const wide = render(withTheme(<ShortcutOverlay groups={groups()} columns={100} />)).lastFrame() ?? "";
		const narrow = render(withTheme(<ShortcutOverlay groups={groups()} columns={50} />)).lastFrame() ?? "";
		expect(sideBySide(wide)).toBe(true);
		expect(sideBySide(narrow)).toBe(false);
		// Folding is about width, never about content.
		expect(narrow).toContain("/status");
	});

	// Two rows in the Vim group are both "Esc" — leaving insert and cancelling a
	// selection. Both are real rows a reader needs, and the frame cannot tell them
	// apart from a duplicate: verify the content is there.
	test("keys that appear twice in one group both keep their own description", () => {
		const frame =
			render(
				withTheme(<ShortcutOverlay groups={shortcutGroups({ editor: "vim", vimMode: "normal" })} columns={100} />),
			).lastFrame() ?? "";
		expect(frame).toContain("leave insert");
		expect(frame).toContain("cancel selection");
	});
});

describe("PermissionDialog", () => {
	test("Enter on 'Yes' resolves allow once", async () => {
		const decisions: Array<[boolean, boolean]> = [];
		const { stdin, lastFrame, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Bash"
					inputPreview="rm -rf /"
					onResolve={(allow, always) => decisions.push([allow, always])}
				/>,
			),
		);
		await delay(30);
		expect(lastFrame()).toContain("Permission required");
		expect(lastFrame()).toContain("rm -rf /");

		stdin.write("\r");
		await delay(30);
		expect(decisions).toEqual([[true, false]]);
		unmount();
	});

	test("down arrow + Enter selects don't-ask-again", async () => {
		const decisions: Array<[boolean, boolean]> = [];
		const { stdin, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Edit"
					inputPreview="x.ts"
					onResolve={(allow, always) => decisions.push([allow, always])}
				/>,
			),
		);
		await delay(30);
		stdin.write("\x1b[B"); // down
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(decisions).toEqual([[true, true]]);
		unmount();
	});

	// A move and the Enter it earned in one read, dispatched before React has
	// committed the move: the same coalescing the picker's burst test pins. A
	// confirm read from the rendered value answers row 0 — the row the screen
	// was still showing — so a quick ↓+Enter silently selects "allow once" when
	// the user reached "don't ask again".
	test("a move and Enter in one read approve the moved row", async () => {
		const decisions: Array<[boolean, boolean]> = [];
		const { stdin, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Edit"
					inputPreview="x.ts"
					onResolve={(allow, always) => decisions.push([allow, always])}
				/>,
			),
		);
		await delay(30);
		stdin.write("\x1b[B\r"); // down, then Enter, in the same read
		await delay(30);
		expect(decisions).toEqual([[true, true]]);
		unmount();
	});

	test("an Edit is shown as a diff, and Ctrl+A still reaches the raw input", async () => {
		const diff = permissionDiff("Edit", {
			file_path: "src/a.ts",
			old_string: "const answer = 1;",
			new_string: "const answer = 42;",
		});
		const { stdin, lastFrame, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Edit"
					inputPreview="src/a.ts"
					inputFull="RAW INPUT"
					diff={diff}
					onResolve={() => {}}
				/>,
			),
		);
		await delay(30);
		const frame = flatFrame(lastFrame() ?? "");
		expect(frame).toContain("--- src/a.ts");
		expect(frame).toContain("-const answer = 1;");
		expect(frame).toContain("+const answer = 42;");
		expect(frame).not.toContain("RAW INPUT");

		stdin.write("\x01"); // Ctrl+A
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).toContain("RAW INPUT");
		unmount();
	});

	test("Esc denies", async () => {
		const decisions: Array<[boolean, boolean]> = [];
		const { stdin, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Write"
					inputPreview="y.ts"
					onResolve={(allow, always) => decisions.push([allow, always])}
				/>,
			),
		);
		await delay(30);
		stdin.write("\x1b");
		await delay(30);
		expect(decisions).toEqual([[false, false]]);
		unmount();
	});

	test("the answers say what they grant, not just what they are called", async () => {
		// The old second option granted the whole tool while its label said
		// "this tool": approving `git status` also approved every later Bash call.
		const { lastFrame, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Bash"
					inputPreview="git status"
					options={permissionOptions("Bash", { command: "git status" }, "C:\\work\\proj")}
					onResolve={() => {}}
				/>,
			),
		);
		await delay(30);
		const frame = flatFrame(lastFrame() ?? "");
		expect(frame).toContain("1. Yes, just this once");
		expect(frame).toContain("commands starting with `git ` (this session)");
		// The fourth answer is the third row: yes to this call, and a stay for the
		// question — named with the same scope as the grant above it.
		expect(frame).toContain("3. Yes, and ask me every time for commands starting with `git ` (this session)");
		expect(frame).toContain("4. No, and tell the model what to do differently");
		unmount();
	});

	test("the ask row's number answers with the ask flag, not with a grant", async () => {
		// The row and the resolve call are two halves that can drift: a digit wired
		// to the wrong answer would look right on screen and grant the wrong thing.
		const decisions: Array<[boolean, boolean, boolean | undefined]> = [];
		const { stdin, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Bash"
					inputPreview="git status"
					options={permissionOptions("Bash", { command: "git status" }, process.cwd())}
					onResolve={(allow, always, ask) => decisions.push([allow, always, ask])}
				/>,
			),
		);
		await delay(30);
		stdin.write("3");
		await delay(30);
		expect(decisions).toEqual([[true, false, true]]);
		unmount();
	});

	test("the fourth answer opens a field instead of denying on the spot", async () => {
		// The row promises to tell the model what to do differently; a denial that
		// resolved before anything was typed would leave that promise unkept.
		const decisions: Array<[boolean, boolean, boolean | undefined, string | undefined]> = [];
		const { stdin, lastFrame, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Bash"
					inputPreview="git status"
					onResolve={(allow, always, ask, message) => decisions.push([allow, always, ask, message])}
				/>,
			),
		);
		await delay(30);
		stdin.write("4");
		await delay(30);
		expect(decisions).toEqual([]);
		expect(flatFrame(lastFrame() ?? "")).toContain("Tell the model what to do differently:");

		stdin.write("use git status instead");
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).toContain("use git status instead");

		stdin.write("\r");
		await delay(30);
		expect(decisions).toEqual([[false, false, false, "use git status instead"]]);
		unmount();
	});

	test("submitting the field empty is the plain deny it always was", async () => {
		const decisions: Array<[boolean, boolean, boolean | undefined, string | undefined]> = [];
		const { stdin, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Bash"
					inputPreview="git status"
					onResolve={(allow, always, ask, message) => decisions.push([allow, always, ask, message])}
				/>,
			),
		);
		await delay(30);
		stdin.write("4");
		await delay(30);
		stdin.write("\r");
		await delay(30);
		expect(decisions).toEqual([[false, false, false, undefined]]);
		unmount();
	});

	test("Esc in the field goes back to the list rather than answering twice", async () => {
		const decisions: Array<[boolean, boolean, boolean | undefined, string | undefined]> = [];
		const { stdin, lastFrame, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Bash"
					inputPreview="git status"
					onResolve={(allow, always, ask, message) => decisions.push([allow, always, ask, message])}
				/>,
			),
		);
		await delay(30);
		stdin.write("4");
		await delay(30);
		stdin.write("\x1b");
		await delay(30);
		expect(decisions).toEqual([]);
		expect(flatFrame(lastFrame() ?? "")).not.toContain("Tell the model what to do differently:");

		// Back on the list, and the first row still answers normally.
		stdin.write("\r");
		await delay(30);
		expect(decisions).toEqual([[true, false, false, undefined]]);
		unmount();
	});

	test("without a scoped rule the label promises only the tool", async () => {
		const { lastFrame, unmount } = render(
			withTheme(<PermissionDialog toolName="WebFetch" inputPreview="url" onResolve={() => {}} />),
		);
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).toContain("don't ask again for WebFetch (this session)");
		unmount();
	});

	test("Ctrl+A shows the whole input and Ctrl+A again puts it back", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Bash"
					inputPreview="npm test -- --watch=false …"
					inputFull={'{\n  "command": "npm test -- --watch=false --reporter=dot"\n}'}
					onResolve={() => {}}
				/>,
			),
		);
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).toContain("Ctrl+A show full input");
		expect(flatFrame(lastFrame() ?? "")).not.toContain("--reporter=dot");

		stdin.write("\x01"); // Ctrl+A
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).toContain("--reporter=dot");
		expect(flatFrame(lastFrame() ?? "")).toContain("Ctrl+A collapse");

		stdin.write("\x01");
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).not.toContain("--reporter=dot");
		unmount();
	});

	test("Ctrl+A with nothing more to show does not offer it", async () => {
		const { stdin, lastFrame, unmount } = render(
			withTheme(<PermissionDialog toolName="Read" inputPreview="a.ts" onResolve={() => {}} />),
		);
		await delay(30);
		stdin.write("\x01");
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).toContain("a.ts");
		expect(flatFrame(lastFrame() ?? "")).not.toContain("Ctrl+A");
		unmount();
	});

	test("a forwarded ask names the subagent that raised it", async () => {
		const { lastFrame, unmount } = render(
			withTheme(
				<PermissionDialog
					toolName="Write"
					inputPreview="x.ts"
					source={'subagent "Fix the flaky test" (sidechain-42-abcd)'}
					onResolve={() => {}}
				/>,
			),
		);
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).toContain('Requested by subagent "Fix the flaky test" (sidechain-42-abcd)');
		unmount();
	});

	test("the session's own asks carry no source line", async () => {
		const { lastFrame, unmount } = render(
			withTheme(<PermissionDialog toolName="Bash" inputPreview="ls" onResolve={() => {}} />),
		);
		await delay(30);
		expect(flatFrame(lastFrame() ?? "")).not.toContain("Requested by");
		unmount();
	});
});

describe("ui-state reducer", () => {
	test("streams text then commits on turn_end", () => {
		let state: UiState = initialUiState();
		const partial = (text: string) =>
			({
				role: "assistant",
				content: [{ type: "text", text }],
				provider: "faux",
				model: "faux-1",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "pending",
				timestamp: 0,
			}) as any;

		state = reduceEvent(state, { type: "agent_start" });
		expect(state.statusPhase).toBe("thinking");

		state = reduceEvent(state, {
			type: "message_update",
			message: partial("Hel"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial: partial("Hel") },
		});
		state = reduceEvent(state, {
			type: "message_update",
			message: partial("Hello"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo", partial: partial("Hello") },
		});
		expect(state.streamingText).toBe("Hello");

		state = reduceEvent(state, { type: "turn_end", message: partial("Hello"), toolResults: [] });
		expect(state.streamingText).toBe("");
		expect(state.entries).toEqual([{ kind: "assistant", text: "Hello" }]);
		expect(state.statusPhase).toBe("idle");
	});

	test("turn_end moves the request's cache channels onto the row it commits", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			provider: "anthropic",
			model: "claude-sonnet-5",
			usage: { input: 120, output: 30, cacheRead: 800, cacheWrite: 60, promptTotal: 980 },
			stopReason: "stop",
			timestamp: 0,
		} as any;
		let state: UiState = initialUiState();
		state = reduceEvent(state, { type: "agent_start" });
		state = reduceEvent(state, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: message },
		});
		state = reduceEvent(state, { type: "turn_end", message, toolResults: [] });
		expect(state.entries).toEqual([{ kind: "assistant", text: "hi", cache: { read: 800, write: 60, prompt: 980 } }]);
	});

	test("a restored transcript keeps each message's cache numbers with its own row", () => {
		const assistant = (text: string, usage: Usage): AgentMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "anthropic",
			model: "claude-sonnet-5",
			usage,
			stopReason: "stop",
			timestamp: 0,
		});
		const entries = entriesFromMessages([
			assistant("first", { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, promptTotal: 1000 }),
			assistant("second", { input: 0, output: 10, cacheRead: 0, cacheWrite: 1200, promptTotal: 1200 }),
		]);
		expect(entries).toEqual([
			{ kind: "assistant", text: "first", cache: { read: 900, write: 0, prompt: 1000 } },
			{ kind: "assistant", text: "second", cache: { read: 0, write: 1200, prompt: 1200 } },
		]);
	});

	test("tool events track pending tools and results", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, {
			type: "tool_execution_start",
			callId: "c1",
			toolName: "Bash",
			input: { command: "ls" },
		});
		expect(state.pendingTools).toHaveLength(1);
		expect(state.entries[0]).toMatchObject({ kind: "toolUse", toolName: "Bash", inputPreview: "ls" });

		state = reduceEvent(state, {
			type: "tool_execution_end",
			callId: "c1",
			toolName: "Bash",
			result: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "Bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 0,
			},
		});
		expect(state.pendingTools).toHaveLength(0);
		expect(state.entries[0]).toMatchObject({ resultText: "done" });
	});

	test("streamed output accumulates per running tool and goes when the result lands", () => {
		let state: UiState = initialUiState();
		const start = (callId: string) =>
			reduceEvent(state, { type: "tool_execution_start", callId, toolName: "Bash", input: { command: "ls" } });
		const update = (callId: string, partialOutput: string) =>
			reduceEvent(state, { type: "tool_execution_update", callId, toolName: "Bash", partial: { partialOutput } });

		state = start("c1");
		state = start("c2");
		state = update("c1", "one\n");
		state = update("c1", "one\ntwo\n");
		state = update("c2", "other\n");
		expect(state.liveOutputs).toEqual({ c1: "one\ntwo\n", c2: "other\n" });

		state = reduceEvent(state, {
			type: "tool_execution_end",
			callId: "c1",
			toolName: "Bash",
			result: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "Bash",
				content: [{ type: "text", text: "one\ntwo\n" }],
				isError: false,
				timestamp: 0,
			},
		});
		// The result replaces the stream; holding both would keep every command's
		// output for the life of the session.
		expect(state.liveOutputs).toEqual({ c2: "other\n" });
	});

	test("an update carrying no text leaves the state untouched", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, { type: "tool_execution_start", callId: "c1", toolName: "Bash", input: {} });
		const before = state;
		state = reduceEvent(state, { type: "tool_execution_update", callId: "c1", toolName: "Bash", partial: 42 });
		expect(state).toBe(before);
		state = reduceEvent(state, { type: "tool_execution_update", callId: "c1", toolName: "Bash", partial: { pct: 40 } });
		expect(state).toBe(before);
	});

	test("a run that ends with a tool still pending does not leave it on screen", () => {
		// Aborting mid-tool: the tool's own end event may never arrive, and a
		// stale row would keep naming a command that is no longer running.
		let state: UiState = initialUiState();
		state = reduceEvent(state, { type: "tool_execution_start", callId: "c1", toolName: "Bash", input: {} });
		state = reduceEvent(state, {
			type: "tool_execution_update",
			callId: "c1",
			toolName: "Bash",
			partial: { partialOutput: "half a line" },
		});
		state = reduceEvent(state, { type: "agent_end", reason: "aborted", messages: [] });
		expect(state.pendingTools).toHaveLength(0);
		expect(state.liveOutputs).toEqual({});
	});

	test("toolPreview extracts command/path/pattern keys", () => {
		expect(toolPreview("Bash", { command: "git status" })).toBe("git status");
		expect(toolPreview("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
		expect(toolPreview("Grep", { pattern: "foo", path: "/x" })).toBe("foo");
	});

	test("a Task preview is its description, and a command still wins over one", () => {
		// The Task tool's input is `{ description, prompt }` — no command, path or
		// pattern — so the row used to render the whole input as JSON. The
		// description is the same kind of one-line summary the other keys are.
		expect(toolPreview("Task", { description: "修 flaky 测试", prompt: "…" })).toBe("修 flaky 测试");
		// `description` is last in the key list on purpose: a call that carries a
		// command alongside one keeps showing the command.
		expect(toolPreview("Bash", { command: "ls", description: "list files" })).toBe("ls");
	});

	test("agent_end commits streaming text and records error/abort entries", () => {
		let state: UiState = initialUiState();
		const partial = (text: string) =>
			({
				role: "assistant",
				content: [{ type: "text", text }],
				provider: "faux",
				model: "faux-1",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "pending",
				timestamp: 0,
			}) as any;

		state = reduceEvent(state, { type: "agent_start" });
		state = reduceEvent(state, {
			type: "message_update",
			message: partial("partial answer"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial answer",
				partial: partial("partial answer"),
			},
		});
		state = reduceEvent(state, { type: "agent_end", reason: "error", messages: [], errorMessage: "provider down" });
		const kinds = state.entries.map((e) => e.kind);
		expect(kinds).toContain("assistant");
		expect(state.entries.at(-1)).toMatchObject({ kind: "error", text: "Error: provider down" });
		expect(state.statusPhase).toBe("idle");

		let aborted: UiState = initialUiState();
		aborted = reduceEvent(aborted, { type: "agent_end", reason: "aborted", messages: [] });
		expect(aborted.entries.at(-1)).toMatchObject({
			kind: "info",
			text: "[interrupted · type a new message to continue]",
		});
	});
});

describe("retry, fallback, and partial results", () => {
	const partial = (text: string) =>
		({
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "faux",
			model: "faux-1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "pending",
			timestamp: 0,
		}) as any;
	const delta = (text: string) => ({
		type: "message_update" as const,
		message: partial(text),
		assistantMessageEvent: { type: "text_delta" as const, contentIndex: 0, delta: text, partial: partial(text) },
	});
	const result = (text: string, extra: { isError?: boolean; interrupted?: true } = {}) => ({
		type: "tool_execution_end" as const,
		callId: "c1",
		toolName: "Bash",
		result: {
			role: "toolResult" as const,
			toolCallId: "c1",
			toolName: "Bash",
			content: [{ type: "text" as const, text }],
			isError: extra.isError ?? false,
			...(extra.interrupted ? { interrupted: true as const } : {}),
			timestamp: 0,
		},
	});

	test("a scheduled retry is stamped and yields to the first stream event", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, { type: "agent_start" });
		const before = Date.now();
		state = reduceEvent(state, { type: "retry", attempt: 2, delayMs: 5_000, message: "rate limited" });
		expect(state.retry).toMatchObject({ attempt: 2, message: "rate limited" });
		expect(state.retry?.untilMs).toBeGreaterThanOrEqual(before + 5_000);
		expect(state.statusPhase).toBe("thinking");

		state = reduceEvent(state, delta("hello"));
		expect(state.retry).toBeUndefined();
		expect(state.streamingText).toBe("hello");
	});

	test("a retry that never sees a stream is cleared when the run ends", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, { type: "agent_start" });
		state = reduceEvent(state, { type: "retry", attempt: 3, delayMs: 1_000, message: "boom" });
		state = reduceEvent(state, { type: "agent_end", reason: "error", messages: [], errorMessage: "boom" });
		expect(state.retry).toBeUndefined();
	});

	test("a fallback leaves a durable line naming both models and the reason", () => {
		const state = reduceEvent(initialUiState(), {
			type: "fallback",
			from: { provider: "anthropic", id: "big-model" },
			to: { provider: "openai", id: "small-model" },
			reason: "overloaded",
			errorKind: "overload",
		});
		expect(state.entries).toEqual([
			{ kind: "info", text: "[model fallback] anthropic/big-model → openai/small-model: overloaded" },
		]);
	});

	test("the host's remedy is printed under the error, not instead of it", () => {
		const state = reduceEvent(initialUiState(), {
			type: "agent_end",
			reason: "error",
			messages: [],
			errorMessage: "rate limited",
			errorKind: "rate_limit",
			errorRemedy: "Wait a minute, then retry — or switch with /model.",
		});
		expect(state.entries.at(-1)).toEqual({
			kind: "error",
			text: "Error: rate limited\nWait a minute, then retry — or switch with /model.",
		});
	});

	test("a turn that ended early marks its assistant row incomplete", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, { type: "agent_start" });
		state = reduceEvent(state, delta("half an ans"));
		state = reduceEvent(state, {
			type: "turn_end",
			message: { ...partial("half an ans"), incomplete: true },
			toolResults: [],
		});
		expect(state.entries.at(-1)).toEqual({ kind: "assistant", text: "half an ans", incomplete: true });
	});

	test("agent_end marks the last assistant message, and only when it was partial", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, { type: "agent_start" });
		state = reduceEvent(state, delta("cut off"));
		state = reduceEvent(state, {
			type: "agent_end",
			reason: "error",
			messages: [partial("an earlier complete answer"), { ...partial("cut off"), incomplete: true }],
			errorMessage: "socket closed",
		});
		expect(state.entries.find((entry) => entry.kind === "assistant")).toMatchObject({
			text: "cut off",
			incomplete: true,
		});
	});

	test("a tool result the interrupt cut short keeps its text and says why", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, {
			type: "tool_execution_start",
			callId: "c1",
			toolName: "Bash",
			input: { command: "sleep 99" },
		});
		state = reduceEvent(state, result("half\na line", { isError: true, interrupted: true }));
		expect(state.entries[0]).toMatchObject({
			kind: "toolUse",
			resultText: "half\na line",
			isError: true,
			interrupted: true,
		});
	});

	test("a long result remembers how much was cut, though the row keeps the head", () => {
		let state: UiState = initialUiState();
		state = reduceEvent(state, {
			type: "tool_execution_start",
			callId: "c1",
			toolName: "Bash",
			input: { command: "cat big.log" },
		});
		const huge = "x".repeat(RESULT_TEXT_CAP + 25);
		state = reduceEvent(state, result(huge));
		expect(state.entries[0]).toMatchObject({
			resultText: huge.slice(0, RESULT_TEXT_CAP),
			resultTotalChars: huge.length,
			resultTruncated: true,
		});
	});

	test("an abort names what it dropped, with previews, and stops at ten", () => {
		const queued = Array.from({ length: 12 }, (_, i) => ({
			id: `q${i}`,
			text: i === 0 ? `first\n  line ${"y".repeat(300)}` : `message ${i}`,
			mode: "queue" as const,
		}));
		const aborted = reduceEvent(
			{ ...initialUiState(), queued },
			{ type: "agent_end", reason: "aborted", messages: [] },
		);
		const infos = aborted.entries.map((entry) => (entry.kind === "info" ? entry.text : ""));
		expect(infos[0]).toBe("[interrupted · 12 queued messages dropped · type a new message to continue]");
		expect(infos.filter((text) => text.startsWith("Dropped:"))).toHaveLength(10);
		expect(infos.at(-1)).toBe("… and 2 more");
		const first = infos[1] ?? "";
		expect(first).toContain("first line "); // folded to one line
		expect(first).not.toContain("\n");
		expect(first.length).toBeLessThan(240); // 200 characters plus the label
		expect(first.endsWith('…"')).toBe(true);
	});

	test("the run's own account of what it dropped wins over the store's queue", () => {
		const queued = [{ id: "q1", text: "queued copy", mode: "queue" as const }];
		const aborted = reduceEvent(
			{ ...initialUiState(), queued },
			{
				type: "agent_end",
				reason: "aborted",
				messages: [],
				interrupted: { followUp: ["the run's copy"], steering: [] },
			},
		);
		const texts = aborted.entries.map((entry) => (entry.kind === "info" ? entry.text : ""));
		expect(texts).toContain('Dropped: "the run\'s copy"');
		expect(texts).not.toContain('Dropped: "queued copy"');
	});
});

describe("store", () => {
	test("set notifies subscribers with new state", () => {
		const store = createStore({ count: 0 });
		const seen: number[] = [];
		const unsub = store.subscribe(() => seen.push(store.get().count));
		store.set((s) => ({ count: s.count + 1 }));
		store.set((s) => ({ count: s.count + 1 }));
		unsub();
		store.set((s) => ({ count: s.count + 1 }));
		expect(seen).toEqual([1, 2]);
		expect(store.get().count).toBe(3);
	});
});
