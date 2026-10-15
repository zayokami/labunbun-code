/**
 * The watch panel: which shell it watches, which stop of the source ring is on
 * screen, how tall the panel is allowed to be, and what a reader actually sees.
 *
 * The sizing tests exist because the number is the feature's exposure: the panel
 * shares the frame with the live tail, the status block and the prompt, and this
 * frame reaching the terminal's height is what makes ink clear and reprint the
 * session's scrollback instead of diffing. "Never more than the clamp" is asserted
 * on the drawn frame, not trusted to the arithmetic — the two can disagree, and
 * the one that matters is the frame.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import {
	nextWatchSelection,
	selectWatchShell,
	WATCH_PANEL_DESIRED_ROWS,
	WATCH_PANEL_RESERVE_ROWS,
	WatchPanel,
	watchPanelHeight,
	watchRing,
} from "../src/components/WatchPanel.tsx";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiBackgroundShell, type UiState } from "../src/ui-state.ts";

const shell = (id: string, over: Partial<UiBackgroundShell> = {}): UiBackgroundShell => ({
	id,
	command: `run ${id}`,
	status: "running",
	tail: [],
	...over,
});

/** A tail of `count` numbered lines, newest last — the order the publisher sends. */
const tailOf = (count: number): string[] => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

/** The drawn rows, without a trailing blank the way a frame may carry one. */
const rows = (view: { lastFrame: () => string | undefined }): string[] =>
	(view.lastFrame() ?? "").trimEnd().split("\n");

/**
 * Run a body against a terminal that is not the mock's own height.
 *
 * `ink-testing-library` hard-codes `columns` at 100 and has no `rows` at all, so
 * ink falls back to a terminal it cannot read — which means a test that never
 * overrides them cannot tell "the panel measured the terminal" from "the panel
 * used a constant". The property goes on the mock's prototype and comes back
 * afterwards, the same way the activity panel's column tests do it.
 */
async function withTerminalRows<T>(rowsWanted: number, run: () => T | Promise<T>): Promise<T> {
	// The probe exists only to reach the prototype, and it is mounted with no
	// shells, so it renders no data at all.
	const probe = render(<WatchPanel shells={[]} />);
	const proto = Object.getPrototypeOf(probe.stdout) as object;
	const original = Object.getOwnPropertyDescriptor(proto, "rows");
	probe.unmount();
	Object.defineProperty(proto, "rows", { value: rowsWanted, configurable: true });
	try {
		return await run();
	} finally {
		if (original) Object.defineProperty(proto, "rows", original);
		else Reflect.deleteProperty(proto, "rows");
	}
}

describe("watchPanelHeight", () => {
	test("asks for twelve rows and no more, however tall the terminal is", () => {
		expect(watchPanelHeight(24)).toBe(WATCH_PANEL_DESIRED_ROWS);
		expect(watchPanelHeight(40)).toBe(WATCH_PANEL_DESIRED_ROWS);
		expect(watchPanelHeight(200)).toBe(WATCH_PANEL_DESIRED_ROWS);
	});

	test("takes its reserve off the terminal's own height once that is the smaller number", () => {
		// The reserve is the whole of `8` here, in one example per row it covers.
		expect(WATCH_PANEL_RESERVE_ROWS).toBe(8);
		expect(watchPanelHeight(20)).toBe(12);
		expect(watchPanelHeight(18)).toBe(10);
		expect(watchPanelHeight(13)).toBe(5);
	});

	test("never drops below three rows, however short the terminal gets", () => {
		expect(watchPanelHeight(12)).toBe(4);
		expect(watchPanelHeight(11)).toBe(3);
		expect(watchPanelHeight(8)).toBe(3);
		// A terminal that reports no height at all still gets a panel that draws.
		expect(watchPanelHeight(0)).toBe(3);
	});

	// The two clamps meet: below the crossing point the reserve wins and above it
	// the desire does, and a function that applied only one of them would pass
	// both single-ended tests above.
	test("is a clamp and not a constant", () => {
		expect(watchPanelHeight(13)).toBeLessThan(watchPanelHeight(18));
		expect(watchPanelHeight(18)).toBeLessThan(watchPanelHeight(24));
		expect(watchPanelHeight(40)).toBe(watchPanelHeight(24));
	});
});

