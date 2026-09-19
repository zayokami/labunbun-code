import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { MessageList } from "../src/components/MessageList.tsx";
import { PermissionDialog } from "../src/components/PermissionDialog.tsx";
import { ShortcutOverlay } from "../src/components/ShortcutOverlay.tsx";
import { StatusLine, toolSummary } from "../src/components/StatusLine.tsx";
import { permissionOptions } from "../src/permission-options.ts";
import { shortcutGroups } from "../src/shortcuts.ts";
import { createStore } from "../src/store.ts";
import { DARK_THEME, HIGH_CONTRAST_DARK, type Theme, ThemeContext } from "../src/theme.ts";
import { initialUiState, reduceEvent, toolPreview, type UiState } from "../src/ui-state.ts";

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
		expect(frame).toContain("[Bash]");
		expect(frame).toContain("ls");
		expect(frame).toContain("Here are the files.");
		expect(frame).toContain("Error: boom");
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
		expect(frame).toContain("...");
		expect(frame).not.toContain("x".repeat(500)); // full output never rendered
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

	// Three parallel Bash calls listed as "Bash · Bash · Bash" make the reader do
	// the counting; the row is there to be read at a glance.
	test("repeated tools are counted instead of repeated", () => {
		const tools = (names: string[]) => names.map((toolName, i) => ({ callId: `c${i}`, toolName }));
		expect(toolSummary(tools(["Bash", "Bash", "Read"]))).toBe("Bash ×2 · Read");
		expect(toolSummary(tools(["Grep"]))).toBe("Grep");
		expect(toolSummary([])).toBe("");
	});
});

describe("ShortcutOverlay", () => {
	const groups = () => shortcutGroups({ vim: false, commands: [["/status", "Show status"]] });

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
				withTheme(<ShortcutOverlay groups={shortcutGroups({ vim: true, vimMode: "normal" })} columns={100} />),
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
		expect(frame).toContain("3. No, and tell the model what to do differently");
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
		expect(aborted.entries.at(-1)).toMatchObject({ kind: "info", text: "[interrupted]" });
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
