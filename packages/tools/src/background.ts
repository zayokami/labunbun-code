/**
 * Background shell manager: long-running commands (dev servers, watchers)
 * started by the Bash tool with run_in_background, or adopted by it when a
 * foreground command outlives its timeout. Output streams to a temp file;
 * BashOutput tails it, KillBash terminates the process tree.
 *
 * A shell that finishes on its own is announced through `onComplete`, so an
 * app can be woken instead of polling, and its record stays pollable until the
 * retained set outgrows {@link MAX_RETAINED_SHELLS} — a session that starts a
 * watcher per hour should not accumulate a record per command for the life of
 * the process.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "@labunbun/agent";
import { defaultOperations, detectShell, type ExecOperations } from "./operations.ts";
import { detectRuntime, resolveSandboxExecution, type SandboxRuntime } from "./sandbox/index.ts";

/** How much of a shell's log one read may bring back. */
const MAX_SHELL_OUTPUT_CHARS = 30_000;

/** How many ended shells the manager keeps pollable before evicting the oldest. */
const MAX_RETAINED_SHELLS = 16;

/**
 * The last `maxChars` characters of a file, without reading the whole thing.
 *
 * One character is at most four UTF-8 bytes, so a window of `4 * maxChars`
 * bytes always holds at least that many characters: the last `maxChars` of what
 * it decodes are the last `maxChars` of the file, and everything before them
 * never had to be read. A window that opens in the middle of a character
 * decodes its leftover bytes as a replacement character — at the front of the
 * window, ahead of everything kept, so the text that comes back is a suffix of
 * the file and made of characters the file contains.
 */
export function readTail(path: string, maxChars: number): { text: string; truncated: boolean; bytes: number } {
	const bytes = statSync(path).size;
	const window = Math.min(bytes, maxChars * 4);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(window);
		const read = readSync(fd, buffer, 0, window, bytes - window);
		const text = buffer.subarray(0, read).toString("utf8");
		const tail = text.length > maxChars ? text.slice(-maxChars) : text;
		// Two ways to have lost something: the window did not cover the file, or
		// it did and the characters in it still did not fit.
		return { text: tail, truncated: bytes > window || tail.length < text.length, bytes };
	} finally {
		closeSync(fd);
	}
}

export type ShellStatus = "running" | "completed" | "killed";

export interface BackgroundShell {
	id: string;
	command: string;
	cwd: string;
	outputFile: string;
	startTime: number;
	status: ShellStatus;
	exitCode: number | null;
}

interface ShellEntry {
	info: BackgroundShell;
	proc: ChildProcess;
	/** When the process was seen to end; the eviction key. Unset while running. */
	endedAt?: number;
}

let shellCounter = 0;

/**
 * A best-effort log writer. A shell's output is diagnostic: failing to append a
 * chunk must not take the shell down, and letting the error surface from an
 * event handler would do exactly that — worse than a gap in a log.
 */
