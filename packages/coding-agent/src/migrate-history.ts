/**
 * Conversation-history import: another tool's transcripts, written as labunbun
 * session files.
 *
 * Sources are read, never written, and a session only becomes a file when the
 * user asks for it. The conversion is lossy on purpose: reasoning that arrives
 * encrypted, sidechains and subagent threads are dropped and counted rather
 * than reconstructed, and a tool call left without its result (or the reverse)
 * loses both halves — a transcript that half-pairs would fail the API on the
 * first `--continue`, which is worse than a shorter transcript.
 *
 * Two phases, because the second one is expensive:
 *   list…  — metadata only (a bounded head-read per file), for the picker
 *   read…  — full conversion of the sessions the user actually chose
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { compactionBoundary, type SessionEntry, sessionFilePath } from "@labunbun/agent";
import {
	type AgentMessage,
	type AssistantContent,
	assistantMessage,
	type ImageContent,
	repairToolPairing,
	type ToolResultContent,
	textContent,
	toolResultMessage,
	type Usage,
	userMessage,
} from "@labunbun/ai";
import { caseInsensitivePaths } from "@labunbun/tools";
import { codexRoot } from "./codex-home.ts";
import { dshRoot } from "./dsh-home.ts";
import { listDshSessions, readDshLog } from "./dsh-session.ts";
import { decodeGrokCwdDir, grokRoot, grokSessionsRoot } from "./grok-home.ts";
import { listGrokSessions, readGrokSession } from "./grok-session.ts";

import { kimiInputHistoryDir, kimiInputHistoryFile, kimiRoot } from "./kimi-home.ts";
import { listKimiSessions, readKimiSession } from "./kimi-session.ts";
import type { MigrationSourceId } from "./migrate.ts";
import { minimaxRoot } from "./minimax-home.ts";
import { listMinimaxSessions, readMinimaxSession } from "./minimax-session.ts";
import { listStepSessions, readStepSession } from "./step-session.ts";
import { readZcodeConversation, readZcodeSessions, type ZcodePartRow } from "./zcode-db.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Which sessions to import: just this project's, everything, or nothing. */
export type HistoryScope = "cwd" | "all" | "none";

export const HISTORY_SCOPES: HistoryScope[] = ["cwd", "all", "none"];

/** Sessions imported per source unless `--history-limit` says otherwise. */
export const DEFAULT_HISTORY_LIMIT = 20;

export interface HistoryCandidate {
	source: MigrationSourceId;
	/** The id the source tool uses, and the input to the target session id. */
	sourceId: string;
	cwd: string;
	/** Empty when the source does not name a session; filled in during conversion. */
	title: string;
	/** Epoch ms of the session's first entry. */
	startedAt: number;
	/** Where the source keeps it, so the read phase need not derive the path again. */
	path: string;
	/**
	 * The source had filed this session away rather than leaving it in the
	 * ordinary place, and a reader of the report deserves to know the transcript
	 * came from there. Only Codex has the distinction so far: it moves a rollout
	 * into `archived_sessions/` when the user archives the session.
	 */
	archived?: boolean;
}

/** Something the importer chose not to carry over, and how often it happened. */
export interface HistoryNote {
	reason: string;
	count: number;
}

/** One entry of the imported transcript, in the shape the session file stores. */
export type HistoryEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "compaction"; summary: string; preTokens: number };

export interface HistorySession {
	source: MigrationSourceId;
	sourceId: string;
	cwd: string;
	title: string;
	startedAt: number;
	entries: HistoryEntry[];
	/** Carried from the candidate: see {@link HistoryCandidate.archived}. */
	archived?: boolean;
}

/** What a source offers for import, narrowed to the requested scope. */
export interface HistoryListing {
	candidates: HistoryCandidate[];
	notes: HistoryNote[];
}

export interface HistoryReadResult {
	sessions: HistorySession[];
	notes: HistoryNote[];
}

/** What one source contributes to a plan: the converted sessions and the skips. */
export interface HistoryInput extends HistoryReadResult {
	/** Candidates that matched but fell outside the limit. */
	overLimit: number;
}

export type HistoryImport = Partial<Record<MigrationSourceId, HistoryInput>>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Structural repair: both halves of an unpaired tool call go.
 *
 * Re-exported so this module's callers (and its tests) keep one import site;
 * the implementation lives in `@labunbun/ai` because resuming a session whose
 * file lost a line needs the same repair, one layer below this one.
 */
export { repairToolPairing };

/** Canonical form of a project path, so two spellings of one directory compare equal. */
export function projectKey(path: string): string {
	const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return caseInsensitivePaths ? slashed.toLowerCase() : slashed;
}

/** Does this path name the same project directory as `cwd`? */
export function sameProject(a: string, b: string): boolean {
	return projectKey(a) === projectKey(b);
}

/**
 * Identity of a recall entry: the prompt plus the directory it was typed in.
 *
 * Recall is filtered by directory, so the same words typed in two projects are
 * two entries; and the path has to be normalised, or one directory spelled with
 * a backslash and with a slash would count twice.
 *
 * The two halves are joined by a NUL: both are free text, and any separator a
 * prompt could itself contain would let `{cwd: "a b", text: "c"}` and
 * `{cwd: "a", text: "b c"}` collide — which would drop a prompt rather than
 * merge it.
 */
export function promptKey(text: string, cwd: string): string {
	return `${projectKey(cwd)}\u0000${text}`;
}

/**
 * Fill in a tool result's tool name from the call it answers: only the call
 * records the name, and a result that arrives without one renders as an
 * unnamed tool in the transcript view.
 */
function rewriteToolNames(messages: AgentMessage[]): AgentMessage[] {
	const names = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") names.set(block.id, block.name);
	}
	return messages.map((message) => {
		if (message.role !== "toolResult" || message.toolName !== UNKNOWN_TOOL_NAME) return message;
		const name = names.get(message.toolCallId);
		return name ? { ...message, toolName: name } : message;
	});
}

/**
 * A tool result's content must be non-empty: an empty text block is rejected by
 * the messages API, which would make an otherwise resumable transcript fail on
 * the first `--continue`. Sources record a failed call as an empty output, so
 * the placeholder is what keeps those sessions replayable.
 */
function resultContent(text: string): ToolResultContent[] {
	return [textContent(text || "(no output recorded)")];
}

/** Stand-in for a tool name the source did not record; replaced when a call names it. */
const UNKNOWN_TOOL_NAME = "unknown";

/** Convert `arguments` text into a value that can be re-encoded as a JSON object. */
function parseArguments(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	try {
		const parsed = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : { input: parsed };
	} catch {
		return { input: raw };
	}
}

/**
 * The opening lines of a file, up to about `maxBytes` of them.
 *
 * A line that would not fit is not returned: half a JSON object is not the
 * object it was cut from, and every caller here parses what it gets. The first
 * line is the exception, and the exception is the point — a Codex rollout opens
 * with the `session_meta` line, which carries the whole base instruction set and
 * is routinely larger than any head window. Dropping it turned 115 of 125
 * rollouts on a real machine into "no session metadata" rather than sessions.
 */
function readHeadLines(path: string, maxBytes = 65_536): string[] {
	try {
		return headLinesOf(readFileSync(path, "utf8"), maxBytes);
	} catch {
		return [];
	}
}

/** The head window itself, over text that has already been read. */
function headLinesOf(text: string, maxBytes: number): string[] {
	const out: string[] = [];
	let used = 0;
	for (const line of text.split("\n")) {
		if (out.length > 0 && used + line.length > maxBytes) break;
		out.push(line);
		used += line.length;
	}
	return out;
}

/**
 * The closing lines of a file, up to about `maxBytes` of them.
 *
 * The mirror of {@link readHeadLines}, and for the same class of file: a prompt
 * history is appended to, so its newest prompts are at the end, and a limit-based
 * import reading from the front would carry the oldest prompts on the machine.
 * `truncated` says the window was smaller than the file, so the report can admit
 * that something before it went unread rather than implying the count is all of it.
 */
function readTailLines(path: string, maxBytes: number): { lines: string[]; truncated: boolean } {
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - maxBytes);
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(size - start);
			readSync(fd, buffer, 0, buffer.length, start);
			const lines = buffer.toString("utf8").split("\n");
			// The window can open mid-line, and half a JSON object is not the object
			// it was cut from. The first line goes; the rest are whole.
			if (start > 0) lines.shift();
			return { lines, truncated: start > 0 };
		} finally {
			closeSync(fd);
		}
	} catch {
		return { lines: [], truncated: false };
	}
}

function parseJsonLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return asRecord(parsed);
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function firstText(value: string, max = 60): string {
	const single = value.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** The suffix Codex compresses a rollout with once it is a week old. */
const COMPRESSED_SUFFIX = ".zst";

/**
 * The canonical `.jsonl` name of a rollout file, or `null` when the name is not
 * a rollout's.
 *
 * Both spellings Codex writes are accepted — `rollout-*.jsonl`, and the
 * `rollout-*.jsonl.zst` it recompresses an old rollout into — because the id and
 * the timestamp are parsed from this name rather than from the file's, and the
 * compressed spelling would otherwise fail the `rollout-`/`.jsonl` test on its
 * trailing `.zst` alone.
 */
function plainRolloutName(name: string): string | null {
	const plain = name.endsWith(COMPRESSED_SUFFIX) ? name.slice(0, -COMPRESSED_SUFFIX.length) : name;
	return plain.startsWith("rollout-") && plain.endsWith(".jsonl") ? plain : null;
}

/**
 * A rollout's text, compressed or not.
 *
 * A `.jsonl.zst` is decompressed whole, which is a cost worth naming: the
 * listing walks every rollout and reads a bounded head of each, and for a
 * compressed one that window is now paid for with a full decode of the file.
 * Codex itself avoids this with a seekable decoder, but a stream here would be a
 * second reader with its own copy of the head-window rules — including the rule
 * that keeps an oversized first line — and one file, one reader is worth more
 * than the time on a path a user walks once. The frame carries its source size
 * (Codex pledges it on write, `encode_zstd_to_writer`), which is what lets a
 * one-shot decompressor size its output.
 */
function readRolloutText(path: string): string | null {
	try {
		const bytes = readFileSync(path);
		return (path.endsWith(COMPRESSED_SUFFIX) ? Bun.zstdDecompressSync(bytes) : bytes).toString("utf8");
	} catch {
		return null;
	}
}

/**
 * A rollout's lines, decompressed on the way in.
 *
 * A rollout that cannot be opened throws, so the caller counts it as a session
 * that produced nothing — an unreadable file must not be presented as a
 * transcript that happened to be empty.
 */
function rolloutLines(path: string): string[] {
	const text = readRolloutText(path);
	if (text === null) throw new Error(`rollout is unreadable: ${path}`);
	return text.split("\n");
}

/**
 * `rollout-*.jsonl` under a Codex session root, newest first.
 *
 * A compressed rollout is skipped when its plain sibling is still there, which
 * is Codex's own rule (`should_skip_compressed_sibling`): in that state the plain
 * file is the one Codex reads, and listing both would put one session in the
 * picker twice — once under a name that has no second copy behind it.
 */
function listRolloutFiles(root: string): Array<{ plainName: string; path: string; mtimeMs: number }> {
	const out: Array<{ plainName: string; path: string; mtimeMs: number }> = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) return;
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(path, depth + 1);
					continue;
				}
				if (!entry.isFile()) continue;
				const plainName = plainRolloutName(entry.name);
				if (plainName === null) continue;
				if (entry.name.endsWith(COMPRESSED_SUFFIX) && existsSync(join(dir, plainName))) continue;
				out.push({ plainName, path, mtimeMs: mtimeOf(path) });
			}
		} catch {
			// An unreadable level contributes nothing; the rest of the walk stands.
		}
	};
	walk(root, 0);
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * A session's own working directory must still exist to import it: the target
 * file lives under a directory named after that cwd, so a session whose project
 * is gone would import into a project `--continue` cannot be run from.
 */
function directoryExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Apply the cwd rules and the scope to what a source listed. */
function narrowCandidates(listing: HistoryListing, options: { cwd: string; scope: HistoryScope }): HistoryListing {
	// The source's own notes (subagent threads, unreadable files) survive the
	// narrowing: they are skips the report owes the user regardless of scope.
	const notes: HistoryNote[] = [...listing.notes];
	const alive: HistoryCandidate[] = [];
	let missing = 0;
	// A session with no directory at all is a different fact from one whose
	// directory has since been deleted, and telling the user the second when the
	// first is true sends them looking for something they never had. dsh records
	// it plainly: a session started outside any project lands in its `_no-cwd`
	// bucket, so this path is ordinary there rather than an edge case.
	let unattributed = 0;
	for (const candidate of listing.candidates) {
		if (!candidate.cwd) unattributed += 1;
		else if (!directoryExists(candidate.cwd)) missing += 1;
		else alive.push(candidate);
	}
	if (missing > 0) notes.push({ reason: "working directory no longer exists", count: missing });
	if (unattributed > 0) notes.push({ reason: "no working directory recorded", count: unattributed });

	let matching = alive;
	if (options.scope === "cwd") {
		matching = alive.filter((candidate) => sameProject(candidate.cwd, options.cwd));
		const elsewhere = alive.length - matching.length;
		if (elsewhere > 0) notes.push({ reason: 'another project (scope is "cwd")', count: elsewhere });
	}
	return { candidates: [...matching].sort((a, b) => b.startedAt - a.startedAt), notes };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** Claude Code's entry line, as far as this importer reads it. */
interface ClaudeEntry {
	type?: unknown;
	message?: unknown;
	timestamp?: unknown;
	cwd?: unknown;
	isSidechain?: unknown;
}

const CLAUDE_STOP_REASONS: Record<string, "stop" | "toolUse" | "length"> = {
	end_turn: "stop",
	stop_sequence: "stop",
	tool_use: "toolUse",
	max_tokens: "length",
};

/** A tool result's content: a string, or blocks of text and images. */
function claudeResultContent(content: unknown): ToolResultContent[] {
	if (typeof content === "string") return resultContent(content);
	if (!Array.isArray(content)) return resultContent("");
	const out: ToolResultContent[] = [];
	for (const raw of content) {
		const block = asRecord(raw);
		if (!block) continue;
		if (block.type === "text") out.push(textContent(asText(block.text)));
		else if (block.type === "image") {
			const source = asRecord(block.source);
			const data = asText(source?.data);
			const mimeType = asText(source?.media_type);
			if (data && mimeType) out.push({ type: "image", mimeType, data } satisfies ImageContent);
		}
	}
	return out.length > 0 ? out : resultContent("");
}

function claudeEntriesFromUser(content: unknown, timestamp: number): AgentMessage[] {
	if (typeof content === "string") return [userMessage(content, timestamp)];
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	const results: AgentMessage[] = [];
	for (const raw of content) {
		const block = asRecord(raw);
		if (!block) continue;
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) texts.push(text);
			continue;
		}
		if (block.type !== "tool_result") continue;
		const toolCallId = asText(block.tool_use_id);
		if (!toolCallId) continue;
		results.push(
			toolResultMessage(
				toolCallId,
				UNKNOWN_TOOL_NAME,
				claudeResultContent(block.content),
				block.is_error === true,
				timestamp,
			),
		);
	}
	// Text first: a user turn that also carries tool results is the model's
	// prompt read back, and those results answer calls made before it.
	return texts.length > 0 ? [userMessage(texts.join("\n"), timestamp), ...results] : results;
}

function claudeAssistant(message: Record<string, unknown>, timestamp: number): AgentMessage | null {
	const raw = Array.isArray(message.content) ? message.content : [];
	const content: AssistantContent[] = [];
	for (const entry of raw) {
		const block = asRecord(entry);
		if (!block) continue;
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) content.push(textContent(text));
			continue;
		}
		if (block.type === "thinking") {
			const thinking = asText(block.thinking);
			if (thinking) content.push({ type: "thinking", thinking });
			continue;
		}
		if (block.type !== "tool_use") continue;
		const id = asText(block.id);
		const name = asText(block.name);
		if (!id || !name) continue;
		content.push({ type: "toolCall", id, name, arguments: JSON.stringify(block.input ?? {}) });
	}
	if (content.length === 0) return null;
	const usage = asRecord(message.usage);
	const hasToolCall = content.some((block) => block.type === "toolCall");
	return assistantMessage({
		content,
		model: asText(message.model),
		usage: {
			input: Number(usage?.input_tokens ?? 0) || 0,
			output: Number(usage?.output_tokens ?? 0) || 0,
			cacheRead: Number(usage?.cache_read_input_tokens ?? 0) || 0,
			cacheWrite: Number(usage?.cache_creation_input_tokens ?? 0) || 0,
		} satisfies Usage,
		stopReason: CLAUDE_STOP_REASONS[asText(message.stop_reason)] ?? (hasToolCall ? "toolUse" : "stop"),
		timestamp,
	});
}

