/**
 * Esc while a dialog is open.
 *
 * Both the REPL and the open dialog listen for keys, so one Esc used to do two
 * things at once: the dialog denied the request, and the REPL's global handler
 * killed the turn. The user answered a question and lost the answer in the same
 * keystroke. Esc belongs to the dialog while one is open; the turn-wide
 * interrupt is still there when no dialog is up.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
	const streaming = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const faux = fauxProvider([{ text: "thinking hard" }, { text: "never reached" }]);
	const streamFn: StreamFn = async function* (model, context, options) {
		for await (const event of faux.streamFn(model, context, options)) {
			if (event.type === "done") {
				// Hold the terminal event: the turn is still in flight while the
				// user presses Esc, so the REPL sees a running session.
				streaming.resolve();
				await release.promise;
			}
			yield event;
		}
	};

	const session = new AgentSession({ model: FAUX_MODEL, maxTurns: 4, deps: { streamFn } });
	const store = createStore<UiState>({ ...initialUiState(), statusPhase: "responding" });
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);

	const answers: Array<[boolean, boolean]> = [];
	const openDialog = (toolName: string) =>
		store.set((state) => ({
			...state,
			dialog: {
				callId: `perm-${toolName}`,
				toolName,
				inputPreview: `Allow ${toolName}?`,
				resolve: (allow, alwaysAllow) => answers.push([allow, alwaysAllow]),
			},
		}));

	return {
		session,
		store,
		answers,
		openDialog,
		streaming,
		release,
		stdin: view.stdin,
		unmount: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

async function startTurn(stdin: { write: (text: string) => void }, text: string) {
	stdin.write(text);
	await delay(20);
	stdin.write("\r");
}

describe("Esc inside a permission dialog", () => {
	test("denies the request without interrupting the turn", async () => {
		const h = setup();
		await delay(40);
		await startTurn(h.stdin, "run something slow");
		await h.streaming.promise;
		expect(h.session.isRunning).toBe(true);

		h.openDialog("Write");
		await delay(40);
		h.stdin.write("\x1b");
		await delay(60);

		expect(h.answers).toEqual([[false, false]]);
		// The decision the user just made must land on a live turn.
		expect(h.session.isInterrupted).toBe(false);
		expect(h.session.isRunning).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("Esc with no dialog up still interrupts the run", async () => {
		const h = setup();
		await delay(40);
		await startTurn(h.stdin, "run something slow");
		await h.streaming.promise;

		h.stdin.write("\x1b");
		await delay(60);

		expect(h.session.isInterrupted).toBe(true);
		expect(h.answers).toEqual([]);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);
});
