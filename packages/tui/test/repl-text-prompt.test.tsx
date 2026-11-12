/**
 * The text prompt as the REPL actually runs it.
 *
 * The dialog's own tests mount it with props in hand; what they cannot see is
 * the store-shaped half of the contract — `promptText` puts a
 * {@link TextPromptState} in the store, the REPL renders it from there, and
 * while it is up the prompt and the global keys must stand down. A dialog that
 * draws but leaves the prompt eating keystrokes looks right and types into two
 * places at once, so both halves are pinned here.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type TextPromptRequest, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CTRL_T = "\x14";

function setup() {
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>(initialUiState());
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
	(view.stdout as { isTTY?: boolean }).isTTY = true;
	return {
		store,
		view,
		finish: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

/** What `promptText` puts in the store, field for field. */
function openPrompt(
	h: { store: ReturnType<typeof setup>["store"] },
	request: Partial<TextPromptRequest> = {},
): Array<string | null> {
	const answers: Array<string | null> = [];
	h.store.set((s) => ({
		...s,
		textPrompt: {
			title: "DEEPSEEK_API_KEY",
			mask: true,
			resolve: (value) => {
				answers.push(value);
				h.store.set((st) => ({ ...st, textPrompt: null }));
			},
			...request,
		},
	}));
	return answers;
}

describe("the text prompt the REPL renders from the store", () => {
	test("draws, takes the answer, and hands the keyboard back", async () => {
		const h = setup();
		const answers = openPrompt(h);
		await delay(30);
		expect(h.view.lastFrame()).toContain("DEEPSEEK_API_KEY");

		h.view.stdin.write("sk-1");
		await delay(20);
		h.view.stdin.write("\r");
		await delay(30);
		expect(answers).toEqual(["sk-1"]);
		expect(h.view.lastFrame()).not.toContain("DEEPSEEK_API_KEY");

		// The prompt had been disabled while the dialog owned the keys; with the
		// value handed back, what is typed lands in the prompt again.
		h.view.stdin.write("next question");
		await delay(30);
		expect(h.view.lastFrame()).toContain("next question");
		h.finish();
	});

	test("a global key waits until the prompt is answered", async () => {
		const h = setup();
		const answers = openPrompt(h);
		await delay(30);

		h.view.stdin.write(CTRL_T);
		await delay(20);
		expect(h.view.lastFrame()).not.toContain("No background shells.");

		h.view.stdin.write("\u001b");
		await delay(30);
		expect(answers).toEqual([null]);

		h.view.stdin.write(CTRL_T);
		await delay(20);
		expect(h.view.lastFrame()).toContain("No background shells.");
		h.finish();
	});
});
