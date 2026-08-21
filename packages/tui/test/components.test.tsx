import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { MessageList } from "../src/components/MessageList.tsx";
import { PermissionDialog } from "../src/components/PermissionDialog.tsx";
import { createStore } from "../src/store.ts";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import { initialUiState, reduceEvent, toolPreview, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTheme(node: React.ReactNode) {
	return <ThemeContext.Provider value={DARK_THEME}>{node}</ThemeContext.Provider>;
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
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "o", partial: partial("Hello") },
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

	test("toolPreview extracts command/path/pattern keys", () => {
		expect(toolPreview("Bash", { command: "git status" })).toBe("git status");
		expect(toolPreview("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
		expect(toolPreview("Grep", { pattern: "foo", path: "/x" })).toBe("foo");
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
