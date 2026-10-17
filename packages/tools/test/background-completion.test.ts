/**
 * A shell's end of life: who is told, and how long the record is kept.
 *
 * The manager used to end a shell silently — `status` changed, and a caller
 * learned about it by polling. Three things are pinned here. The completion
 * hook fires exactly once, only for shells that ended on their own (a kill is
 * the user's own doing and wakes nobody); the ledger hooks — `onSpawned` and
 * `onSettled` — hear the starts, and every end including the kills, because a
 * record that misses either side of a life cannot be paired; and the retained
 * map stays bounded: a session that starts a watcher per hour should not hold
 * every record it ever made, while a *running* shell's record is never a
 * candidate, because it is the only handle left that can kill the process.
 *
 * The processes here are fake children (an `EventEmitter`), not spawns: what is
 * under test is the record-keeping around the events, and a real shell's start
 * time would make the eviction order a race against the machine.
 */
import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import {
	BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS,
	BACKGROUND_SHELL_MAX_LOG_BYTES,
	BACKGROUND_SHELL_MAX_TIMEOUT_MS,
	BackgroundShellManager,
	isInteractivePromptLine,
	lastNonEmptyLine,
	STALL_AFTER_MS,
	STALL_POLL_MS,
} from "../src/background.ts";
import { EXIT_DRAIN_GRACE_MS } from "../src/operations.ts";

/** A stand-in process: the manager only ever subscribes to it. */
function fakeProc(): EventEmitter {
	return new EventEmitter();
}

/** Register a fake child through the real `adopt` path — that is its own API budget. */
function adopt(manager: BackgroundShellManager, command: string, proc: EventEmitter): string {
	return manager.adopt({
		child: proc as unknown as ChildProcess,
		command,
		cwd: "/w/repo",
		startTime: Date.now(),
		stdout: "",
		stderr: "",
	}).id;
}

describe("completion hook", () => {
	test("a shell that ends on its own is announced once, with its exit code", () => {
		const manager = new BackgroundShellManager();
		const seen: Array<{ id: string; status: string; exitCode: number | null }> = [];
		manager.onComplete((shell) => seen.push({ id: shell.id, status: shell.status, exitCode: shell.exitCode }));

		const proc = fakeProc();
		const id = adopt(manager, "npm run build", proc);
		// Running is not an event: nothing has finished yet.
		expect(seen).toHaveLength(0);

		proc.emit("close", 0);
		expect(seen).toEqual([{ id, status: "completed", exitCode: 0 }]);
	});

	test("a failed spawn is a completion too — 127, announced once even if close follows", () => {
		const manager = new BackgroundShellManager();
		// Captured by value at call time: the record itself keeps changing after
		// the first end event (a following close overwrites the exit code), and
		// these assertions are about what the announcement said.
		const seen: Array<{ status: string; exitCode: number | null }> = [];
		manager.onComplete((shell) => seen.push({ status: shell.status, exitCode: shell.exitCode }));

		const proc = fakeProc();
		adopt(manager, "definitely-not-on-path", proc);

		proc.emit("error", new Error("spawn definitely-not-on-path ENOENT"));
		expect(seen).toEqual([{ status: "completed", exitCode: 127 }]);

		// Whichever order the platform delivers the two end events in, one ended
		// shell is one announcement — the second event only updates the record.
		proc.emit("close", 0);
		expect(seen).toHaveLength(1);
	});

	test("a killed shell says nothing — the user asked it to stop", () => {
		const manager = new BackgroundShellManager();
		let announced = 0;
		manager.onComplete(() => announced++);

		const proc = fakeProc();
		const id = adopt(manager, "sleep 30", proc);
		const shell = manager.get(id);
		if (!shell) throw new Error("adopt returned an id the manager does not know");
		// The state `kill()` leaves on the record before the close arrives —
		// without running a real taskkill against a pid this test made up.
		shell.status = "killed";

		proc.emit("close", null);
		expect(announced).toBe(0);
	});

	test("unsubscribing stops the announcements", () => {
		const manager = new BackgroundShellManager();
		let announced = 0;
		const detach = manager.onComplete(() => announced++);
		detach();

		const proc = fakeProc();
		adopt(manager, "true", proc);
		proc.emit("close", 0);
		expect(announced).toBe(0);
	});
});