/**
 * `projects/<slug>/memory/` — the auto-memory Claude Code keeps per project: a
 * `MEMORY.md` and the notes written beside it (`memdir/paths.ts`, `AUTO_MEM_DIRNAME`).
 *
 * It sits in the same directory as the transcripts, so the walk below used to
 * count it as one more sidechain directory and the report called it a subagent
 * transcript — a curated memory document described as a conversation nobody
 * needed. Named for what it is now, and not imported: this build keeps one
 * memory file for the user, so one project's notes would apply to every project.
 */
const AUTO_MEMORY_DIRNAME = "memory";

function listClaudeCodeHistory(home: string): HistoryListing {
	const root = join(home, ".claude", "projects");
	const candidates: HistoryCandidate[] = [];
	const notes: HistoryNote[] = [];
	let subagents = 0;
	let skippedDirs = 0;
	let memories = 0;
	let unreadable = 0;
	try {
		if (!existsSync(root)) return { candidates, notes };
		for (const project of readdirSync(root, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			const projectDir = join(root, project.name);
			for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
				// `<project>/memory/` is not a session directory at all.
				if (entry.isDirectory() && entry.name === AUTO_MEMORY_DIRNAME) {
					memories += 1;
					continue;
				}
				// `<project>/<sessionId>/subagents/*.jsonl` — a sidechain that never
				// belonged to the parent conversation.
				if (entry.isDirectory()) {
					skippedDirs += 1;
					try {
						subagents += readdirSync(join(projectDir, entry.name), { recursive: true }).filter((name) =>
							String(name).endsWith(".jsonl"),
						).length;
					} catch {
						// unreadable sidechain directory — counted as one skip
					}
					continue;
				}
				if (!entry.name.endsWith(".jsonl")) continue;
				const path = join(projectDir, entry.name);
				let cwd = "";
				let startedAt = 0;
				let title = "";
				for (const line of readHeadLines(path)) {
					const parsed = parseJsonLine(line) as ClaudeEntry | null;
					if (!parsed) continue;
					if (!startedAt && typeof parsed.timestamp === "string") {
						const parsedTime = Date.parse(parsed.timestamp);
						if (Number.isFinite(parsedTime)) startedAt = parsedTime;
					}
					if (!cwd && typeof parsed.cwd === "string") cwd = parsed.cwd;
					if (!title && parsed.type === "user") {
						const content = asRecord(parsed.message)?.content;
						if (typeof content === "string") title = firstText(content);
					}
					if (cwd && startedAt && title) break;
				}
				if (!cwd) {
					unreadable += 1;
					continue;
				}
				candidates.push({
					source: "claude-code",
					sourceId: entry.name.replace(/\.jsonl$/, ""),
					cwd,
					title,
					startedAt: startedAt || mtimeOf(path),
					path,
				});
			}
		}
	} catch {
		return { candidates: [], notes: [] };
	}
	if (subagents > 0 || skippedDirs > 0) {
		notes.push({
			reason: "subagent transcript (kept out of the parent conversation)",
			count: Math.max(subagents, skippedDirs),
		});
	}
	if (memories > 0) {
		notes.push({
			reason:
				"auto-memory directory (MEMORY.md and the notes beside it) — one project's memory, and this build keeps one " +
				"memory file for the whole user, so importing it would apply that project's notes everywhere",
			count: memories,
		});
	}
	if (unreadable > 0) notes.push({ reason: "session file with no working directory", count: unreadable });
	return { candidates, notes };
}

function readClaudeCodeSession(
	path: string,
	candidate: HistoryCandidate,
): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const notes: HistoryNote[] = [];
	let sidechain = 0;
	let malformed = 0;
	let ignored = 0;
	const collected: AgentMessage[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const parsed = parseJsonLine(line) as ClaudeEntry | null;
		if (!parsed) {
			malformed += 1;
			continue;
		}
		if (parsed.isSidechain === true) {
			sidechain += 1;
			continue;
		}
		if (parsed.type !== "user" && parsed.type !== "assistant") {
			ignored += 1;
			continue;
		}
		const message = asRecord(parsed.message);
		if (!message) continue;
		const rawTime = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
		const timestamp = Number.isFinite(rawTime) ? rawTime : candidate.startedAt;
		if (parsed.type === "user") {
			collected.push(...claudeEntriesFromUser(message.content, timestamp));
			continue;
		}
		const assistant = claudeAssistant(message, timestamp);
		if (assistant) collected.push(assistant);
	}

	const repaired = repairToolPairing(rewriteToolNames(collected));
	if (malformed > 0) notes.push({ reason: "malformed line", count: malformed });
	if (sidechain > 0) notes.push({ reason: "sidechain entry", count: sidechain });
	if (ignored > 0) notes.push({ reason: "non-conversation entry", count: ignored });
	if (repaired.dropped > 0) notes.push({ reason: "unpaired tool call or result", count: repaired.dropped });
	return { entries: repaired.messages.map((message) => ({ kind: "message", message })), notes };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function readCodexMeta(text: string): { cwd: string; sessionId: string; child: boolean; startedAt: number } | null {
	let startedAt = 0;
	for (const line of headLinesOf(text, 16_384)) {
		const parsed = parseJsonLine(line);
		if (!parsed) continue;
		if (!startedAt && typeof parsed.timestamp === "string") {
			const parsedTime = Date.parse(parsed.timestamp);
			if (Number.isFinite(parsedTime)) startedAt = parsedTime;
		}
		if (parsed.type !== "session_meta") continue;
		const payload = asRecord(parsed.payload);
		if (!payload) continue;
		return {
			cwd: asText(payload.cwd),
			sessionId: asText(payload.session_id),
			child: Boolean(asText(payload.parent_thread_id) || asText(payload.forked_from_id) || asText(payload.agent_role)),
			startedAt,
		};
	}
	return null;
}

/**
 * `$CODEX_HOME/sessions/` and `$CODEX_HOME/archived_sessions/`.
 *
 * The archived directory is the same kind of session — Codex moves a rollout
 * there when the user archives the session, and its own thread listing reads
 * that directory under the same rules when asked for archived threads. Reading
 * only `sessions/` would leave every archived session out of the picker while
 * the report claimed to have found the source's history, so the walk covers both
 * and each session carries which one it came from.
 */
function listCodexHistory(home: string): HistoryListing {
	const root = codexRoot(home);
	const candidates: HistoryCandidate[] = [];
	let children = 0;
	let unreadable = 0;
	for (const [name, archived] of [
		["sessions", false],
		["archived_sessions", true],
	] as const) {
		for (const file of listRolloutFiles(join(root, name))) {
			const text = readRolloutText(file.path);
			const meta = text === null ? null : readCodexMeta(text);
			if (!meta) {
				unreadable += 1;
				continue;
			}
			// A subagent thread is a conversation of its own that never belonged to
			// the session that spawned it.
			if (meta.child) {
				children += 1;
				continue;
			}
			candidates.push({
				source: "codex",
				sourceId: meta.sessionId || file.plainName.replace(/^rollout-/, "").replace(/\.jsonl$/, ""),
				cwd: meta.cwd,
				title: "",
				startedAt: meta.startedAt || file.mtimeMs,
				path: file.path,
				archived: archived || undefined,
			});
		}
	}
	const notes: HistoryNote[] = [];
	if (children > 0) notes.push({ reason: "subagent thread", count: children });
	if (unreadable > 0) notes.push({ reason: "rollout without session metadata", count: unreadable });
	return { candidates, notes };
}

/** Codex records `{success:false}` for a failed call; nothing else says so. */
function codexOutputIsError(output: string): boolean {
	const trimmed = output.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
	try {
		return asRecord(JSON.parse(trimmed))?.success === false;
	} catch {
		return false;
	}
}