describe("selectWatchShell", () => {
	test("watches the last shell still running, in the order the manager lists them", () => {
		const shells = [shell("shell_1"), shell("shell_2"), shell("shell_3", { status: "completed" })];
		expect(selectWatchShell(shells)?.id).toBe("shell_2");
		// Start order, not status: the newest running shell is the interesting one
		// whatever order the manager happened to return.
		expect(selectWatchShell([shell("shell_1", { status: "completed" }), shell("shell_2")])?.id).toBe("shell_2");
	});

	test("falls back to the last shell when none is running", () => {
		const shells = [shell("shell_1", { status: "completed" }), shell("shell_2", { status: "killed" })];
		expect(selectWatchShell(shells)?.id).toBe("shell_2");
	});

	test("an empty list watches nothing, rather than crashing or inventing one", () => {
		expect(selectWatchShell([])).toBeUndefined();
	});
});

describe("the source ring", () => {
	test("every shell in the manager's order, then the listing, then the facts", () => {
		expect(watchRing([shell("s1"), shell("s2")])).toEqual([
			{ kind: "shell", id: "s1" },
			{ kind: "shell", id: "s2" },
			{ kind: "subagents" },
			{ kind: "status" },
		]);
	});

	test("no shells is a ring of two, not an empty ring", () => {
		expect(watchRing([])).toEqual([{ kind: "subagents" }, { kind: "status" }]);
	});

	// The first press moves on: from the standing automatic shell it steps to
	// the next stop, so a keypress never spends itself repeating what is already
	// on screen, and from nowhere-watching it starts at the listing.
	test("the first press steps past the automatic shell rather than onto it", () => {
		const shells = [shell("s1"), shell("s2", { status: "completed" })];
		// The automatic answer is s1, the only running shell; one step lands on s2.
		expect(nextWatchSelection(shells, null)).toEqual({ kind: "shell", id: "s2" });
		expect(nextWatchSelection([], null)).toEqual({ kind: "subagents" });
	});

	// Everything ended still has an automatic answer — the last shell — and the
	// walk continues from there rather than from the top.
	test("the walk starts after the fallback shell when nothing is running", () => {
		const shells = [shell("s1", { status: "completed" }), shell("s2", { status: "killed" })];
		expect(nextWatchSelection(shells, null)).toEqual({ kind: "subagents" });
	});

	test("the walk wraps: past the last shell the listing, past the facts the first shell", () => {
		const shells = [shell("s1")];
		expect(nextWatchSelection(shells, { kind: "shell", id: "s1" })).toEqual({ kind: "subagents" });
		expect(nextWatchSelection(shells, { kind: "subagents" })).toEqual({ kind: "status" });
		expect(nextWatchSelection(shells, { kind: "status" })).toEqual({ kind: "shell", id: "s1" });
	});

	test("with no shells the facts wrap to the listing", () => {
		expect(nextWatchSelection([], { kind: "status" })).toEqual({ kind: "subagents" });
	});

	// The pick is an identity, not a position: a shell that left the list must
	// not hand its index to whichever shell slid into that slot.
	test("a pick whose shell is gone restarts at the ring's first stop", () => {
		expect(nextWatchSelection([shell("s2"), shell("s3")], { kind: "shell", id: "s1" })).toEqual({
			kind: "shell",
			id: "s2",
		});
	});
});

