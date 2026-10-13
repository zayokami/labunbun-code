/**
 * The shell ledger: what a run writes down, and what the next run reads back.
 *
 * The ledger's whole job is the gap between two processes, so the tests are
 * split the same way. The write side is fed fake events and asserted on what
 * reached the session file — including what deliberately does not, a shell
 * with no pid. The read side is fed session entries and asserted on what comes
 * back: which shells are alive, which have ended, and that a pid reused across
 * generations — start, end, start — comes out as one ended shell and one open
 * one, which is the reason the scan carries state instead of folding maps.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundShell } from "@labunbun/tools";
import {
	attachShellLedger,
	excludeManagedShells,
	formatShellRecovery,
	isRecoveredShell,
	probePid,
	type RecoveredShell,
	readShellLedger,
	recoveredShellOutput,
	SHELL_END_KIND,
	SHELL_START_KIND,
} from "../src/shell-ledger.ts";

/** One `custom` session entry, the shape the ledger writes and reads. */
function custom(kind: string, data: unknown): { type: string; kind: string; data: unknown } {
	return { type: "custom", kind, data };
}

/** A session file stand-in holding exactly these entries. */
function store(entries: Array<{ type: string; kind?: string; data?: unknown }>) {
	return { linearEntries: () => entries };
}

/** A start record with everything filled, as the write side emits it. */
function start(pid: number): Record<string, unknown> {
	return {
		shellId: `shell_${pid}`,
		pid,
		command: "npm run dev",
		cwd: "/w/repo",
		startedAt: 1000,
		outputFile: `/tmp/lbb-shell_${pid}.log`,
	};
}

/** Run `body` with `process.kill` failing with `code`; restored before returning. */
function withKillError(code: string, body: () => void): void {
	const original = process.kill;
	process.kill = () => {
		const error = new Error(`kill failed: ${code}`) as NodeJS.ErrnoException;
		error.code = code;
		throw error;
	};
	try {
		body();
	} finally {
		process.kill = original;
	}
}

/** A tracked shell in the shape the manager's hooks deliver. */
function shell(overrides: Partial<BackgroundShell> & { id: string }): BackgroundShell {
	return {
		command: "npm run dev",
		cwd: "/w/repo",
		outputFile: "/tmp/lbb-shell_1.log",
		startTime: 1000,
		status: "running",
		exitCode: null,
		...overrides,
	};
}

describe("readShellLedger", () => {
	test("a paired shell is an ended one, not an alive one", () => {
		const recovery = readShellLedger(
			store([
				custom(SHELL_START_KIND, start(111)),
				custom(SHELL_END_KIND, { pid: 111, status: "completed", exitCode: 0 }),
			]),
			// The OS is not asked about a pid the ledger already closed out.
			() => true,
		);
		expect(recovery.alive).toEqual([]);
		expect(recovery.ended).toBe(1);
	});

	test("an open shell whose pid answers is alive, in the command layer's shape", () => {
		const recovery = readShellLedger(store([custom(SHELL_START_KIND, start(4242))]), () => true);

		expect(recovery.ended).toBe(0);
		expect(recovery.alive).toHaveLength(1);
		const recovered = recovery.alive[0] as RecoveredShell;
		expect(recovered.id).toBe("pid-4242");
		expect(recovered.pid).toBe(4242);
		expect(recovered.command).toBe("npm run dev");
		expect(recovered.outputFile).toBe("/tmp/lbb-shell_4242.log");
		expect(recovered.startTime).toBe(1000);
		expect(recovered.status).toBe("running");
		// The marker `/ps` and `/stop` branch on: this shell has no handle here.
		expect(isRecoveredShell(recovered)).toBe(true);
	});

	test("an open shell whose pid is gone ended while nobody was listening", () => {
		const recovery = readShellLedger(store([custom(SHELL_START_KIND, start(4242))]), () => false);
		expect(recovery.alive).toEqual([]);
		expect(recovery.ended).toBe(1);
	});

	test("a pid reused across generations pairs in order: one ended, one open", () => {
		const recovery = readShellLedger(
			store([
				custom(SHELL_START_KIND, start(111)),
				custom(SHELL_END_KIND, { pid: 111, status: "killed", exitCode: null }),
				custom(SHELL_START_KIND, start(111)),
			]),
			() => true,
		);
		expect(recovery.ended).toBe(1);
		expect(recovery.alive.map((recovered) => recovered.id)).toEqual(["pid-111"]);
	});

	test("an end with no start pairs with nothing and is dropped", () => {
		const recovery = readShellLedger(
			store([custom(SHELL_END_KIND, { pid: 999, status: "completed", exitCode: 0 })]),
			() => true,
		);
		expect(recovery.alive).toEqual([]);
		expect(recovery.ended).toBe(0);
	});

	test("entries that are not the ledger's, and records without a pid, cost only themselves", () => {
		const recovery = readShellLedger(
			store([
				{ type: "message" },
				custom(SHELL_START_KIND, null),
				custom(SHELL_START_KIND, { pid: "not a number" }),
				custom(SHELL_START_KIND, { pid: -3 }),
				custom(SHELL_END_KIND, {}),
				custom(SHELL_START_KIND, start(77)),
			]),
			() => true,
		);
		expect(recovery.ended).toBe(0);
		expect(recovery.alive.map((recovered) => recovered.id)).toEqual(["pid-77"]);
	});
});

