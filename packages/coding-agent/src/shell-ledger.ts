/**
 * The background shells of previous runs, told apart from this run's.
 *
 * A shell started with `run_in_background` outlives the process that started
 * it -- that is the point of it -- so the session it belongs to can lose track
 * of it entirely: quit, resume, and the shells are running on with nobody who
 * knows their names. The session file is the one thing that survives both
 * sides of that gap, so the shells are recorded there: a `shell_start` when
 * one is tracked, a `shell_end` when it ends. This module is the two ends of
 * that record -- the writer the manager feeds, and the reader a later run
 * starts from.
 *
 * The pairing key is the process id, not the shell id. Shell ids (`shell_1`,
 * `shell_2`) are handed out by a counter that lives and dies with the process,
 * so the next run's `shell_1` is a different shell wearing the same name, and
 * the output file follows the shell id -- a new `shell_1` overwrites the old
 * log. The pid is the one value that keeps meaning the same thing across the
 * gap, and it is also the only value that can be asked whether the process is
 * still there, which is the question this module exists to answer.
 *
 * Everything here is best effort. A shell the ledger failed to record is a
 * shell the next run cannot find -- but a shell whose record cost the session
 * its start would be worse, so the write side never lets a failure of its own
 * take anything else down. The read side is defensive the same way: the file
 * is append-only and written line by line, and a line that does not parse
 * costs only itself.
 */
import { type BackgroundShell, readTail } from "@labunbun/tools";

/** The session-file kind of a shell's start; see the module header for why. */
export const SHELL_START_KIND = "shell_start";
/** The session-file kind of a shell's end — a completion and a kill alike. */
export const SHELL_END_KIND = "shell_end";

/** How much of a recovered shell's log one read brings back; the manager's own window. */
const RECOVERED_OUTPUT_CHARS = 30_000;

/** What a start records. The pid is the identity; the rest is for whoever reads the file. */
export interface ShellStartRecord {
	shellId: string;
	pid: number;
	command: string;
	cwd: string;
	startedAt: number;
	outputFile: string;
}

/**
 * What an end records. The pid is what pairs it with its start; the status and
 * exit code are not read by anything here — a paired end is only a count — but
 * they are the difference between "it ended" and "it ended with this", and the
 * file is readable by eye.
 */
export interface ShellEndRecord {
	pid: number;
	status: "completed" | "killed";
	exitCode: number | null;
}

/**
 * A shell from an earlier run that is still running, in the shape the command
 * layer already handles: `/ps` and `/stop` take a `BackgroundShell` and the
 * picker and resolver are pure over them, so wearing the same interface is
 * what lets the recovered shells ride those paths with no branch of their own
 * except where acting on one needs a pid instead of a handle.
 */
export interface RecoveredShell extends BackgroundShell {
	pid: number;
	recovered: true;
}

/** Whether a shell came from the ledger rather than from this run's manager. */
export function isRecoveredShell(shell: BackgroundShell): shell is RecoveredShell {
	return (shell as { recovered?: unknown }).recovered === true;
}

/** What a resume finds in the ledger. */
export interface ShellRecovery {
	/** Started, never seen to end, and the pid still answers: what `/stop` can stop and `/ps` can read. */
	alive: RecoveredShell[];
	/** Started and no longer running — ended on the ledger, or ended without one. The number is all there is to say. */
	ended: number;
}

/**
 * Whether a pid names a live process.
 *
 * EPERM counts as alive: it means the process is there and simply not ours to
 * signal, and "it is still running" is the truthful answer — the other way
 * would report a running shell as gone because of who owns it.
 */
