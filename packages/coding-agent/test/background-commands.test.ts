/**
 * `/ps` and `/stop` are thin: they pick a shell, then either print its tail or
 * kill it. The picking, the tail and the argument forms are all pure, which is
 * where the mistakes live — an id that only matches one of its two spellings, a
 * tail that shows the start of a ten-minute log instead of the end.
 *
 * No process is started here. What a real shell does is the manager's business
 * and is covered where the manager is.
 */
import { describe, expect, test } from "bun:test";
import type { BackgroundShell } from "@labunbun/tools";
import { createStore, DARK_THEME, LIVE_OUTPUT_LINES } from "@labunbun/tui";
import { formatShellOutput, resolveShellId, shellAge, shellPickerItems } from "../src/background-commands.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const NOW = 1_700_000_000_000;

function shell(overrides: Partial<BackgroundShell> = {}): BackgroundShell {
	return {
		id: "shell_1",
		command: "npm run dev",
		cwd: "G:\\proj",
		outputFile: "C:\\Temp\\lbb-shell_1.log",
		startTime: NOW,
		status: "running",
		exitCode: null,
		...overrides,
	};
}

/** The frame's whitespace is not what is under test. */
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("shellAge", () => {
	test("seconds, then minutes, then hours and minutes", () => {
		expect(shellAge(shell({ startTime: NOW - 0 }), NOW)).toBe("0s");
		expect(shellAge(shell({ startTime: NOW - 59_000 }), NOW)).toBe("59s");
		expect(shellAge(shell({ startTime: NOW - 60_000 }), NOW)).toBe("1m");
		expect(shellAge(shell({ startTime: NOW - 59 * 60_000 }), NOW)).toBe("59m");
		expect(shellAge(shell({ startTime: NOW - 3_600_000 }), NOW)).toBe("1h 0m");
		expect(shellAge(shell({ startTime: NOW - 3_661_000 }), NOW)).toBe("1h 1m");
	});

	// A clock that went backwards (or a start time read from a file written on
	// another machine) must not render as "-3s ago".
	test("a start time in the future reads as just started", () => {
		expect(shellAge(shell({ startTime: NOW + 5000 }), NOW)).toBe("0s");
	});
});

describe("shellPickerItems", () => {
	test("one row per shell, id and command on the label", () => {
		const items = shellPickerItems([shell({ id: "shell_1" }), shell({ id: "shell_2", command: "vite" })], NOW);
		expect(items).toHaveLength(2);
		expect(items[0].label).toBe("shell_1  npm run dev");
		expect(items[1].label).toBe("shell_2  vite");
	});

	test("the description says what the shell is doing, and since when", () => {
		expect(shellPickerItems([shell({ startTime: NOW - 3000 })], NOW)[0].description).toBe("running · 3s");
		// A finished shell shows its exit code; a killed one has none to show,
		// so the row must not read "exit null".
		expect(shellPickerItems([shell({ status: "completed", exitCode: 0 })], NOW)[0].description).toBe(
			"completed · exit 0 · 0s",
		);
		expect(shellPickerItems([shell({ status: "killed", exitCode: null })], NOW)[0].description).toBe("killed · 0s");
	});

	// A command line can be a whole script with newlines; the list is one line
	// per row, and a raw newline would push the rest of the list off the screen.
	test("a multi-line command is folded onto one line and elided, not wrapped", () => {
		const command = `node -e "${"x".repeat(200)}"`;
		const item = shellPickerItems([shell({ command })], NOW)[0];
		expect(item.label).not.toContain("\n");
		expect(item.label.length).toBeLessThanOrEqual("shell_1  ".length + 60);
		expect(item.label.endsWith("…")).toBe(true);
	});

	test("the head survives eliding — that is the part that says what it is", () => {
		const item = shellPickerItems([shell({ command: `bun run dev ${" --flag".repeat(20)}` })], NOW)[0];
		expect(item.label).toContain("bun run dev");
	});
});

describe("formatShellOutput", () => {
	test("names the shell, then indents its tail", () => {
		expect(formatShellOutput("shell_1", "one\ntwo\n")).toBe("shell_1:\n  one\n  two");
	});

	// Silence is the common case right after starting a server, and an empty
	// body would look like the command failed rather than like it is quiet.
	test("a shell that has printed nothing says so", () => {
		expect(flat(formatShellOutput("shell_1", ""))).toBe("shell_1: (no output yet)");
	});

	// Same question as a running tool's preview — "what is it saying now" — so
	// the answer is the same tail, and it is bounded by the same window.
	test("a long log is shown from the end, marked with what was dropped", () => {
		const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const lines = formatShellOutput("shell_1", text, LIVE_OUTPUT_LINES).split("\n");
		expect(lines[0]).toBe("shell_1:");
		expect(lines).toHaveLength(LIVE_OUTPUT_LINES + 1);
		expect(lines[1]).toContain("lines omitted");
		expect(lines[lines.length - 1]).toBe("  line 40");
		expect(lines.join("\n")).not.toContain("line 1\n");
	});

	test("the maximum number of lines is the caller's to lower", () => {
		const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
		expect(formatShellOutput("shell_1", text, 2).split("\n")).toEqual(["shell_1:", "  … 9 lines omitted", "  line 10"]);
	});
});

