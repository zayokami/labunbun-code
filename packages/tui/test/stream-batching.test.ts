/**
 * Streaming deltas are gathered before they reach the store.
 *
 * A provider sends one delta per token; each delta used to be its own store
 * write, React commit and Yoga layout, while Ink throttled the drawing to 30
 * frames a second anyway. The subscription now holds text and thinking deltas
 * for one frame's interval and applies them in one write. What this file pins
 * is the two halves of that bargain: deltas are held, and every event that
 * resets or ends a buffer flushes the held deltas first so nothing is applied
 * out of order.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentSession } from "@labunbun/agent";
import { connectSessionToStore } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Listener = (event: AgentEvent) => void;

function fakeSession(): { session: AgentSession; emit: (event: AgentEvent) => void } {
	const listeners = new Set<Listener>();
	const session = {
		messages: [],
		on(listener: Listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	} as unknown as AgentSession;
	return {
		session,
		emit: (event) => {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

/** The start of a text or thinking block; both reset what came before. */
function start(kind: "text_start" | "thinking_start"): AgentEvent {
	return {
		type: "message_update",
		message: {} as never,
		assistantMessageEvent: { type: kind, contentIndex: 0, partial: {} as never },
	};
}

/** A message_update carrying one delta; the reducer reads only the delta. */
function delta(kind: "text_delta" | "thinking_delta", text: string): AgentEvent {
	return {
		type: "message_update",
		message: {} as never,
		assistantMessageEvent: {
			type: kind,
			contentIndex: 0,
			delta: text,
			partial: {} as never,
		},
	};
}

describe("streaming deltas", () => {
	test("a burst of deltas is one store write, not one per token", async () => {
		const { session, emit } = fakeSession();
		const store = createStore<UiState>(initialUiState());
		let writes = 0;
		const unsubscribeStore = store.subscribe(() => {
			writes++;
		});
		const unsubscribe = connectSessionToStore(session, store);

		emit(start("text_start"));
		const afterStart = writes;
		emit(delta("text_delta", "Hel"));
		emit(delta("text_delta", "lo"));
		emit(delta("text_delta", " there"));

		// Held, not dropped: the text is not in the store yet, and the burst has
		// not caused a write beyond the start event's.
		expect(store.get().streamingText).toBe("");
		expect(writes).toBe(afterStart);

		await delay(60);
		expect(store.get().streamingText).toBe("Hello there");
		expect(writes).toBe(afterStart + 1);

		unsubscribe();
		unsubscribeStore();
	});

	test("a non-delta event flushes the held deltas before it applies", () => {
		const { session, emit } = fakeSession();
		const store = createStore<UiState>(initialUiState());
		const unsubscribe = connectSessionToStore(session, store);

		emit(start("thinking_start"));
		emit(delta("thinking_delta", "plan "));
		emit(delta("thinking_delta", "first"));
		// A text start resets the answer buffer; it must not overtake the
		// thinking deltas it was sent after.
		emit(start("text_start"));

		expect(store.get().thinkingText).toBe("plan first");
		expect(store.get().streamingText).toBe("");
		unsubscribe();
	});

	test("unsubscribing flushes what the session already said", () => {
		const { session, emit } = fakeSession();
		const store = createStore<UiState>(initialUiState());
		const unsubscribe = connectSessionToStore(session, store);

		emit(start("text_start"));
		emit(delta("text_delta", "tail"));
		expect(store.get().streamingText).toBe("");

		unsubscribe();
		expect(store.get().streamingText).toBe("tail");
	});
});
