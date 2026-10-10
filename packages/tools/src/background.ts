// Background shell manager: long-running and adopted shells, their logs, and their bound.
// Long-form design notes: docs/dev/tools.md
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
		};
		const entry: ShellEntry = { info, proc: input.child };
		this.#entries.set(id, entry);
		this.#attachExit(entry, logAppender(outputFile));

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