describe("resolveShellId", () => {
	const shells = [shell({ id: "shell_1" }), shell({ id: "shell_2" })];

	test("both spellings of an id name the same shell", () => {
		expect(resolveShellId("shell_2", shells)?.id).toBe("shell_2");
		expect(resolveShellId("2", shells)?.id).toBe("shell_2");
		// The picker shows the full id; people type whatever they remember.
		expect(resolveShellId("  SHELL_2 ", shells)?.id).toBe("shell_2");
	});

	test("an id nobody has is undefined rather than a near miss", () => {
		expect(resolveShellId("3", shells)).toBeUndefined();
		expect(resolveShellId("", shells)).toBeUndefined();
		expect(resolveShellId("shell_", shells)).toBeUndefined();
		// shell_1 must not be reachable as the bare number "12" or as "shell".
		expect(resolveShellId("shell", shells)).toBeUndefined();
	});
});

/**
 * The commands themselves. `/ps` and `/stop` are async in the body (the picker
 * is a promise) even though they answer `true` synchronously, so every
 * assertion here is after a tick.
 */
describe("the /ps and /stop commands", () => {
	const tick = () => new Promise((r) => setTimeout(r, 0));

	interface Ctx {
		ctx: AppCommandContext;
		infos: () => string[];
		killed: string[];
		refreshes: () => number;
		/** Every picker that was opened, with the rows it was given. */
		picked: Array<{ title: string; labels: string[] }>;
	}

	function makeCtx(shells: BackgroundShell[], output = "boot\nlistening on :3000\n"): Ctx {
		const store = createStore<{ entries: Array<{ kind: string; text: string }> }>({ entries: [] });
		const killed: string[] = [];
		let refreshes = 0;
		const picked: Array<{ title: string; labels: string[] }> = [];
		const ctx = {
			sessionRef: undefined,
			getSession: () => undefined,
			handle: {
				store,
				pickFromList: (title: string, items: Array<{ label: string }>) => {
					picked.push({ title, labels: items.map((item) => item.label) });
					return Promise.resolve(0);
				},
			},
			backgroundShells: {
				list: () => shells,
				output: () => output,
				kill: (id: string) => {
					killed.push(id);
					const target = shells.find((s) => s.id === id);
					// The manager refuses to kill what is not running; saying "stopped"
					// for a shell that never got the signal would be a lie.
					return target?.status === "running";
				},
			},
			refreshBackgroundShells: () => {
				refreshes += 1;
			},
			settings: {} as never,
			cwd: process.cwd(),
			costTracker: { state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} } } as never,
			baseRules: [],
			sessionRules: [],
			commands: [],
			compaction: () => ({}) as never,
			mcpConnections: [],
			mcpConfig: {},
			pendingMcpApprovals: [],
			sessionStore: () => undefined,
			theme: { theme: DARK_THEME, available: [DARK_THEME.name], problems: [] },
			hotSwapSession: async () => {},
			switchModel: () => false,
		} as unknown as AppCommandContext;
		return { ctx, infos: () => store.get().entries.map((e) => e.text), killed, refreshes: () => refreshes, picked };
	}

	test("/ps with nothing to show says so and never opens a picker", async () => {
		const t = makeCtx([]);
		expect(handleAppCommand("/ps", t.ctx)).toBe(true);
		await tick();
		expect(t.infos().join("\n")).toContain("No background shells.");
		expect(t.picked).toEqual([]);
	});

	test("/ps prints the tail of the shell that was picked", async () => {
		const t = makeCtx([shell({ id: "shell_1" }), shell({ id: "shell_2", command: "vite" })]);
		handleAppCommand("/ps", t.ctx);
		await tick();
		expect(t.picked.map((p) => p.title)).toEqual(["Background shells"]);
		expect(t.picked[0].labels).toEqual(["shell_1  npm run dev", "shell_2  vite"]);
		// Shell 1 was highlighted and accepted; the output printed is its own.
		expect(t.infos().join("\n")).toContain("shell_1:");
		expect(t.infos().join("\n")).toContain("listening on :3000");
	});

	test("/stop names the shell by number, kills it, and republishes the list", async () => {
		const t = makeCtx([shell({ id: "shell_1" }), shell({ id: "shell_2" })]);
		handleAppCommand("/stop 2", t.ctx);
		await tick();
		expect(t.killed).toEqual(["shell_2"]);
		expect(t.infos().join("\n")).toContain("Stopped shell_2.");
		// The row has to go away without waiting for the next poll.
		expect(t.refreshes()).toBe(1);
	});

	test("/stop on an id nobody has lists the shells instead of guessing", async () => {
		const t = makeCtx([shell({ id: "shell_1" })]);
		handleAppCommand("/stop 9", t.ctx);
		await tick();
		expect(t.killed).toEqual([]);
		expect(t.infos().join("\n")).toContain('No shell "9". /ps lists them.');
	});

	test("/stop on a shell that already ended reports that, rather than a false success", async () => {
		const t = makeCtx([shell({ id: "shell_1", status: "completed", exitCode: 1 })]);
		handleAppCommand("/stop shell_1", t.ctx);
		await tick();
		expect(t.infos().join("\n")).toContain("shell_1 is not running.");
	});

	test("/stop with no argument only offers what is running", async () => {
		const t = makeCtx([shell({ id: "shell_1", status: "completed" }), shell({ id: "shell_2" })]);
		handleAppCommand("/stop", t.ctx);
		await tick();
		expect(t.picked.map((p) => p.title)).toEqual(["Stop a background shell"]);
		// shell_1 already ended, so the only row offered is shell_2: a finished
		// shell in this list would make "stop" a no-op that reads like a success.
		expect(t.picked[0].labels).toEqual(["shell_2  npm run dev"]);
		expect(t.killed).toEqual(["shell_2"]);
	});

	test("/stop with no argument and nothing running says so", async () => {
		const t = makeCtx([]);
		handleAppCommand("/stop", t.ctx);
		await tick();
		expect(t.infos().join("\n")).toContain("No background shells are running.");
		expect(t.picked).toEqual([]);
	});
});
