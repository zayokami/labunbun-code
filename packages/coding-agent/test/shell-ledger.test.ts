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
	observeRecoveredShell,
	observeRecoveredShells,
	probePid,
	probePidState,
	type RecoveredShell,
	readShellLedger,
	recoveredShellOutput,
	SHELL_END_KIND,
	SHELL_START_KIND,
	shellStateWord,
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

/** Run `body` with `process.kill` planted as a recording success; restored before returning. */
function withPlantedKill(mark: () => void, body: () => void): void {
	const original = process.kill;
	process.kill = () => {
		mark();
		return true;
	};
	try {
		body();
	} finally {
		process.kill = original;
	}
}

/** A recovered shell in the shape the reader hands one over: alive at read time. */
function recovered(pid: number, overrides: Partial<RecoveredShell> = {}): RecoveredShell {
	return {
		...shell({ id: `pid-${pid}` }),
		pid,
		recovered: true,
		liveness: "running",
		observedAt: 1000,
		...overrides,
	};
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
			() => "alive",
		);
		expect(recovery.alive).toEqual([]);
		expect(recovery.ended).toBe(1);
		expect(recovery.unknown).toEqual([]);
	});

	test("an open shell whose pid answers is alive, in the command layer's shape", () => {
		const before = Date.now();
		const recovery = readShellLedger(store([custom(SHELL_START_KIND, start(4242))]), () => "alive");
		const after = Date.now();

		expect(recovery.ended).toBe(0);
		expect(recovery.unknown).toEqual([]);
		expect(recovery.alive).toHaveLength(1);
		const found = recovery.alive[0] as RecoveredShell;
		expect(found.id).toBe("pid-4242");
		expect(found.pid).toBe(4242);
		expect(found.command).toBe("npm run dev");
		expect(found.outputFile).toBe("/tmp/lbb-shell_4242.log");
		expect(found.startTime).toBe(1000);
		expect(found.status).toBe("running");
		expect(found.liveness).toBe("running");
		// The observation is taken at read time — it is the anchor the age freezes
		// at if the shell is later seen to end.
		expect(found.observedAt).toBeGreaterThanOrEqual(before);
		expect(found.observedAt).toBeLessThanOrEqual(after);
		// The marker `/ps` and `/stop` branch on: this shell has no handle here.
		expect(isRecoveredShell(found)).toBe(true);
	});

	test("an open shell whose pid is gone ended while nobody was listening", () => {
		const recovery = readShellLedger(store([custom(SHELL_START_KIND, start(4242))]), () => "dead");
		expect(recovery.alive).toEqual([]);
		expect(recovery.unknown).toEqual([]);
		expect(recovery.ended).toBe(1);
	});

	test("a probe that cannot answer is reported as unknown — not alive, not counted ended", () => {
		const recovery = readShellLedger(store([custom(SHELL_START_KIND, start(4242))]), () => "unknown");
		expect(recovery.alive).toEqual([]);
		// Not counted among the ended: the probe failed to say it ended, and the
		// count would assert what the probe denied.
		expect(recovery.ended).toBe(0);
		expect(recovery.unknown).toHaveLength(1);
		const found = recovery.unknown[0] as RecoveredShell;
		expect(found.id).toBe("pid-4242");
		expect(found.liveness).toBe("unknown");
	});

	test("a pid reused across generations pairs in order: one ended, one open", () => {
		const recovery = readShellLedger(
			store([
				custom(SHELL_START_KIND, start(111)),
				custom(SHELL_END_KIND, { pid: 111, status: "killed", exitCode: null }),
				custom(SHELL_START_KIND, start(111)),
			]),
			() => "alive",
		);
		expect(recovery.ended).toBe(1);
		expect(recovery.alive.map((entry) => entry.id)).toEqual(["pid-111"]);
	});

	test("an end with no start pairs with nothing and is dropped", () => {
		const recovery = readShellLedger(
			store([custom(SHELL_END_KIND, { pid: 999, status: "completed", exitCode: 0 })]),
			() => "alive",
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
			() => "alive",
		);
		expect(recovery.ended).toBe(0);
		expect(recovery.alive.map((entry) => entry.id)).toEqual(["pid-77"]);
	});
});

