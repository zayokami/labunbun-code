/**
 * A foreground command that outlives its timeout.
 *
 * The timeout used to be a kill: whatever a build, a test run, or a server had
 * done by second N was lost with the process. Now the call that gave up hands
 * the *running* process to the background manager — the same process, not a
 * restart, because a restart would run the work twice — and the tool's answer
 * says where it went. These tests pin the three edges: the default stayed a
 * kill (a handoff that became unconditional would change what every timeout in
 * an embedder's tool set does), the handed-over process is still alive with its
 * output still landing in the log, and the adopted shell is a first-class one
 * that KillBash stops like any other.
 */
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "../src/background.ts";
import { createBashTool, createKillBashTool } from "../src/bash.ts";
import { ChildProcessExecOperations, defaultOperations } from "../src/operations.ts";

/**
 * The handoff shape the executor promises, spelled out rather than imported.
 *
 * A test that imports the type can only ever run against the code that defines
 * it — and then "the old implementation fails this file" degrades into "the old
 * implementation fails to load this file", which is a red about imports, not
 * about behavior. Spelled locally, these rows run against a call that never
 * hands anything over and fail one claim at a time.
 */
interface Handoff {
	child: ChildProcess;
	killTree: () => void;
	startedAt: number;
	stdout: string;
	stderr: string;
}

/**
 * Prints immediately, then keeps running — output has to survive the handoff.
 *
 * Sequential on Windows (`&&`, not `&`): the backgrounding form is the shape
 * this would naturally be written in, and it is the one shape that failed here
 * — Git Bash's fork of the subshell for `&` hit cygwin's `couldn't create
 * signal pipe` when spawned from the test process, printed nothing, and left
 * the shell in a state a `taskkill` never closed. `echo first && ping` keeps
 * the print-then-wait shape without a subshell.
 */
const SLOW_WITH_OUTPUT =
	process.platform === "win32" ? "echo first && ping -n 5 127.0.0.1" : "echo first; sleep 2; echo second";

/** Runs long enough that only a kill ends it inside a test's lifetime. */
const LONG_RUNNING = process.platform === "win32" ? "ping -n 30 127.0.0.1 > nul" : "sleep 30";

/**
 * How far a wall-clock lower bound may fall short of the nominal window.
 *
 * The clock assertions below ask "did the recorded start happen a full timeout
 * window ago, or at the handoff just now?" — ~600ms against ~0ms. The exact
 * bound is not the property, and the measurement is not exact: CI clocks are
 * quantized (Windows' system timer granularity is coarse) and libuv timers may
 * fire a hair early, so a window that really took 600ms read as 597 on the
 * windows runner and failed a `>= 600`. The tolerance absorbs the
 * measurement's error; the reading a wrong clock produces is nowhere near the
 * bound either way.
 */
const CLOCK_TOLERANCE_MS = 50;

const toolCtx = (cwd: string) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd,
	// The handoff is orthogonal to confinement, and `danger-full-access` keeps
	// every platform's spawn the bare shell — the same process tree the kill
	// path would have targeted, with no wrapper between the timeout and it.
	sandbox: "danger-full-access" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
});

/**
 * Await `promise`, but fail rather than hang: a shell that never ends must not
 * take the run with it, and a promise that never settles does not respect
 * per-test timeouts here. The timer is cleared on the way out so a resolved
 * race does not leave the event loop holding it.
 */
async function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Poll for a condition, bounded: `false` rather than a hang when it never holds. */
async function until(condition: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return condition();
}

/** The shell id out of a tool result's text, or a thrown report of what it said. */
function shellIdOf(text: string): string {
	const id = /shell_\d+/.exec(text)?.[0];
	if (!id) throw new Error(`the result names no shell id: ${text}`);
	return id;
}

