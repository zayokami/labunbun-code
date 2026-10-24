// Background shell manager: long-running and adopted shells, their logs, and their bound.
// Long-form design notes: docs/dev/tools.md
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "@labunbun/agent";
import { defaultOperations, detectShell, EXIT_DRAIN_GRACE_MS, type ExecOperations } from "./operations.ts";
import {
	acquireWorkspaceGrant,
	type ConfinedProcess,
	canonicalPathForChild,
	confinedCommandLine,
	confinedEnvBlock,
	confinedProgramName,
	containerCanExecute,
	containerShellRefusal,
	releaseWorkspaceGrant,
	spawnConfined,
} from "./sandbox/appcontainer.ts";
import { detectRuntime, resolveSandboxExecution, type SandboxRuntime } from "./sandbox/index.ts";
import { feedSeccompFilter, SECCOMP_FD, seccompFilter } from "./sandbox/seccomp.ts";

/** How much of a shell's log one read may bring back. */
const MAX_SHELL_OUTPUT_CHARS = 30_000;

/** How many ended shells the manager keeps pollable before evicting the oldest. */
const MAX_RETAINED_SHELLS = 16;

/**
 * How much buffered output forces a log write before the sweep.
 *
 * A log used to take one synchronous append per chunk — a chatty command paid
 * a syscall on the session's thread for every line it printed. Chunks now land
 * in memory and reach the file in batches: at this threshold immediately, and
 * otherwise on the sweep. The end of a shell always flushes first (see
 * `#onEnded`), so the exit line is on disk before any reader is told the shell
 * ended — the visibility the per-chunk synchronous writer used to give.
 */
const LOG_FLUSH_BYTES = 64 * 1024;

/** How often the sweep turns small buffered chunks into one write. */
const LOG_FLUSH_INTERVAL_MS = 100;

/** How long a killed POSIX shell gets to honour `SIGTERM` before `killPidTree` escalates to `SIGKILL`. */
const KILL_ESCALATE_MS = 250;

/**
 * The lifetime a background shell gets when its caller names none: 30 minutes.
 * A shell is for a build or a watcher, not for a service; one that outlives
 * this is more likely forgotten than still working.
 */
export const BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS = 1_800_000;

/** The longest lifetime a caller may ask for: 2 hours. */
export const BACKGROUND_SHELL_MAX_TIMEOUT_MS = 7_200_000;

/**
 * The hard byte cap for one shell's log: 5 GiB. A command that writes more
 * than this is not producing output a person can read, and the file would
 * otherwise grow for as long as the shell runs. The cap stops both.
 */
export const BACKGROUND_SHELL_MAX_LOG_BYTES = 5 * 1024 ** 3;

/** How often the stall watchdog looks at a running shell's log. */
export const STALL_POLL_MS = 5_000;

/** How long a log may stand still before its last line is checked for a prompt shape. */
export const STALL_AFTER_MS = 45_000;

/** How much of the log's tail the stall check reads — enough for the last line and its neighbours. */
const STALL_TAIL_CHARS = 4_000;

/**
 * The last-line shapes the stall watchdog treats as an interactive prompt.
 *
 * This list is our own and deliberately small; it is not a claim of parity
 * with any other tool's heuristic. A false positive costs one notice and
 * nothing else — the watchdog never kills — and a false negative costs the
 * notice a waiting shell would have earned. Matching is case-insensitive.
 */
const INTERACTIVE_PROMPT_PATTERNS: readonly RegExp[] = [
	// A bracketed choice: (y/n), [yes/no], ( y / n / a ).
	/[[(]\s*(?:y\s*\/\s*n(?:\s*\/\s*a)?|yes\s*\/\s*no)\s*[\])]\s*[?:]?$/i,
	// The same choice without brackets: "continue y/n".
	/\b(?:y\s*\/\s*n|yes\s*\/\s*no)\s*[?:]?$/i,
	// A question, which can carry the choice before it: "Do you want to proceed?".
	/\?\s*$/,
	// A key press or confirmation prompt: "Press any key to continue", "Press Enter".
	/\bpress\s+(?:any\s+key|enter|return)\b/i,
];

/** Whether a line has the shape of a prompt that waits for a person. */
export function isInteractivePromptLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "") return false;
	return INTERACTIVE_PROMPT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** The last non-blank line of a text block, trimmed, or `undefined` when there is none. */
export function lastNonEmptyLine(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trim();
		if (line !== undefined && line !== "") return line;
	}
	return undefined;
}

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

