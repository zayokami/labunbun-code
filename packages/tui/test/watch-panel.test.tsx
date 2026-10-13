/**
 * The watch panel: which shell it watches, how tall it is allowed to be, and
 * what a reader actually sees.
 *
 * The sizing tests exist because the number is the feature's exposure: the panel
 * shares the frame with the live tail, the status block and the prompt, and this
 * frame reaching the terminal's height is what makes ink clear and reprint the
 * session's scrollback instead of diffing. "Never more than the clamp" is asserted
 * on the drawn frame, not trusted to the arithmetic — the two can disagree, and
 * the one that matters is the frame.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import {
	selectWatchShell,
	WATCH_PANEL_DESIRED_ROWS,
	WATCH_PANEL_RESERVE_ROWS,
	WatchPanel,
	watchPanelHeight,
} from "../src/components/WatchPanel.tsx";
import type { UiBackgroundShell } from "../src/ui-state.ts";

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

describe("the panel", () => {
	test("says the read is a poll snapshot, not a live one", () => {
		const view = render(<WatchPanel shells={[shell("shell_1")]} />);
		expect(rows(view).join("\n")).toContain("as of last poll (2s)");
		view.unmount();
	});

	test("an empty list says so instead of drawing an empty frame", () => {
		const view = render(<WatchPanel shells={[]} />);
		expect(view.lastFrame()).toContain("No background shells.");
		view.unmount();
	});

	// Every published shell gets a row, not just the watched one: the list is what
	// makes the watched shell's absence — it ended — legible.
	test("one header per shell, naming it and saying whether it is still going", () => {
		const view = render(<WatchPanel shells={[shell("shell_1"), shell("shell_2", { status: "completed" })]} />);
		const frame = view.lastFrame() ?? "";
		expect(frame).toContain("shell_1");
		expect(frame).toContain("run shell_1");
		expect(frame).toContain("running");
		expect(frame).toContain("shell_2");
		expect(frame).toContain("completed");
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

	test("elides a command that will not fit, keeping the id and the status word", () => {
		const command = "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort --force --logLevel info --debug";
		const view = render(<WatchPanel shells={[shell("shell_1", { command })]} />);
		const frame = view.lastFrame() ?? "";
		expect(frame).not.toContain("--logLevel info");
		expect(frame).toContain("…");
		expect(frame).toContain("shell_1");
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