describe("probePid", () => {
	test("this process is alive", () => {
		expect(probePid(process.pid)).toBe(true);
	});

	test("values that cannot be a pid are not alive", () => {
		expect(probePid(0)).toBe(false);
		expect(probePid(-1)).toBe(false);
		expect(probePid(1.5)).toBe(false);
	});

	// The two errno branches, driven by a planted `process.kill`: neither code
	// can be produced on demand from a test — EPERM needs a process the test
	// does not own — and "alive" is the answer that costs nothing to get wrong
	// in the safe direction and a running shell to get wrong in the other.
	test("EPERM is alive — the process is there, just not ours to signal", () => {
		withKillError("EPERM", () => expect(probePid(4)).toBe(true));
	});

	test("ESRCH is not alive", () => {
		withKillError("ESRCH", () => expect(probePid(4)).toBe(false));
	});
});

describe("excludeManagedShells", () => {
	test("a recovered pid this run already tracks is dropped, the ended count is untouched", () => {
		const alive = readShellLedger(
			store([custom(SHELL_START_KIND, start(111)), custom(SHELL_START_KIND, start(222))]),
			() => true,
		).alive;
		const filtered = excludeManagedShells({ alive, ended: 3 }, [111]);
		expect(filtered.alive.map((shell) => shell.id)).toEqual(["pid-222"]);
		// A pid the manager holds is not a shell the previous run left ended —
		// the count is the file's, and the drop is not a quiet ending.
		expect(filtered.ended).toBe(3);
	});

	test("nothing managed changes nothing", () => {
		const alive = readShellLedger(store([custom(SHELL_START_KIND, start(111))]), () => true).alive;
		const filtered = excludeManagedShells({ alive, ended: 0 }, []);
		expect(filtered.alive.map((shell) => shell.id)).toEqual(["pid-111"]);
	});
});

describe("formatShellRecovery", () => {
	test("nothing to say is nothing, not an empty line", () => {
		expect(formatShellRecovery({ alive: [], ended: 0 })).toBeUndefined();
	});

	test("an alive shell is named, with the two commands that act on it", () => {
		const alive = readShellLedger(store([custom(SHELL_START_KIND, start(4242))]), () => true).alive;
		const line = formatShellRecovery({ alive, ended: 0 });
		expect(line).toContain("pid-4242");
		expect(line).toContain("still running");
		expect(line).toContain("/ps");
		expect(line).toContain("/stop");
	});

	test("ended shells are counted, plural or not", () => {
		expect(formatShellRecovery({ alive: [], ended: 1 })).toBe("1 background shell from a previous run has ended.");
		expect(formatShellRecovery({ alive: [], ended: 2 })).toBe("2 background shells from previous runs have ended.");
	});
});