describe("the panel", () => {
	test("says the read is a poll snapshot, not a live one", () => {
		const view = render(<WatchPanel shells={[shell("shell_1")]} />);
		expect(rows(view).join("\n")).toContain("as of last poll (2s)");
		view.unmount();
	});

	test("an empty list says so instead of drawing an empty frame", () => {
		const view = render(<WatchPanel shells={[]} />);
		expect(view.lastFrame()).toContain("No background shells.");
		// No list, no marker: the gutter exists to point at a row, and there is none.
		expect(view.lastFrame()).not.toContain("▶");
		view.unmount();
	});

	// Every published shell gets a row, not just the watched one: the list is what
	// makes the watched shell's absence — it ended — legible.
	test("one header per shell, naming it and saying whether it is still going", () => {
		const view = render(<WatchPanel shells={[shell("shell_1"), shell("shell_2", { status: "completed" })]} />);
		const frame = view.lastFrame() ?? "";
		// Exact rows including the gutter: shell_1 is the last running shell, the
		// one the tail follows, so its row opens on the marker; shell_2's does not.
		// Loose substrings would pass on headers with no gutter at all and would
		// not pin which row carries the marker.
		expect(frame).toContain("▶ shell_1  run shell_1  running");
		expect(frame).toContain("  shell_2  run shell_2  completed");
		view.unmount();
	});

	test("draws the watched shell's tail, newest last", () => {
		const view = render(<WatchPanel shells={[shell("shell_1", { tail: ["VITE v5 ready", "compiled in 300 ms"] })]} />);
		const drawn = rows(view);
		const first = drawn.findIndex((row) => row.includes("VITE v5 ready"));
		const second = drawn.findIndex((row) => row.includes("compiled in 300 ms"));
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
		view.unmount();
	});

	test("draws the last running shell's tail, not the first shell's", () => {
		const view = render(
			<WatchPanel
				shells={[shell("shell_1", { tail: ["from the old one"] }), shell("shell_2", { tail: ["from the new one"] })]}
			/>,
		);
		const frame = view.lastFrame() ?? "";
		expect(frame).toContain("from the new one");
		expect(frame).not.toContain("from the old one");
		view.unmount();
	});

	// The marker answers the question the headers alone cannot: with several
	// shells they all look alike, so the row whose tail is below must be nameable.
	// Two markers would be a lie about which tail it is, and none is the gap the
	// marker exists to close.
	test("marks the running shell's header — and that shell is the one whose tail is drawn", () => {
		const view = render(
			<WatchPanel
				shells={[
					shell("shell_1", { status: "completed", tail: ["from the old one"] }),
					shell("shell_2", { tail: ["from the new one"] }),
				]}
			/>,
		);
		const marked = rows(view).filter((row) => row.includes("▶"));
		expect(marked).toHaveLength(1);
		expect(marked[0]).toContain("shell_2");
		// The marked row is a header, not a tail row: the id it names is the one
		// with the drawable gutter, and the tail text that appears is that shell's.
		expect(marked[0]).not.toContain("shell_1");
		const frame = view.lastFrame() ?? "";
		expect(frame).toContain("from the new one");
		expect(frame).not.toContain("from the old one");
		view.unmount();
	});

	test("with every shell ended, the marker is on the last one — the fallback the tail follows", () => {
		const view = render(
			<WatchPanel shells={[shell("shell_1", { status: "completed" }), shell("shell_2", { status: "killed" })]} />,
		);
		const marked = rows(view).filter((row) => row.includes("▶"));
		expect(marked).toHaveLength(1);
		expect(marked[0]).toContain("shell_2");
		view.unmount();
	});

	test("a lone shell is marked, because it is the one being read", () => {
		const view = render(<WatchPanel shells={[shell("shell_1")]} />);
		expect(view.lastFrame()).toContain("▶ shell_1");
		view.unmount();
	});

	test("elides a command that will not fit, keeping the id and the status word", () => {
		const command = "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort --force --logLevel info --debug";
		const view = render(<WatchPanel shells={[shell("shell_1", { command })]} />);
		const frame = view.lastFrame() ?? "";
		expect(frame).not.toContain("--logLevel info");
		expect(frame).toContain("…");
		// The gutter and the two load-bearing columns survive the elision.
		expect(frame).toContain("▶ shell_1");
		expect(frame).toContain("running");
		view.unmount();
	});

	// The height is a budget, and the test is on the drawn frame because that is
	// what spends it. Eight lines fit at the desired height, and the window keeps
	// the newest ones — an older line is what gets cut, never the newest.
	test("draws at most the rows it computed, keeping the newest output", async () => {
		const shells = [shell("shell_1", { tail: tailOf(20) })];
		const view = render(<WatchPanel shells={shells} />);
		expect(rows(view).length).toBeLessThanOrEqual(watchPanelHeight(24));
		expect(view.lastFrame()).toContain("line 20");
		expect(view.lastFrame()).not.toContain("line 12");
		view.unmount();

		// A shorter terminal buys fewer rows, and the panel follows it down.
		await withTerminalRows(13, () => {
			const short = render(<WatchPanel shells={shells} />);
			expect(rows(short).length).toBe(watchPanelHeight(13));
			expect(short.lastFrame()).toContain("line 20");
			expect(short.lastFrame()).not.toContain("line 19");
			short.unmount();
		});
	});

	// The probe: the panel reads `useWindowSize().rows` and not a constant. Two
	// terminals of different heights, the same data, and the frame differs.
	test("measures the terminal's height rather than assuming one", async () => {
		const shells = [shell("shell_1", { tail: tailOf(20) })];
		const drawnAt = (terminalRows: number) =>
			withTerminalRows(terminalRows, () => {
				const view = render(<WatchPanel shells={shells} />);
				const height = rows(view).length;
				view.unmount();
				return height;
			});
		expect(watchPanelHeight(13)).not.toBe(watchPanelHeight(24));
		expect(await drawnAt(13)).toBe(watchPanelHeight(13));
		expect(await drawnAt(24)).toBe(watchPanelHeight(24));
	});
});

