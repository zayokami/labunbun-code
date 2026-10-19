/**
 * The tool ledger: what the agent did while it ran.
 *
 * The session file holds the conversation, the compaction history and the task
 * list, and none of them say what the agent *did* — which tools it called,
 * whether they worked, and what the files they touched held on either side.
 * That is the question someone asks before trusting a rewrite, and it is the
 * state a checkpoint has to exist before anything can be restored, so every
 * finished tool call leaves one `custom` entry: this module is the shape of
 * that entry, the writer that puts it in the file, and the readers that turn
 * the file back into a report.
 *
 * Two sizes are held down on purpose. The input is never stored whole — a Bash
 * command can be 200k characters, and a session file is not where that should
 * be discovered — only a capped summary of its most telling string field, with
 * the cut admitted in `truncated`. And a file's fingerprint is a sha256, not
 * its content: the `file_checkpoint` entry beside it already holds the content
 * (capped the same way), and the hash is the half that stays cheap to compare.
 *
 * A compaction re-roots the chain, which takes every entry above the boundary
 * out of `linearEntries` — including these and the `file_checkpoint` entries
 * `/rewind` restores from. The task list has the same problem and is re-saved
 * when a pass ends (`task-snapshot.ts`); {@link resendCheckpointsAcrossCompaction}
 * is the same put-back for the two readers that would otherwise lose their
 * history silently.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import type { SessionEntry, SessionStore } from "@labunbun/agent";
import type { ToolResultMessage } from "@labunbun/ai";
import { type AgentTask, isMissingPathError } from "@labunbun/tools";
import { SHELL_END_KIND, SHELL_START_KIND } from "./shell-ledger.ts";
import { readTaskSnapshot } from "./task-snapshot.ts";

/** The `custom` entry kind one finished tool call records; on disk, so it is fixed. */
export const TOOL_CHECKPOINT_KIND = "checkpoint";
/** The `custom` entry kind a pre-Edit/Write content snapshot uses — `/rewind`'s payload. */
export const FILE_CHECKPOINT_KIND = "file_checkpoint";
/** The `custom` entry kind `/rewind` records a restore under. */
export const REWIND_KIND = "rewind";

/** One file an Edit/Write named, and what it held on either side of the call. */
export interface CheckpointFile {
	path: string;
	/**
	 * sha256 of the file just before the call, or null when no fingerprint
	 * could be taken — a file that did not exist yet, or one that could not be
	 * read. Null is "unknown", never "unchanged": the two are different answers
	 * and only one of them is a fact this build can point at.
	 */
	beforeHash: string | null;
	/**
	 * sha256 of the file just after the call, or null when the call failed, was
	 * blocked or never reached its after-read, or the file was gone by then.
	 */
	afterHash: string | null;
}

/** What one finished tool call recorded. */
export interface ToolCheckpoint {
	/** When the call ended. */
	at: number;
	callId: string;
	toolName: string;
	isError: boolean;
	/** The files an Edit/Write named. Absent for every other tool. */
	filesTouched?: CheckpointFile[];
	/**
	 * A capped slice of one string field of the call's input — the command for
	 * Bash, the path for Read/Edit/Write, the pattern for Grep. What the model
	 * said, in the one field that names the act; never the whole input.
	 */
	inputSummary?: string;
	/** True when `inputSummary` was cut to fit {@link INPUT_SUMMARY_MAX_CHARS}. */
	truncated?: boolean;
	/**
	 * The failing tests the call's result reported, in the order the runner
	 * printed them — set only when the call ran a test command, failed, and its
	 * output carried recognizable failure lines (see {@link failedTestsFromTestOutput}
	 * for the one shape this build reads).
	 */
	failedTests?: string[];
	/**
	 * How many failing test names did not fit {@link FAILED_TESTS_MAX}. When
	 * present, the total number of failures is `failedTests.length` plus this —
	 * the count is the runner's even when the names are capped.
	 */
	failedTestsOmitted?: number;
	/**
	 * The step the session itself said it was on when this call ended:
	 * the in-progress task's label, or the first pending task's subject, read
	 * off the session's own task board (see {@link nextStepFromTasks}). Derived
	 * from that record, never invented — absent when the board had no open work.
	 */
	nextStep?: string;
}