/** Why the manager itself stopped a running shell. A user kill carries no reason. */
export type ShellKillReason = "lifetime" | "log-limit";

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
	/**
	 * Set only when a cap in this manager ended the shell — its lifetime ran
	 * out or its log reached the byte cap. A shell the user killed, or one
	 * that ended on its own, carries no reason.
	 */
	killReason?: ShellKillReason;
}

/**
 * The manager's own bounds and its attention hooks.
 *
 * Every value has a default, so the three-argument constructor keeps working
 * unchanged. The callbacks are how a host hears about the two states that are
 * not completions and not user kills: a shell standing still on what looks
 * like an interactive prompt, and a shell this manager stopped for a cap.
 */
export interface BackgroundShellManagerOptions {
	/** Lifetime a shell gets when its caller names none. Default 30 minutes. */
	defaultTimeoutMs?: number;
	/** The ceiling any requested lifetime is clamped to. Default 2 hours. */
	maxTimeoutMs?: number;
	/** The log's hard byte cap. Default 5 GiB. The crossing chunk is dropped and the shell stopped. */
	maxLogBytes?: number;
	/** How often the stall watchdog samples a running shell's log. Default 5 s. */
	stallPollMs?: number;
	/** How long the log may stand still before its last line is examined. Default 45 s. */
	stallAfterMs?: number;
	/**
	 * Called once per stall episode, when a log has not grown for `stallAfterMs`
	 * and its last non-empty line matches {@link isInteractivePromptLine}. The
	 * shell is left running. The callback's own bugs are contained.
	 */
	onStalled?: (shell: BackgroundShell, line: string, idleMs: number) => void;
	/** Called when one of this manager's caps stopped a shell, after the record says why. */
	onTerminated?: (shell: BackgroundShell) => void;
}

// Long-form design notes: docs/dev/tools.md
/**
 * End a process tree by pid, best effort — the same mechanics `kill` gives a
 * tracked shell, for a process no manager here ever held: one a previous run
 * left running, found again through the session ledger. Resolves true only
 * when the kill was delivered and confirmed; a pid this process cannot reach
 * — or a taskkill that ran and failed — is false, so no caller reports a stop
 * that did not happen.
 */
export async function killPidTree(pid: number): Promise<boolean> {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (process.platform === "win32") {
		// taskkill is the only tree kill Windows has, and its failure used to be
		// silent: the caller heard "attempted" and said "stopped" while the
		// process kept running. Exit 0 is the confirmation; a non-zero exit —
		// not found, access denied — is a kill that did not happen.
		return new Promise<boolean>((resolve) => {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
			killer.on("error", () => {
				// taskkill itself failed to spawn — fall back to the direct signal so
				// the process doesn't linger while we've already reported it killed.
				try {
					process.kill(pid);
					resolve(true);
				} catch {
					resolve(false);
				}
			});
			killer.on("close", (code) => resolve(code === 0));
		});
	}
	try {
		// `SIGTERM` can be caught or ignored, and it reaches the one process —
		// there is no group to signal, because nothing here spawns detached — so
		// a short grace is followed by a `SIGKILL` to the same pid. The hard
		// kill throwing means the pid was already gone: the graceful signal was
		// delivered and did its job, which is still a stop that happened.
		process.kill(pid, "SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, KILL_ESCALATE_MS));
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already dead — the confirmation the escalation was for.
		}
		return true;
	} catch {
		return false;
	}
}

/** The stream surface the manager reads off a shell: whatever a child-like process offers as stdout/stderr. */
interface ShellStream {
	setEncoding(encoding: string): void;
	on(event: "data", listener: (chunk: string | Buffer) => void): void;
}

/**
 * The slice of a child-like process this manager uses. A `ChildProcess` from
 * the plain spawn and the confined runner's handle both satisfy it, which is
 * what lets the one manager take either without a shape in between.
 */
interface ShellProcess {
	readonly pid?: number;
	readonly stdout: ShellStream | null;
	readonly stderr: ShellStream | null;
	on(event: "error", listener: (error: Error) => void): void;
	on(event: "exit" | "close", listener: (code: number | null) => void): void;
	once(event: "error", listener: (error: Error) => void): void;
	once(event: "exit" | "close", listener: (code: number | null) => void): void;
}