describe("the panel's other stops", () => {
	test("the note row names the cycle key — it is the one row that is never cut", () => {
		const view = render(<WatchPanel shells={[shell("shell_1")]} />);
		expect(view.lastFrame()).toContain("ctrl+v cycles");
		view.unmount();
	});

	test("the subagent stop draws the published lines, counts first", () => {
		const view = render(
			<WatchPanel
				shells={[shell("shell_1")]}
				selection={{ kind: "subagents" }}
				subagentLines={["2 subagents: 1 running, 1 completed", "running   12s  Fix it  (sidechain-1)"]}
			/>,
		);
		const frame = view.lastFrame() ?? "";
		expect(frame).toContain("2 subagents: 1 running, 1 completed");
		expect(frame).toContain("Fix it  (sidechain-1)");
		// The gutter points at the shell whose tail is below; on this stop there
		// is no shell row to point at, and a marker would be a lie about what
		// the rows under it are.
		expect(frame).not.toContain("▶");
		// And the shells' own rows are not behind it: the stops are exclusive.
		expect(frame).not.toContain("run shell_1");
		view.unmount();
	});

	test("the facts stop draws its lines as handed", () => {
		const view = render(
			<WatchPanel
				shells={[]}
				selection={{ kind: "status" }}
				statusLines={["model    anthropic/fable-5-1", "cost     $0.1200 this session · $3.4000 this project"]}
			/>,
		);
		const frame = view.lastFrame() ?? "";
		expect(frame).toContain("model    anthropic/fable-5-1");
		expect(frame).toContain("$0.1200 this session");
		// No shells is the ring of two; the facts do not depend on one ever
		// having run, and the empty-list sentence is not the answer here.
		expect(frame).not.toContain("No background shells.");
		view.unmount();
	});

	test("a stop with nothing published yet says so rather than drawing an empty frame", () => {
		const subagents = render(<WatchPanel shells={[]} selection={{ kind: "subagents" }} />);
		expect(subagents.lastFrame()).toContain("No subagents have run in this session.");
		subagents.unmount();

		const facts = render(<WatchPanel shells={[]} selection={{ kind: "status" }} />);
		expect(facts.lastFrame()).toContain("No session facts yet.");
		facts.unmount();
	});

	// The pick is an identity and the marker follows it: with two running shells
	// the automatic answer is the last one, so picking the first must move the
	// gutter and the tail together — a marker that moved alone, or a tail that
	// stayed, would be the panel reading from two places at once.
	test("a picked shell moves the marker and the tail together", () => {
		const view = render(
			<WatchPanel
				shells={[shell("shell_1", { tail: ["from the old one"] }), shell("shell_2", { tail: ["from the new one"] })]}
				selection={{ kind: "shell", id: "shell_1" }}
			/>,
		);
		const marked = rows(view).filter((row) => row.includes("▶"));
		expect(marked).toHaveLength(1);
		expect(marked[0]).toContain("shell_1");
		const frame = view.lastFrame() ?? "";
		expect(frame).toContain("from the old one");
		expect(frame).not.toContain("from the new one");
		view.unmount();
	});

	test("a pick whose shell has left the list falls back to the automatic shell", () => {
		const view = render(
			<WatchPanel
				shells={[shell("shell_1", { tail: ["still here"] })]}
				selection={{ kind: "shell", id: "shell_gone" }}
			/>,
		);
		const marked = rows(view).filter((row) => row.includes("▶"));
		expect(marked).toHaveLength(1);
		expect(marked[0]).toContain("shell_1");
		expect(view.lastFrame()).toContain("still here");
		view.unmount();
	});
});