function readCodexSession(
	path: string,
	candidate: HistoryCandidate,
): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const notes: HistoryNote[] = [];
	let reasoning = 0;
	let developer = 0;
	let ignored = 0;
	let malformed = 0;
	const collected: AgentMessage[] = [];
	// One assistant turn arrives as several items — text, then the calls it made —
	// so they accumulate into a single message and are flushed when the next
	// user turn or tool output arrives.
	let pendingAssistant: Extract<AgentMessage, { role: "assistant" }> | null = null;
	const flush = (): void => {
		if (pendingAssistant) collected.push(pendingAssistant);
		pendingAssistant = null;
	};

	for (const line of rolloutLines(path)) {
		if (!line.trim()) continue;
		const row = parseJsonLine(line);
		if (!row) {
			malformed += 1;
			continue;
		}
		if (row.type !== "response_item") continue; // bookkeeping: event_msg, turn_context, …
		const payload = asRecord(row.payload);
		if (!payload) continue;
		const type = asText(payload.type);
		const rawTime = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
		const timestamp = Number.isFinite(rawTime) ? rawTime : candidate.startedAt;

		if (type === "reasoning") {
			reasoning += 1;
			continue;
		}
		if (type === "message") {
			const role = asText(payload.role);
			const content = Array.isArray(payload.content) ? payload.content : [];
			const texts: string[] = [];
			for (const entry of content) {
				const block = asRecord(entry);
				if (!block) continue;
				const text = asText(block.text);
				if (text && (block.type === "input_text" || block.type === "output_text")) texts.push(text);
			}
			if (role === "developer") {
				developer += 1;
				continue;
			}
			if (role === "assistant") {
				if (!pendingAssistant) pendingAssistant = assistantMessage({ timestamp, stopReason: "stop" });
				pendingAssistant.content.push(...texts.map((text) => textContent(text)));
				continue;
			}
			if (role !== "user") {
				ignored += 1;
				continue;
			}
			flush();
			if (texts.length > 0) {
				const text = texts.join("\n\n");
				collected.push(userMessage(text, timestamp));
				if (!candidate.title) candidate.title = firstText(text);
			}
			continue;
		}
		if (type === "function_call" || type === "custom_tool_call") {
			const callId = asText(payload.call_id);
			const name = asText(payload.name) || UNKNOWN_TOOL_NAME;
			if (!callId) {
				ignored += 1;
				continue;
			}
			const rawArguments = type === "function_call" ? asText(payload.arguments) : asText(payload.input);
			if (!pendingAssistant) pendingAssistant = assistantMessage({ timestamp, stopReason: "toolUse" });
			pendingAssistant.content.push({
				type: "toolCall",
				id: callId,
				name,
				arguments: JSON.stringify(parseArguments(rawArguments)),
			});
			pendingAssistant.stopReason = "toolUse";
			continue;
		}
		if (type === "function_call_output" || type === "custom_tool_call_output") {
			const callId = asText(payload.call_id);
			const output = asText(payload.output);
			flush();
			if (!callId) {
				ignored += 1;
				continue;
			}
			collected.push(
				toolResultMessage(callId, UNKNOWN_TOOL_NAME, resultContent(output), codexOutputIsError(output), timestamp),
			);
			continue;
		}
		ignored += 1;
	}
	flush();

	const repaired = repairToolPairing(rewriteToolNames(collected));
	if (malformed > 0) notes.push({ reason: "malformed line", count: malformed });
	if (reasoning > 0) notes.push({ reason: "reasoning item (stored encrypted)", count: reasoning });
	if (developer > 0) notes.push({ reason: "developer message (instructions, not conversation)", count: developer });
	if (ignored > 0) notes.push({ reason: "unsupported response item", count: ignored });
	if (repaired.dropped > 0) notes.push({ reason: "unpaired tool call or result", count: repaired.dropped });
	return { entries: repaired.messages.map((message) => ({ kind: "message", message })), notes };
}

// ---------------------------------------------------------------------------
// ZCode
// ---------------------------------------------------------------------------

function listZcodeHistory(home: string): HistoryListing {
	const candidates: HistoryCandidate[] = [];
	let children = 0;
	for (const session of readZcodeSessions(join(home, ".zcode", "cli", "db", "db.sqlite"))) {
		if (session.parentId) {
			children += 1;
			continue;
		}
		candidates.push({
			source: "zcode",
			sourceId: session.id,
			cwd: session.directory,
			title: session.title,
			startedAt: session.timeCreated,
			path: join(home, ".zcode", "cli", "db", "db.sqlite"),
		});
	}
	const notes: HistoryNote[] = [];
	if (children > 0) notes.push({ reason: "subagent session", count: children });
	return { candidates, notes };
}

/** A compaction's summary text lives in the message the marker points at. */
function zcodeCompactionSummary(part: Record<string, unknown>, partsByMessage: Map<string, ZcodePartRow[]>): string {
	for (const candidate of partsByMessage.get(asText(part.summaryMessageId)) ?? []) {
		const text = asText(candidate.data.text);
		if (text) return text;
	}
	return "(compaction recorded by ZCode; its summary is not in this database)";
}

function readZcodeSession(sourceId: string, home: string): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const { messages, parts } = readZcodeConversation(join(home, ".zcode", "cli", "db", "db.sqlite"), sourceId);
	const notes: HistoryNote[] = [];
	let synthetic = 0;
	let ignored = 0;
	let emptyOutputs = 0;

	const partsByMessage = new Map<string, ZcodePartRow[]>();
	for (const part of parts) {
		const list = partsByMessage.get(part.messageId);
		if (list) list.push(part);
		else partsByMessage.set(part.messageId, [part]);
	}

	const collected: AgentMessage[] = [];
	// A compaction marker belongs right after the message that carried it. Its
	// position is kept as an index into the message stream; if the repair pass
	// drops something, the markers move to the end rather than land mid-stream.
	const markers: Array<{ after: number; entry: HistoryEntry }> = [];
	for (const message of messages) {
		const role = asText(message.data.role);
		const created = asRecord(message.data.time)?.created;
		const timestamp = typeof created === "number" ? created : message.timeCreated;
		const own = [...(partsByMessage.get(message.id) ?? [])].sort((a, b) => a.timeCreated - b.timeCreated);

		if (role === "user") {
			const texts: string[] = [];
			for (const part of own) {
				if (part.type === "text") {
					// Synthetic parts are injected by the tool itself (file contents,
					// reminders) rather than typed by the user.
					if (part.data.synthetic === true) {
						synthetic += 1;
						continue;
					}
					const text = asText(part.data.text);
					if (text) texts.push(text);
					continue;
				}
				if (part.type !== "step-start" && part.type !== "step-finish") ignored += 1;
			}
			if (texts.length > 0) collected.push(userMessage(texts.join("\n\n"), timestamp));
			continue;
		}
		if (role !== "assistant") {
			ignored += own.length;
			continue;
		}

		const content: AssistantContent[] = [];
		const results: AgentMessage[] = [];
		const messageMarkers: HistoryEntry[] = [];
		for (const part of own) {
			if (part.type === "text") {
				const text = asText(part.data.text);
				if (text) content.push(textContent(text));
				continue;
			}
			if (part.type === "reasoning") {
				const thinking = asText(part.data.text);
				if (thinking) content.push({ type: "thinking", thinking });
				continue;
			}
			if (part.type === "tool") {
				const state = asRecord(part.data.state) ?? {};
				const callId = asText(part.data.callID);
				if (!callId) {
					ignored += 1;
					continue;
				}
				const name = asText(part.data.tool) || UNKNOWN_TOOL_NAME;
				content.push({
					type: "toolCall",
					id: callId,
					name,
					arguments: JSON.stringify(parseArguments(asText(state.input))),
				});
				const output = asText(state.output) || asText(state.error);
				if (!output) emptyOutputs += 1;
				results.push(
					toolResultMessage(callId, name, resultContent(output), asText(state.status) === "error", timestamp),
				);
				continue;
			}
			if (part.type === "compaction") {
				const preTokens = typeof part.data.preCompactTokenCount === "number" ? part.data.preCompactTokenCount : 0;
				messageMarkers.push({
					kind: "compaction",
					summary: zcodeCompactionSummary(part.data, partsByMessage),
					preTokens,
				});
				continue;
			}
			if (part.type !== "step-start" && part.type !== "step-finish") ignored += 1;
		}
		if (content.length > 0) {
			const calls = content.some((block) => block.type === "toolCall");
			collected.push(assistantMessage({ content, timestamp, stopReason: calls ? "toolUse" : "stop" }));
			collected.push(...results);
		} else if (results.length > 0) {
			// Results without their call cannot be replayed, and the repair pass
			// below would drop them anyway; counting them is more honest.
			ignored += results.length;
		}
		// The marker follows the message it belonged to, results included.
		for (const entry of messageMarkers) markers.push({ after: collected.length, entry });
	}

	const repaired = repairToolPairing(collected);
	let entries: HistoryEntry[] = repaired.messages.map((message) => ({ kind: "message", message }));
	if (markers.length > 0) {
		if (repaired.dropped === 0) {
			for (const marker of [...markers].sort((a, b) => b.after - a.after)) {
				entries.splice(Math.min(marker.after, entries.length), 0, marker.entry);
			}
		} else {
			entries = [...entries, ...markers.map((marker) => marker.entry)];
		}
	}
	if (synthetic > 0) notes.push({ reason: "tool-injected text part", count: synthetic });
	if (ignored > 0) notes.push({ reason: "unsupported part", count: ignored });
	if (emptyOutputs > 0) notes.push({ reason: "tool call with no recorded output", count: emptyOutputs });
	if (repaired.dropped > 0) notes.push({ reason: "unpaired tool call or result", count: repaired.dropped });
	return { entries, notes };
}