function logAppender(outputFile: string): (chunk: Buffer | string) => void {
	return (chunk) => {
		try {
			appendFileSync(outputFile, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		} catch {
			// best-effort logging
		}
	};
}

export class BackgroundShellManager {
	readonly #entries = new Map<string, ShellEntry>();
	/** Who to tell when a shell finishes on its own; see `onComplete`. */
	readonly #exitHandlers = new Set<(shell: BackgroundShell) => void>();
	readonly #shell = detectShell();
	/** Injected for the same reason as `ChildProcessExecOperations`'s: so a test on
	 * one platform can exercise the wrapping branch for another. */
	readonly #runtime: SandboxRuntime;
	/** Whoever owns the proxy lifecycle. Defaults to a real executor so a manager
	 * that confines a network cannot be built without one. */
	readonly #operations: ExecOperations;

	constructor(runtime: SandboxRuntime = detectRuntime(), operations: ExecOperations = defaultOperations()) {
		this.#runtime = runtime;
		this.#operations = operations;
	}

	/**
	 * The completion handlers every shell gets, whichever path started it: mark
	 * the shell ended — unless a kill already did — record the exit code, put
	 * the code in the log, so a reader who only ever saw the file learns how it
	 * ended and not only what it printed along the way, and hand the end to
	 * {@link #onEnded}, which is what announces and bounds it.
	 */
	#attachExit(entry: ShellEntry, append: (chunk: Buffer | string) => void): void {
		entry.proc.on("error", (error) => {
			append(`\n[spawn error: ${error.message}]`);
			if (entry.info.status !== "killed") entry.info.status = "completed";
			entry.info.exitCode = 127;
			this.#onEnded(entry);
		});
		entry.proc.on("close", (code) => {
			if (entry.info.status !== "killed") entry.info.status = "completed";
			entry.info.exitCode = code ?? 0;
			append(`\n[exit code: ${entry.info.exitCode}]`);
			this.#onEnded(entry);
		});
	}

	/**
	 * The first end event a shell reports, and the only one acted on.
	 *
	 * A failed spawn can surface twice — an `error` and, on some platforms, the
	 * `close` behind it — so the stamp decides: whoever arrives first stops the
	 * clock and does the work, and a second event only updates the record. A
	 * killed shell is deliberately not a completion: the user asked for it to
	 * stop, so nothing is woken to say that it did — but its record is still
	 * stamped, because an ended shell is an eviction candidate however it ended.
	 */
	#onEnded(entry: ShellEntry): void {
		if (entry.endedAt !== undefined) return;
		entry.endedAt = Date.now();
		if (entry.info.status === "completed") {
			for (const handler of this.#exitHandlers) {
				try {
					handler(entry.info);
				} catch {
					// A subscriber's bug (a UI, a session) must not take the shell
					// record down with it — the same stance as `AgentSession`'s
					// event dispatch.
				}
			}
		}
		this.#evictEnded();
	}

	/**
	 * Keep the ended shells bounded.
	 *
	 * Every shell stays pollable after it ends — that is what BashOutput reads,
	 * and it is how a caller who missed the announcement catches up — but the
	 * map would otherwise keep a record per command for the life of the process.
	 * Ended shells are kept newest-first up to {@link MAX_RETAINED_SHELLS} and
	 * the oldest beyond that are dropped. A running shell is never a candidate:
	 * its record is the only handle that can still kill it.
	 */
	#evictEnded(): void {
		const ended = [...this.#entries.entries()].filter(([, entry]) => entry.endedAt !== undefined);
		if (ended.length <= MAX_RETAINED_SHELLS) return;
		ended.sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0));
		for (const [id] of ended.slice(0, ended.length - MAX_RETAINED_SHELLS)) {
			this.#entries.delete(id);
		}
	}

	/**
	 * Subscribe to shells that finish on their own — the hook behind "tell me
	 * when it is done" rather than "poll it". A killed shell is not a
	 * completion; see {@link #onEnded}. Called synchronously from the process's
	 * own end event, before any eviction, so the log is still where the
	 * subscriber last saw it. Returns the unsubscribe.
	 */
	onComplete(handler: (shell: BackgroundShell) => void): () => void {
		this.#exitHandlers.add(handler);
		return () => this.#exitHandlers.delete(handler);
	}

	/**
	 * Start a detached command.
	 *
	 * `sandbox` is a parameter rather than something this manager resolves for
	 * itself because it spawns the shell directly instead of going through
	 * `Operations.exec`. That made it a second, unwrapped spawn path: the moment
	 * a filesystem sandbox existed, `run_in_background: true` would have been a
	 * one-word bypass around it, and it would have looked like the sandbox working
	 * for every command a user actually ran in the foreground. The wrapping is
	 * resolved here for the same reason it is in `exec` — the wrapper has to be
	 * the parent of the shell, and this is the parent of the shell.
	 *
	 * The network half of that policy is resolved here too, and that was the
	 * second instance of the same bypass: the wrapper is built from the policy's
	 * filesystem half and the proxy's variables were never added to the spawn,
	 * so a backgrounded command reached the network unconfined while every
	 * foreground command was held by the proxy. `networkRules` is enforced by
	 * the proxy alone — there is no second reading of the domain table — so
	 * dropping those variables dropped the axis.
	 *
	 * Async because resolving them is: starting a listener is not something a
	 * synchronous spawn can do, and making `start` wait is what keeps the two
	 * spawn paths on one lifecycle instead of one listener each.
	 */
	async start(command: string, cwd: string, sandbox?: SandboxPolicy): Promise<BackgroundShell> {
		shellCounter += 1;
		const id = `shell_${shellCounter}`;
		const outputFile = join(tmpdir(), `lbb-${id}.log`);
		writeFileSync(outputFile, "");

		const { command: shellCommand, args } = this.#shell;
		const resolution = sandbox
			? resolveSandboxExecution({
					policy: sandbox,
					command: [shellCommand, ...args(command)],
					platform: this.#runtime.platform,
					hasNativeBackend: this.#runtime.hasNativeBackend,
					hasAppContainer: this.#runtime.hasAppContainer,
				})
			: ({ kind: "unconfined" } as const);
		const [program, ...programArgs] =
			resolution.kind === "native"
				? [resolution.execution.argv[0], ...resolution.execution.argv.slice(1)]
				: [shellCommand, ...args(command)];
		// The container backend does not serve this path, and the branch says so
		// rather than falling through to the bare shell. `bash.ts` named this
		// exact hole when it threaded the policy in — "leaving it out would make
		// `run_in_background: true` the way around the sandbox" — and the
		// container kind makes it real in a way the simulated answer never did:
		// a foreground command under the same session policy would run confined
		// while this one ran with nothing around it.
		//
		// Why not confine it: `runConfined` is a synchronous FFI wait that does
		// not return until the child exits, and a background shell's whole point
		// is a child that outlives the call — a server, a watcher, a test suite
		// that reports progress. Holding this method until the process died
		// would block the session, so the only honest options are confining it
		// through an async rewrite of the spawner or refusing to start it. This
		// build does the second.
		if (resolution.kind === "appcontainer") {
			throw new Error(
				"run_in_background is not available while the Windows container sandbox is in force: a background shell outlives the call that starts it, and this build's confined runner waits for the child to exit. Run the command in the foreground, or turn the sandbox off for this session.",
			);
		}
		// The policy's variables go last, for the reason `exec` puts them last:
		// what confines this command outranks what this process happened to
		// inherit. A manager with no policy spawns with no env of its own, so a
		// session that confines nothing runs with the environment it had.
		const proxyEnv = sandbox ? await this.#operations.networkEnvFor?.(sandbox) : undefined;
		const proc: ChildProcess = spawn(program, programArgs, {
			cwd,
			windowsHide: true,
			env: proxyEnv ? { ...process.env, ...proxyEnv } : process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const info: BackgroundShell = {
			id,
			command,
			cwd,
			outputFile,
			startTime: Date.now(),
			status: "running",
			exitCode: null,
		};
		const entry: ShellEntry = { info, proc };
		this.#entries.set(id, entry);

		const append = logAppender(outputFile);
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", append);
		proc.stderr?.on("data", append);
		this.#attachExit(entry, append);

		return info;
	}

	/**
	 * Register a process that was already running — the shape a foreground
	 * command arrives in when it outlives its timeout and the executor hands it
	 * over rather than killing it.
	 *
	 * Everything the class already offers works on the adopted process from
	 * here: `output` tails the log, `kill` stops the tree, `completed` resolves
	 * with the exit code. The one thing not re-attached is output: the exec
	 * call's own listeners keep reading both pipes — a process caught
	 * mid-stream has no clean point to switch readers without racing one
	 * against the other — and they forward what they read through `append`.
	 * Whatever had been buffered before the handoff is written first, so the
	 * log opens with what the command had already printed.
	 */
	adopt(input: {
		child: ChildProcess;
		command: string;
		cwd: string;
		startTime: number;
		stdout: string;
		stderr: string;
	}): BackgroundShell {
		shellCounter += 1;
		const id = `shell_${shellCounter}`;
		const outputFile = join(tmpdir(), `lbb-${id}.log`);
		writeFileSync(outputFile, input.stdout + input.stderr);

		const info: BackgroundShell = {
			id,
			command: input.command,
			cwd: input.cwd,
			outputFile,
			startTime: input.startTime,
			status: "running",
			exitCode: null,
		};
		const entry: ShellEntry = { info, proc: input.child };
		this.#entries.set(id, entry);
		this.#attachExit(entry, logAppender(outputFile));

		return info;
	}

	get(id: string): BackgroundShell | undefined {
		return this.#entries.get(id)?.info;
	}

	/**
	 * Append a chunk to a shell's log.
	 *
	 * The adopted shell's write path: the exec call that started the process
	 * owns its pipes to the end, so the manager is handed what those listeners
	 * read rather than attaching a second reader to a stream already being read.
	 * An unknown id is ignored — the same best-effort stance as the log write
	 * itself, for a chunk whose process has no other reader to lose it to.
	 */
	append(id: string, chunk: string): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		logAppender(entry.info.outputFile)(chunk);
	}

	/**
	 * Resolve once a shell has ended, with its exit code.
	 *
	 * A caller has no way to learn that a shell finished except by reading
	 * `status`, so the only available technique is polling — and polling means
	 * choosing a budget, which is an assertion about how fast the machine is that
	 * nothing enforces. Measured on macOS CI: a test that waited on
	 * `50 × 100 ms` exhausted the whole budget with the shell still `running` and
	 * failed, while the very next test in the same file, spawning and polling the
	 * same way, passed in 113 ms.
	 *
	 * The process already announces its own end, and `start` installs the handler
	 * that marks the shell `completed` before this can be called, so this hands
	 * that over rather than guessing at it. A shell that has already ended
	 * resolves immediately instead of waiting for an event that already fired.
	 *
	 * A shell that never ends still hangs here, and that is deliberate: the
	 * caller owns the timeout, so a hang fails the caller rather than being read
	 * as a slow machine. An unknown id resolves with `null`, matching `get`.
	 */
	completed(id: string): Promise<number | null> {
		const entry = this.#entries.get(id);
		if (!entry) return Promise.resolve(null);
		if (entry.info.status !== "running") return Promise.resolve(entry.info.exitCode);
		return new Promise((resolve) => {
			entry.proc.once("close", (code) => resolve(entry.info.exitCode ?? code ?? 0));
			// `start`'s own handler marks a spawn that never produced a process
			// completed with 127, so this listens for that too and takes whichever
			// arrives first rather than waiting on a `close` this shell may never
			// reach. Which event Node emits first for a failed spawn is not claimed
			// here — only that this cannot hang on one.
			entry.proc.once("error", () => resolve(entry.info.exitCode));
		});
	}

	list(): BackgroundShell[] {
		return [...this.#entries.values()].map((e) => e.info);
	}

	/**
	 * The end of a shell's output so far, at most `maxChars` of it.
	 *
	 * A shell is polled while it runs, so the log only ever grows: a dev server
	 * left up for an hour would otherwise be read whole — as bytes and again as
	 * a string — to show the last few lines of it, once per poll. The read
	 * starts at an offset instead, and what it skipped is said out loud along
	 * with the path to the whole thing, because a tail is a window on the log
	 * and not the log.
	 */
	output(id: string, maxChars = MAX_SHELL_OUTPUT_CHARS): string {
		const entry = this.#entries.get(id);
		if (!entry || !existsSync(entry.info.outputFile)) return "";
		const tail = readTail(entry.info.outputFile, maxChars);
		const header = tail.truncated
			? `[log tail: last ${tail.text.length} characters of ${tail.bytes} bytes — full log: ${entry.info.outputFile}]\n`
			: "";
		return `${header}${tail.text}`;
	}

	kill(id: string): boolean {
		const entry = this.#entries.get(id);
		if (entry?.info.status !== "running" || !entry.proc.pid) return false;
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(entry.proc.pid), "/T", "/F"], { windowsHide: true });
			killer.on("error", () => {
				// taskkill itself failed to spawn — fall back to the direct signal so
				// the process doesn't linger while we've already reported it killed.
				entry.proc.kill();
			});
		} else {
			entry.proc.kill();
		}
		entry.info.status = "killed";
		return true;
	}
}