interface ShellEntry {
	info: BackgroundShell;
	proc: ShellProcess;
	/** When the process was seen to end; the eviction key. Unset while running. */
	endedAt?: number;
	/** The confined shell's grant release: runs exactly once, at the first end. */
	release?: () => void;
	/** The confined shell's handle-level kill: the backstop behind the pid-tree kill. */
	terminate?: () => void;
	/** Log chunks not yet on disk, and their byte count; see `#append`. */
	pending?: string[];
	pendingBytes?: number;
	/** Bytes accepted into the log so far, seeded for an adopted shell from the text it arrived with. */
	loggedBytes?: number;
	/** Set when the log cap was reached: later chunks are dropped and the one cap line is already written. */
	logCapped?: boolean;
	/** The lifetime timer; cleared at end, eviction, user kill, and disposal. */
	lifetimeTimer?: ReturnType<typeof setTimeout>;
	/** The log size the stall watchdog last saw, after a flush, and when it last changed. */
	stallBytes?: number;
	stallSince?: number;
	/** One notice per stall episode; growth clears it. */
	stallNotified?: boolean;
}

let shellCounter = 0;

// Long-form design notes: docs/dev/tools.md
/**
 * Create the log file for a shell, exclusively and privately.
 *
 * The name used to be `lbb-<id>.log` — predictable from any earlier run — and
 * `writeFileSync` truncates an existing file and follows a symlink to its
 * target, so another local user could pre-plant the path and have the shell's
 * output land on a file of their choosing, or the user's file truncated. The
 * random suffix makes the name unguessable, `wx` refuses anything already at
 * the path, and 0600 keeps a log that can hold anything the command printed
 * to its owner.
 */
function createLogFile(id: string, initial: string): string {
	const outputFile = join(tmpdir(), `lbb-${id}-${randomBytes(8).toString("hex")}.log`);
	writeFileSync(outputFile, initial, { flag: "wx", mode: 0o600 });
	return outputFile;
}

export class BackgroundShellManager {
	readonly #entries = new Map<string, ShellEntry>();
	/** Who to tell when a shell finishes on its own; see `onComplete`. */
	readonly #exitHandlers = new Set<(shell: BackgroundShell) => void>();
	/** Who to tell when a shell is tracked; see `onSpawned`. */
	readonly #spawnHandlers = new Set<(shell: BackgroundShell) => void>();
	/** Who to tell at every end, kill included; see `onSettled`. */
	readonly #settleHandlers = new Set<(shell: BackgroundShell) => void>();
	readonly #shell: ReturnType<typeof detectShell>;
	/** Injected for the same reason as `ChildProcessExecOperations`'s: so a test on
	 * one platform can exercise the wrapping branch for another. */
	readonly #runtime: SandboxRuntime;
	/** Whoever owns the proxy lifecycle. Defaults to a real executor so a manager
	 * that confines a network cannot be built without one. */
	readonly #operations: ExecOperations;
	/** The manager's caps and attention hooks; every field has a default. */
	readonly #defaultTimeoutMs: number;
	readonly #maxTimeoutMs: number;
	readonly #maxLogBytes: number;
	readonly #stallPollMs: number;
	readonly #stallAfterMs: number;
	readonly #onStalled: BackgroundShellManagerOptions["onStalled"];
	readonly #onTerminated: BackgroundShellManagerOptions["onTerminated"];

	constructor(
		// Resolved in the body, not as a default: the default now depends on the
		// shell (the Windows probe runs this session's shell), and a default
		// parameter list cannot see one of its own.
		runtime: SandboxRuntime | undefined = undefined,
		operations: ExecOperations = defaultOperations(),
		// Injected like the runtime: so a test can pin the shell the container
		// branch wraps without depending on what this machine has installed.
		shell: ReturnType<typeof detectShell> = detectShell(),
		// Fourth and optional, so every three-argument construction keeps its
		// meaning. Read once here: a bound that changed under a running timer
		// would make one shell's life depend on when the caller edited settings.
		options: BackgroundShellManagerOptions = {},
	) {
		this.#runtime = runtime ?? detectRuntime(process.platform, shell);
		this.#operations = operations;
		this.#shell = shell;
		this.#defaultTimeoutMs = options.defaultTimeoutMs ?? BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS;
		this.#maxTimeoutMs = options.maxTimeoutMs ?? BACKGROUND_SHELL_MAX_TIMEOUT_MS;
		this.#maxLogBytes = options.maxLogBytes ?? BACKGROUND_SHELL_MAX_LOG_BYTES;
		this.#stallPollMs = options.stallPollMs ?? STALL_POLL_MS;
		this.#stallAfterMs = options.stallAfterMs ?? STALL_AFTER_MS;
		this.#onStalled = options.onStalled;
		this.#onTerminated = options.onTerminated;
	}