// ---------------------------------------------------------------------------
// DeepSeek Harness
// ---------------------------------------------------------------------------

function listDshHistory(home: string): HistoryListing {
	const listed = listDshSessions(dshRoot(home));
	return {
		candidates: listed.sessions.map((session) => ({
			source: "deepseek-harness",
			sourceId: session.sessionId,
			cwd: session.cwd,
			title: session.title,
			startedAt: session.startedAt,
			path: session.path,
		})),
		notes: listed.notes,
	};
}

// ---------------------------------------------------------------------------
// Grok Build
// ---------------------------------------------------------------------------

function listGrokHistory(home: string): HistoryListing {
	const listed = listGrokSessions(grokRoot(home));
	return {
		candidates: listed.sessions.map((session) => ({
			source: "grok-build",
			sourceId: session.sessionId,
			cwd: session.cwd,
			title: session.title,
			startedAt: session.startedAt,
			path: session.path,
		})),
		notes: listed.notes,
	};
}

/**
 * Read one chosen grok session.
 *
 * The candidate carries the transcript's path and nothing else, while the reader
 * takes the session the listing built: its directory, where the compaction
 * segments are, and its kind and parent, which the report needs to say that a
 * fork's inherited prefix came along. Widening `HistoryCandidate` for one
 * source's vocabulary would put grok's fields in every other source's way, so
 * the session is looked up again instead — and one that went away between the
 * listing and the read is reported rather than reconstructed from a path.
 */
function readGrokHistory(home: string, candidate: HistoryCandidate): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const session = listGrokSessions(grokRoot(home)).sessions.find((found) => found.path === candidate.path);
	if (!session) return { entries: [], notes: [{ reason: "session is no longer on disk", count: 1 }] };
	const read = readGrokSession(session);
	if ("error" in read) return { entries: [], notes: [{ reason: read.error, count: 1 }] };
	return { entries: read.entries, notes: read.notes };
}

// ---------------------------------------------------------------------------
// Kimi Code
// ---------------------------------------------------------------------------

function listKimiHistory(home: string): HistoryListing {
	const listed = listKimiSessions(kimiRoot(home));
	return {
		candidates: listed.sessions.map((session) => ({
			source: "kimi-code",
			sourceId: session.sessionId,
			cwd: session.cwd,
			title: session.title,
			startedAt: session.startedAt,
			path: session.path,
			// Kimi filed this one away rather than leaving it in its list. That is a fact
			// about where the transcript came from, which the report says, not a reason
			// to drop it — the same call the codex source makes for `archived_sessions/`.
			archived: session.archived || undefined,
		})),
		notes: listed.notes,
	};
}

/**
 * Read one chosen kimi session.
 *
 * The candidate carries a path and the reader wants the session the listing
 * built, so it is looked up again rather than rebuilt from the path — and one
 * that went away between the listing and the read is reported, not reconstructed.
 * The reader's own vocabulary is this module's: `KimiEntry` is `HistoryEntry`
 * written out — a message, or a compaction summary with the token count it
 * replaced — so entries cross over as they are rather than through a translation
 * that could disagree with either side.
 */
function readKimiHistory(home: string, candidate: HistoryCandidate): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const session = listKimiSessions(kimiRoot(home)).sessions.find((found) => found.path === candidate.path);
	if (!session) return { entries: [], notes: [{ reason: "session is no longer on disk", count: 1 }] };
	const read = readKimiSession(session);
	if ("error" in read) return { entries: [], notes: [{ reason: read.error, count: 1 }] };
	return { entries: read.entries, notes: read.notes };
}

// ---------------------------------------------------------------------------
// MiniMax Code
// ---------------------------------------------------------------------------

/**
 * Every session MiniMax's own walk would find, as candidates.
 *
 * The archived flag travels as a fact about where the transcript came from — the
 * same call the codex source makes for `archived_sessions/` and kimi for the
 * sessions it filed away — because archived is a place a session was put, not a
 * reason it is worth less. A session the tool hides or files under an internal
 * kind never reaches here: the listing counts it and says why.
 */
function listMinimaxHistory(home: string): HistoryListing {
	const listed = listMinimaxSessions(minimaxRoot(home).root);
	return {
		candidates: listed.sessions.map((session) => ({
			source: "minimax-code",
			sourceId: session.sessionId,
			cwd: session.cwd,
			title: session.title,
			startedAt: session.startedAt,
			path: session.path,
			archived: session.archived || undefined,
		})),
		notes: listed.notes,
	};
}

/**
 * Read one chosen MiniMax session.
 *
 * The candidate carries a path and the reader wants the session the listing
 * built — its directory, which writer left the transcript, and the kind and
 * parent the report needs — so the session is looked up again rather than
 * rebuilt from the path. One that went away between the listing and the read is
 * reported, not reconstructed.
 */
function readMinimaxHistory(
	home: string,
	candidate: HistoryCandidate,
): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const session = listMinimaxSessions(minimaxRoot(home).root).sessions.find((found) => found.path === candidate.path);
	if (!session) return { entries: [], notes: [{ reason: "session is no longer on disk", count: 1 }] };
	const read = readMinimaxSession(session);
	if ("error" in read) return { entries: [], notes: [{ reason: read.error, count: 1 }] };
	return { entries: read.entries, notes: read.notes };
}