export function probePid(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The one shape this module reads out of the session file: a `custom` entry and its payload. */
interface LedgerEntry {
	type: string;
	kind?: string;
	data?: unknown;
}

/** Where the writer writes. A `SessionStore` satisfies this; so does a stub. */
export interface ShellLedgerSession {
	appendCustom(kind: string, data: unknown): unknown;
}

/** Where the writer hears from — a `BackgroundShellManager` and nothing more. */
export interface ShellLedgerManager {
	onSpawned(handler: (shell: BackgroundShell) => void): () => void;
	onSettled(handler: (shell: BackgroundShell) => void): () => void;
}

/**
 * Record every shell the manager tracks, from start to end.
 *
 * The session is read per event rather than captured, for the same reason
 * `attachShellNotices` reads it per completion: a `/resume` mid-session swaps
 * the store, and the shells started after the swap belong to the new file.
 * Returns the unsubscribe, for a shutdown that wants the ledger to stop
 * growing before the session goes away.
 */
export function attachShellLedger(
	manager: ShellLedgerManager,
	currentSession: () => ShellLedgerSession | undefined,
): () => void {
	const write = (kind: string, data: unknown): void => {
		// Failures land in the manager's own subscriber guard: a ledger that
		// throws must cost neither the shell nor the other subscribers.
		currentSession()?.appendCustom(kind, data);
	};
	const offSpawned = manager.onSpawned((shell) => {
		// A shell with no pid has nothing a later run could pair or probe, so it
		// is not written at all: half a ledger is worse than a gap in one.
		if (shell.pid === undefined) return;
		const data: ShellStartRecord = {
			shellId: shell.id,
			pid: shell.pid,
			command: shell.command,
			cwd: shell.cwd,
			startedAt: shell.startTime,
			outputFile: shell.outputFile,
		};
		write(SHELL_START_KIND, data);
	});
	const offSettled = manager.onSettled((shell) => {
		if (shell.pid === undefined) return;
		const data: ShellEndRecord = {
			pid: shell.pid,
			status: shell.status === "killed" ? "killed" : "completed",
			exitCode: shell.exitCode,
		};
		write(SHELL_END_KIND, data);
	});
	return () => {
		offSpawned();
		offSettled();
	};
}

/**
 * Read the ledger in order and pair it: what a resume starts from.
 *
 * A linear scan, not a fold over two maps, because the pairing has to be
 * generation-correct: a pid that starts, ends, and starts again — the second
 * run's shell behind the first run's number — must come out as one ended shell
 * and one open one, and only the order of the lines can tell those apart. A
 * pid still open at the end of the scan is settled by asking the OS, not the
 * file: the line that would have ended it may never have been written.
 */
export function readShellLedger(
	session: { linearEntries(): readonly LedgerEntry[] },
	isAlive: (pid: number) => boolean = probePid,
): ShellRecovery {
	const open = new Map<number, ShellStartRecord>();
	let ended = 0;
	for (const entry of session.linearEntries()) {
		if (entry.type !== "custom") continue;
		if (entry.kind === SHELL_START_KIND) {
			const start = startRecord(entry.data);
			// A second start for a pid with no end between them replaces the
			// first: there is one shell to speak of, and the later record is the
			// one whose output file is still the live one.
			if (start) open.set(start.pid, start);
		} else if (entry.kind === SHELL_END_KIND) {
			const end = endRecord(entry.data);
			// An end with no start on file pairs with nothing; counting it would
			// invent a shell no start ever claimed.
			if (end && open.delete(end.pid)) ended += 1;
		}
	}
	const alive: RecoveredShell[] = [];
	for (const start of open.values()) {
		if (isAlive(start.pid)) {
			alive.push(recoveredShell(start));
			continue;
		}
		// Started, never ended on the ledger, and no longer there: it ended
		// while nobody was listening — a crash, a kill, a reboot. The count is
		// the whole of what can honestly be said about it.
		ended += 1;
	}
	return { alive, ended };
}

/**
 * The line a resume prints when the ledger has something to say, or nothing.
 *
 * One line and no card: it is a warning about state the user cannot see yet,
 * not a screen they asked for. The ids are in it because they are the handles
 * the very next command takes — the shell a user wants stopped is named
 * `pid-4412` and the fix is to type that.
 */
export function formatShellRecovery(recovery: ShellRecovery): string | undefined {
	const sentences: string[] = [];
	if (recovery.alive.length > 0) {
		const ids = recovery.alive.map((shell) => shell.id).join(", ");
		sentences.push(
			recovery.alive.length === 1
				? `1 background shell from a previous run is still running: ${ids} — /ps reads its log, /stop ends it.`
				: `${recovery.alive.length} background shells from previous runs are still running: ${ids} — /ps reads a log, /stop ends one.`,
		);
	}
	if (recovery.ended > 0) {
		sentences.push(
			recovery.ended === 1
				? "1 background shell from a previous run has ended."
				: `${recovery.ended} background shells from previous runs have ended.`,
		);
	}
	return sentences.length > 0 ? sentences.join(" ") : undefined;
}

/**
 * The recovery minus the shells this process's own manager is already tracking.
 *
 * A `/resume` can land on a session whose ledger still holds an open start for
 * a shell this process started while that session was live — the start was
 * written there because the session was. That shell has a handle: `/ps` lists
 * it already and the exit guard counts it already. Without this, coming back
 * to that session would show one shell twice — once by id and once by pid —
 * and count it twice against the batch being interrupted. The ended count is
 * the file's, untouched: a pid the manager tracks is not a shell the previous
 * run left ended.
 */
export function excludeManagedShells(recovery: ShellRecovery, managedPids: Iterable<number>): ShellRecovery {
	const managed = new Set(managedPids);
	return { alive: recovery.alive.filter((shell) => !managed.has(shell.pid)), ended: recovery.ended };
}

/**
 * The end of a recovered shell's log, or the reason there is none. The manager
 * answers this for its own shells; a recovered one has no entry to look up, so
 * the log file recorded at its start is read directly — and a file since
 * deleted is said to be gone rather than shown as empty output.
 */
export function recoveredShellOutput(shell: RecoveredShell, maxChars = RECOVERED_OUTPUT_CHARS): string {
	try {
		const tail = readTail(shell.outputFile, maxChars);
		const header = tail.truncated
			? `[log tail: last ${tail.text.length} characters of ${tail.bytes} bytes — full log: ${shell.outputFile}]\n`
			: "";
		return `${header}${tail.text}`;
	} catch {
		return "(the log file is gone)";
	}
}

/** A start record out of unchecked file data, or null when the pid — the one field pairing needs — is not there. */
function startRecord(data: unknown): ShellStartRecord | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.pid !== "number" || !Number.isInteger(d.pid) || d.pid <= 0) return null;
	return {
		pid: d.pid,
		shellId: typeof d.shellId === "string" ? d.shellId : `pid-${d.pid}`,
		command: typeof d.command === "string" ? d.command : "(unknown command)",
		cwd: typeof d.cwd === "string" ? d.cwd : "",
		startedAt: typeof d.startedAt === "number" ? d.startedAt : 0,
		outputFile: typeof d.outputFile === "string" ? d.outputFile : "",
	};
}

/** An end record out of unchecked file data, or null when the pid is not there — the same rule as a start. */
function endRecord(data: unknown): ShellEndRecord | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.pid !== "number" || !Number.isInteger(d.pid) || d.pid <= 0) return null;
	return {
		pid: d.pid,
		status: d.status === "killed" ? "killed" : "completed",
		exitCode: typeof d.exitCode === "number" ? d.exitCode : null,
	};
}

/** The shell a start record describes, as the command layer sees it. */
function recoveredShell(start: ShellStartRecord): RecoveredShell {
	return {
		id: `pid-${start.pid}`,
		command: start.command,
		cwd: start.cwd,
		outputFile: start.outputFile,
		startTime: start.startedAt,
		status: "running",
		exitCode: null,
		pid: start.pid,
		recovered: true,
	};
}
