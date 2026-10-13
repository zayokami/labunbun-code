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
import type { SessionEntry, SessionStore } from "@labunbun/agent";
import { SHELL_END_KIND, SHELL_START_KIND } from "./shell-ledger.ts";

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

/** Record one finished tool call. Best effort — see {@link appendEntry}. */
export function writeToolCheckpoint(store: SessionStore, record: ToolCheckpoint): void {
	appendEntry(store, TOOL_CHECKPOINT_KIND, record);
}

/** Record a restore, so a reader can tell a workspace that was rolled back from one that was merely edited. */
export function recordRewind(store: SessionStore, path: string, fromEntryId: string): void {
	const record: RewindRecord = { at: Date.now(), path, fromEntryId };
	appendEntry(store, REWIND_KIND, record);
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
function appendEntry(store: SessionStore, kind: string, data: unknown): void {
	try {
		store.appendCustom(kind, data);
	} catch {
		// Best effort — see the doc above.
	}
}