/** `<root>/user-history` — one JSONL file per working directory. */
function countKimiHistoryFiles(root: string): number {
	try {
		return readdirSync(kimiInputHistoryDir(root)).filter((name) => name.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

/**
 * `<root>/user-history/<md5(cwd)>.jsonl`, one `{"content": "…"}` per line.
 *
 * Two things about this file decide the shape of the reader.
 *
 * The name is a hash of the working directory, so it is one-way: the only list
 * this reader can find by itself is the current project's. Scope `all` asks for
 * every project, and the way back to the others is the sessions — each records
 * the directory it ran in, so hashing that finds its file. A project whose
 * sessions are all gone keeps its prompts out of reach, and that is counted
 * rather than passed over, because the format cannot tell this reader which
 * directory an unreachable file belongs to.
 *
 * And a line carries its text and nothing else: no timestamp, no directory. The
 * directory is the file's, and time is what the format does not have — the file
 * is append-only, so its order is the only ordering there is. These entries
 * therefore arrive newest-first with epoch 0, which is what keeps the per-source
 * limit taking the newest end: the selection sorts by that timestamp and is
 * stable, so equal keys keep the order they were read in.
 */
function readKimiPromptHistory(
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	const scan: PromptScan = { candidates: [], counts: new Map(), seen: 0, truncated: false };
	const root = kimiRoot(home);
	// The current project first, so the file a user is most likely asking about is
	// the one that is read even when nothing else can be found.
	const cwds = [options.cwd];
	if (options.scope === "all") {
		const known = new Set(cwds.map((cwd) => projectKey(cwd)));
		for (const session of listKimiSessions(root).sessions) {
			if (session.cwd === "" || known.has(projectKey(session.cwd))) continue;
			known.add(projectKey(session.cwd));
			cwds.push(session.cwd);
		}
		const files = countKimiHistoryFiles(root);
		if (files > cwds.length) {
			bump(scan.counts, "prompt history whose project has no session left to name it", files - cwds.length);
		}
	}
	for (const cwd of cwds) readKimiPromptLines(kimiInputHistoryFile(root, cwd), cwd, scan);
	return selectPrompts(scan, options);
}

/** Fold one project's remembered prompts into the scan. */
function readKimiPromptLines(path: string, cwd: string, scan: PromptScan): void {
	if (!existsSync(path)) return;
	const tail = readTailLines(path, PROMPT_HISTORY_BYTES);
	scan.truncated = scan.truncated || tail.truncated;
	for (const line of tail.lines.reverse()) {
		if (!line.trim()) continue;
		const parsed = parseJsonLine(line);
		if (!parsed) {
			bump(scan.counts, "line not in the history shape");
			continue;
		}
		scan.seen += 1;
		const text = asText(parsed.content).trim();
		if (!text) {
			bump(scan.counts, "empty prompt");
			continue;
		}
		// Kimi stores a shell line with the `!` its own recall strips off again, so the
		// marker is the source's and not a guess: recalling one here would offer `!ls`
		// as a prompt and send the shell line as a message.
		if (text.startsWith("!")) {
			bump(scan.counts, "`!` command");
			continue;
		}
		// This build's recall list is a list of prompts, and a slash command it offered
		// would be sent as one. A command the palette consumed never reached kimi's
		// recorder at all, so a line that starts with a slash is text that does.
		if (text.startsWith("/")) {
			bump(scan.counts, "slash command");
			continue;
		}
		if (PASTE_PLACEHOLDER.test(text)) {
			bump(scan.counts, "prompt whose text was a pasted block, stored without its body");
			continue;
		}
		scan.candidates.push({ text, cwd, timestamp: 0 });
	}
}
// ---------------------------------------------------------------------------
// Dispatch and output
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt history (the ↑ recall list)
// ---------------------------------------------------------------------------

/**
 * Prompts imported per source.
 *
 * Deliberately not `--history-limit`: that one counts conversations, where each
 * is a file and a resume candidate. A prompt is a line, and a user who wanted
 * twenty conversations did not ask for twenty remembered prompts.
 */
export const DEFAULT_PROMPT_HISTORY_LIMIT = 500;

/** How much of a history file to read; the newest prompts are at its end. */
const PROMPT_HISTORY_BYTES = 4 * 1024 * 1024;

/** One recalled prompt, in the shape `~/.labunbun/history.jsonl` stores. */
export interface PromptEntry {
	text: string;
	cwd: string;
	timestamp: number;
}

/** What one source contributes to the recall list, and what it held back. */
export interface PromptHistoryInput {
	/** Lines the source's history had, before any filter. Zero means it has none. */
	seen: number;
	entries: PromptEntry[];
	notes: HistoryNote[];
	/** Prompts inside the scope but past the limit. */
	overLimit: number;
	/** The file was larger than this reads, so only its newest end was considered. */
	truncated: boolean;
	/**
	 * Set when this source has no prompt list anywhere, with the reason to report.
	 *
	 * A source with an empty list and a source with no list look the same from
	 * `seen`, and the difference is the whole point for a reader wondering why their
	 * prompts did not appear: one means "nothing was typed", the other "nothing is
	 * kept". Only sources whose tree was actually walked set this, so the line means
	 * a list was looked for and there is none — not that a directory was missing.
	 */
	absent?: string;
}

export type PromptHistoryImport = Partial<Record<MigrationSourceId, PromptHistoryInput>>;

/**
 * `[Pasted text #1 +42 lines]` — a pointer into the paste store, not a prompt.
 *
 * A display that only names a paste would be recalled as that sentence, which
 * is not something anyone can use; a display that merely contains one is a real
 * prompt and travels as it is written.
 */
const PASTE_PLACEHOLDER = /^\[Pasted text #\d+(\s*\+\s*\d+ lines?)?\]$/;

/** Epoch ms from either seconds or milliseconds — the sources disagree. */
function toEpochMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return value < 1e11 ? Math.round(value * 1000) : value;
}

/** A prompt that passed the shape checks, before the scope and the limit. */
interface PromptCandidate {
	text: string;
	cwd: string;
	timestamp: number;
}

/** Why lines were left behind, counted as they are read. */
interface PromptScan {
	candidates: PromptCandidate[];
	counts: Map<string, number>;
	seen: number;
	truncated: boolean;
}

function bump(counts: Map<string, number>, reason: string, by = 1): void {
	counts.set(reason, (counts.get(reason) ?? 0) + by);
}

/**
 * Apply the scope, the limit and the ordering to the prompts of one source.
 *
 * The limit takes the newest prompts: the point of importing them is to have
 * them back, and a user reaching for ↑ is reaching for what they were doing
 * recently, not for what they were doing last year.
 */
function selectPrompts(
	scan: PromptScan,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	const inScope =
		options.scope === "cwd" ? scan.candidates.filter((c) => sameProject(c.cwd, options.cwd)) : scan.candidates;
	if (inScope.length < scan.candidates.length) {
		bump(scan.counts, "prompt from another directory", scan.candidates.length - inScope.length);
	}
	const newest = [...inScope].sort((a, b) => b.timestamp - a.timestamp);
	const kept = newest.slice(0, Math.max(0, options.limit));
	return {
		seen: scan.seen,
		entries: kept.sort((a, b) => a.timestamp - b.timestamp),
		notes: [...scan.counts].map(([reason, count]) => ({ reason, count })),
		overLimit: inScope.length - kept.length,
		truncated: scan.truncated,
	};
}

/** `~/.claude/history.jsonl`: `{display, project, timestamp}`. */
function readClaudePromptHistory(
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	const scan: PromptScan = { candidates: [], counts: new Map(), seen: 0, truncated: false };
	if (!existsSync(join(home, ".claude", "history.jsonl"))) return selectPrompts(scan, options);
	const tail = readTailLines(join(home, ".claude", "history.jsonl"), PROMPT_HISTORY_BYTES);
	scan.truncated = tail.truncated;
	for (const line of tail.lines) {
		if (!line.trim()) continue;
		const parsed = parseJsonLine(line);
		if (!parsed) {
			bump(scan.counts, "line not in the history shape");
			continue;
		}
		scan.seen += 1;
		const text = asText(parsed.display).trim();
		const cwd = asText(parsed.project);
		if (!text) {
			bump(scan.counts, "empty prompt");
			continue;
		}
		// The local recorder skips these, so importing them would put lines in the
		// file that this build's own ↑ would never have offered.
		if (text.startsWith("/")) {
			bump(scan.counts, "slash command");
			continue;
		}
		if (PASTE_PLACEHOLDER.test(text)) {
			bump(scan.counts, "prompt whose text was a pasted block, stored without its body");
			continue;
		}
		if (!cwd) {
			bump(scan.counts, "prompt with no project recorded");
			continue;
		}
		scan.candidates.push({ text, cwd, timestamp: toEpochMs(parsed.timestamp) });
	}
	return selectPrompts(scan, options);
}

/**
 * `<CODEX_HOME>/history.jsonl`: `{session_id, text, ts}`.
 *
 * It names the session, not the directory, so the directory comes from the
 * rollout of that session — the same metadata the session listing reads, and the
 * same listing that knows about `archived_sessions/`: a prompt answered in a
 * session the user later archived must still find its project. A prompt whose
 * session has no rollout left on disk cannot be located to a project, and an
 * entry that no directory can recall is not worth writing.
 */
function readCodexPromptHistory(
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	const scan: PromptScan = { candidates: [], counts: new Map(), seen: 0, truncated: false };
	const historyFile = join(codexRoot(home), "history.jsonl");
	// Before the rollout scan, not after: locating each prompt costs a head-read
	// per rollout, and a home with no prompt history has nothing to locate.
	if (!existsSync(historyFile)) return selectPrompts(scan, options);
	const directories = new Map<string, string>();
	for (const candidate of listCodexHistory(home).candidates) {
		if (candidate.cwd) directories.set(candidate.sourceId, candidate.cwd);
	}
	const tail = readTailLines(historyFile, PROMPT_HISTORY_BYTES);
	scan.truncated = tail.truncated;
	for (const line of tail.lines) {
		if (!line.trim()) continue;
		const parsed = parseJsonLine(line);
		if (!parsed) {
			bump(scan.counts, "line not in the history shape");
			continue;
		}
		scan.seen += 1;
		const text = asText(parsed.text).trim();
		if (!text) {
			bump(scan.counts, "empty prompt");
			continue;
		}
		if (text.startsWith("/")) {
			bump(scan.counts, "slash command");
			continue;
		}
		const cwd = directories.get(asText(parsed.session_id));
		if (!cwd) {
			bump(scan.counts, "prompt whose session has no rollout on disk");
			continue;
		}
		scan.candidates.push({ text, cwd, timestamp: toEpochMs(parsed.ts) });
	}
	return selectPrompts(scan, options);
}

/**
 * `$GROK_HOME/sessions/<cwd-dir>/prompt_history.jsonl`: `{timestamp, session_id,
 * prompt, is_bash}`.
 *
 * The file is per working directory rather than per home — grok keeps one beside
 * each project's sessions, which is what its own ↑ filters on — so the directory
 * comes from where the file sits (a line does not name one) and the scope decides
 * which files are worth opening at all. Under `cwd` that is the one file for the
 * project being migrated; under `all` it is every project's.
 *
 * A directory whose name decodes to no path and which has no `.cwd` sidecar is
 * skipped with a count: prompts written into the wrong project's recall list are
 * worse than prompts left behind, and recall is filtered by directory.
 */
function readGrokPromptHistory(
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	const scan: PromptScan = { candidates: [], counts: new Map(), seen: 0, truncated: false };
	const root = grokSessionsRoot(grokRoot(home));
	let names: string[];
	try {
		names = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return selectPrompts(scan, options);
	}
	for (const name of names) {
		const dir = join(root, name);
		const cwd = decodeGrokCwdDir(dir);
		if (cwd === null || (options.scope === "cwd" && !sameProject(cwd, options.cwd))) {
			if (cwd === null && existsSync(join(dir, "prompt_history.jsonl"))) {
				bump(scan.counts, "prompt history with no working directory recorded");
			}
			continue;
		}
		readGrokPromptLines(join(dir, "prompt_history.jsonl"), cwd, scan);
	}
	return selectPrompts(scan, options);
}

/** Fold one project's remembered prompts into the scan. */
function readGrokPromptLines(path: string, cwd: string, scan: PromptScan): void {
	if (!existsSync(path)) return;
	const tail = readTailLines(path, PROMPT_HISTORY_BYTES);
	// One truncated file makes the whole import partial, and the note is about the
	// import rather than about a file, so the flag is the source's and not this
	// file's.
	scan.truncated = scan.truncated || tail.truncated;
	for (const line of tail.lines) {
		if (!line.trim()) continue;
		const parsed = parseJsonLine(line);
		if (!parsed) {
			bump(scan.counts, "line not in the history shape");
			continue;
		}
		scan.seen += 1;
		const text = asText(parsed.prompt).trim();
		if (!text) {
			bump(scan.counts, "empty prompt");
			continue;
		}
		// A `!` command is a shell line grok remembered, not words that were sent
		// to a model. Recalling it here would offer `! ls` as a prompt, and picking
		// it would send the shell line as a message.
		if (parsed.is_bash === true) {
			bump(scan.counts, "`!` command");
			continue;
		}
		if (text.startsWith("/")) {
			bump(scan.counts, "slash command");
			continue;
		}
		if (PASTE_PLACEHOLDER.test(text)) {
			bump(scan.counts, "prompt whose text was a pasted block, stored without its body");
			continue;
		}
		scan.candidates.push({ text, cwd, timestamp: toEpochMs(grokStamp(parsed.timestamp)) });
	}
}

/** The recall list is filtered and sorted by time, and grok writes RFC 3339. */
function grokStamp(value: unknown): unknown {
	return typeof value === "string" ? Date.parse(value) : value;
}

// ---------------------------------------------------------------------------
// Step Code
// ---------------------------------------------------------------------------

/**
 * Every session Step's own session list would show, as candidates.
 *
 * The walk behind `listStepSessions` is `stepSessionScan`'s: the canonical tree
 * and the pre-rename one, the configured session directory read in either
 * layout, and a file that appears in more than one of them taken once. A file
 * the scan passed over arrives as a note with the reason it could not become a
 * session, folded the way kimi's and MiniMax's listings fold theirs.
 */
function listStepHistory(home: string): HistoryListing {
	const listed = listStepSessions(home);
	const counts = new Map<string, number>();
	for (const skip of listed.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
	return {
		candidates: listed.sessions.map((session) => ({
			source: "step-code",
			sourceId: session.id,
			// A session that states no working directory is listed with an empty
			// one, as kimi and MiniMax do with a header that names none: a scope
			// filter is a question about a directory, and `""` is not one.
			cwd: session.cwd ?? "",
			title: session.title ?? "",
			startedAt: session.startedAt,
			path: session.path,
		})),
		notes: [...counts].map(([reason, count]) => ({ reason, count })),
	};
}

/**
 * Read one chosen Step session.
 *
 * The listing reads a bounded head of each file to find its name; the session
 * this returns is the one the listing built, looked up again rather than rebuilt
 * from the path — a file that went away between the two is reported, not
 * reconstructed. `StepEntry` is `HistoryEntry` written out, so entries cross
 * over as they are.
 */
function readStepHistory(home: string, candidate: HistoryCandidate): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const session = listStepSessions(home).sessions.find((found) => found.path === candidate.path);
	if (!session) return { entries: [], notes: [{ reason: "session is no longer on disk", count: 1 }] };
	const read = readStepSession(session);
	if ("error" in read) return { entries: [], notes: [{ reason: read.error, count: 1 }] };
	return { entries: read.entries, notes: read.notes };
}

/** Prompts a source remembers, ready to be merged into the recall list. */
export function readPromptHistory(
	source: MigrationSourceId,
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	if (options.scope === "none") return { seen: 0, entries: [], notes: [], overLimit: 0, truncated: false };
	if (source === "claude-code") return readClaudePromptHistory(home, options);
	if (source === "codex") return readCodexPromptHistory(home, options);
	if (source === "grok-build") return readGrokPromptHistory(home, options);

	if (source === "kimi-code") return readKimiPromptHistory(home, options);

	// MiniMax has no prompt list, and the reason is specific enough to be worth a
	// line rather than the usual silence. Three things on its disk could be mistaken
	// for one, and it writes none of them as one: the composer's unsent drafts are
	// text the user never sent (`v2/mcode/drafts`), the sessions hold the prompts
	// themselves — those are imported as transcripts — and the shell's own history
	// is a file MiniMax protects rather than reads (`.bash_history` / `.zsh_history`
	// appear in its sensitive-file list, `agent-modules/permission/src/tools/fs-permission.ts:53-54`).
	// So the ↑ list gets nothing from this source while the prompts it does know
	// about come across inside their sessions, and a reader who asked for MiniMax
	// history is owed that distinction.
	if (source === "minimax-code") {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent:
				"MiniMax keeps no cross-session prompt list — its sessions hold the prompts themselves, its drafts hold text " +
				"you never sent, and shell history is a file it protects rather than reads — so nothing was added to the ↑ " +
				"recall list, and the prompts you sent come across with their sessions",
		};
	}

	// Step's recall list is not on disk at all, which is a stronger statement than
	// MiniMax's and worth making in its own words: the editor keeps it in memory,
	// capped at 100 entries (`packages/tui/src/components/editor.ts:318-408`), and
	// writes it nowhere. A home with no such file is not a home whose list was
	// empty — the list does not outlive the process, and no reader could have
	// found it however it was written.
	if (source === "step-code") {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent:
				"Step keeps its ↑ recall list in memory only — the editor holds the last 100 prompts and never writes them " +
				"to a file — so there is nothing to read here for any home, and the prompts you sent come across with " +
				"their sessions",
		};
	}
	return { seen: 0, entries: [], notes: [], overLimit: 0, truncated: false };
}

/** What a source offers, narrowed to the requested scope. */
export function listHistory(
	source: MigrationSourceId,
	home: string,
	options: { cwd: string; scope: HistoryScope },
): HistoryListing {
	if (options.scope === "none") return { candidates: [], notes: [] };
	const listed =
		source === "claude-code"
			? listClaudeCodeHistory(home)
			: source === "codex"
				? listCodexHistory(home)
				: source === "zcode"
					? listZcodeHistory(home)
					: source === "deepseek-harness"
						? listDshHistory(home)
						: source === "grok-build"
							? listGrokHistory(home)
							: source === "kimi-code"
								? listKimiHistory(home)
								: source === "minimax-code"
									? listMinimaxHistory(home)
									: source === "step-code"
										? listStepHistory(home)
										: { candidates: [] as HistoryCandidate[], notes: [] as HistoryNote[] };
	return narrowCandidates(listed, options);
}

/**
 * Apply the user's selection and the per-source limit.
 *
 * The selection is applied before the cap because it is a decision about which
 * sessions matter: a picker that offered twenty choices must not silently drop
 * half of them to the default limit afterwards.
 */
export function selectHistory(
	listing: HistoryListing,
	options: { limit: number; selected?: string[] },
): { chosen: HistoryCandidate[]; overLimit: number } {
	const wanted = options.selected ? new Set(options.selected) : null;
	const matching = wanted
		? listing.candidates.filter((candidate) => wanted.has(candidate.sourceId))
		: listing.candidates;
	const chosen = matching.slice(0, options.limit);
	return { chosen, overLimit: matching.length - chosen.length };
}

/** Resolve `--history-scope`; the default is the conservative one. */
export function parseHistoryScope(value: string | undefined): HistoryScope | { error: string } {
	if (value === undefined || value.trim() === "") return "cwd";
	const trimmed = value.trim() as HistoryScope;
	if (!HISTORY_SCOPES.includes(trimmed)) {
		return { error: `Invalid history scope: ${value} (expected ${HISTORY_SCOPES.join(", ")})` };
	}
	return trimmed;
}

/**
 * Everything one source contributes: list it, take the user's selection, then
 * convert. The three phases stay separate because the middle one is the user's
 * — a picker needs the listing before it can ask, and only the chosen sessions
 * are worth converting.
 */
export function collectHistory(
	source: MigrationSourceId,
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number; selected?: string[] },
): HistoryInput {
	const listing = listHistory(source, home, { cwd: options.cwd, scope: options.scope });
	const { chosen, overLimit } = selectHistory(listing, { limit: options.limit, selected: options.selected });
	const read = readHistory(source, home, chosen);
	return { sessions: read.sessions, notes: mergeNotes([...listing.notes, ...read.notes]), overLimit };
}