describe("kept records", () => {
	test("ended shells are kept newest-first, up to sixteen, and an evicted record's log goes with it", () => {
		const manager = new BackgroundShellManager();
		const procs = Array.from({ length: 20 }, () => fakeProc());
		const ids = procs.map((proc, index) => adopt(manager, `cmd ${index}`, proc));
		const droppedFile = manager.get(ids[0] ?? "")?.outputFile ?? "";
		const keptFile = manager.get(ids[19] ?? "")?.outputFile ?? "";
		for (const proc of procs) proc.emit("close", 0);

		expect(manager.list()).toHaveLength(16);
		// The dropped four are the oldest — a shell that ended moments ago must
		// not vanish before one from an hour earlier.
		expect(manager.get(ids[0] ?? "")).toBeUndefined();
		expect(manager.get(ids[3] ?? "")).toBeUndefined();
		expect(manager.get(ids[4] ?? "")).toBeDefined();
		expect(manager.get(ids[19] ?? "")).toBeDefined();
		// The eviction is about the record and its file together: the temp
		// directory drops the evicted shell's log while a retained record's log
		// stays exactly as readable as `output` promises.
		expect(droppedFile).not.toBe("");
		expect(existsSync(droppedFile)).toBe(false);
		expect(existsSync(keptFile)).toBe(true);
	});

	test("a running shell is never evicted — its record is the only handle left", () => {
		const manager = new BackgroundShellManager();
		const firstEnded: string[] = [];
		for (let i = 0; i < 16; i++) {
			const proc = fakeProc();
			firstEnded.push(adopt(manager, `done ${i}`, proc));
			proc.emit("close", 0);
		}
		const live = [fakeProc(), fakeProc()];
		const liveIds = live.map((proc, i) => adopt(manager, `live ${i}`, proc));

		// One end past the cap evicts exactly one ended record, and it is the
		// oldest ended one — the two live shells are untouched.
		const extra = fakeProc();
		adopt(manager, "done extra", extra);
		extra.emit("close", 0);

		for (const id of liveIds) expect(manager.get(id)).toBeDefined();
		expect(manager.list().filter((shell) => shell.status === "running")).toHaveLength(2);
		expect(manager.get(firstEnded[0] ?? "")).toBeUndefined();
		expect(manager.list()).toHaveLength(18);
	});
});