/** What `/rewind` records when it restored a file. */
export interface RewindRecord {
	at: number;
	path: string;
	/** The `file_checkpoint` entry the restored content came from. */
	fromEntryId: string;
}

/** How far a touched file has moved since the last call that touched it. */
export type TouchedFileState = "unchanged" | "changed" | "missing" | "unfingerprinted";

/** One touched file, against the disk as it is now. */
export interface TouchedFileReport {
	path: string;
	state: TouchedFileState;
	/** The fingerprint the last call recorded, when it took one. */
	afterHash: string | null;
}

/** sha256 (hex) of a piece of text — the same fingerprint a compaction boundary records. */
export function sha256Of(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Read a file and fingerprint it, or null when there is nothing to read. */
export function hashFileOrNull(path: string, readFile: (path: string) => string | null): string | null {
	const content = readFile(path);
	return content === null ? null : sha256Of(content);
}

/** The file an Edit/Write input names, or undefined for an input that names none. */
export function filePathFromInput(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const filePath = (input as { file_path?: unknown }).file_path;
	return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

/** How much of one input string a checkpoint keeps. Long enough for a path or a
 *  one-line command; a session holds one of these per tool call, so the cap is
 *  what keeps a chatty run from being paid for file-size-wise twice. */
export const INPUT_SUMMARY_MAX_CHARS = 160;

/**
 * The input fields worth keeping, most specific first.
 *
 * A fixed list rather than "the first string in the object": JSON key order is
 * not something a tool's caller promises, and a picker that took whatever key
 * came first would record `timeout` for one Bash call and `command` for the
 * next. A field this list does not know falls through to nothing, which is the
 * honest answer — the entry is about which call this was, not about the input.
 */
const SUMMARY_FIELDS = [
	"command",
	"file_path",
	"path",
	"notebook_path",
	"pattern",
	"url",
	"query",
	"subject",
	"description",
	"prompt",
];

/** The capped summary of a tool input, or undefined when no known field carries a string. */
export function summarizeToolInput(input: unknown): { text: string; truncated: boolean } | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	for (const field of SUMMARY_FIELDS) {
		const value = record[field];
		if (typeof value !== "string" || value.length === 0) continue;
		if (value.length <= INPUT_SUMMARY_MAX_CHARS) return { text: value, truncated: false };
		return { text: `${value.slice(0, INPUT_SUMMARY_MAX_CHARS)}…`, truncated: true };
	}
	return undefined;
}

/** How many failing test names one checkpoint keeps; the rest live on as a count. */
export const FAILED_TESTS_MAX = 20;

/**
 * One failure line of a bun test report: `(fail) <name>`, with bun's optional
 * `[16.00ms]` timing suffix.
 *
 * This is the only shape the recognizer reads. The project's own workflow runs
 * `bun test`, so the shape that matters is the one this build can have seen;
 * every other runner's failure format (a mocha dot report, a jest list, a
 * pytest summary) is left alone rather than guessed at, because a checkpoint
 * that named the wrong test would be worse than one that named none.
 */
const BUN_FAIL_LINE = /^\s*\(fail\)\s+(.+?)(?:\s+\[\d+(?:\.\d+)?m?s\])?\s*$/;

/**
 * Whether a shell command is a test run this build may read failures out of.
 *
 * A small fixed pattern set, matched segment by segment so a compound command
 * (`cd x && bun test`) still counts while a mention of a test command inside an
 * argument (`echo "run bun test"`) does not — the match is anchored at the
 * command word of each segment. The list is deliberately short: the only
 * failure shape this build understands is bun's, and a gate wide enough to
 * admit scripts whose output merely looked test-shaped would be parsing
 * arbitrary output for lines that only look like failure lines.
 */
export function looksLikeTestRun(command: string): boolean {
	for (const segment of command.split(/&&|\|\||[;|\n]/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		// Leading environment assignments (`NODE_ENV=test bun test`) are the
		// command's surroundings, not the command.
		let index = 0;
		while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
		const binary = unquote(words[index] ?? "")
			.replace(/.*[\\/]/, "")
			.replace(/\.(exe|cmd)$/i, "");
		const subcommand = unquote(words[index + 1] ?? "");
		const afterSubcommand = unquote(words[index + 2] ?? "");
		if (binary === "bun" && subcommand === "test") return true;
		if (binary === "bun" && subcommand === "run" && afterSubcommand === "test") return true;
		if ((binary === "npm" || binary === "pnpm" || binary === "yarn") && subcommand === "test") return true;
		if (
			(binary === "npm" || binary === "pnpm" || binary === "yarn") &&
			subcommand === "run" &&
			afterSubcommand === "test"
		) {
			return true;
		}
		// Invoked by name or by path (`./node_modules/.bin/vitest`).
		if (binary === "vitest" || binary === "jest") return true;
	}
	return false;
}

/** A shell word without the quotes a caller may have wrapped the binary in. */
function unquote(word: string): string {
	return word.replace(/^["']/, "").replace(/["']$/, "");
}

/**
 * The failing test names a test run's result reported, or undefined when none.
 *
 * Read line by line over the whole result. Names come out in report order and
 * duplicates are kept — two suites can each hold a test with the same name, and
 * a recognizer that cannot see the file of a failure line has no business
 * deciding they are the same test. Over the cap the names stop but the count
 * does not: `omitted` carries what did not fit.
 */
export function failedTestsFromTestOutput(text: string): { names: string[]; omitted: number } | undefined {
	const names: string[] = [];
	let total = 0;
	for (const line of text.split(/\r?\n/)) {
		const match = BUN_FAIL_LINE.exec(line);
		const name = match?.[1];
		if (name === undefined) continue;
		total++;
		if (names.length < FAILED_TESTS_MAX) names.push(name);
	}
	if (total === 0) return undefined;
	return { names, omitted: total - names.length };
}

/**
 * The next step as the session's task board states it.
 *
 * The board is the plan the session itself wrote down, so this reads it rather
 * than inventing anything: the first in-progress task (its present-continuous
 * `activeForm` when it has one — "Running tests" reads as a step, "Run tests"
 * as a to-do — else its subject), or the first pending task's subject when
 * nothing is in progress. `tasks` arrives in the board's own order, lowest id
 * first, and no open task is the honest answer `undefined`: a board whose work
 * is all completed has no next step, and resurrecting the last one would be the
 * ledger making work up.
 */
export function nextStepFromTasks(tasks: readonly AgentTask[]): string | undefined {
	const active = tasks.find((task) => task.status === "in_progress");
	if (active) return active.activeForm ?? active.subject;
	return tasks.find((task) => task.status === "pending")?.subject;
}

/** The one file-content cap a rewind checkpoint keeps. Over it the hash still goes in; the copy does not. */
const CHECKPOINT_MAX_CHARS = 200_000;

/** The result of one finished tool call, as the loop's end event carries it. */
export interface ToolEndEvent {
	callId: string;
	toolName: string;
	result: ToolResultMessage;
}

/**
 * One ledger write that did not land.
 *
 * The ledger stays best-effort — a checkpoint is not worth failing a turn over —
 * but "best effort" and "silent" are different promises. A snapshot the disk
 * refused is a file `/rewind` will not be able to restore, and the person who
 * later asks for it deserves to have been told when it happened.
 */
export interface LedgerFailure {
	/**
	 * Which half of the ledger failed: the pre-Edit/Write file snapshot that
	 * `/rewind` restores from, or the per-call checkpoint entry.
	 */
	operation: "checkpoint" | "entry";
	/** The file the failed write named, when it named one. */
	path?: string;
	message: string;
}

/** The writer of the tool ledger — see {@link createToolLedger}. */
export interface ToolLedger {
	/** The input each running call was announced with; the end event carries none. */
	noteToolStart(callId: string, input: unknown): void;
	/** Record one finished call. One entry, best effort. */
	noteToolEnd(event: ToolEndEvent): void;
	/** The before side of an Edit/Write: the rewind snapshot and the pre-call fingerprint. */
	noteBeforeMutation(toolName: string, input: unknown): void;
	/** The after side: the post-call fingerprint, or null when the call failed. */
	noteAfterMutation(toolName: string, input: unknown, isError: boolean): void;
	/**
	 * The writes that failed so far, in the order they first failed and
	 * deduplicated by what failed. Empty is the ordinary answer.
	 */
	failures(): readonly LedgerFailure[];
}

/**
 * One writer for the ledger, shared by the REPL and `-p` runs.
 *
 * Both apps run the same tool loop, so both have to leave the same record of
 * it: a `checkpoint` entry per finished call, the `file_checkpoint` a /rewind
 * restores from, and the fingerprints on either side of an Edit or Write. This
 * holds the pieces that only make sense together — the input each running call
 * was announced with, and the file a mutation is mid-way through — because
 * splitting them across two call sites is how the two modes drifted the last
 * time: batch B wired the REPL's events and left headless's unwired.
 *
 * The two hook-shaped methods run before the user's own hooks at their call
 * sites, so a hook that blocks a call still sees the ledger say what was
 * attempted, and the fingerprint of the before side is taken before anything
 * else could touch the file.
 */
export function createToolLedger(options: {
	/** The session to write into, read per call: `/resume` swaps the store under a running app. */
	store(): SessionStore | undefined;
	/** Read a file, or null when it is absent or unreadable. */
	readFile(path: string): string | null;
	/** Called once per distinct failure, in addition to {@link ToolLedger.failures}. */
	onWarning?(failure: LedgerFailure): void;
}): ToolLedger {
	const startedInputs = new Map<string, unknown>();
	const pendingFiles = new Map<string, { path: string; beforeHash: string | null; afterHash: string | null }>();
	const failureList: LedgerFailure[] = [];
	const reportedFailures = new Set<string>();

	/**
	 * Remember a failed write and say it once.
	 *
	 * The dedupe key is what failed, not when: a full disk refuses every append
	 * with the same words, and a warning per tool call would bury the first one.
	 */
	function reportFailure(failure: LedgerFailure): void {
		const key = `${failure.operation}\u0000${failure.path ?? ""}\u0000${failure.message}`;
		if (reportedFailures.has(key)) return;
		reportedFailures.add(key);
		failureList.push(failure);
		options.onWarning?.(failure);
	}

	function snapshotBeforeMutation(store: SessionStore, input: unknown): void {
		const filePath = filePathFromInput(input);
		if (filePath === undefined) return;
		let beforeHash: string | null = null;
		try {
			// `lstat`, not `stat`: a path the call named may be a symlink, and a
			// checkpoint copies contents into the session file. Following the
			// link would pull a file the user never asked this session to hold
			// in through a name an Edit/Write happened to mention. Links,
			// directories and devices are simply not captured — the same
			// "nothing to snapshot" answer a missing file gets.
			const stats = lstatSync(filePath);
			if (stats.isFile() && !stats.isSymbolicLink()) {
				const content = readFileSync(filePath, "utf8");
				beforeHash = sha256Of(content);
				// Over the cap the content is not inlined — a session file is not
				// where a 200k file's copy belongs — but the hash still is: the
				// entry can say the file changed on this call even when /rewind
				// cannot restore it.
				if (content.length <= CHECKPOINT_MAX_CHARS) {
					try {
						store.appendCustom(FILE_CHECKPOINT_KIND, { path: filePath, content, at: Date.now() });
					} catch (error) {
						// The snapshot is the rewind's payload. The call still goes
						// ahead; the entry that survives will carry the hash only,
						// which is enough to report a change and not to undo it.
						reportFailure({ operation: "checkpoint", path: filePath, message: failureMessage(error) });
					}
				}
			}
		} catch (error) {
			// A path that is not there is the ordinary Write-creates-it case:
			// there was nothing to snapshot and nothing went wrong. Everything
			// else — a refusal, an I/O fault, a directory read as a file — is a
			// snapshot that should have happened and did not.
			if (!isMissingPathError(error)) {
				reportFailure({ operation: "checkpoint", path: filePath, message: failureMessage(error) });
			}
		}
		pendingFiles.set(filePath, { path: filePath, beforeHash, afterHash: null });
	}

	return {
		noteToolStart(callId, input) {
			startedInputs.set(callId, input);
		},

		noteBeforeMutation(toolName, input) {
			if (toolName !== "Edit" && toolName !== "Write") return;
			const store = options.store();
			if (!store) return;
			snapshotBeforeMutation(store, input);
		},

		noteAfterMutation(toolName, input, isError) {
			if (toolName !== "Edit" && toolName !== "Write") return;
			const filePath = filePathFromInput(input);
			if (filePath === undefined) return;
			const pending = pendingFiles.get(filePath);
			// Read only when the call reported success: a failed edit left the
			// file as it was (or never created it), so "the hash after" would be
			// the before side wearing the wrong label.
			if (pending) pending.afterHash = isError ? null : hashFileOrNull(filePath, options.readFile);
		},

		noteToolEnd(event) {
			const input = startedInputs.get(event.callId);
			startedInputs.delete(event.callId);
			let filesTouched: CheckpointFile[] | undefined;
			if (event.toolName === "Edit" || event.toolName === "Write") {
				const filePath = input === undefined ? undefined : filePathFromInput(input);
				const pending = filePath === undefined ? undefined : pendingFiles.get(filePath);
				if (filePath !== undefined) pendingFiles.delete(filePath);
				// Only a pending state means a validated call reached its before
				// hook: an input the schema refused never named a file this build
				// fingerprinted, and a row for it would be a claim built on input
				// nothing accepted.
				if (pending) {
					filesTouched = [{ path: pending.path, beforeHash: pending.beforeHash, afterHash: pending.afterHash }];
				}
			}
			const store = options.store();
			if (!store) return;
			const record: ToolCheckpoint = {
				at: Date.now(),
				callId: event.callId,
				toolName: event.toolName,
				isError: event.result.isError,
			};
			if (input !== undefined) {
				const summary = summarizeToolInput(input);
				if (summary) {
					record.inputSummary = summary.text;
					if (summary.truncated) record.truncated = true;
				}
			}
			if (filesTouched) record.filesTouched = filesTouched;
			// Failures are read only off a call that failed: a run that reported
			// success is done, whatever its output happens to contain, and output
			// is quoted back and summarized all over this transcript.
			const command = commandFromInput(input);
			if (event.result.isError && command !== undefined && looksLikeTestRun(command)) {
				const failures = failedTestsFromTestOutput(toolResultText(event.result));
				if (failures) {
					record.failedTests = failures.names;
					if (failures.omitted > 0) record.failedTestsOmitted = failures.omitted;
				}
			}
			const nextStep = nextStepFromTasks(readTaskSnapshot(store) ?? []);
			if (nextStep) record.nextStep = nextStep;
			writeToolCheckpoint(store, record, reportFailure);
		},

		failures() {
			return failureList;
		},
	};
}

/** The message a caught write failure is reported with. */
function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The one line a host prints when a ledger write failed.
 *
 * Shared so the interactive and scripted runs describe the same missing thing
 * the same way: the operation says what `/rewind` will not have, and the path —
 * when there is one — says which file it is about.
 */
export function formatLedgerFailureNotice(failure: LedgerFailure): string {
	const subject = failure.operation === "checkpoint" ? `checkpoint for ${failure.path ?? "a file"}` : "tool checkpoint";
	return `Warning: could not save the ${subject}: ${failure.message}`;
}

/** The shell command a tool input names, when it carries one as a string. */
function commandFromInput(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const command = (input as { command?: unknown }).command;
	return typeof command === "string" && command.length > 0 ? command : undefined;
}

/** The text blocks of a tool result, joined the way the transcript renders them. */
function toolResultText(result: ToolResultMessage): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

/** The most recent test failures the ledger recorded, or undefined when none were. */
export function latestTestFailures(
	checkpoints: readonly ToolCheckpoint[],
): { at: number; names: string[]; omitted: number } | undefined {
	for (let i = checkpoints.length - 1; i >= 0; i--) {
		const checkpoint = checkpoints[i];
		if (!checkpoint?.failedTests) continue;
		return { at: checkpoint.at, names: checkpoint.failedTests, omitted: checkpoint.failedTestsOmitted ?? 0 };
	}
	return undefined;
}

/**
 * One line saying what the resumed session was doing — the recovery protocol's
 * first move, printed by both apps at startup when the ledger has anything to
 * say.
 *
 * Everything in it is read out of the ledger, the same facts `/checkpoint`
 * renders in full: the last call and when, how much is recorded, how many files
 * the calls named, the failing-test count the newest test run reported, and the
 * next step the board stated — each from the newest entry that can carry it,
 * which for `nextStep` means the last call, because "the plan as of the newest
 * thing that happened" is the only version of it that is still true. Undefined
 * when nothing was recorded, which is what lets a fresh session print nothing
 * without a branch of its own.
 */
export function formatResumeSummary(checkpoints: readonly ToolCheckpoint[]): string | undefined {
	const last = checkpoints[checkpoints.length - 1];
	if (!last) return undefined;
	const clauses = [
		`last ${last.toolName} ${last.isError ? "failed" : "ok"} at ${new Date(last.at).toLocaleTimeString()}`,
	];
	clauses.push(`${checkpoints.length} tool ${checkpoints.length === 1 ? "call" : "calls"} recorded`);
	const files = new Set<string>();
	for (const checkpoint of checkpoints) {
		for (const file of checkpoint.filesTouched ?? []) files.add(file.path);
	}
	if (files.size > 0) clauses.push(`${files.size} file${files.size === 1 ? "" : "s"} touched`);
	const failures = latestTestFailures(checkpoints);
	if (failures) {
		const count = failures.names.length + failures.omitted;
		clauses.push(`${count} failing test${count === 1 ? "" : "s"}`);
	}
	let line = `Resumed: ${clauses.join(", ")}.`;
	if (last.nextStep) line += ` Next: ${last.nextStep}.`;
	line += " /checkpoint shows the ledger; /rewind restores a file.";
	return line;
}

/** Record one finished tool call. Best effort — see {@link appendEntry}. */
export function writeToolCheckpoint(
	store: SessionStore,
	record: ToolCheckpoint,
	onFailure?: (failure: LedgerFailure) => void,
): void {
	appendEntry(store, TOOL_CHECKPOINT_KIND, record, onFailure);
}

/** Record a restore, so a reader can tell a workspace that was rolled back from one that was merely edited. */
export function recordRewind(store: SessionStore, path: string, fromEntryId: string): void {
	const record: RewindRecord = { at: Date.now(), path, fromEntryId };
	appendEntry(store, REWIND_KIND, record);
}

/** `O_NOFOLLOW` where the platform defines one; Windows has no such flag, and 0 is the flagless value. */
const O_NOFOLLOW_OR_ZERO: number = constants.O_NOFOLLOW ?? 0;

/** The mode a restore requests for a path it has to create. */
const RESTORE_FILE_MODE = 0o600;

/**
 * Write a checkpoint's content back over `path` for `/rewind` — refusing every
 * name that is not a plain, singly-linked file.
 *
 * The content comes out of the session file, which is data this build may not
 * have written (a damaged or hand-edited entry, another build's session), and
 * the path it names is written over the live workspace. So the destination is
 * checked before the write: a symlink would make `/rewind` overwrite whatever
 * it points at — including a file outside the project — and a hard link would
 * silently rewrite the other name it shares its inode with. Both are refused
 * with an error the caller reports; neither is ever written through.
 *
 * The write itself repeats the symlink refusal at the syscall where the
 * platform has one (`O_NOFOLLOW`): the `lstat` above and the `open` below are
 * two moments, and only the open can refuse the link that appeared between
 * them. Windows defines no `O_NOFOLLOW`, so there the `lstat` guard is the
 * defense. A missing path is the ordinary "Write created this file" case and is
 * created — with the same failure to make missing parents the caller's plain
 * write had, and with `0o600` as the requested mode. An existing file keeps
 * the mode it arrived with, because `open` consults the mode only when it
 * creates.
 */
export function restoreCheckpointFile(path: string, content: string): void {
	let mode = RESTORE_FILE_MODE;
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) {
			throw new Error(`Refusing to restore ${path}: it is a symbolic link.`);
		}
		if (!stats.isFile()) {
			throw new Error(`Refusing to restore ${path}: it is not a regular file.`);
		}
		if (stats.nlink > 1) {
			throw new Error(`Refusing to restore ${path}: it has ${stats.nlink} hard links.`);
		}
		mode = stats.mode & 0o777;
	} catch (error) {
		// A path that is not there yet is the creation case: let the open below
		// make it. Every other lstat failure — a permissions problem, a parent
		// that is a file — is the caller's to see.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	if (O_NOFOLLOW_OR_ZERO === 0) {
		// Windows: no `O_NOFOLLOW` to pass, and its `open` does not take the
		// numeric flag set at all (Bun answers EINVAL). The `lstat` guard above
		// is the defense there; the write itself is the plain one.
		writeFileSync(path, content, { encoding: "utf8", mode });
		return;
	}
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW_OR_ZERO, mode);
	try {
		writeFileSync(fd, content, "utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * The tool checkpoints a session holds, oldest first.
 *
 * Read over every entry in the file rather than the active chain: the question
 * this answers is what the session did, and a compaction is exactly the moment
 * the chain stops holding the calls above it. Data read back from a file is
 * checked rather than trusted — a line a damaged write or an older build left
 * is skipped, the same way `/rewind` refuses a checkpoint it cannot read.
 */
export function readToolCheckpoints(entries: readonly SessionEntry[]): ToolCheckpoint[] {
	const out: ToolCheckpoint[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.kind !== TOOL_CHECKPOINT_KIND) continue;
		const record = checkpointRecord(entry.data);
		if (record) out.push(record);
	}
	return out;
}

/**
 * The files the session's calls named, latest fingerprint per path, each read
 * against the disk now — the same four answers `preservedFilesDrift` gives the
 * compaction fingerprints, because it is the same question one level down: the
 * call said this file held X, and the only way to check that claim is to hash
 * the file again. A later call on the same path replaces the earlier one: the
 * state of the file now is the state the newest fingerprint describes.
 */
export function touchedFileReports(
	checkpoints: readonly ToolCheckpoint[],
	readFile: (path: string) => string | null,
): TouchedFileReport[] {
	const latest = new Map<string, string | null>();
	for (const checkpoint of checkpoints) {
		for (const file of checkpoint.filesTouched ?? []) latest.set(file.path, file.afterHash);
	}
	const reports: TouchedFileReport[] = [];
	for (const [path, afterHash] of latest) {
		if (afterHash === null) {
			// No fingerprint is a different answer from any of the three below,
			// and the one case where reading the file anyway would prove nothing.
			reports.push({ path, state: "unfingerprinted", afterHash: null });
			continue;
		}
		const content = readFile(path);
		if (content === null) {
			reports.push({ path, state: "missing", afterHash });
			continue;
		}
		reports.push({ path, state: sha256Of(content) === afterHash ? "unchanged" : "changed", afterHash });
	}
	return reports;
}

/**
 * Put back what a compaction's re-rooting strands.
 *
 * A boundary hangs off the chain's root, so every entry above it — the file
 * checkpoints `/rewind` restores from, the shell starts a later run reads —
 * drops out of `linearEntries` the moment a pass ends. What is re-sent here is
 * the minimum the two readers need: the latest checkpoint per path, and every
 * shell whose start never met an end. Older checkpoints for a path are
 * deliberately left behind — after a summary the useful thing to restore is the
 * newest state of a file, not its whole editing history, and re-sending every
 * one would grow the file by a transcript per pass.
 *
 * Read over `store.entries` on purpose: the entries being salvaged are exactly
 * the ones the active chain no longer holds.
 */
export function resendCheckpointsAcrossCompaction(store: SessionStore | undefined): void {
	if (!store) return;
	for (const data of latestFileCheckpoints(store.entries)) appendEntry(store, FILE_CHECKPOINT_KIND, data);
	for (const data of openShellStarts(store.entries)) appendEntry(store, SHELL_START_KIND, data);
}

/** One `file_checkpoint` payload per path, the newest, in the order the paths first appeared. */
function latestFileCheckpoints(entries: readonly SessionEntry[]): Array<{ path: string; content: string; at: number }> {
	const latest = new Map<string, { path: string; content: string; at: number }>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.kind !== FILE_CHECKPOINT_KIND) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const record = data as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.content !== "string" || typeof record.at !== "number") {
			continue;
		}
		latest.set(record.path, { path: record.path, content: record.content, at: record.at });
	}
	return [...latest.values()];
}

