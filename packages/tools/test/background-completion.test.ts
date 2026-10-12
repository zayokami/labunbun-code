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
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { BackgroundShellManager } from "../src/background.ts";

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
	test("ended shells are kept newest-first, up to sixteen", () => {
		const manager = new BackgroundShellManager();
		const procs = Array.from({ length: 20 }, () => fakeProc());
		const ids = procs.map((proc, index) => adopt(manager, `cmd ${index}`, proc));
		for (const proc of procs) proc.emit("close", 0);

		expect(manager.list()).toHaveLength(16);
		// The dropped four are the oldest — a shell that ended moments ago must
		// not vanish before one from an hour earlier.
		expect(manager.get(ids[0] ?? "")).toBeUndefined();
		expect(manager.get(ids[3] ?? "")).toBeUndefined();
		expect(manager.get(ids[4] ?? "")).toBeDefined();
		expect(manager.get(ids[19] ?? "")).toBeDefined();
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
		// The close lands a moment after the signal. Poll the invariant rather
		// than sleeping a fixed window a loaded machine can outrun.
		for (let i = 0; i < 200 && settled.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
		expect(settled).toEqual(["killed"]);
	}, 10_000);
});