describe("probePidState", () => {
	test("this process is alive", () => {
		expect(probePidState(process.pid)).toBe("alive");
	});

	test("values that cannot be a pid are dead, in the terminal sense", () => {
		expect(probePidState(0)).toBe("dead");
		expect(probePidState(-1)).toBe("dead");
		expect(probePidState(1.5)).toBe("dead");
	});

	// The errno branches, driven by a planted `process.kill`: none of these
	// codes can be produced on demand from a test — EPERM needs a process the
	// test does not own — and each answer steers a different report.
	test("EPERM is alive — the process is there, just not ours to signal", () => {
		withKillError("EPERM", () => expect(probePidState(4)).toBe("alive"));
	});

	test("ESRCH is dead — the one answer that is evidence of death", () => {
		withKillError("ESRCH", () => expect(probePidState(4)).toBe("dead"));
	});

	test("a probe that fails for any other reason is unknown, not an ending", () => {
		withKillError("EIO", () => expect(probePidState(4)).toBe("unknown"));
	});
});

describe("probePid", () => {
	// The boolean the reader predates the tri-state with: only an affirmative
	// probe counts — an unanswerable probe is not claimed alive.
	test("only an affirmative probe is true", () => {
		expect(probePid(process.pid)).toBe(true);
		expect(probePid(0)).toBe(false);
		withKillError("EPERM", () => expect(probePid(4)).toBe(true));
		withKillError("ESRCH", () => expect(probePid(4)).toBe(false));
		withKillError("EIO", () => expect(probePid(4)).toBe(false));
	});
});

describe("observeRecoveredShell", () => {
	test("an alive shell is running, and the sighting moves with the clock it was taken at", () => {
		const found = recovered(process.pid);
		expect(observeRecoveredShell(found, 5000)).toBe("running");
		expect(found.liveness).toBe("running");
		expect(found.observedAt).toBe(5000);
		expect(found.status).toBe("running");
	});

	test("EPERM still reads running — the process is there, just not ours to signal", () => {
		const found = recovered(4);
		withKillError("EPERM", () => expect(observeRecoveredShell(found, 5000)).toBe("running"));
		expect(found.liveness).toBe("running");
	});

	test("a dead pid is an ending: ended, completed, and the clock stops there", () => {
		const found = recovered(4);
		withKillError("ESRCH", () => expect(observeRecoveredShell(found, 5000)).toBe("ended"));
		expect(found.liveness).toBe("ended");
		expect(found.status).toBe("completed");
		expect(found.observedAt).toBe(5000);
	});

	test("a probe that cannot answer leaves the shell unknown — not ended, not running", () => {
		const found = recovered(4);
		withKillError("EIO", () => expect(observeRecoveredShell(found, 5000)).toBe("unknown"));
		expect(found.liveness).toBe("unknown");
		expect(found.status).toBe("running");
		expect(found.observedAt).toBe(5000);
	});

	test("unknown settles once evidence arrives: a later dead probe is an ending", () => {
		const found = recovered(4);
		withKillError("EIO", () => expect(observeRecoveredShell(found, 5000)).toBe("unknown"));
		withKillError("ESRCH", () => expect(observeRecoveredShell(found, 6000)).toBe("ended"));
		expect(found.status).toBe("completed");
		expect(found.observedAt).toBe(6000);
	});

	test("ended is terminal: a recycled pid answering later does not revive the shell", () => {
		const found = recovered(4);
		withKillError("ESRCH", () => expect(observeRecoveredShell(found, 5000)).toBe("ended"));
		let probedAgain = false;
		withPlantedKill(
			() => {
				probedAgain = true;
			},
			() => {
				expect(observeRecoveredShell(found, 9000)).toBe("ended");
			},
		);
		// Settled means settled: the shell is not even asked about again, and a
		// pid that answers now is not evidence it is the same shell.
		expect(probedAgain).toBe(false);
		expect(found.liveness).toBe("ended");
		expect(found.observedAt).toBe(5000);
	});
});

describe("observeRecoveredShells", () => {
	test("one clock for the batch, so rows asked about together freeze together", () => {
		const first = recovered(1);
		const second = recovered(2);
		withKillError("ESRCH", () => observeRecoveredShells([first, second], 7777));
		expect(first.observedAt).toBe(7777);
		expect(second.observedAt).toBe(7777);
		expect([first.liveness, second.liveness]).toEqual(["ended", "ended"]);
	});
});

