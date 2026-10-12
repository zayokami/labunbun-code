/**
 * `/tasks` is the whole picture: the root row, then a branch per subagent and
 * shell. The row shapes are the two listings' own, so what is under test here
 * is the tree's own decisions -- what the root says, where the branch marks
 * land, which family goes first, and the mark that explains a recovered
 * shell's pid-shaped id to someone who never started it in this run.
 */
import { describe, expect, test } from "bun:test";
import type { BackgroundShell } from "@labunbun/tools";
import type { RecoveredShell } from "../src/shell-ledger.ts";
import type { SubagentHandle } from "../src/subagent-registry.ts";
import { formatTaskTree } from "../src/task-tree.ts";

const NOW = 1_700_000_000_000;

function handle(overrides: Partial<SubagentHandle> = {}): SubagentHandle {
	return {
		sidechainId: "sidechain-42-abcd",
		agentType: "general-purpose",
		title: "Fix the flaky test",
		prompt: "Fix the flaky test",
		startedAt: NOW - 12_000,
		endedAt: 0,
		pendingAsks: 0,
		state: "live",
		session: {} as never,
		notes: [],
		...overrides,
	};
}

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

function recovered(overrides: Partial<RecoveredShell> = {}): RecoveredShell {
	return {
		...shell({ id: "pid-1234", startTime: NOW - 12 * 60_000 }),
		pid: 1234,
		recovered: true,
		...overrides,
	};
}

/** The frame's whitespace is not what is under test; alignment has its own test. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

describe("formatTaskTree", () => {
	test("a quiet session says so on the one branch there is", () => {
		const lines = formatTaskTree({ mainRunning: false, subagents: [], shells: [], now: NOW }).split("\n");
		expect(lines).toEqual(["main  idle", "└─ (no subagents or background shells this session)"]);
	});

	test("the root row says what the session is doing, and nothing more", () => {
		expect(formatTaskTree({ mainRunning: true, subagents: [], shells: [], now: NOW }).split("\n")[0]).toBe(
			"main  running",
		);
	});

	test("a subagent branch carries the listing's row behind a branch mark", () => {
		const lines = formatTaskTree({ mainRunning: true, subagents: [handle()], shells: [], now: NOW }).split("\n");
		expect(lines).toHaveLength(2);
		expect(flat(lines[1] ?? "")).toBe("└─ agent running general-purpose 12s Fix the flaky test (sidechain-42-abcd)");
	});

	test("a waiting row says waiting — that is the state a person is stuck on", () => {
		const lines = formatTaskTree({
			mainRunning: true,
			subagents: [handle({ pendingAsks: 1 })],
			shells: [],
			now: NOW,
		}).split("\n");
		expect(flat(lines[1] ?? "")).toContain("waiting");
	});

	test("a shell branch reads like the picker's row, with the id /stop takes", () => {
		const lines = formatTaskTree({ mainRunning: false, subagents: [], shells: [shell()], now: NOW }).split("\n");
		expect(flat(lines[1] ?? "")).toBe("└─ shell running 0s npm run dev (shell_1)");
	});

	test("a recovered shell is marked as from a previous run, beside the pid that names it", () => {
		const lines = formatTaskTree({ mainRunning: false, subagents: [], shells: [recovered()], now: NOW }).split("\n");
		expect(flat(lines[1] ?? "")).toBe("└─ shell running 12m npm run dev (pid-1234, from a previous run)");
	});

	test("every branch but the last wears ├─, the last wears └─", () => {
		const lines = formatTaskTree({
			mainRunning: false,
			subagents: [handle({ sidechainId: "s-1" }), handle({ sidechainId: "s-2", startedAt: NOW - 5_000 })],
			shells: [shell()],
			now: NOW,
		}).split("\n");
		expect(lines.slice(1).map((line) => line.slice(0, 2))).toEqual(["├─", "├─", "└─"]);
	});

	test("the subagent family comes first, in the listing's own order", () => {
		const old = handle({ sidechainId: "s-old", title: "Old" });
		const recent = handle({ sidechainId: "s-recent", title: "Recent", startedAt: NOW - 5_000 });
		// Input scrambled on purpose: the tree runs subagents through the
		// listing's ordering (live oldest-first) and keeps them above the shells.
		const lines = formatTaskTree({
			mainRunning: false,
			subagents: [recent, old],
			shells: [shell()],
			now: NOW,
		}).split("\n");
		expect(flat(lines[1] ?? "")).toContain("s-old");
		expect(flat(lines[2] ?? "")).toContain("s-recent");
		expect(flat(lines[3] ?? "")).toContain("shell_1");
	});

	test("ended rows stay on — a failed run is a state of the schedule, not a deletion", () => {
		const failed = handle({
			sidechainId: "s-bad",
			state: "finished",
			endReason: "error",
			finishedAt: NOW - 2_000,
			endedAt: 1,
		});
		const dead = shell({ id: "shell_2", status: "killed" });
		const lines = formatTaskTree({ mainRunning: false, subagents: [failed], shells: [dead], now: NOW }).split("\n");
		expect(flat(lines[1] ?? "")).toContain("failed");
		expect(flat(lines[2] ?? "")).toContain("killed");
	});

	test("the columns line up across the two families, so the tree reads as one wall", () => {
		const rows = formatTaskTree({
			mainRunning: true,
			subagents: [handle({ agentType: "general-purpose" })],
			shells: [shell()],
			now: NOW,
		}).split("\n");
		// The status column starts at the same offset on an agent row and a
		// shell row; the kind word before it is what a reader scans for.
		const statusAt = (line: string) => line.indexOf("running");
		expect(statusAt(rows[1] ?? "")).toBe(statusAt(rows[2] ?? ""));
		expect(statusAt(rows[1] ?? "")).toBeGreaterThan(0);
	});

	test("status words of different lengths still hold the column — the pad, not luck", () => {
		// `failed` is six characters and `completed` is nine: only the width pad
		// keeps the title column from drifting between the two rows.
		const rows = formatTaskTree({
			mainRunning: false,
			subagents: [
				handle({ sidechainId: "s-bad", title: "Same title", state: "finished", endReason: "error", endedAt: 1 }),
				handle({
					sidechainId: "s-ok",
					title: "Same title",
					state: "finished",
					endReason: "completed",
					endedAt: 1,
				}),
			],
			shells: [],
			now: NOW,
		}).split("\n");
		const titleAt = (line: string) => line.indexOf("Same title");
		const failedRow = rows.find((line) => line.includes("failed")) ?? "";
		const completedRow = rows.find((line) => line.includes("completed")) ?? "";
		expect(titleAt(failedRow)).toBeGreaterThan(0);
		expect(titleAt(failedRow)).toBe(titleAt(completedRow));
	});
});
