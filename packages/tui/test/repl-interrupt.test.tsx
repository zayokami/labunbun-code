/**
 * Esc must interrupt a running turn — reported from a real terminal, where the
 * spinner kept running after the key was pressed.
 *
 * Driven through the REPL's own prompt input so the path under test is the one
 * a user takes: type, submit, Esc. The provider stream here ignores the cancel
 * and finishes late (an aborted SSE body ends without an error), which is the
 * shape that used to leave the turn recorded as a completed one.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(options: { vim?: boolean; completeFiles?: (query: string) => Promise<string[]> } = {}) {
	const streaming = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const faux = fauxProvider([{ text: "thinking hard" }, { text: "never reached" }]);
	const streamFn: StreamFn = async function* (model, context, options) {
		for await (const event of faux.streamFn(model, context, options)) {
			if (event.type === "done") {
				// Hold the terminal event until the test releases it: the turn is
				// still in flight while the user presses Esc.
				streaming.resolve();
				await release.promise;
			}
			yield event;
		}
	};

	const session = new AgentSession({ model: FAUX_MODEL, maxTurns: 4, deps: { streamFn } });
	const store = createStore<UiState>({ ...initialUiState(), statusPhase: "responding" });
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(
		<REPL
			getSession={() => session}
			store={store}
			modelName="test"
			onExit={() => {}}
			vimMode={options.vim}
			completeFiles={options.completeFiles}
		/>,
	);

	return {
		session,
		store,
		streaming,
		release,
		stdin: view.stdin,
		frame: () => view.lastFrame() ?? "",
		unmount: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

const transcript = (store: { get: () => UiState }) =>
	store.get().entries.map((e) => (e.kind === "toolUse" ? `${e.kind}:${e.toolName}` : `${e.kind}:${e.text}`));

async function submit(stdin: { write: (text: string) => void }, text: string) {
	stdin.write(text);
	await delay(20);
	stdin.write("\r");
}

describe("Esc interrupts a run", () => {
	test("escape mid-turn stops the run and reports the interrupt", async () => {
		const h = setup();
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;
		expect(h.session.isRunning).toBe(true);

		h.stdin.write("\x1b");
		await delay(60);
		// The REPL forwarded the key to the session even though the stream is
		// still finishing.
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);

		expect(h.session.isRunning).toBe(false);
		expect(transcript(h.store)).toContain("info:[interrupted]");
		expect(h.store.get().statusPhase).toBe("idle");
		const lastAssistant = [...h.session.messages].reverse().find((m) => m.role === "assistant");
		expect(lastAssistant).toMatchObject({ stopReason: "aborted" });
		h.unmount();
	}, 20_000);

	test("escape while idle does nothing", async () => {
		const h = setup();
		await delay(40);
		expect(h.session.isRunning).toBe(false);

		h.stdin.write("\x1b");
		await delay(60);

		expect(h.session.isRunning).toBe(false);
		expect(h.session.isInterrupted).toBe(false);
		expect(transcript(h.store)).not.toContain("info:[interrupted]");
		h.unmount();
	}, 20_000);
});

/**
 * Ink hands every keypress to every active listener, so "the vim engine
 * consumed it" cannot keep the REPL's own Escape binding from firing. The
 * editor therefore gets the key first — through a ref the REPL calls — and only
 * an Escape it declines to use reaches the session.
 */
describe("Esc and the vim layer", () => {
	test("escape from insert mode leaves insert without killing the turn", async () => {
		const h = setup({ vim: true });
		await delay(40);
		// vim starts in NORMAL, where the letters are commands — the prompt has to
		// be typed into the buffer from insert mode.
		h.stdin.write("i");
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;
		expect(h.session.isRunning).toBe(true);

		h.stdin.write("half typed");
		await delay(20);
		h.stdin.write("\x1b");
		await delay(60);

		expect(h.session.isInterrupted).toBe(false); // insert mode used the key
		expect(h.frame()).toContain("[NORMAL]");

		// Nothing left to cancel: this one is the interrupt.
		h.stdin.write("\x1b");
		await delay(60);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("an idle Escape in normal mode interrupts right away", async () => {
		const h = setup({ vim: true });
		await delay(40);
		h.stdin.write("i");
		await submit(h.stdin, "run something slow");
		await delay(20);
		h.stdin.write("\x1b"); // back to NORMAL, so the next Esc is not "leave insert"
		await h.streaming.promise;
		await delay(20);

		h.stdin.write("\x1b");
		await delay(60);
		expect(h.session.isInterrupted).toBe(true);

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);

	test("escape dismisses the @-list instead of aborting", async () => {
		const h = setup({ completeFiles: async () => ["src/index.ts"] });
		await delay(40);
		await submit(h.stdin, "run something slow");
		await h.streaming.promise;

		h.stdin.write("@src");
		await delay(250); // the list loads behind a debounce
		expect(h.frame()).toContain("@src/index.ts");

		h.stdin.write("\x1b");
		await delay(60);
		expect(h.session.isInterrupted).toBe(false);
		expect(h.frame()).not.toContain("@src/index.ts");

		h.release.resolve();
		await delay(150);
		h.unmount();
	}, 20_000);
});