/**
 * Ctrl+T at the REPL: what it opens, what it refuses to open, and what happens
 * to the keys around it.
 *
 * The panel is the first panel here that is *not* a screen, so the tests are
 * about the prompt as much as about the panel: the draft has to survive it, the
 * typing has to reach the prompt while it is open, and the two screens the REPL
 * already has have to keep their keys. The harness is the transcript's
 * (`repl-transcript.test.tsx`), because the claim "the buffer is the buffer, not
 * a repaint of it" is only checkable by sending what was typed.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(done: () => boolean, timeoutMs = 2000): Promise<void> {
	for (let waited = 0; waited < timeoutMs; waited += 10) {
		if (done()) return;
		await delay(10);
	}
}

/** The control bytes this file presses: `Ctrl+O` is 0x0f, `Ctrl+T` is 0x14, `Ctrl+V` is 0x16. */
const CTRL_O = "\x0f";
const CTRL_T = "\x14";
const CTRL_V = "\x16";

function replSetup() {
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>({
		...initialUiState(),
		backgroundShells: [shell("shell_1", { command: "npm run dev", tail: ["VITE v5 ready"] })],
	});
	const unsubscribe = connectSessionToStore(session, store);
	const view = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />);
	return {
		store,
		/** Ink pads and wraps frames; the assertions are about what a user reads. */
		frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "),
		write: async (keys: string) => {
			view.stdin.write(keys);
			await delay(30);
		},
		asked: () =>
			store
				.get()
				.entries.filter((entry) => entry.kind === "user")
				.map((entry) => entry.text),
		finish: () => {
			unsubscribe();
			view.unmount();
		},
	};
}

describe("Ctrl+T at the REPL", () => {
	test("opens the panel over a working prompt, and what is typed next goes to the prompt", async () => {
		const h = replSetup();
		await h.write("a draft");
		expect(h.frame()).toContain("a draft");

		await h.write(CTRL_T);
		expect(h.frame()).toContain("VITE v5 ready");
		// The difference from the transcript in one assertion: the prompt is still
		// painted under the panel, holding what it held.
		expect(h.frame()).toContain("a draft");

		await h.write(" typed");
		expect(h.frame()).toContain("a draft typed");

		// And it is the buffer, not a redraw of it: the key that sends sends what the
		// user wrote, with the panel still open over it.
		await h.write("\r");
		await waitFor(() => h.asked().length > 0);
		expect(h.asked()).toEqual(["a draft typed"]);
		h.finish();
	}, 20_000);

	test("closes on the same key, and on Escape", async () => {
		const h = replSetup();
		await h.write(CTRL_T);
		expect(h.frame()).toContain("VITE v5 ready");
		await h.write(CTRL_T);
		expect(h.frame()).not.toContain("VITE v5 ready");

		await h.write(CTRL_T);
		expect(h.frame()).toContain("VITE v5 ready");
		await h.write("\x1b");
		expect(h.frame()).not.toContain("VITE v5 ready");
		h.finish();
	}, 20_000);

	test("a dialog owns the keyboard while one is up, so the toggle does nothing", async () => {
		const h = replSetup();
		h.store.set((s) => ({
			...s,
			dialog: { callId: "c1", toolName: "Bash", inputPreview: "rm -rf build", resolve: () => {} },
		}));
		// The write is a commit before the key is: the handler reads the render it
		// was built in, and a key sent in the same tick as the store write would be
		// answered by the render before it — which is a fact about the harness, not
		// about the mask.
		await delay(30);
		expect(h.frame()).toContain("Bash");
		await h.write(CTRL_T);
		// Both halves: the dialog is up, and the panel is not — an assertion on the
		// absence alone would pass on a frame that failed to render anything.
		expect(h.frame()).toContain("Bash");
		expect(h.frame()).not.toContain("VITE v5 ready");
		h.finish();
	}, 20_000);

	test("the transcript owns the view keys: Ctrl+T is ignored there, and the panel comes back as it was", async () => {
		const h = replSetup();
		await h.write(CTRL_T);
		await h.write(CTRL_O);
		expect(h.frame()).toContain("Transcript ");
		expect(h.frame()).not.toContain("VITE v5 ready");

		// One press, and that is the point: a key that reached the panel here would
		// close it, so the state the screen gives back is the state it took. Two
		// presses to undo the first would hide exactly the bug this catches.
		await h.write(CTRL_T);

		await h.write(CTRL_O);
		expect(h.frame()).toContain("VITE v5 ready");
		h.finish();
	}, 20_000);

	// The rule that makes "the panel returns" safe: while the transcript is up the
	// panel is not on screen, so it must not answer the key that leaves the screen.
	// Asserted in that order — Escape once, and the panel is still there behind.
	test("Escape on the transcript closes the screen and leaves the hidden panel alone", async () => {
		const h = replSetup();
		await h.write(CTRL_T);
		await h.write(CTRL_O);
		await h.write("\x1b");
		expect(h.frame()).not.toContain("Transcript ");
		expect(h.frame()).toContain("VITE v5 ready");
		h.finish();
	}, 20_000);

	test("with the heatmap open, Escape closes the heatmap first and the panel second", async () => {
		const h = replSetup();
		h.store.set((s) => ({ ...s, activity: { home: undefined, range: "all" } }));
		await h.write(CTRL_T);
		expect(h.frame()).toContain("Activity");
		expect(h.frame()).toContain("VITE v5 ready");

		// One Escape, one panel: the order matters, and it is the REPL's own — the
		// activity block is above the watch panel's in the key handler.
		await h.write("\x1b");
		expect(h.frame()).not.toContain("Activity");
		expect(h.frame()).toContain("VITE v5 ready");

		await h.write("\x1b");
		expect(h.frame()).not.toContain("VITE v5 ready");
		h.finish();
	}, 20_000);
});