describe("shellStateWord", () => {
	test("a recovered shell says its liveness; a tracked one its status", () => {
		const found = recovered(1, { liveness: "unknown" });
		expect(shellStateWord(found)).toBe("unknown");
		found.liveness = "ended";
		expect(shellStateWord(found)).toBe("ended");
		expect(shellStateWord(shell({ id: "shell_1", status: "killed" }))).toBe("killed");
		expect(shellStateWord(shell({ id: "shell_1", status: "completed" }))).toBe("completed");
	});
});

describe("excludeManagedShells", () => {
	test("a recovered pid this run already tracks is dropped, the ended count is untouched", () => {
		const alive = readShellLedger(
			store([custom(SHELL_START_KIND, start(111)), custom(SHELL_START_KIND, start(222))]),
			() => "alive",
		).alive;
		const filtered = excludeManagedShells({ alive, ended: 3, unknown: [] }, [111]);
		expect(filtered.alive.map((shell) => shell.id)).toEqual(["pid-222"]);
		// A pid the manager holds is not a shell the previous run left ended —
		// the count is the file's, and the drop is not a quiet ending.
		expect(filtered.ended).toBe(3);
	});

	test("a pid the manager tracks drops out of the unknown bucket too", () => {
		const unknown = readShellLedger(store([custom(SHELL_START_KIND, start(333))]), () => "unknown").unknown;
		const filtered = excludeManagedShells({ alive: [], ended: 0, unknown }, [333]);
		expect(filtered.unknown).toEqual([]);
	});

	test("nothing managed changes nothing", () => {
		const alive = readShellLedger(store([custom(SHELL_START_KIND, start(111))]), () => "alive").alive;
		const filtered = excludeManagedShells({ alive, ended: 0, unknown: [] }, []);
		expect(filtered.alive.map((shell) => shell.id)).toEqual(["pid-111"]);
	});
});

describe("formatShellRecovery", () => {
	test("nothing to say is nothing, not an empty line", () => {
		expect(formatShellRecovery({ alive: [], ended: 0, unknown: [] })).toBeUndefined();
	});

	test("an alive shell is named, with the two commands that act on it", () => {
		const alive = readShellLedger(store([custom(SHELL_START_KIND, start(4242))]), () => "alive").alive;
		const line = formatShellRecovery({ alive, ended: 0, unknown: [] });
		expect(line).toContain("pid-4242");
		expect(line).toContain("still running");
		expect(line).toContain("/ps");
		expect(line).toContain("/stop");
	});

	test("an unknown shell is reported as unknown, with the commands that can still look and try", () => {
		const unknown = readShellLedger(store([custom(SHELL_START_KIND, start(4242))]), () => "unknown").unknown;
		expect(formatShellRecovery({ alive: [], ended: 0, unknown })).toBe(
			"1 background shell from a previous run is in an unknown state: pid-4242 — the probe could not say whether it is still running; /ps reads its log, /stop tries to end it.",
		);
	});

	test("unknown shells are counted in the plural too", () => {
		const unknown = readShellLedger(
			store([custom(SHELL_START_KIND, start(1)), custom(SHELL_START_KIND, start(2))]),
			() => "unknown",
		).unknown;
		expect(formatShellRecovery({ alive: [], ended: 0, unknown })).toContain(
			"2 background shells from previous runs are in an unknown state: pid-1, pid-2",
		);
	});

	test("ended shells are counted, plural or not", () => {
		expect(formatShellRecovery({ alive: [], ended: 1, unknown: [] })).toBe(
			"1 background shell from a previous run has ended.",
		);
		expect(formatShellRecovery({ alive: [], ended: 2, unknown: [] })).toBe(
			"2 background shells from previous runs have ended.",
		);
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
			const found = recovered(1, { outputFile: log });
			expect(recoveredShellOutput(found)).toBe("listening on :3000\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a log since deleted is said to be gone, not shown as empty", () => {
		const found = recovered(1, { outputFile: join(tmpdir(), "lbb-never-existed.log") });
		expect(recoveredShellOutput(found)).toBe("(the log file is gone)");
	});
});

describe("isRecoveredShell", () => {
	test("a this-run shell is not recovered", () => {
		expect(isRecoveredShell(shell({ id: "shell_1" }))).toBe(false);
	});
});