	/** The sweep timer, alive only while some entry has buffered output. */
	#sweepTimer: ReturnType<typeof setInterval> | null = null;
	/** The stall watchdog, alive only while a host asked for stall attention and a shell runs. */
	#stallTimer: ReturnType<typeof setInterval> | null = null;

	// Long-form design notes: docs/dev/tools.md
	/**
	 * The write path for every chunk a shell produces — its pipes, an adopted
	 * exec's forwarded chunks, and the manager's own annotations — best-effort,
	 * as it always was: a shell's output is diagnostic, and failing to append a
	 * chunk must not take the shell down. Loose chunks buffer in memory and
	 * reach the file in batches (see LOG_FLUSH_BYTES); a chunk for a shell that
	 * no longer has a record is dropped rather than recreating a log the
	 * eviction just deleted; and a chunk that arrives after the shell ended
	 * writes straight through, so the drain's late output stays ordered behind
	 * the exit line.
	 *
	 * The byte cap is charged here, in bytes and not characters, because the
	 * file grows by UTF-8 bytes. The chunk that would cross the cap is dropped
	 * whole — a half line would be a log that lies about what the command
	 * printed — and from then on every chunk is dropped. `adopt` seeds the
	 * count with the text the log opened with, so an adopted process does not
	 * get a fresh allowance for what it printed before the handoff.
	 */
	#append(entry: ShellEntry, chunk: Buffer | string): void {
		if (!this.#entries.has(entry.info.id)) return;
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (entry.logCapped === true) return;
		const bytes = Buffer.byteLength(text);
		if ((entry.loggedBytes ?? 0) + bytes > this.#maxLogBytes) {
			this.#capLog(entry);
			return;
		}
		entry.loggedBytes = (entry.loggedBytes ?? 0) + bytes;
		if (entry.endedAt !== undefined) {
			try {
				appendFileSync(entry.info.outputFile, text);
			} catch {
				// best-effort logging
			}
			return;
		}
		entry.pending ??= [];
		entry.pending.push(text);
		entry.pendingBytes = (entry.pendingBytes ?? 0) + bytes;
		if (entry.pendingBytes >= LOG_FLUSH_BYTES) {
			this.#flushEntry(entry);
			return;
		}
		if (this.#sweepTimer === null) {
			this.#sweepTimer = setInterval(() => this.#sweep(), LOG_FLUSH_INTERVAL_MS);
			// The same rule as the session's polls: a pending write must not keep
			// the process alive.
			this.#sweepTimer.unref();
		}
	}

