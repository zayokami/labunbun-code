/**
 * The exit request path: the REPL reports "the user asked to leave", and the
 * TUI turns that into an unmount only when the guard upstream agrees. What is
 * under test is the decision table and its failure direction — doubt leaves,
 * because a guard that cannot answer must not become an app nobody can exit.
 */
import { describe, expect, test } from "bun:test";
import { cancelOpenPicker, createExitHandler } from "../src/app.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

/** One lap of the event loop: the handler's unmount lands on a microtask. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createExitHandler", () => {
	test("no guard: the exit is immediate, exactly as it was before there was one", () => {
		let unmounted = 0;
		createExitHandler(undefined, () => unmounted++)();
		expect(unmounted).toBe(1);
	});

	test("a yes unmounts, and only after the answer arrives", async () => {
		let unmounted = 0;
		let answer: (leave: boolean) => void = () => {};
		const handler = createExitHandler(
			() =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
			() => unmounted++,
		);
		handler();
		// The question may still be on screen; nothing may come down yet.
		expect(unmounted).toBe(0);
		answer(true);
		await settle();
		expect(unmounted).toBe(1);
	});

	test("a no keeps the session up", async () => {
		let unmounted = 0;
		createExitHandler(
			() => false,
			() => unmounted++,
		)();
		await settle();
		expect(unmounted).toBe(0);
	});

	test("a synchronous yes takes the same route as the asynchronous one", async () => {
		let unmounted = 0;
		createExitHandler(
			() => true,
			() => unmounted++,
		)();
		await settle();
		expect(unmounted).toBe(1);
	});

	test("a guard that rejects fails open", async () => {
		let unmounted = 0;
		createExitHandler(
			() => Promise.reject(new Error("boom")),
			() => unmounted++,
		)();
		await settle();
		expect(unmounted).toBe(1);
	});

	test("a guard that throws fails open the same way", async () => {
		let unmounted = 0;
		createExitHandler(
			() => {
				throw new Error("boom");
			},
			() => unmounted++,
		)();
		await settle();
		expect(unmounted).toBe(1);
	});
});

/**
 * A store holding one open picker, wired the way `mountRepl` wires one: the
 * resolve clears the store before it hands the caller its null.
 */
function storeWithPicker(onCancel?: () => void, onResolve?: (index: number | null) => void) {
	const store = createStore<UiState>({
		...initialUiState(true),
		picker: {
			title: "t",
			items: [],
			onCancel,
			resolve: (index) => {
				onResolve?.(index);
				store.set((state) => ({ ...state, picker: null }));
			},
		},
	});
	return { store };
}

describe("cancelOpenPicker", () => {
	test("an open picker ends as canceled: the preview is undone, then the null", () => {
		const events: string[] = [];
		const { store } = storeWithPicker(
			() => events.push("cancel"),
			(index) => events.push(`resolve:${index}`),
		);
		cancelOpenPicker(store);
		// One sequence, because the order is the contract: an undo that ran
		// after the null would be undoing a picker that already closed.
		expect(events).toEqual(["cancel", "resolve:null"]);
		expect(store.get().picker).toBeNull();
	});

	test("no picker: nothing happens, nothing throws", () => {
		const store = createStore<UiState>(initialUiState(true));
		cancelOpenPicker(store);
		expect(store.get().picker).toBeNull();
	});

	test("a picker with no preview to undo still resolves — the cancel is optional, the ending is not", () => {
		const events: string[] = [];
		const { store } = storeWithPicker(undefined, (index) => events.push(`resolve:${index}`));
		cancelOpenPicker(store);
		expect(events).toEqual(["resolve:null"]);
		expect(store.get().picker).toBeNull();
	});
});
