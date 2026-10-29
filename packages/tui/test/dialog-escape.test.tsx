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
import type { PermissionDiff } from "../src/permission-diff.ts";
import { createPermissionQueue } from "../src/permission-queue.ts";
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
	const openDialog = (toolName: string, source?: string) =>
		store.set((state) => ({
			...state,
			dialog: {
				callId: `perm-${toolName}`,
				toolName,
				inputPreview: `Allow ${toolName}?`,
				source,
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
		lastFrame: () => view.lastFrame(),
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

/**
 * The attribution line, painted by the whole tree.
 *
 * PermissionDialog has its own test for the line, and the queue has one for
 * carrying the source to it; what neither covers is the line in between —
 * REPL handing `dialog.source` down. A prop dropped there leaves every unit
 * green and the screen silent, so this renders the real REPL and reads the
 * frame the user would.
 */
describe("a forwarded ask, through the real REPL", () => {
	test("shows the asker on the dialog", async () => {
		const h = setup();
		await delay(40);
		h.openDialog("Write", 'subagent "Fix the flaky test" (sidechain-42-abcd)');

		// Poll to the invariant rather than trusting one fixed window: under a
		// full-suite load Ink's paint can land after any delay short enough to
		// keep this file fast, and a fixed window is exactly when that shows.
		const wanted = 'Requested by subagent "Fix the flaky test" (sidechain-42-abcd)';
		const deadline = Date.now() + 5000;
		let frame = "";
		while (Date.now() < deadline) {
			frame = (h.lastFrame() ?? "").replace(/\s+/g, " ");
			if (frame.includes(wanted)) break;
			await delay(20);
		}
		expect(frame).toContain(wanted);
		h.unmount();
	}, 20_000);
});

describe("the permission dialog as the REPL runs it", () => {
	const DOWN = "\x1b[B";

	/** A REPL whose permission dialog is fed by the real queue, the way `mountRepl` wires it. */
	function setupQueue() {
		const faux = fauxProvider([{ text: "n/a" }]);
		const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
		const store = createStore<UiState>(initialUiState());
		const unsubscribe = connectSessionToStore(session, store);
		const queue = createPermissionQueue({
			show: (dialog) => store.set((state) => ({ ...state, dialog })),
			preview: (_tool, input) => (input as { command: string }).command,
			diffPreview: (_tool, input) => (input as { diff?: PermissionDiff }).diff,
		});
		const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
		return {
			queue,
			stdin: view.stdin,
			frame: () => view.lastFrame() ?? "",
			unmount: () => {
				unsubscribe();
				view.unmount();
			},
		};
	}

	test("the next queued request opens fresh, and the sentence typed for the last one reaches its caller", async () => {
		const h = setupQueue();
		const first = h.queue.request("Bash", { command: "git status" });
		const second = h.queue.request("Bash", { command: "rm -rf build" });
		await delay(60);

		// Row 4 is the one that asks for a sentence; type one and send it.
		for (let i = 0; i < 3; i++) {
			h.stdin.write(DOWN);
			await delay(20);
		}
		h.stdin.write("\r");
		await delay(30);
		for (const ch of "use git log") {
			h.stdin.write(ch);
			await delay(5);
		}
		h.stdin.write("\r");
		await delay(80);

		// The REPL used to forward three of the answer's four fields, so the
		// sentence the model was meant to act on was dropped on the way.
		expect(await first).toEqual({ allow: false, alwaysAllow: false, alwaysAsk: false, message: "use git log" });

		// The same dialog component stood in the same place for the next request and
		// kept its highlight, its open field and the sentence in it: Enter on the
		// first screen would have denied `rm -rf build` with the other call's text.
		const frame = h.frame();
		expect(frame).toContain("rm -rf build");
		expect(frame).not.toContain("Tell the model what to do differently:");
		expect(frame).not.toContain("use git log");
		expect(frame).toMatch(/❯ 1\. /);

		h.stdin.write("n");
		await delay(40);
		expect(await second).toBe(false);
		h.unmount();
	}, 20_000);

	test("an Edit's diff is drawn in the dialog instead of the one-line preview", async () => {
		const h = setupQueue();
		void h.queue.request("Edit", {
			command: "Edit src/a.ts",
			diff: {
				lines: [
					{ kind: "removed", text: "const a = 1;" },
					{ kind: "added", text: "const a = 2;" },
				],
				notice: "1 line changed",
			},
		});
		await delay(60);

		const frame = h.frame();
		expect(frame).toContain("-const a = 1;");
		expect(frame).toContain("+const a = 2;");
		expect(frame).toContain("1 line changed");
		expect(frame).not.toContain("Edit src/a.ts");
		h.unmount();
	}, 20_000);
});
