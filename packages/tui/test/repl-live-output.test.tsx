/**
 * The live command preview, end to end through a mounted REPL.
 *
 * Each piece has its own test already — the reducer records the stream, the
 * shaping lives in live-output.ts, the drawing in MessageList. What none of
 * those can see is the wiring between them: a REPL that never selected
 * `liveOutputs` off the store renders exactly as it did before the feature
 * existed, with every unit test still green.
 *
 * No provider is involved. The events are the real ones the session emits, fed
 * straight into the store, so this stays a rendering test rather than a second
 * copy of the loop tests.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentSession } from "@labunbun/agent";
import { render } from "ink-testing-library";
import { REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, reduceEvent, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The REPL only reaches for the session on submit or Esc; neither happens here. */
const idleSession = { isRunning: false, abort: () => {} } as unknown as AgentSession;

describe("live tool output in the REPL", () => {
	test("streamed output reaches the screen, then gives way to the result", async () => {
		const store = createStore<UiState>({ ...initialUiState(), statusPhase: "tools" });
		const view = render(<REPL getSession={() => idleSession} store={store} modelName="test" onExit={() => {}} />);
		const send = (event: AgentEvent) => store.set((s) => reduceEvent(s, event));

		send({ type: "tool_execution_start", callId: "c1", toolName: "Bash", input: { command: "bun run build" } });
		send({
			type: "tool_execution_update",
			callId: "c1",
			toolName: "Bash",
			partial: { partialOutput: "bundling\nchunk 1 done\n" },
		});
		await delay(30);
		const running = view.lastFrame() ?? "";
		expect(running).toContain("bun run build");
		expect(running).toContain("chunk 1 done");
		// The status row says what is running, not just that something is.
		expect(running).toContain("└ Bash");

		send({
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
		});
		await delay(30);
		const finished = view.lastFrame() ?? "";
		expect(finished).toContain("build finished");
		expect(finished).not.toContain("chunk 1 done");
		view.unmount();
	});
});

describe("the background shell row in the REPL", () => {
	// The row is one `useStore` slice away from existing at all. `backgroundShellRow`
	// itself is covered in components.test.tsx; what a unit test cannot see is a
	// REPL that never reads the slice, which renders identically to before the
	// feature and leaves every other test green.
	test("a running shell shows up under the status line, and goes away with it", async () => {
		const store = createStore<UiState>({ ...initialUiState(), statusPhase: "idle" });
		const view = render(<REPL getSession={() => idleSession} store={store} modelName="test" onExit={() => {}} />);

		expect(view.lastFrame() ?? "").not.toContain("background shell");

		store.set((s) => ({
			...s,
			backgroundShells: [{ id: "shell_1", command: "npm run dev", status: "running" }],
		}));
		await delay(30);
		const running = view.lastFrame() ?? "";
		expect(running).toContain("1 background shell running · /ps to view · /stop to close");

		// The poll publishes the same list with the shell now finished; the row is
		// what the user reads to know the port is free again.
		store.set((s) => ({
			...s,
			backgroundShells: [{ id: "shell_1", command: "npm run dev", status: "completed" }],
		}));
		await delay(30);
		expect(view.lastFrame() ?? "").not.toContain("background shell");
		view.unmount();
	});
});

describe("the compaction activity row in the REPL", () => {
	// The app writes the field itself (a compaction emits nothing of its own while
	// it runs, so there is no event to reduce), and how the row draws it is covered
	// in components.test.tsx. What neither sees is a REPL that never reads the
	// slice: the field would be set, the screen would say nothing, and every other
	// test would still be green.
	test("a summary in flight is on screen while it runs, and gone when it lands", async () => {
		const store = createStore<UiState>({ ...initialUiState(), statusPhase: "idle" });
		const view = render(<REPL getSession={() => idleSession} store={store} modelName="test" onExit={() => {}} />);

		expect(view.lastFrame() ?? "").not.toContain("Compacting context");

		store.set((s) => ({ ...s, contextActivity: "Compacting context…" }));
		await delay(30);
		expect(view.lastFrame() ?? "").toContain("Compacting context…");

		store.set((s) => ({ ...s, contextActivity: undefined }));
		await delay(30);
		expect(view.lastFrame() ?? "").not.toContain("Compacting context");
		view.unmount();
	});
});