describe("attachShellLedger", () => {
	/** A manager stand-in that hands its two handlers to the test. */
	function hooks() {
		const state: {
			spawned?: (shell: BackgroundShell) => void;
			settled?: (shell: BackgroundShell) => void;
		} = {};
		return {
			state,
			manager: {
				onSpawned(handler: (shell: BackgroundShell) => void) {
					state.spawned = handler;
					return () => {
						state.spawned = undefined;
					};
				},
				onSettled(handler: (shell: BackgroundShell) => void) {
					state.settled = handler;
					return () => {
						state.settled = undefined;
					};
				},
			},
		};
	}

	test("a spawn and its end are written as the file's two kinds", () => {
		const calls: Array<{ kind: string; data: unknown }> = [];
		const session = {
			appendCustom(kind: string, data: unknown) {
				calls.push({ kind, data });
			},
		};
		const { state, manager } = hooks();
		attachShellLedger(manager, () => session);

		state.spawned?.(shell({ id: "shell_1", pid: 4242 }));
		state.settled?.(shell({ id: "shell_1", pid: 4242, status: "killed", exitCode: null }));

		expect(calls).toEqual([
			{
				kind: SHELL_START_KIND,
				data: {
					shellId: "shell_1",
					pid: 4242,
					command: "npm run dev",
					cwd: "/w/repo",
					startedAt: 1000,
					outputFile: "/tmp/lbb-shell_1.log",
				},
			},
			{ kind: SHELL_END_KIND, data: { pid: 4242, status: "killed", exitCode: null } },
		]);
	});

	test("a shell with no pid is not written — half a ledger is worse than a gap", () => {
		const calls: unknown[] = [];
		const session = { appendCustom: (_kind: string, data: unknown) => void calls.push(data) };
		const { state, manager } = hooks();
		attachShellLedger(manager, () => session);

		state.spawned?.(shell({ id: "shell_1" }));
		state.settled?.(shell({ id: "shell_1", status: "completed", exitCode: 0 }));
		expect(calls).toEqual([]);
	});

	test("no session is a quiet no-op, and detaching stops the writing", () => {
		const calls: unknown[] = [];
		let session: { appendCustom(kind: string, data: unknown): void } | undefined;
		const { state, manager } = hooks();
		const detach = attachShellLedger(manager, () => session);

		state.spawned?.(shell({ id: "shell_1", pid: 4242 }));
		expect(calls).toEqual([]);

		session = { appendCustom: (_kind: string, data: unknown) => void calls.push(data) };
		state.spawned?.(shell({ id: "shell_1", pid: 4242 }));
		expect(calls).toHaveLength(1);

		detach();
		state.spawned?.(shell({ id: "shell_2", pid: 4243 }));
		state.settled?.(shell({ id: "shell_2", pid: 4243, status: "killed" }));
		expect(calls).toHaveLength(1);
	});
});

describe("recoveredShellOutput", () => {
	test("the tail of the log the start recorded", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-ledger-"));
		try {
			const log = join(dir, "shell.log");
			writeFileSync(log, "listening on :3000\n");
			const recovered: RecoveredShell = { ...shell({ id: "pid-1", outputFile: log }), pid: 1, recovered: true };
			expect(recoveredShellOutput(recovered)).toBe("listening on :3000\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a log since deleted is said to be gone, not shown as empty", () => {
		const recovered: RecoveredShell = {
			...shell({ id: "pid-1", outputFile: join(tmpdir(), "lbb-never-existed.log") }),
			pid: 1,
			recovered: true,
		};
		expect(recoveredShellOutput(recovered)).toBe("(the log file is gone)");
	});
});

describe("isRecoveredShell", () => {
	test("a this-run shell is not recovered", () => {
		expect(isRecoveredShell(shell({ id: "shell_1" }))).toBe(false);
	});
});