/** Convert the chosen sessions; a candidate that fails to convert is counted. */
export function readHistory(source: MigrationSourceId, home: string, chosen: HistoryCandidate[]): HistoryReadResult {
	const sessions: HistorySession[] = [];
	const notes: HistoryNote[] = [];
	let failed = 0;
	for (const candidate of chosen) {
		let converted: { entries: HistoryEntry[]; notes: HistoryNote[] };
		try {
			if (source === "claude-code") converted = readClaudeCodeSession(candidate.path, candidate);
			else if (source === "codex") converted = readCodexSession(candidate.path, candidate);
			else if (source === "zcode") converted = readZcodeSession(candidate.sourceId, home);
			else if (source === "deepseek-harness") {
				const read = readDshLog(candidate.path);
				// A log this build must not reconstruct (an event type it does not know)
				// is a skip, not a failure of the run: the reader's own reason becomes
				// the note, and the session it names is reported rather than guessed at.
				if ("error" in read) {
					notes.push({ reason: read.error, count: 1 });
					continue;
				}
				converted = { entries: read.entries, notes: read.notes };
			} else if (source === "grok-build") {
				const read = readGrokHistory(home, candidate);
				// A session that could not be read — or one whose every line was a tool
				// call — is reported by why it came to nothing rather than counted as a
				// session that was empty. "Nothing to import" is a claim about the user's
				// conversation, and this reader is in no position to make it when the
				// reason it holds nothing is that it could not open the file.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else if (source === "kimi-code") {
				const read = readKimiHistory(home, candidate);
				// Same rule as grok: a session that could not be read is reported by why,
				// rather than counted as a session that was empty. "Nothing to import" is a
				// claim about the user's conversation, and this reader is in no position to
				// make it when the reason it holds nothing is that it could not open the file.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else if (source === "minimax-code") {
				const read = readMinimaxHistory(home, candidate);
				// Same rule as grok and kimi: a session that could not be read is reported
				// by why, rather than counted as a session that was empty. "Nothing to
				// import" is a claim about the user's conversation, and this reader is in no
				// position to make it when the reason it holds nothing is that it could not
				// open the file.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else if (source === "step-code") {
				const read = readStepHistory(home, candidate);
				// Same rule as its three neighbours: a session that could not be read is
				// reported by why, rather than counted as a session that was empty.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else continue;
		} catch {
			failed += 1;
			continue;
		}
		if (converted.entries.length === 0) {
			failed += 1;
			continue;
		}
		notes.push(...converted.notes);
		sessions.push({
			source,
			sourceId: candidate.sourceId,
			cwd: candidate.cwd,
			title: candidate.title,
			startedAt: candidate.startedAt,
			entries: converted.entries,
			archived: candidate.archived,
		});
	}
	if (failed > 0) notes.push({ reason: "session with nothing to import", count: failed });
	return { sessions, notes: mergeNotes(notes) };
}

/** Sum counts for the same reason, keeping first-seen order. */
export function mergeNotes(notes: HistoryNote[]): HistoryNote[] {
	const order: string[] = [];
	const counts = new Map<string, number>();
	for (const note of notes) {
		if (!counts.has(note.reason)) order.push(note.reason);
		counts.set(note.reason, (counts.get(note.reason) ?? 0) + note.count);
	}
	return order.map((reason) => ({ reason, count: counts.get(reason) ?? 0 }));
}

/**
 * The target session id: derived from the source session's id, so importing the
 * same session twice names the same file and the second run is a no-op.
 */
export function importedSessionId(source: MigrationSourceId, sourceId: string): string {
	const digest = createHash("sha256").update(sourceId).digest("hex").slice(0, 8);
	return `imported-${source}-${digest}`;
}

/** The session file a converted session would be written to. */
export function historyPath(session: HistorySession, home: string): string {
	return sessionFilePath(session.cwd, importedSessionId(session.source, session.sourceId), home);
}

/**
 * Render a converted session as the JSONL `SessionStore` reads: a header, then
 * one entry per line, each linked to the previous by id.
 *
 * Ids are derived from the session id and the entry's index rather than
 * generated, so re-running the import over the same source produces the same
 * bytes — which is what makes a second `--apply` a no-op instead of a rewrite.
 */
export function renderHistorySession(session: HistorySession): string {
	const sessionId = importedSessionId(session.source, session.sourceId);
	const lines: string[] = [];
	let parentId: string | null = null;
	const push = (entry: SessionEntry): void => {
		lines.push(JSON.stringify(entry));
		parentId = entry.id;
	};
	push({
		id: `${sessionId}-0`,
		parentId: null,
		type: "header",
		version: 1,
		sessionId,
		cwd: session.cwd,
		createdAt: session.startedAt || Date.now(),
	});
	session.entries.forEach((entry, index) => {
		const id = `${sessionId}-${index + 1}`;
		const parent = parentId ?? `${sessionId}-0`;
		if (entry.kind === "compaction") {
			push({
				id,
				parentId: parent,
				type: "compaction",
				timestamp: session.startedAt,
				// The source tool already replaced its own prefix with this summary, so
				// the boundary is the same one ours would have written. Synthesized from
				// the same builder, so an imported session resumes like a native one.
				message: compactionBoundary(entry.summary, { timestamp: session.startedAt }),
				summary: entry.summary,
				preservedFiles: [],
				preTokens: entry.preTokens,
				// Neither is recorded by the tools we import from; zero and a source
				// label, rather than a guess dressed up as a measurement.
				postTokens: 0,
				model: "imported",
				trigger: "manual",
			});
			return;
		}
		push({
			id,
			parentId: parent,
			type: "message",
			timestamp: entry.message.timestamp,
			message: entry.message,
		});
	});
	return `${lines.join("\n")}\n`;
}