describe("Ctrl+V at the REPL", () => {
	test("walks the ring while the panel is open, wraps around, and never costs the prompt", async () => {
		const h = replSetup();
		await h.write("a draft");
		expect(h.frame()).toContain("a draft");
		// Closed, the key is nobody's: asserted with a live frame first, so the
		// absence cannot pass on a frame that failed to render anything.
		await h.write(CTRL_V);
		expect(h.frame()).toContain("a draft");
		expect(h.frame()).not.toContain("ctrl+v cycles");

		// One shell, so the automatic stop is its tail; the first press steps to
		// the listing, the second to the facts, the third wraps back to the tail.
		await h.write(CTRL_T);
		expect(h.frame()).toContain("VITE v5 ready");
		await h.write(CTRL_V);
		expect(h.frame()).toContain("ctrl+v cycles");
		expect(h.frame()).not.toContain("VITE v5 ready");
		await h.write(CTRL_V);
		expect(h.frame()).not.toContain("VITE v5 ready");
		await h.write(CTRL_V);
		expect(h.frame()).toContain("VITE v5 ready");

		// The prompt was in reach the whole way.
		await h.write(" still");
		expect(h.frame()).toContain("a draft still");
		h.finish();
	}, 20_000);

	test("the published stops are what the ring shows", async () => {
		const h = replSetup();
		h.store.set((s) => ({
			...s,
			watchSubagentLines: ["1 subagent: 1 running", "running   3s  Ship it  (sidechain-9)"],
			watchStatusLines: ["model    test/faux"],
		}));
		await delay(30);
		await h.write(CTRL_T);
		await h.write(CTRL_V);
		expect(h.frame()).toContain("Ship it");
		await h.write(CTRL_V);
		// The harness collapses runs of whitespace, so the label column reads as
		// one space here — the aligned form is pinned by the panel's own tests.
		expect(h.frame()).toContain("model test/faux");
		h.finish();
	}, 20_000);

	// The transcript owns the view-switch keys, so the cycle key dies with them:
	// asserted in that order — the screen comes back to the stop it left, which
	// a press that had reached the ring could not (one shell means any step
	// lands on another stop).
	test("the transcript keeps its keys: Ctrl+V does nothing there, and the panel is where it was", async () => {
		const h = replSetup();
		await h.write(CTRL_T);
		await h.write(CTRL_O);
		expect(h.frame()).toContain("Transcript ");
		await h.write(CTRL_V);
		expect(h.frame()).toContain("Transcript ");

		await h.write(CTRL_O);
		expect(h.frame()).toContain("VITE v5 ready");
		h.finish();
	}, 20_000);

	test("a dialog owns the keyboard: Ctrl+V cycles nothing while one is up", async () => {
		const h = replSetup();
		await h.write(CTRL_T);
		expect(h.frame()).toContain("VITE v5 ready");
		h.store.set((s) => ({
			...s,
			dialog: { callId: "c1", toolName: "Bash", inputPreview: "rm -rf build", resolve: () => {} },
		}));
		await delay(30);
		await h.write(CTRL_V);
		h.store.set((s) => ({ ...s, dialog: null }));
		await delay(30);
		// Had the press reached the ring, the panel would be on the listing stop
		// and the tail would be gone; it is exactly where it was.
		expect(h.frame()).toContain("VITE v5 ready");
		h.finish();
	}, 20_000);
});
