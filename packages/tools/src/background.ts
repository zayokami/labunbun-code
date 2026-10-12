// Background shell manager: long-running and adopted shells, their logs, and their bound.
// Long-form design notes: docs/dev/tools.md
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "@labunbun/agent";
import { defaultOperations, detectShell, EXIT_DRAIN_GRACE_MS, type ExecOperations } from "./operations.ts";
import { detectRuntime, resolveSandboxExecution, type SandboxRuntime } from "./sandbox/index.ts";

/** How much of a shell's log one read may bring back. */
const MAX_SHELL_OUTPUT_CHARS = 30_000;

/** How many ended shells the manager keeps pollable before evicting the oldest. */
const MAX_RETAINED_SHELLS = 16;

// Long-form design notes: docs/dev/tools.md
/** The last `maxChars` characters of a file, without reading the whole thing. */
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
	/**
	 * The OS process id, when the spawn produced one. Carried on the record
	 * rather than re-read from the ChildProcess so a record that leaves the
	 * manager — one written to the session ledger — keeps the one field a
	 * later run can probe and kill with.
	 */
	pid?: number;
}

// Long-form design notes: docs/dev/tools.md
/**
 * End a process tree by pid, best effort — the same mechanics `kill` gives a
 * tracked shell, for a process no manager here ever held: one a previous run
 * left running, found again through the session ledger. Returns whether an
 * attempt was made; a pid this process can no longer reach is false.
 */
export function killPidTree(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
		killer.on("error", () => {
			// taskkill itself failed to spawn — fall back to the direct signal so
			// the process doesn't linger while we've already reported it killed.
			try {
				process.kill(pid);
			} catch {
				// already gone
			}
		});
		return true;
	}
	try {
		process.kill(pid);
		return true;
	} catch {
		return false;
	}
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
	/** Who to tell when a shell is tracked; see `onSpawned`. */
	readonly #spawnHandlers = new Set<(shell: BackgroundShell) => void>();
	/** Who to tell at every end, kill included; see `onSettled`. */
	readonly #settleHandlers = new Set<(shell: BackgroundShell) => void>();
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
		// Settling on `close` alone can wait on a drain that never finishes:
		// see EXIT_DRAIN_GRACE_MS for the measured shapes — the shell is dead
		// and `exit` fires on schedule while a half-forked child holds the
		// inherited pipes. `exit` starts the same bounded grace the foreground
		// path uses; a `close` inside it is the normal, prompt end and cancels
		// the timer; whichever arrives first writes the end. A late `close`
		// still lands its exit code on the record, as it always did, but adds
		// no second line to the log — one end, one `[exit code]` line.
		let exitLine = false;
		const settle = (code: number | null) => {
			if (entry.info.status !== "killed") entry.info.status = "completed";
			entry.info.exitCode = code ?? 0;
			if (!exitLine) {
				exitLine = true;
				append(`\n[exit code: ${entry.info.exitCode}]`);
			}
			this.#onEnded(entry);
		};
		let exitGrace: ReturnType<typeof setTimeout> | null = null;
		entry.proc.on("exit", (code) => {
			if (entry.endedAt !== undefined) return;
			exitGrace = setTimeout(() => settle(code), EXIT_DRAIN_GRACE_MS);
		});
		entry.proc.on("close", (code) => {
			if (exitGrace) clearTimeout(exitGrace);
			settle(code);
		});
	}

	// Long-form design notes: docs/dev/tools.md
	/** The spawn announcements. A subscriber's bug is not the shell's problem. */
	#onSpawned(info: BackgroundShell): void {
		for (const handler of this.#spawnHandlers) {
			try {
				handler(info);
			} catch {
				// The same stance as the end handlers below.
			}
		}
	}

	// Long-form design notes: docs/dev/tools.md
	/** The first end event a shell reports, and the only one acted on. */
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
		for (const handler of this.#settleHandlers) {
			try {
				handler(entry.info);
			} catch {
				// Same stance again: the record-keeper's bug is not the shell's.
			}
		}
		this.#evictEnded();
	}

	// Long-form design notes: docs/dev/tools.md
	/** Keep the ended shells bounded. */
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
	 * Subscribe to shells the moment they are tracked — the record is in the
	 * map and the process is running. This is where the ledger hears about a
	 * shell, so a later run can find it by pid. Returns the unsubscribe.
	 */
	onSpawned(handler: (shell: BackgroundShell) => void): () => void {
		this.#spawnHandlers.add(handler);
		return () => this.#spawnHandlers.delete(handler);
	}

	/**
	 * Subscribe to every end — completed and killed alike. `onComplete` is the
	 * session-facing announcement and stays silent about kills, which are the
	 * user's own doing; this is the record-keeper's hook, because a ledger fed
	 * only by natural endings would leave every killed shell looking forever
	 * running. Returns the unsubscribe.
	 */
	onSettled(handler: (shell: BackgroundShell) => void): () => void {
		this.#settleHandlers.add(handler);
		return () => this.#settleHandlers.delete(handler);
	}

	// Long-form design notes: docs/dev/tools.md
	/** Start a detached command. */
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
		// The container backend does not serve this path: refuse rather than
		// fall through to the bare shell.
		// Long-form design notes: docs/dev/tools.md
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
			pid: proc.pid,
		};
		const entry: ShellEntry = { info, proc };
		this.#entries.set(id, entry);

		const append = logAppender(outputFile);
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", append);
		proc.stderr?.on("data", append);
		this.#attachExit(entry, append);
		// After the exit wiring, so a shell that dies faster than the caller can
		// look still announces its start before its end — the ledger's pairing
		// needs the start on file whichever way the race goes.
		this.#onSpawned(info);

		return info;
	}

	// Long-form design notes: docs/dev/tools.md
	/** Register a process that was already running — a foreground command that outlived its timeout. */
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
			pid: input.child.pid,
		};
		const entry: ShellEntry = { info, proc: input.child };
		this.#entries.set(id, entry);
		this.#attachExit(entry, logAppender(outputFile));
		this.#onSpawned(info);

		return info;
	}

	get(id: string): BackgroundShell | undefined {
		return this.#entries.get(id)?.info;
	}

	// Long-form design notes: docs/dev/tools.md
	/** Append a chunk to a shell's log. */
	append(id: string, chunk: string): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		logAppender(entry.info.outputFile)(chunk);
	}

	// Long-form design notes: docs/dev/tools.md
	/** Resolve once a shell has ended, with its exit code. */
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

	// Long-form design notes: docs/dev/tools.md
	/** The end of a shell's output so far, at most `maxChars` of it. */
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
		killPidTree(entry.proc.pid);
		entry.info.status = "killed";
		return true;
	}
}
