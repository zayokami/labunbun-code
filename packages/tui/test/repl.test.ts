/**
 * REPL-level logic is asserted through its pure helpers: the component itself
 * has no render tests, because a frame carries no ANSI when stdout is not a
 * TTY and the interesting behavior here is timing, not layout.
 */

import { describe, expect, test } from "bun:test";
import { sameShells } from "../src/app.tsx";
import { CTRL_C_EXIT_WINDOW_MS, ctrlCShouldExit, handleCommand } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { LIGHT_THEME } from "../src/themes/index.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

/**
 * `/clear` clears the transcript, and nothing else.
 *
 * The list of things that must survive a `/clear` is not the list of things
 * that are inconvenient to rebuild: the theme, the model name, the editing
 * mode and the running shells are session state the user set, and the dialog,
 * picker and question hold the closures a running turn is waiting on — thrown
 * away, they are gone for good, and the tool that asked never hears back.
 */
function loadedState(): UiState {
	return {
		...initialUiState(true),
		entries: [
			{ kind: "user", text: "hi" },
			{ kind: "assistant", text: "hello" },
		],
		streamingText: "mid-",
		thinkingText: "hmm",
		pendingTools: [{ callId: "c1", toolName: "Bash" }],
		liveOutputs: { c1: "…" },
		statusPhase: "tools",
		dialog: { callId: "c1", toolName: "Bash", inputPreview: "ls", resolve: () => {} },
		question: { questions: [{ question: "?", header: "h", options: [] }], resolve: () => {} },
		picker: { title: "t", items: [], resolve: () => {} },
		statusCard: { model: "m", details: [["Cost", "$0"]] },
		backgroundShells: [{ id: "s1", command: "npm run dev", status: "running" }],
		queued: [{ id: "q1", text: "next", mode: "queue" }],
		theme: LIGHT_THEME,
		modelName: "anthropic/claude-sonnet-5",
	};
}

describe("/clear", () => {
	test("empties the transcript", () => {
		const store = createStore<UiState>(loadedState());
		handleCommand("/clear", { store, modelName: "m", onExit: () => {} });

		const s = store.get();
		expect(s.entries).toEqual([]);
		expect(s.streamingText).toBe("");
		expect(s.thinkingText).toBe("");
		expect(s.pendingTools).toEqual([]);
		expect(s.liveOutputs).toEqual({});
	});

	test("leaves the theme, the model and the editor alone", () => {
		const store = createStore<UiState>(loadedState());
		handleCommand("/clear", { store, modelName: "m", onExit: () => {} });

		const s = store.get();
		expect(s.theme).toBe(LIGHT_THEME);
		expect(s.modelName).toBe("anthropic/claude-sonnet-5");
		expect(s.vim).toBe(true);
	});

	// A fresh initial state drops these: the closures a running turn is waiting
	// on, the shells that are still up, and the phase the spinner reports.
	test("keeps what a running turn is waiting on", () => {
		const before = loadedState();
		const store = createStore<UiState>(before);
		handleCommand("/clear", { store, modelName: "m", onExit: () => {} });

		const s = store.get();
		expect(s.dialog).toBe(before.dialog);
		expect(s.question).toBe(before.question);
		expect(s.picker).toBe(before.picker);
		expect(s.statusCard).toBe(before.statusCard);
		expect(s.backgroundShells).toBe(before.backgroundShells);
		expect(s.queued).toBe(before.queued);
		expect(s.statusPhase).toBe("tools");
	});
});

describe("idle Ctrl+C double-press", () => {
	test("a single press never exits", () => {
		expect(ctrlCShouldExit(0, 1000)).toBe(false);
	});

	test("a second press inside the window exits", () => {
		expect(ctrlCShouldExit(1000, 1000 + CTRL_C_EXIT_WINDOW_MS - 1)).toBe(true);
		expect(ctrlCShouldExit(1000, 1000 + CTRL_C_EXIT_WINDOW_MS)).toBe(true);
	});

	test("once the window lapses a press starts counting again instead", () => {
		expect(ctrlCShouldExit(1000, 1000 + CTRL_C_EXIT_WINDOW_MS + 1)).toBe(false);
	});
});

/**
 * The shell list is republished every couple of seconds forever, so "did
 * anything change" is the difference between a no-op and a full tree render.
 * Getting it wrong is invisible in tests that only ever look at one frame.
 */
describe("sameShells", () => {
	const shell = (id: string, status: "running" | "completed", command = "npm run dev") => ({ id, command, status });

	test("the same list, freshly built, counts as unchanged", () => {
		expect(sameShells([shell("shell_1", "running")], [shell("shell_1", "running")])).toBe(true);
		expect(sameShells([], [])).toBe(true);
	});

	test("nothing to say is not the same as something to say", () => {
		expect(sameShells([], [shell("shell_1", "running")])).toBe(false);
		expect(sameShells([shell("shell_1", "running")], [])).toBe(false);
	});

	test("a shell ending, or being restarted with another command, is a change", () => {
		expect(sameShells([shell("shell_1", "running")], [shell("shell_1", "completed")])).toBe(false);
		expect(sameShells([shell("shell_1", "running", "npm run dev")], [shell("shell_1", "running", "vite")])).toBe(false);
	});

	// Order matters: the row counts, but the picker behind it lists in this
	// order, so a reshuffle is a real difference and not just an alias.
	test("two shells listed the other way round are not the same list", () => {
		expect(
			sameShells(
				[shell("shell_1", "running"), shell("shell_2", "running")],
				[shell("shell_2", "running"), shell("shell_1", "running")],
			),
		).toBe(false);
	});
});