/**
 * The shell starts no end has closed, in first-start order.
 *
 * The same generation-correct scan `readShellLedger` pairs by — the pid is the
 * identity across a restart, and only the order of the lines can tell a
 * second run's shell from the first one behind the same number. Liveness is
 * not consulted: an unpaired start is re-sent whether or not its process is
 * still there, because "it ended while nobody was listening" is itself a fact
 * the next resume's probe needs the record for.
 */
function openShellStarts(entries: readonly SessionEntry[]): unknown[] {
	const open = new Map<number, unknown>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.kind === SHELL_START_KIND) {
			const pid = shellPid(entry.data);
			if (pid !== null) open.set(pid, entry.data);
		} else if (entry.kind === SHELL_END_KIND) {
			const pid = shellPid(entry.data);
			if (pid !== null) open.delete(pid);
		}
	}
	return [...open.values()];
}

/** The pid a ledger payload pairs by, or null when it carries none — the one field pairing needs. */
function shellPid(data: unknown): number | null {
	if (typeof data !== "object" || data === null) return null;
	const pid = (data as { pid?: unknown }).pid;
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** A tool checkpoint out of unchecked file data, or null when the shape this build reads is not there. */
function checkpointRecord(data: unknown): ToolCheckpoint | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (
		typeof d.callId !== "string" ||
		typeof d.toolName !== "string" ||
		typeof d.isError !== "boolean" ||
		typeof d.at !== "number"
	) {
		return null;
	}
	const record: ToolCheckpoint = { at: d.at, callId: d.callId, toolName: d.toolName, isError: d.isError };
	if (typeof d.inputSummary === "string") record.inputSummary = d.inputSummary;
	if (d.truncated === true) record.truncated = true;
	if (Array.isArray(d.failedTests)) {
		const names = d.failedTests.filter((name): name is string => typeof name === "string" && name.length > 0);
		if (names.length > 0) record.failedTests = names;
	}
	if (typeof d.failedTestsOmitted === "number" && Number.isInteger(d.failedTestsOmitted) && d.failedTestsOmitted > 0) {
		record.failedTestsOmitted = d.failedTestsOmitted;
	}
	if (typeof d.nextStep === "string" && d.nextStep.length > 0) record.nextStep = d.nextStep;
	if (Array.isArray(d.filesTouched)) {
		const files: CheckpointFile[] = [];
		for (const raw of d.filesTouched) {
			const file = checkpointFile(raw);
			if (file) files.push(file);
		}
		if (files.length > 0) record.filesTouched = files;
	}
	return record;
}

/** One file entry of a checkpoint payload; a payload with no readable path names no file. */
function checkpointFile(data: unknown): CheckpointFile | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.path !== "string") return null;
	const hash = (value: unknown): string | null => (typeof value === "string" ? value : null);
	return { path: d.path, beforeHash: hash(d.beforeHash), afterHash: hash(d.afterHash) };
}

/**
 * Append one ledger entry, best effort.
 *
 * A file that cannot be appended to must not cost the turn that was running: a
 * lost checkpoint is a line a later reader will not have, which is the one cost
 * this module accepts. The same swallow as every other `custom` writer here.
 */
function appendEntry(
	store: SessionStore,
	kind: string,
	data: unknown,
	onFailure?: (failure: LedgerFailure) => void,
): void {
	try {
		store.appendCustom(kind, data);
	} catch (error) {
		// Best effort — the turn is not failed. The failure is still reported to
		// callers that asked, because a ledger with a hole in it should not read
		// as a ledger with nothing missing.
		onFailure?.({ operation: "entry", message: failureMessage(error) });
	}
}