	// Long-form design notes: docs/dev/tools.md
	/**
	 * The log cap's one exit. What was already accepted is flushed, the one
	 * notice line goes straight to the file — it is not charged against the cap
	 * it announces — and the shell is stopped through {@link kill}, the only
	 * path that also releases a container grant. Later chunks are dropped by
	 * the `logCapped` guard above.
	 *
	 * The wording promises only what the manager knows: the log stopped
	 * growing. Whether the process behind it stopped is the kill's answer, and
	 * a shell with no pid (a fake, a failed spawn) keeps its running record
	 * rather than a kill that did not happen.
	 */
	#capLog(entry: ShellEntry): void {
		if (entry.logCapped === true) return;
		entry.logCapped = true;
		this.#flushEntry(entry);
		try {
			appendFileSync(
				entry.info.outputFile,
				`\n[background log limit reached: ${this.#maxLogBytes} bytes; later output is dropped]\n`,
			);
		} catch {
			// best-effort logging
		}
		this.#terminateForCap(entry, "log-limit");
	}

	// Long-form design notes: docs/dev/tools.md
	/**
	 * End a running shell for one of the manager's own caps. The stop goes
	 * through {@link kill} and nowhere else: that path runs the pid-tree kill
	 * and the confined handle's own terminate, marks the record killed, and
	 * lets the end event release the container grant before any subscriber
	 * hears of it. A shell this manager cannot reach — no pid — is left with
	 * its running record, and no kill is claimed.
	 */
	#terminateForCap(entry: ShellEntry, reason: ShellKillReason): void {
		if (entry.info.status !== "running") return;
		if (!this.kill(entry.info.id)) return;
		entry.info.killReason = reason;
		if (reason === "lifetime") {
			// The lifetime line goes through the append path like every other
			// annotation, so it lands behind what the command last printed.
			this.#append(entry, "\n[background shell lifetime limit reached; stopped]\n");
		}
		const shell = entry.info;
		if (this.#onTerminated !== undefined) {
			try {
				this.#onTerminated(shell);
			} catch {
				// A subscriber's bug is not the shell's record — the same stance
				// as every other hook here.
			}
		}
	}

	/**
	 * Arm a shell's lifetime. The requested value falls back to the configured
	 * default and is clamped to the configured maximum; an adopted shell has
	 * already spent `alreadyRunMs` of it. `unref` for the same reason as every
	 * timer here: a shell's cap must not keep the process alive.
	 */
	#armLifetime(entry: ShellEntry, requested: number | undefined, alreadyRunMs = 0): void {
		const lifetimeMs = Math.min(Math.max(1, requested ?? this.#defaultTimeoutMs), this.#maxTimeoutMs);
		const remainingMs = Math.max(0, lifetimeMs - Math.max(0, alreadyRunMs));
		entry.lifetimeTimer = setTimeout(() => {
			entry.lifetimeTimer = undefined;
			this.#terminateForCap(entry, "lifetime");
		}, remainingMs);
		entry.lifetimeTimer.unref();
	}

	// Long-form design notes: docs/dev/tools.md
	/**
	 * Start watching a shell for a stall. Growth is measured from the log file,
	 * not from memory, so everything a reader sees is counted; the poll flushes
	 * the batch buffer before it stats, because buffered bytes are not in the
	 * file yet and a busy shell would otherwise read as a quiet one.
	 *
	 * The watch exists only when a host supplied {@link BackgroundShellManagerOptions.onStalled}.
	 * A host with nowhere to put a notice — a `-p` run, an ACP session — pays no
	 * timer at all, which is also why this file's notices cannot appear in
	 * those hosts by accident.
	 */
	#watchStalls(entry: ShellEntry): void {
		if (this.#onStalled === undefined) return;
		entry.stallBytes = entry.loggedBytes ?? 0;
		entry.stallSince = Date.now();
		entry.stallNotified = false;
		if (this.#stallTimer !== null) return;
		this.#stallTimer = setInterval(() => this.#pollStalls(), this.#stallPollMs);
		this.#stallTimer.unref();
	}

	/**
	 * One stall watchdog pass. Growth resets the episode: the idle clock moves,
	 * and the next stall earns its own notice. No growth for `stallAfterMs`
	 * earns a notice only when the last non-empty line looks like a prompt, and
	 * only once per episode. The watchdog never kills — a prompt that waits is
	 * a decision for the person or the model, not a reason to end the shell.
	 */
	#pollStalls(): void {
		const now = Date.now();
		let running = 0;
		for (const entry of this.#entries.values()) {
			if (entry.info.status !== "running") continue;
			running += 1;
			// The batch buffer is not in the file until it is flushed; a stat
			// before this would read a chatty shell as quiet.
			this.#flushEntry(entry);
			let size: number;
			try {
				size = statSync(entry.info.outputFile).size;
			} catch {
				continue;
			}
			if (size !== entry.stallBytes) {
				entry.stallBytes = size;
				entry.stallSince = now;
				entry.stallNotified = false;
				continue;
			}
			if (entry.stallNotified === true) continue;
			const idleSince = entry.stallSince ?? now;
			if (now - idleSince < this.#stallAfterMs) continue;
			const line = this.#lastLogLine(entry);
			if (line === undefined || !isInteractivePromptLine(line)) continue;
			entry.stallNotified = true;
			if (this.#onStalled !== undefined) {
				try {
					this.#onStalled(entry.info, line, now - idleSince);
				} catch {
					// A subscriber's bug must not take the shell down.
				}
			}
		}
		// A watchdog with nothing to watch is a leak; retire it until the next
		// running shell arms it again.
		if (running === 0 && this.#stallTimer !== null) {
			clearInterval(this.#stallTimer);
			this.#stallTimer = null;
		}
	}

	/** The last non-empty line of a shell's log, read from a bounded tail. */
	#lastLogLine(entry: ShellEntry): string | undefined {
		try {
			return lastNonEmptyLine(readTail(entry.info.outputFile, STALL_TAIL_CHARS).text);
		} catch {
			return undefined;
		}
	}

	/** Retire the stall watchdog early when the last running shell has ended. */
	#stopStallWatchIfIdle(): void {
		if (this.#stallTimer === null) return;
		for (const entry of this.#entries.values()) {
			if (entry.info.status === "running") return;
		}
		clearInterval(this.#stallTimer);
		this.#stallTimer = null;
	}

	/** One append of everything buffered, in order. */
	#flushEntry(entry: ShellEntry): void {
		const chunks = entry.pending;
		if (chunks === undefined || chunks.length === 0) return;
		entry.pending = [];
		entry.pendingBytes = 0;
		try {
			appendFileSync(entry.info.outputFile, chunks.join(""));
		} catch {
			// best-effort logging
		}
	}

	/** The sweep: flush every entry with buffered output, and retire the timer when none is left. */
	#sweep(): void {
		let any = false;
		for (const entry of this.#entries.values()) {
			if (entry.pending !== undefined && entry.pending.length > 0) {
				this.#flushEntry(entry);
				any = true;
			}
		}
		if (!any && this.#sweepTimer !== null) {
			clearInterval(this.#sweepTimer);
			this.#sweepTimer = null;
		}
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
		// An ended shell has no lifetime left to enforce. Clearing here is what
		// makes "cleared on shell end" true even when the close and the timer
		// race; the same clear runs at eviction and disposal.
		if (entry.lifetimeTimer !== undefined) {
			clearTimeout(entry.lifetimeTimer);
			entry.lifetimeTimer = undefined;
		}
		// Whatever is still buffered goes to disk before anyone is told, so a
		// subscriber that reads the log in its handler sees the exit line the
		// caller appended just above. Appends after this point write through
		// directly (see `#append`), which keeps late drain output ordered
		// behind it.
		this.#flushEntry(entry);
		// The confined shell's grant comes back before anyone is told the shell
		// ended: a subscriber that immediately starts the next shell must not
		// race the release, and a cleanup warning belongs in the log before a
		// completion reader reads it. Exactly once, be the end a `close`, an
		// `exit`, or a spawn error — the guard above is the once.
		if (entry.release !== undefined) {
			const release = entry.release;
			entry.release = undefined;
			release();
		}
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
		this.#stopStallWatchIfIdle();
	}

	// Long-form design notes: docs/dev/tools.md
	/** Keep the ended shells bounded. */
	#evictEnded(): void {
		const ended = [...this.#entries.entries()].filter(([, entry]) => entry.endedAt !== undefined);
		if (ended.length <= MAX_RETAINED_SHELLS) return;
		ended.sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0));
		for (const [id, entry] of ended.slice(0, ended.length - MAX_RETAINED_SHELLS)) {
			this.#entries.delete(id);
			// Defensive: `#onEnded` is the one place an ended entry's timer is
			// cleared, and this loop only sees ended entries. A timer that
			// somehow survived would fire into a record no longer in the map.
			if (entry.lifetimeTimer !== undefined) {
				clearTimeout(entry.lifetimeTimer);
				entry.lifetimeTimer = undefined;
			}
			// The file goes with the record: once the id no longer resolves, the
			// path inside `info` is out of every reader's reach — `output` guards
			// on the map — so keeping the file would only pile up one log per
			// shell per session in the temp directory forever. Best-effort, like
			// the writes, and after the delete so a racing late chunk is already
			// being dropped rather than recreating the file.
			this.#flushEntry(entry);
			try {
				rmSync(entry.info.outputFile, { force: true });
			} catch {
				// best-effort: a log left behind is not worth a crash
			}
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
	/**
	 * Start a detached command.
	 *
	 * `timeoutMs` is the shell's lifetime: it falls back to the manager's
	 * default (30 minutes) and is clamped to its maximum (2 hours). On expiry
	 * the shell is stopped through {@link kill}, so a confined shell's grant is
	 * released by the same end path a user kill uses, and the record carries
	 * `killReason: "lifetime"`.
	 */
	async start(command: string, cwd: string, sandbox?: SandboxPolicy, timeoutMs?: number): Promise<BackgroundShell> {
		shellCounter += 1;
		const id = `shell_${shellCounter}`;
		const outputFile = createLogFile(id, "");
		// Declared here, assigned below: the append path buffers on the entry,
		// and the container branch builds its cleanup line before the entry
		// literal exists. Every call reaches the closure after assignment — the
		// pipes are wired and `release` runs only once the entry is in the map.
		let entry: ShellEntry;
		const append = (chunk: Buffer | string): void => this.#append(entry, chunk);

		const { command: shellCommand, args } = this.#shell;
		// The wrapper must name the enforcing proxy's own route before the argv
		// is built — the macOS profile its ports, the bwrap one its bridge — the
		// same order, and the same reason, as the foreground path documents — so
		// the running listener is asked for them first. A manager with no policy,
		// or an operations bundle from before these methods existed, asks for
		// nothing and gets the dead-network shape.
		const networkPorts = sandbox ? await this.#operations.networkPortsFor?.(sandbox) : undefined;
		const networkBridge = sandbox ? await this.#operations.networkBridgeFor?.(sandbox) : undefined;
		// Same filter, same descriptor, same pipe as the foreground path: a
		// background shell outlives the call but not the policy, so it carries
		// the syscall boundary too.
		const seccomp =
			sandbox !== undefined && this.#runtime.platform === "linux" ? seccompFilter(process.arch) : undefined;
		const resolution = sandbox
			? resolveSandboxExecution({
					policy: sandbox,
					command: [shellCommand, ...args(command)],
					platform: this.#runtime.platform,
					hasNativeBackend: this.#runtime.hasNativeBackend,
					hasAppContainer: this.#runtime.hasAppContainer,
					appContainerReason: this.#runtime.appContainerReason,
					executableRoots: this.#runtime.executableRoots,
					networkPorts,
					networkBridge,
					seccompFd: seccomp === undefined ? undefined : SECCOMP_FD,
				})
			: ({ kind: "unconfined" } as const);
		// Refused the way the container refusal below is: thrown, so the caller reports it as a tool error and
		// the command never starts. A read-only policy with no wrapper to place has nothing to run under.
		if (resolution.kind === "refused") {
			throw new Error(resolution.reason);
		}
		// The shell has to be executable inside the container, and that check is
		// lexical — the resolved path against System32 and the granted roots — so
		// it refuses here, before any side effect, with the sentence the
		// foreground path uses. The resolved name serves the spawn below too.
		const shellProgram = confinedProgramName(shellCommand);
		if (
			resolution.kind === "appcontainer" &&
			!containerCanExecute(shellProgram, [...resolution.grantRoots, ...resolution.executableRoots])
		) {
			throw new Error(containerShellRefusal(shellProgram));
		}
		// The policy's variables go last, for the reason `exec` puts them last:
		// what confines this command outranks what this process happened to
		// inherit. A manager with no policy spawns with no env of its own, so a
		// session that confines nothing runs with the environment it had. For the
		// container branch it is computed before the grant is acquired — a proxy
		// failure must not strand an acquired grant — and folded into the env
		// block below.
		const proxyEnv = sandbox ? await this.#operations.networkEnvFor?.(sandbox) : undefined;
		let proc: ChildProcess | ConfinedProcess;
		let release: (() => void) | undefined;
		let terminate: (() => void) | undefined;
		// Long-form design notes: docs/dev/tools.md
		if (resolution.kind === "appcontainer") {
			const grant = acquireWorkspaceGrant(
				resolution.workspace,
				resolution.network,
				resolution.grantRoots.slice(1),
				resolution.executableRoots,
				resolution.protectedRoots,
			);
			if (grant.error !== undefined || grant.profile === undefined) {
				// Fail closed and legibly, as the foreground path does: no grant
				// means the child could not touch the workspace at all.
				throw new Error(grant.error ?? "the container profile could not be established");
			}
			// The child's environment: the parent's, the policy's variables, and
			// the block format `CreateProcessW` demands — the `undefined`
			// pseudo-variables of `process.env` dropped, the same value `exec`
			// feeds its env block.
			const confinedEnv = Object.fromEntries(
				Object.entries({ ...process.env, ...proxyEnv }).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			);
			// The child's cwd, spelled the one way every reader agrees on — the
			// same canonicalisation the grant roots get, for the same measured
			// reason the foreground path documents.
			const spawned = spawnConfined(grant.profile, confinedCommandLine([shellProgram, ...args(command)]), {
				cwd: canonicalPathForChild(cwd),
				env: confinedEnvBlock(confinedEnv),
			});
			if ("error" in spawned) {
				// The grant was acquired for this spawn, and there is no shell
				// whose end could release it — it comes back here, and a failed
				// cleanup rides in the thrown message rather than vanishing.
				const dropError = releaseWorkspaceGrant(resolution.workspace, resolution.network);
				const cleanup = dropError !== null && dropError !== "" ? ` [sandbox cleanup: ${dropError}]` : "";
				throw new Error(`${spawned.error}${cleanup}`);
			}
			proc = spawned;
			release = () => {
				const dropError = releaseWorkspaceGrant(resolution.workspace, resolution.network);
				// A failed cleanup is logged, not thrown: the shell already ran
				// and its exit code is what the caller acts on.
				if (dropError !== null && dropError !== "") append(`\n[sandbox cleanup: ${dropError}]`);
			};
			terminate = () => spawned.kill();
		} else {
			const [program, ...programArgs] =
				resolution.kind === "native"
					? [resolution.execution.argv[0], ...resolution.execution.argv.slice(1)]
					: [shellCommand, ...args(command)];
			// Only the native branch's argv names fd 3, for the reason the
			// foreground spawn gives.
			const seccompProgram = resolution.kind === "native" ? seccomp : undefined;
			proc = spawn(program, programArgs, {
				cwd,
				windowsHide: true,
				env: proxyEnv ? { ...process.env, ...proxyEnv } : process.env,
				stdio: seccompProgram === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "pipe"],
			});
			if (seccompProgram !== undefined && !feedSeccompFilter(proc, seccompProgram)) {
				// A shell that could not receive the promised filter is ended, not
				// left running behind an argv that describes a boundary it lacks.
				proc.kill("SIGKILL");
			}
		}

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
		entry = { info, proc };
		if (release !== undefined) entry.release = release;
		if (terminate !== undefined) entry.terminate = terminate;
		this.#entries.set(id, entry);
		// Timers arm only once the entry is in the map: a lifetime that fired
		// before registration would reach `kill` after its own record was gone.
		this.#armLifetime(entry, timeoutMs);
		this.#watchStalls(entry);

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
	/**
	 * Register a process that was already running — a foreground command that
	 * outlived its timeout.
	 *
	 * `timeoutMs` is a lifetime measured from the original spawn, not from the
	 * adoption: the time the process already ran comes off the budget, so a
	 * command handed over near the end of its life is not granted a fresh one.
	 * The log's own counter is seeded with the text it opens with, for the same
	 * reason: an adopted shell's output before the handoff counts against its
	 * byte cap.
	 */
	adopt(input: {
		child: ChildProcess;
		command: string;
		cwd: string;
		startTime: number;
		stdout: string;
		stderr: string;
		timeoutMs?: number;
	}): BackgroundShell {
		shellCounter += 1;
		const id = `shell_${shellCounter}`;
		const initial = input.stdout + input.stderr;
		const outputFile = createLogFile(id, initial);

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
		const entry: ShellEntry = { info, proc: input.child, loggedBytes: Buffer.byteLength(initial) };
		this.#entries.set(id, entry);
		this.#armLifetime(entry, input.timeoutMs, Date.now() - input.startTime);
		this.#watchStalls(entry);
		this.#attachExit(entry, (chunk) => this.#append(entry, chunk));
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
		this.#append(entry, chunk);
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
		if (!entry) return "";
		// A read settles the buffer: batching may delay bytes on disk, but never
		// past the next read, so every caller that appends and then reads back
		// (the adopted-shell handoff does exactly that) sees what it wrote.
		this.#flushEntry(entry);
		if (!existsSync(entry.info.outputFile)) return "";
		const tail = readTail(entry.info.outputFile, maxChars);
		const header = tail.truncated
			? `[log tail: last ${tail.text.length} characters of ${tail.bytes} bytes — full log: ${entry.info.outputFile}]\n`
			: "";
		return `${header}${tail.text}`;
	}

	kill(id: string): boolean {
		const entry = this.#entries.get(id);
		if (entry?.info.status !== "running" || !entry.proc.pid) return false;
		// A user kill ends the lifetime question now, not when the close event
		// eventually arrives: a shell that ignores its stop must not later be
		// "terminated" by a cap we already acted on.
		if (entry.lifetimeTimer !== undefined) {
			clearTimeout(entry.lifetimeTimer);
			entry.lifetimeTimer = undefined;
		}
		// Fire-and-forget: for a shell in hand the end is confirmed by the
		// process's own close event, which settles the record and the ledger.
		// Only a pid with no handle left to watch needs the awaited exit code.
		void killPidTree(entry.proc.pid);
		// Plus the handle-level stop for a confined shell — the backstop behind
		// the pid-tree kill: taskkill races the child's own end, the handle
		// this manager holds does not.
		entry.terminate?.();
		entry.info.status = "killed";
		return true;
	}

	/**
	 * Stop this manager's own timers: every shell's lifetime, the log sweep, and
	 * the stall watchdog. Running shells are left running — ending them is a
	 * decision, and a host that wants it calls {@link kill} or disposes after a
	 * stop. A disposed manager still accepts new shells; their timers arm as
	 * usual. Exists for tests and shutdown paths that must not leave a timer
	 * behind.
	 */
	dispose(): void {
		for (const entry of this.#entries.values()) {
			if (entry.lifetimeTimer !== undefined) {
				clearTimeout(entry.lifetimeTimer);
				entry.lifetimeTimer = undefined;
			}
		}
		if (this.#sweepTimer !== null) {
			clearInterval(this.#sweepTimer);
			this.#sweepTimer = null;
		}
		if (this.#stallTimer !== null) {
			clearInterval(this.#stallTimer);
			this.#stallTimer = null;
		}
	}
}
