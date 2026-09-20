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
import { initialUiState, reduceEvent, type UiState } from "../src/ui-state.ts";

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

	/**
	 * The five tests above are a list someone wrote down, and a list is only as
	 * good as the day it was written: the field added to `UiState` next month is
	 * not on it, so a `/clear` that resets it is not caught by anything — the
	 * test that would have caught it does not mention the field.
	 *
	 * So the state is asked for its own keys instead. Everything `initialUiState`
	 * knows about is walked, and only the transcript is allowed to change
	 * identity; every other field is a bug report with its own name on it.
	 */
	test("every field it does not own keeps its identity", () => {
		/** What `/clear` is for. A field added here has to be argued for. */
		const cleared = new Set<string>(["entries", "streamingText", "thinkingText", "pendingTools", "liveOutputs"]);

		const before = loadedState();
		const store = createStore<UiState>(before);
		handleCommand("/clear", { store, modelName: "m", onExit: () => {} });
		const after = store.get();

		// Collected rather than asserted one at a time: the failure is then the
		// list of fields `/clear` reached into, not whichever one it walked past
		// first.
		const keys = Object.keys(initialUiState(true)) as Array<keyof UiState>;
		const touched = keys.filter((key) => !cleared.has(key as string)).filter((key) => after[key] !== before[key]);

		expect(touched).toEqual([]);
		// ...and the walk covered something: an `initialUiState` that returned
		// nothing would make the line above pass for a `/clear` that reset it all.
		expect(keys.length).toBeGreaterThan(cleared.size + 5);
	});

	// The transcript can be cleared in the middle of a tool call, and the result
	// is already on its way — it lands on a row that is no longer there.
	test("a result that arrives after a clear does not resurrect its row", () => {
		const before = loadedState();
		const store = createStore<UiState>(before);
		handleCommand("/clear", { store, modelName: "m", onExit: () => {} });

		store.set((s) =>
			reduceEvent(s, {
				type: "tool_execution_end",
				callId: "c1",
				toolName: "Bash",
				result: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "Bash",
					content: [{ type: "text", text: "build finished" }],
					isError: false,
					timestamp: 0,
				},
			}),
		);

		// Dropped, not appended: a tool result printed with no call above it reads
		// as output from a command the user cannot see. What matters beyond that is
		// that nothing crashed looking for the row.
		const s = store.get();
		expect(s.entries).toEqual([]);
		expect(s.pendingTools).toEqual([]);
		expect(s.liveOutputs).toEqual({});

		// And the next call, made after the clear, still gets its row.
		store.set((prev) =>
			reduceEvent(prev, { type: "tool_execution_start", callId: "c2", toolName: "Bash", input: { command: "ls" } }),
		);
		expect(store.get().entries.map((e) => e.kind)).toEqual(["toolUse"]);
		expect(store.get().pendingTools.map((p) => p.callId)).toEqual(["c2"]);
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