describe("lifecycle hooks", () => {
	test("a shell announces its start as soon as it is tracked, pid included", () => {
		const manager = new BackgroundShellManager();
		const seen: Array<{ id: string; pid: number | undefined }> = [];
		manager.onSpawned((shell) => seen.push({ id: shell.id, pid: shell.pid }));

		const proc = fakeProc();
		(proc as { pid?: number }).pid = 4242;
		const id = adopt(manager, "npm run dev", proc);

		// Synchronous: the announcement has landed by the time `adopt` returns,
		// which is the contract a writer subscribing after a spawn relies on.
		expect(seen).toEqual([{ id, pid: 4242 }]);
	});

	test("start announcements can be unsubscribed", () => {
		const manager = new BackgroundShellManager();
		let announced = 0;
		const detach = manager.onSpawned(() => announced++);
		detach();

		adopt(manager, "true", fakeProc());
		expect(announced).toBe(0);
	});

	test("onSettled hears kills and completions alike; onComplete stays silent about kills", () => {
		const manager = new BackgroundShellManager();
		const settled: string[] = [];
		let completed = 0;
		manager.onSettled((shell) => settled.push(shell.status));
		manager.onComplete(() => completed++);

		// The state `kill()` leaves on the record before the close arrives.
		const killedProc = fakeProc();
		const killedId = adopt(manager, "sleep 30", killedProc);
		const killedShell = manager.get(killedId);
		if (!killedShell) throw new Error("adopt returned an id the manager does not know");
		killedShell.status = "killed";
		killedProc.emit("close", null);

		const doneProc = fakeProc();
		adopt(manager, "true", doneProc);
		doneProc.emit("close", 0);

		expect(settled).toEqual(["killed", "completed"]);
		expect(completed).toBe(1);
	});

	test("settled announcements can be unsubscribed", () => {
		const manager = new BackgroundShellManager();
		let settled = 0;
		const detach = manager.onSettled(() => settled++);
		detach();

		const proc = fakeProc();
		adopt(manager, "true", proc);
		proc.emit("close", 0);
		expect(settled).toBe(0);
	});

	test("a real kill settles too — the pairing's end for a shell the user stopped", async () => {
		const manager = new BackgroundShellManager();
		const spawned: number[] = [];
		const settled: string[] = [];
		// Registered before the spawn: an end faster than the registration is an
		// end nobody hears about, which for the ledger is exactly the half-pair
		// its write side refuses to write.
		manager.onSpawned((shell) => spawned.push(shell.pid ?? 0));
		manager.onSettled((shell) => settled.push(shell.status));

		// No `> nul`: the win32 shell here is Git Bash, where the redirect is a
		// file named `nul` in the working directory, not the null device.
		const command = process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30";
		const shell = await manager.start(command, process.cwd());
		if (shell.pid === undefined) throw new Error("a real spawn must carry its pid");
		expect(shell.pid).toBeGreaterThan(0);
		expect(spawned).toEqual([shell.pid]);

		expect(manager.kill(shell.id)).toBe(true);
		// The end lands a moment after the signal — a `close` when the pipes
		// drain on schedule, the bounded drain grace when they cannot. Poll the
		// invariant rather than sleeping a fixed window a loaded machine can
		// outrun.
		for (let i = 0; i < 200 && settled.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
		expect(settled).toEqual(["killed"]);
	}, 10_000);

	test("an exit whose close never comes still settles inside the drain grace", async () => {
		const manager = new BackgroundShellManager();
		const settled: string[] = [];
		manager.onSettled((shell) => settled.push(shell.status));

		const proc = fakeProc();
		const id = adopt(manager, "sleep 30", proc);
		const shell = manager.get(id);
		if (!shell) throw new Error("adopt returned an id the manager does not know");
		// The exact shape a Windows kill leaves (see EXIT_DRAIN_GRACE_MS): the
		// record says killed, the process delivers `exit` on schedule, and a
		// half-forked child holding the pipes means `close` never arrives.
		shell.status = "killed";
		proc.emit("exit", 1);

		// The grace is the bound: poll an invariant past it, not a tight window.
		const deadline = Date.now() + EXIT_DRAIN_GRACE_MS + 2_000;
		while (Date.now() < deadline && settled.length === 0) await new Promise((r) => setTimeout(r, 50));
		expect(settled).toEqual(["killed"]);
		expect(manager.get(id)?.exitCode).toBe(1);
		expect(manager.output(id).match(/\[exit code:/g)).toHaveLength(1);

		// A close that limps in after the grace still updates the record — the
		// exit code it always overwrote — but the end is written exactly once.
		proc.emit("close", null);
		expect(settled).toEqual(["killed"]);
		expect(manager.get(id)?.exitCode).toBe(0);
		expect(manager.output(id).match(/\[exit code:/g)).toHaveLength(1);
	}, 10_000);

	test("a close inside the grace settles at once — the grace is a bound, not a delay", () => {
		const manager = new BackgroundShellManager();
		const settled: string[] = [];
		manager.onSettled((shell) => settled.push(shell.status));

		const proc = fakeProc();
		adopt(manager, "echo done", proc);
		proc.emit("exit", 0);
		// Synchronous: a close is the normal end and must not wait out a timer
		// that exists only for the end that never comes.
		proc.emit("close", 0);
		expect(settled).toEqual(["completed"]);
	});

	test("an exit after the spawn error arms no grace — the shell already ended", async () => {
		const manager = new BackgroundShellManager();
		const settled: string[] = [];
		manager.onSettled((shell) => settled.push(shell.status));

		const proc = fakeProc();
		const id = adopt(manager, "definitely-not-on-path", proc);
		proc.emit("error", new Error("spawn definitely-not-on-path ENOENT"));
		expect(settled).toEqual(["completed"]);

		// A spawn that failed has no end left to give: an `exit` after the
		// error must not arm the grace and, moments later, overwrite the record.
		proc.emit("exit", 0);
		await new Promise((r) => setTimeout(r, EXIT_DRAIN_GRACE_MS + 500));
		expect(settled).toEqual(["completed"]);
		expect(manager.get(id)?.exitCode).toBe(127);
	}, 10_000);
});

describe("batched log writes", () => {
	test("a chunk past the flush threshold lands without waiting for the sweep", () => {
		const manager = new BackgroundShellManager();
		const proc = fakeProc();
		const id = adopt(manager, "chatty", proc);
		const file = manager.get(id)?.outputFile ?? "";
		expect(file).not.toBe("");

		// The threshold is 64 KiB; a chunk at it cannot wait for the 100 ms
		// sweep, and the write is synchronous, so the read right behind it sees
		// the bytes. Reading earlier than that would race the timer.
		const big = "x".repeat(64 * 1024);
		manager.append(id, big);
		expect(readFileSync(file, "utf8")).toHaveLength(big.length);

		// Whatever the threshold left buffered is flushed when the shell ends,
		// before the announcements — the exit line included, in order.
		manager.append(id, "tail");
		proc.emit("close", 0);
		expect(readFileSync(file, "utf8")).toBe(`${big}tail\n[exit code: 0]`);
	});
});

/** Poll for a condition, bounded: `false` rather than a hang when it never holds. */
async function until(condition: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return condition();
}

/** A command that runs long enough for only a kill (or a manager cap) to end it inside a test. */
const LONG_RUNNING = process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30";

/**
 * A real child this test owns, for the paths that must reach `kill` —
 * `adopt` keeps the handle, and a fake with a made-up pid would signal a
 * process that may exist on the machine. It prints nothing and reads nothing.
 */
function longChild(): ChildProcess {
	return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
		stdio: ["ignore", "ignore", "ignore"],
		windowsHide: true,
	});
}

/** Wait for a child's end, bounded, so a failed assertion does not leave a process behind. */
async function reap(child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("lifetime cap", () => {
	test("the reference defaults are the documented values", () => {
		expect(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS).toBe(1_800_000);
		expect(BACKGROUND_SHELL_MAX_TIMEOUT_MS).toBe(7_200_000);
		expect(BACKGROUND_SHELL_MAX_LOG_BYTES).toBe(5 * 1024 ** 3);
		expect(STALL_POLL_MS).toBe(5_000);
		expect(STALL_AFTER_MS).toBe(45_000);
	});

	test("a shell is stopped at its lifetime through kill, and the record says why", async () => {
		const terminated: string[] = [];
		const settled: string[] = [];
		const manager = new BackgroundShellManager(undefined, undefined, undefined, {
			// The default above the ceiling is clamped down to it; a small
			// ceiling is the only way to observe the clamp in a test.
			defaultTimeoutMs: 10_000_000,
			maxTimeoutMs: 120,
			onTerminated: (shell) => terminated.push(shell.id),
		});
		manager.onSettled((shell) => settled.push(shell.status));

		const shell = await manager.start(LONG_RUNNING, process.cwd());
		expect(await until(() => manager.get(shell.id)?.status === "killed", 5_000)).toBe(true);
		expect(manager.get(shell.id)?.killReason).toBe("lifetime");
		expect(terminated).toEqual([shell.id]);
		// Through `kill` means the process really ends, and the ordinary settle
		// path — the one that releases a container grant — runs.
		expect(await until(() => settled.length > 0, 10_000)).toBe(true);
		expect(settled).toEqual(["killed"]);
	}, 20_000);

	test("an adopted shell's lifetime counts the time it already ran", async () => {
		const manager = new BackgroundShellManager();
		const child = longChild();
		try {
			const shell = manager.adopt({
				child,
				command: "node -e setTimeout",
				cwd: process.cwd(),
				// 1.8s of the 2s lifetime were spent before the handoff, leaving
				// ~200ms. A lifetime that ignored `startTime` would still be
				// running at the 1.2s deadline.
				startTime: Date.now() - 1_800,
				stdout: "",
				stderr: "",
				timeoutMs: 2_000,
			});
			expect(await until(() => manager.get(shell.id)?.status === "killed", 1_200)).toBe(true);
			expect(manager.get(shell.id)?.killReason).toBe("lifetime");
		} finally {
			await reap(child);
		}
	}, 10_000);

	test("dispose clears a running shell's lifetime timer without killing it", async () => {
		const manager = new BackgroundShellManager();
		const child = longChild();
		try {
			const shell = manager.adopt({
				child,
				command: "node -e setTimeout",
				cwd: process.cwd(),
				startTime: Date.now(),
				stdout: "",
				stderr: "",
				timeoutMs: 120,
			});
			manager.dispose();
			await new Promise((resolve) => setTimeout(resolve, 350));
			expect(manager.get(shell.id)?.status).toBe("running");
			expect(manager.get(shell.id)?.killReason).toBeUndefined();
			expect(manager.kill(shell.id)).toBe(true);
		} finally {
			await reap(child);
		}
	}, 10_000);
});

describe("log cap", () => {
	test("a log past its cap drops the crossing chunk, writes one line, and stops the shell", async () => {
		const terminated: string[] = [];
		const settled: string[] = [];
		const manager = new BackgroundShellManager(undefined, undefined, undefined, {
			maxLogBytes: 128,
			onTerminated: (shell) => terminated.push(shell.id),
		});
		manager.onSettled((shell) => settled.push(shell.status));

		// One burst larger than the cap, then a command that would otherwise
		// run for the whole test.
		const command =
			process.platform === "win32"
				? `echo ${"x".repeat(400)} && ping -n 30 127.0.0.1`
				: `echo ${"x".repeat(400)}; sleep 30`;
		const shell = await manager.start(command, process.cwd());

		expect(await until(() => manager.get(shell.id)?.status === "killed", 5_000)).toBe(true);
		expect(manager.get(shell.id)?.killReason).toBe("log-limit");
		expect(terminated).toEqual([shell.id]);
		expect(await until(() => settled.length > 0, 10_000)).toBe(true);
		expect(settled).toEqual(["killed"]);

		const text = readFileSync(shell.outputFile, "utf8");
		expect(text.match(/\[background log limit reached:/g)).toHaveLength(1);
		// The chunk that would have crossed the cap is dropped whole, and so is
		// everything after it — the exit line included, because the log has
		// already stopped growing on purpose.
		manager.append(shell.id, "late output\n");
		await new Promise((resolve) => setTimeout(resolve, 100));
		const after = readFileSync(shell.outputFile, "utf8");
		expect(after).toBe(text);
		expect(after).not.toContain("late output");
		expect(after).not.toContain("[exit code:");
	}, 20_000);

	test("an adopted shell's opening text counts against the same cap", () => {
		const manager = new BackgroundShellManager(undefined, undefined, undefined, { maxLogBytes: 100 });
		const proc = fakeProc();
		const id = manager.adopt({
			child: proc as unknown as ChildProcess,
			command: "adopted",
			cwd: "/w/repo",
			startTime: Date.now(),
			stdout: "y".repeat(80),
			stderr: "",
		}).id;
		const file = manager.get(id)?.outputFile ?? "";

		// 80 seeded bytes leave 20; this append would cross the cap, so it is
		// dropped whole and the one cap line ends the log.
		manager.append(id, "z".repeat(30));
		const text = readFileSync(file, "utf8");
		expect(text.startsWith("y".repeat(80))).toBe(true);
		expect(text.match(/\[background log limit reached:/g)).toHaveLength(1);
		expect(text).not.toContain("z");

		// One line, once; later chunks stay dropped.
		manager.append(id, "later");
		expect(readFileSync(file, "utf8")).toBe(text);
		// A fake child has no pid, so there is nothing to kill: the record keeps
		// its running status rather than claiming a stop that did not happen.
		expect(manager.get(id)?.status).toBe("running");
		expect(manager.get(id)?.killReason).toBeUndefined();
		manager.dispose();
	});
});

describe("stall watchdog", () => {
	test("the documented prompt list matches its shapes and only its shapes", () => {
		for (const line of [
			"Continue? (y/n)",
			"[Y/N]",
			"(yes/no)",
			"( y / n / a )",
			"Do you want to proceed?",
			"Press any key to continue",
			"press Enter",
			"overwrite y/n",
		]) {
			expect(isInteractivePromptLine(line)).toBe(true);
		}
		for (const line of ["done.", "100% complete", "y/n is a file name", "compiling..."]) {
			expect(isInteractivePromptLine(line)).toBe(false);
		}
		expect(isInteractivePromptLine("   ")).toBe(false);
		expect(lastNonEmptyLine("a\n\n  \n")).toBe("a");
		expect(lastNonEmptyLine("\n \n")).toBeUndefined();
		expect(lastNonEmptyLine("first\r\nsecond\r\n")).toBe("second");
	});

	test("a stalled prompt notifies once, growth resets it, and nothing is killed", async () => {
		const notices: Array<{ id: string; line: string; idleMs: number }> = [];
		const manager = new BackgroundShellManager(undefined, undefined, undefined, {
			stallPollMs: 15,
			stallAfterMs: 60,
			onStalled: (shell, line, idleMs) => notices.push({ id: shell.id, line, idleMs }),
		});
		const proc = fakeProc();
		const id = manager.adopt({
			child: proc as unknown as ChildProcess,
			command: "npm run migrate",
			cwd: "/w/repo",
			startTime: Date.now(),
			stdout: "Proceed with the migration? (y/n)\n",
			stderr: "",
		}).id;

		expect(await until(() => notices.length === 1, 2_000)).toBe(true);
		expect(notices[0]?.id).toBe(id);
		expect(notices[0]?.line).toBe("Proceed with the migration? (y/n)");
		expect(notices[0]?.idleMs).toBeGreaterThanOrEqual(60);
		// Never kills.
		expect(manager.get(id)?.status).toBe("running");

		// Growth is a new episode: the log now ends in ordinary output, so the
		// next quiet window earns no notice.
		manager.append(id, "working...\n");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(notices).toHaveLength(1);

		// A new prompt after growth earns exactly one more notice; one notice
		// per episode means a second quiet window adds nothing.
		manager.append(id, "Overwrite the file? [y/n]\n");
		expect(await until(() => notices.length === 2, 2_000)).toBe(true);
		expect(notices[1]?.line).toBe("Overwrite the file? [y/n]");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(notices).toHaveLength(2);
		expect(manager.get(id)?.status).toBe("running");
		manager.dispose();
	}, 10_000);

	test("a log with no prompt line goes quiet without a notice", async () => {
		let notices = 0;
		const manager = new BackgroundShellManager(undefined, undefined, undefined, {
			stallPollMs: 15,
			stallAfterMs: 60,
			onStalled: () => notices++,
		});
		const proc = fakeProc();
		manager.adopt({
			child: proc as unknown as ChildProcess,
			command: "npm run build",
			cwd: "/w/repo",
			startTime: Date.now(),
			stdout: "building...\n",
			stderr: "",
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(notices).toBe(0);
		manager.dispose();
	});
});
