/**
 * The live end of the transcript: which rows ink redraws on every frame, and
 * what a row that is *not* redrawn has to be able to assume.
 *
 * A transcript row is drawn once and then sealed into ink's static scrollback,
 * which never redraws it — so two things have to hold. Sealing has to wait for
 * anything that can still change, and a row that is deliberately left live has
 * to be cheap to redraw. Both are asserted here; the REPL-level wiring is
 * covered in repl-live-output.test.tsx.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { sealCount, VirtualMessageList } from "../src/components/MessageList.tsx";
import { DARK_THEME, type Theme, ThemeContext } from "../src/theme.ts";
import { initialUiState, reduceEvent, type UiEntry, type UiState } from "../src/ui-state.ts";

function withTheme(node: React.ReactNode, theme: Theme = DARK_THEME) {
	return <ThemeContext.Provider value={theme}>{node}</ThemeContext.Provider>;
}

const settledRows = (count: number): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `answer ${i}` }) as UiEntry);

const runningTool = (callId: string): UiEntry => ({
	kind: "toolUse",
	callId,
	toolName: "Bash",
	inputPreview: "bun run build",
});

const finishedTool = (callId: string, resultText: string): UiEntry => ({
	kind: "toolUse",
	callId,
	toolName: "Bash",
	inputPreview: "bun run build",
	resultText,
});

describe("sealCount", () => {
	test("keeps the newest rows live and seals everything older", () => {
		// Older rows are redrawn every frame for nothing: they cannot change.
		expect(sealCount(settledRows(20))).toBe(12);
	});

	test("a pending tool holds the boundary, however far back it is", () => {
		// Its result is still coming, and a sealed row never redraws — so the
		// seal waits for it, and every row behind it waits too.
		const entries = settledRows(20);
		entries[3] = runningTool("c-old");
		expect(sealCount(entries)).toBe(3);
	});

	test("a transcript shorter than the window seals nothing", () => {
		expect(sealCount(settledRows(5))).toBe(0);
		expect(sealCount([])).toBe(0);
	});

	// The window is eight rows, so the eighth row of a transcript is live and the
	// ninth seals one. An off-by-one here is invisible in every test that only
	// looks at long transcripts.
	test("the window is exact: eight rows are all live, nine seal one", () => {
		expect(sealCount(settledRows(8))).toBe(0);
		expect(sealCount(settledRows(9))).toBe(1);
	});

	test("a pending tool at the last row inside the window holds the boundary to it", () => {
		const entries = settledRows(20);
		entries[11] = runningTool("c-inside");
		expect(sealCount(entries)).toBe(11);
	});

	// Empty output is output: a command that printed nothing has still finished,
	// and reading `resultText` for truth rather than for undefined would keep its
	// row — and every row behind it — live for the rest of the session.
	test("a tool whose result is the empty string counts as finished", () => {
		const entries = settledRows(20);
		entries[2] = finishedTool("c-empty", "");
		expect(sealCount(entries)).toBe(12);
	});
});

describe("rows left live", () => {
	test("a result landing on a running tool replaces what it was showing", () => {
		// The row is memoized: it only redraws because its own entry changed. A
		// comparison that missed that would leave the streamed preview on screen
		// for good, with the result arriving invisibly behind it.
		const entries: UiEntry[] = [settledRows(1)[0], runningTool("c1")];
		const view = render(withTheme(<VirtualMessageList entries={entries} liveOutputs={{ c1: "half a line" }} />));
		expect(view.lastFrame()).toContain("half a line");

		const done: UiEntry[] = [entries[0], finishedTool("c1", "build finished")];
		view.rerender(withTheme(<VirtualMessageList entries={done} liveOutputs={{}} />));

		const frame = view.lastFrame() ?? "";
		expect(frame).toContain("build finished");
		expect(frame).not.toContain("half a line");
		view.unmount();
	});

	test("a theme change still reaches them", () => {
		// Memoization compares props; the theme arrives through context, which
		// has to keep working — a row drawn in the old palette until it is
		// scrolled away is not a trade worth making.
		const loud: Theme = { ...DARK_THEME, marks: { ...DARK_THEME.marks, error: "@@" } };
		const entries: UiEntry[] = [{ kind: "error", text: "boom" }];
		const view = render(withTheme(<VirtualMessageList entries={entries} />));

		expect(view.lastFrame()).toContain(`${DARK_THEME.marks.error} boom`);
		view.rerender(withTheme(<VirtualMessageList entries={entries} />, loud));
		expect(view.lastFrame()).toContain("@@ boom");
		view.unmount();
	});
});

describe("what memoization is allowed to assume", () => {
	test("a tool result replaces its own row and no others", () => {
		// The premise under `memo(EntryView)`: rows are immutable, so identity is
		// a sound "unchanged" test. A reducer that rebuilt every row on each
		// event would still be correct — and would silently cost a full re-parse
		// of the whole live window per tool result.
		let state: UiState = initialUiState();
		state = reduceEvent(state, {
			type: "tool_execution_start",
			callId: "c1",
			toolName: "Bash",
			input: { command: "ls" },
		});
		state = reduceEvent(state, {
			type: "tool_execution_start",
			callId: "c2",
			toolName: "Bash",
			input: { command: "pwd" },
		});
		const before = state.entries;

		state = reduceEvent(state, {
			type: "tool_execution_end",
			callId: "c2",
			toolName: "Bash",
			result: {
				role: "toolResult",
				toolCallId: "c2",
				toolName: "Bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 0,
			},
		});

		expect(state.entries).toHaveLength(before.length);
		expect(state.entries[0]).toBe(before[0]); // untouched, and still the same object
		expect(state.entries[1]).not.toBe(before[1]);
		expect(state.entries[1]).toMatchObject({ callId: "c2", resultText: "done" });
	});
});