describe("exec timeout handoff", () => {
	test("with no adopter the timeout still kills — the default path is unchanged", async () => {
		const ops = new ChildProcessExecOperations();

		const result = await ops.exec({ command: LONG_RUNNING, cwd: process.cwd(), timeoutMs: 400 });

		expect(result.killed).toBe(true);
		expect(result.exitCode).toBe(124);
		expect(result.handedOff).toBeUndefined();
	}, 15_000);

	test("with an adopter the timeout hands the live process over instead of killing it", async () => {
		const ops = new ChildProcessExecOperations();
		const handed: Handoff[] = [];
		const abort = new AbortController();

		const result = await ops.exec({
			command: SLOW_WITH_OUTPUT,
			cwd: process.cwd(),
			timeoutMs: 600,
			signal: abort.signal,
			onTimeout: (handoff) => handed.push(handoff),
		});

		expect(result.handedOff).toBe(true);
		expect(result.killed).toBe(false);
		expect(result.exitCode).toBeNull();

		const handoff = handed[0];
		if (!handoff) throw new Error("the timeout settled without calling onTimeout");
		// A handoff that killed the process reads identically from the promise
		// above; the difference is visible only on the process itself.
		expect(handoff.child.exitCode).toBeNull();
		expect(handoff.child.killed).toBe(false);
		// The clock the adopter shows starts where the command did, not where the
		// wait ended.
		expect(Date.now() - handoff.startedAt).toBeGreaterThanOrEqual(600 - CLOCK_TOLERANCE_MS);

		// An abort after the handoff fires into a listener the handoff removed:
		// whether this process lives is the adopter's call now, and the
		// controller that used to own it no longer reaches it. Without the
		// detach, the kill lands within this window and `exitCode` stops being
		// null — the two hypotheses differ here and nowhere else.
		abort.abort();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(handoff.child.exitCode).toBeNull();

		// The adopter owns the process now: reap it, bounded, so a leaked shell
		// does not outlive the test.
		handoff.killTree();
		await Promise.race([once(handoff.child, "close"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
	}, 15_000);
});

describe("adopt (unit)", () => {
	test("opens the log with what the command had already printed, and takes its exit", () => {
		const manager = new BackgroundShellManager();
		// A fake child: whether a real shell's first chunk races the handoff is up
		// to its startup time, so the buffer-carrying claim needs a row where the
		// buffer is known rather than observed.
		const proc = new EventEmitter() as unknown as ChildProcess;
		const startedAt = Date.now() - 5_000;

		const shell = manager.adopt({
			child: proc,
			command: "sleep 30",
			cwd: "/w/repo",
			startTime: startedAt,
			stdout: "already printed\n",
			stderr: "already complained\n",
		});

		expect(shell.command).toBe("sleep 30");
		expect(shell.startTime).toBe(startedAt);
		expect(shell.status).toBe("running");
		expect(manager.output(shell.id)).toBe("already printed\nalready complained\n");

		manager.append(shell.id, "and one more\n");
		expect(manager.output(shell.id)).toContain("and one more\n");

		proc.emit("close", 7);
		expect(shell.status).toBe("completed");
		expect(shell.exitCode).toBe(7);
		expect(manager.output(shell.id)).toContain("[exit code: 7]");
	});
});

describe("a timed-out Bash call (real spawn)", () => {
	test("moves the command to the background — the same process, still running", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lbb-handoff-"));
		const manager = new BackgroundShellManager();
		const tool = createBashTool(cwd, defaultOperations(), manager);

		const result = await tool.call({ command: SLOW_WITH_OUTPUT, timeout: 600 }, toolCtx(cwd));

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("moved to the background");
		const id = shellIdOf(text);
		expect((result.details as { backgroundShellId?: string } | undefined)?.backgroundShellId).toBe(id);
		const shell = manager.get(id);
		if (!shell) throw new Error(`the result names ${id}, which the manager does not know`);
		expect(shell.status).toBe("running");
		expect(shell.command).toBe(SLOW_WITH_OUTPUT);
		// The shell's clock starts at the spawn, not at the adoption: a poll that
		// showed "0s ago" for a command that had already run for the timeout would
		// be reporting the handoff, and callers read it as the command.
		expect(Date.now() - shell.startTime).toBeGreaterThanOrEqual(600 - CLOCK_TOLERANCE_MS);

		// Output keeps landing after the call returned: the exec listeners still
		// read the pipes, and what they emit is forwarded to the log. Asserted as
		// growth, not by content alone — what had already been printed arrived
		// with the handoff, so a log that already holds `first` proves nothing
		// about what happens next.
		const before = manager.output(id).length;
		const grew = await until(() => manager.output(id).length > before, 8_000);
		expect(grew).toBe(true);

		const code = await withBudget(manager.completed(id), 20_000);
		expect(code).toBe(0);
		expect(manager.output(id)).toContain("first");
		expect(manager.output(id)).toContain("[exit code: 0]");
	}, 25_000);

	test("an adopted shell is a real one: KillBash stops the process tree", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lbb-handoff-"));
		const manager = new BackgroundShellManager();
		const tool = createBashTool(cwd, defaultOperations(), manager);
		const killTool = createKillBashTool(manager);

		const result = await tool.call({ command: LONG_RUNNING, timeout: 500 }, toolCtx(cwd));
		const id = shellIdOf((result.content[0] as { text: string }).text);
		expect(manager.get(id)?.status).toBe("running");

		const killed = await killTool.call({ shell_id: id }, toolCtx(cwd));
		expect((killed.content[0] as { text: string }).text).toContain(`Killed ${id}`);
		expect(manager.get(id)?.status).toBe("killed");
	}, 15_000);

	test("with no manager the timeout still kills — nothing to move the process to", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lbb-handoff-"));
		const tool = createBashTool(cwd, defaultOperations());

		const result = await tool.call({ command: LONG_RUNNING, timeout: 400 }, toolCtx(cwd));

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("[exit code: 124]");
		expect(text).toContain("[command timed out or was killed]");
		expect(result.isError).toBe(true);
	}, 15_000);
});
