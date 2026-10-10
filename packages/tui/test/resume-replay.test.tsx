/**
 * A resumed conversation has to be visible.
 *
 * Resuming restored the model's context and nothing else: the visible
 * transcript (`entries`) only ever grew from live events, so both `--resume`
 * and the in-app `/resume` opened onto a blank screen while the messages sat
 * in the session the whole time. These tests pin the replay — connecting a
 * store to a session that already has history renders that history, and a
 * swap renders the incoming session's history in place of the outgoing one's.
 *
 * Driven through the real REPL and a real AgentSession, because the property
 * under test is about the pair: the session's messages, and what a person
 * reading the screen would see.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession, compactionBoundary } from "@labunbun/agent";
import {
	type AgentMessage,
	assistantMessage,
	FAUX_MODEL,
	fauxProvider,
	toolResultMessage,
	userMessage,
} from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore, type Store } from "../src/store.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

function sessionWith(...messages: AgentMessage[]): AgentSession {
	// The same shape the resume paths build: a session whose messages were
	// pushed in, not streamed in. Nothing here prompts, so the transport is
	// only there to satisfy the constructor.
	const session = new AgentSession({
		model: FAUX_MODEL,
		deps: { streamFn: fauxProvider([{ text: "unused" }]).streamFn },
	});
	session.messages.push(...messages);
	return session;
}

function renderRepl(session: AgentSession, store: Store<UiState>) {
	return render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
}

describe("history on connect", () => {
	test("a session that already has messages shows them", () => {
		const session = sessionWith(
			userMessage("PLANTED QUESTION"),
			assistantMessage({ content: [{ type: "text", text: "PLANTED ANSWER" }], stopReason: "stop" }),
		);
		const store = createStore<UiState>(initialUiState());
		const unsubscribe = connectSessionToStore(session, store);

		expect(store.get().entries).toMatchObject([
			{ kind: "user", text: "PLANTED QUESTION" },
			{ kind: "assistant", text: "PLANTED ANSWER" },
		]);

		// And the frame is where the user would actually read it, not just the
		// state object behind it.
		const view = renderRepl(session, store);
		expect(view.lastFrame()).toContain("PLANTED QUESTION");
		expect(view.lastFrame()).toContain("PLANTED ANSWER");
		unsubscribe();
		view.unmount();
	});

	test("tool calls come back as tool rows with their results attached", () => {
		const session = sessionWith(
			userMessage("wipe it"),
			assistantMessage({
				content: [
					{ type: "toolCall", id: "call_1", name: "Bash", arguments: JSON.stringify({ command: "rm -rf build" }) },
					{ type: "toolCall", id: "call_2", name: "Read", arguments: JSON.stringify({ file_path: "notes.txt" }) },
				],
				stopReason: "toolUse",
			}),
			toolResultMessage("call_1", "Bash", [{ type: "text", text: "removed" }]),
			toolResultMessage("call_2", "Read", [{ type: "text", text: "file not found" }], true),
			// A result whose call is gone — the session file lost the assistant
			// line — has nothing to attach to and must not appear on its own.
			toolResultMessage("call_orphan", "Bash", [{ type: "text", text: "orphan output" }]),
		);
		const store = createStore<UiState>(initialUiState());
		const unsubscribe = connectSessionToStore(session, store);

		expect(store.get().entries).toMatchObject([
			{ kind: "user", text: "wipe it" },
			{
				kind: "toolUse",
				callId: "call_1",
				toolName: "Bash",
				inputPreview: "rm -rf build",
				resultText: "removed",
				isError: false,
			},
			{
				kind: "toolUse",
				callId: "call_2",
				toolName: "Read",
				inputPreview: "notes.txt",
				resultText: "file not found",
				isError: true,
			},
		]);
		expect(store.get().entries).toHaveLength(3);
		unsubscribe();
	});

	test("a compaction boundary is a marker line, not something the user said", () => {
		// The exact sentence `compactionBoundary` writes — pinned as a literal
		// because it is the model's only clue, so a change to it should be a
		// deliberate edit here too.
		const lead =
			"[Conversation compacted to stay within the context window. The summary below preserves everything important.]";
		const session = sessionWith(
			userMessage("before"),
			compactionBoundary("THE SUMMARY OF EVERYTHING BEFORE"),
			userMessage("after"),
		);
		const store = createStore<UiState>(initialUiState());
		const unsubscribe = connectSessionToStore(session, store);

		expect(store.get().entries).toMatchObject([
			{ kind: "user", text: "before" },
			{ kind: "info", text: lead },
			{ kind: "user", text: "after" },
		]);
		unsubscribe();
	});

	test("a length-recovery message — also never typed — leaves no row at all", async () => {
		const { LENGTH_RECOVERY_MESSAGE } = await import("@labunbun/agent");
		expect(typeof LENGTH_RECOVERY_MESSAGE).toBe("string");
		const session = sessionWith(
			userMessage("ask"),
			userMessage(LENGTH_RECOVERY_MESSAGE),
			assistantMessage({ content: [{ type: "text", text: "continued" }], stopReason: "stop" }),
		);
		const store = createStore<UiState>(initialUiState());
		const unsubscribe = connectSessionToStore(session, store);

		expect(store.get().entries).toMatchObject([
			{ kind: "user", text: "ask" },
			{ kind: "assistant", text: "continued" },
		]);
		expect(store.get().entries).toHaveLength(2);
		unsubscribe();
	});
});

describe("history on swap", () => {
	test("a swap replaces the outgoing transcript with the incoming session's history", async () => {
		const { bindSession } = await import("../src/components/REPL.tsx");
		const first = sessionWith(userMessage("OLD QUESTION"));
		const second = sessionWith(
			userMessage("NEW QUESTION"),
			assistantMessage({ content: [{ type: "text", text: "NEW ANSWER" }], stopReason: "stop" }),
		);
		const store = createStore<UiState>(initialUiState());

		const before = bindSession(store, first);
		expect(store.get().entries).toMatchObject([{ kind: "user", text: "OLD QUESTION" }]);

		const after = bindSession(store, second);
		// The old row is gone and the incoming history is in its place — both at
		// once, because a clear that ran after the connect would leave this
		// blank, and a connect that ran before a missing clear would show the
		// two conversations interleaved.
		expect(store.get().entries).toMatchObject([
			{ kind: "user", text: "NEW QUESTION" },
			{ kind: "assistant", text: "NEW ANSWER" },
		]);

		before.unsubscribeSession();
		before.unsubscribeFooter();
		after.unsubscribeSession();
		after.unsubscribeFooter();
	});
});
