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
import { listAlmaHistory, readAlmaConversation } from "./alma-session.ts";
import { antigravityDataDirs, antigravityTreeHasContent } from "./antigravity-home.ts";
import { listAntigravityConversations, readAntigravityConversation } from "./antigravity-session.ts";
import { listCodewhaleSessions, readCodewhaleSession } from "./codewhale-session.ts";
import { codexRoot } from "./codex-home.ts";
import { cursorPromptHistoryFile, cursorPromptHistoryPath } from "./cursor-home.ts";
import { dshRoot } from "./dsh-home.ts";
import { listDshSessions, readDshLog } from "./dsh-session.ts";
import { decodeGrokCwdDir, grokRoot, grokSessionsRoot } from "./grok-home.ts";
import { listGrokSessions, readGrokSession } from "./grok-session.ts";
import { kimiInputHistoryDir, kimiInputHistoryFile, kimiRoot } from "./kimi-home.ts";
import { listKimiSessions, readKimiSession } from "./kimi-session.ts";
import { readText, tildePath } from "./migrate-core.ts";
import type { MigrationSourceId } from "./migrate-types.ts";
import { mimocodeDatabasePath, mimocodeRoots } from "./mimocode-home.ts";
import {
	type MiMoCodePartRow,
	readMiMoCodeConversation,
	readMiMoCodeMessageScope,
	readMiMoCodeSessions,
} from "./mimocode-session.ts";
import { minimaxRoot } from "./minimax-home.ts";
import { listMinimaxSessions, readMinimaxSession } from "./minimax-session.ts";
import { openclawStateDir } from "./openclaw-home.ts";
import { openclawAgentDbPath, readOpenClawEvents, readOpenClawSessionWindows } from "./openclaw-session.ts";
import {
	type OpencodePartRow,
	type OpencodeSessionMessageRow,
	readOpencodeConversation,
	readOpencodeSessionMessages,
	readOpencodeSessions,
} from "./opencode-db.ts";
import { opencodeDatabasePath, opencodePromptHistoryFile, opencodeRoots } from "./opencode-home.ts";
import { listQoderHistory, QODER_HISTORY_NOT_IMPORTED } from "./qoder-session.ts";
import { listStepSessions, readStepSession } from "./step-session.ts";
import { t3BaseDir } from "./t3-home.ts";
import { t3SessionMessages, t3SessionRows } from "./t3-read.ts";
import { readZcodeConversation, readZcodeSessions, type ZcodePartRow } from "./zcode-db.ts";
import { zcodeDbPathFor } from "./zcode-read.ts";

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
	/**
	 * Set when the source records **no** directory for this session and the session
	 * is filed under one anyway. {@link cwd} is already that directory; this field
	 * is the marker that says the directory is the user's and not the source's.
	 *
	 * **Nothing is gained by leaving {@link cwd} empty and resolving this later,
	 * and one thing is lost.** An empty cwd is the value `narrowCandidates` counts
	 * under "no working directory recorded" and drops, which is right for a source
	 * that records directories and had one session without one (dsh's `_no-cwd`
	 * bucket). Applying it to a source that records *no* directory for *any*
	 * session drops every session while the report looks clean — and since the
	 * default scope is `cwd`, it would do so on the default run. So the substitute
	 * is applied where it is chosen, the source that chose it says why in a note,
	 * and this flag survives to the report so the sentence the user reads can name
	 * the difference between "recorded" and "assumed". This is the same shape the
	 * prompt-history path uses for the same reason
	 * ({@link PromptHistoryInput.cwdSubstitute}).
	 */
	cwdSubstitute?: string;
	/** Empty when the source does not name a session; filled in during conversion. */
	title: string;
	/** Epoch ms of the session's first entry. */
	startedAt: number;
	/** Where the source keeps it, so the read phase need not derive the path again. */
	path: string;
	/**
	 * The source had filed this session away rather than leaving it in the
	 * ordinary place, and a reader of the report deserves to know the transcript
	 * came from there. Codex moves a rollout into `archived_sessions/` when the
	 * user archives it; OpenCode keeps a nullable `time_archived` on the row
	 * instead, which is the same statement written in a different storage engine.
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
	/**
	 * Carried from the candidate unchanged: see
	 * {@link HistoryCandidate.cwdSubstitute}. {@link cwd} already holds the
	 * directory, so this is purely the marker the report reads to say the directory
	 * was assumed rather than recorded — and the prompt-history report reads the
	 * same way, so the two halves of `/migrate` use one vocabulary.
	 */
	cwdSubstitute?: string;
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
	// Resolved once: the path depends on a variable and on a setting inside the
	// config file it leads to, and three copies of that rule is how a user whose
	// CLI tree moved ends up with their transcripts reported as none.
	const dbPath = zcodeDbPathFor(home);
	for (const session of readZcodeSessions(dbPath)) {
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
			path: dbPath,
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
	const { messages, parts } = readZcodeConversation(zcodeDbPathFor(home), sourceId);
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
// OpenCode
// ---------------------------------------------------------------------------

/**
 * What a compaction marker says when the transcript holds the trigger but not the
 * summary. OpenCode's own reader only accepts a completed pair
 * (`session/compaction.ts:108` — a summary that also has to be finished and
 * unerrored), so a compaction recorded by a build that was interrupted leaves
 * exactly this case; saying so beats dropping the marker, which would import a
 * transcript that silently claims never to have been summarized.
 */
const OPENCODE_MISSING_SUMMARY = "(compaction recorded by OpenCode; its summary is not in this database)";

/** The database this install reads, resolved the way the reader resolves it. */
function opencodeDbPathFor(home: string): string | null {
	return opencodeDatabasePath(opencodeRoots(home).data);
}

/**
 * OpenCode's sessions, as history candidates.
 *
 * A subagent session (`parent_id` set) is counted and skipped for the same reason
 * ZCode's are: it is a task the primary ran, not a conversation the user had, and
 * importing it would replay the subagent's turns as though the user had typed
 * them. An archived session is imported with the flag rather than skipped, which
 * is what Codex's `archived_sessions/` already does — it is a real conversation
 * the user chose to put away, and "archived" is a property the target records too.
 */
function listOpencodeHistory(home: string): HistoryListing {
	const candidates: HistoryCandidate[] = [];
	let children = 0;
	// Resolved once, for the same reason `listZcodeHistory` does it: the name of
	// the file depends on a variable and on which channel this build was installed
	// from, and a listing that disagreed with the reader would report a source as
	// holding transcripts that the read phase then finds nowhere.
	const dbPath = opencodeDbPathFor(home);
	if (dbPath === null) return { candidates, notes: [] };
	for (const session of readOpencodeSessions(dbPath)) {
		if (session.parentId) {
			children += 1;
			continue;
		}
		candidates.push({
			source: "opencode",
			sourceId: session.id,
			cwd: session.directory,
			title: session.title,
			startedAt: session.timeCreated,
			path: dbPath,
			...(session.timeArchived > 0 ? { archived: true } : {}),
		});
	}
	const notes: HistoryNote[] = [];
	if (children > 0) notes.push({ reason: "subagent session", count: children });
	return { candidates, notes };
}

/**
 * A compaction's summary text, the way `summaryText` assembles it
 * (`session/compaction.ts:87-95`): text parts alone, each trimmed, blanks dropped,
 * joined by a blank line, and the whole trimmed again.
 */
function opencodeSummaryText(parts: OpencodePartRow[]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => asText(part.data.text).trim())
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

/**
 * A tool's recorded answer, in the order v1's `output` then `error` put them.
 *
 * **v2 has no `state.output`.** The four arms of `ToolState`
 * (`packages/schema/src/session-message.ts:83-114`) carry their answer in
 * three different places: a completed call has `result` (typed `unknown`, so a
 * tool that returns something other than a string is stringified here) and
 * `content[]` of `text`/`file` blocks; a failed one has `error.message`;
 * pending and running have none of the three. `result` first because that is
 * what v1's `output` held — the tool's own answer rather than the rendering of
 * it — and `content` last because it is the fallback for a tool that filled in
 * only its model-facing blocks.
 */
function opencodeV2ToolOutput(state: Record<string, unknown>): string {
	const result = state.result;
	if (typeof result === "string" && result !== "") return result;
	const error = asRecord(state.error);
	const message = error === null ? "" : asText(error.message);
	if (message !== "") return message;
	const blocks: string[] = [];
	for (const block of Array.isArray(state.content) ? state.content : []) {
		const entry = asRecord(block);
		if (entry === null) continue;
		if (entry.type === "text") {
			const text = asText(entry.text);
			if (text) blocks.push(text);
			continue;
		}
		// A file block has no text to carry, so it is named by whichever of the
		// two identifying fields it has rather than dropped without a word.
		if (entry.type === "file") blocks.push(`[file] ${asText(entry.name) || asText(entry.uri)}`);
	}
	return blocks.join("\n");
}

/**
 * `ToolState.input` is a **string** on the pending arm and a record on the other
 * three (`session-message.ts:85-113`), so a call that was recorded before it ran
 * has arguments this would otherwise stringify to `{}`.
 */
function opencodeV2ToolArguments(input: unknown): string {
	if (typeof input === "string") return input;
	const record = asRecord(input);
	return record === null ? "{}" : JSON.stringify(record);
}

/**
 * Pair the repaired message stream with the compaction markers, in that order.
 *
 * A marker's position is an index into `collected` recorded as the stream was
 * built, and a repair pass that dropped something invalidates it — so when
 * anything was dropped the markers all move to the end rather than land at
 * positions that no longer mean what they said. The drop count comes back
 * because the caller reports it: an unpaired half is a thing left out.
 */
function assembleOpencodeEntries(
	collected: AgentMessage[],
	markers: Array<{ after: number; entry: HistoryEntry }>,
): { entries: HistoryEntry[]; dropped: number } {
	const repaired = repairToolPairing(collected);
	const entries: HistoryEntry[] = repaired.messages.map((message) => ({ kind: "message", message }));
	if (markers.length > 0) {
		if (repaired.dropped === 0) {
			for (const marker of [...markers].sort((a, b) => b.after - a.after)) {
				entries.splice(Math.min(marker.after, entries.length), 0, marker.entry);
			}
		} else {
			entries.push(...markers.map((marker) => marker.entry));
		}
	}
	return { entries, dropped: repaired.dropped };
}

/**
 * v2's messages, which are one typed JSON object per row rather than a `message`
 * row plus its `part` rows.
 *
 * Three of the eight types are **not messages and are counted rather than
 * turned into one**: `synthetic` is what the tool itself injected, `system` is
 * the harness talking to itself, and `agent-switched`/`model-switched` record a
 * setting change. This importer's transcript has three roles — user, assistant,
 * tool result (`packages/ai/src/types.ts:125`) — and no system one, so rendering
 * any of them as a user turn would put words in the user's mouth. `shell` is the
 * same case: a record of a command the user ran, carrying its output, which is
 * not something the user said. Each is counted under a name that says which.
 *
 * The one type that is a real message and is not read as a turn is `compaction`,
 * which becomes a marker: v1 split it across two messages joined by a `parentID`
 * link, v2 records it as one row with both halves in it
 * (`session-message.ts:184-189`).
 */
function opencodeV2Session(rows: OpencodeSessionMessageRow[]): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const notes: HistoryNote[] = [];
	let synthetic = 0;
	let system = 0;
	let shells = 0;
	let switches = 0;
	let attachments = 0;
	let unknown = 0;
	let emptyOutputs = 0;
	let summaries = 0;

	const collected: AgentMessage[] = [];
	const markers: Array<{ after: number; entry: HistoryEntry }> = [];

	for (const message of rows) {
		const created = asRecord(message.data.time)?.created;
		const timestamp = typeof created === "number" ? created : message.timeCreated;

		if (message.type === "user") {
			if (Array.isArray(message.data.files)) attachments += message.data.files.length;
			const text = asText(message.data.text);
			if (text) collected.push(userMessage(text, timestamp));
			continue;
		}
		if (message.type === "synthetic") {
			synthetic += 1;
			continue;
		}
		if (message.type === "system") {
			system += 1;
			continue;
		}
		if (message.type === "shell") {
			shells += 1;
			continue;
		}
		if (message.type === "agent-switched" || message.type === "model-switched") {
			switches += 1;
			continue;
		}
		if (message.type === "compaction") {
			summaries += 1;
			markers.push({
				after: collected.length,
				entry: {
					kind: "compaction",
					// `summary` is required by the schema, so this only fires on a row
					// that failed to decode; the marker still has to say something.
					summary: asText(message.data.summary) || OPENCODE_MISSING_SUMMARY,
					preTokens: 0,
				},
			});
			continue;
		}
		if (message.type !== "assistant") {
			unknown += 1;
			continue;
		}

		const content: AssistantContent[] = [];
		const results: AgentMessage[] = [];
		for (const block of Array.isArray(message.data.content) ? message.data.content : []) {
			const entry = asRecord(block);
			if (entry === null) {
				unknown += 1;
				continue;
			}
			if (entry.type === "text") {
				const text = asText(entry.text);
				if (text) content.push(textContent(text));
				continue;
			}
			if (entry.type === "reasoning") {
				const thinking = asText(entry.text);
				if (thinking) content.push({ type: "thinking", thinking });
				continue;
			}
			if (entry.type !== "tool") {
				unknown += 1;
				continue;
			}
			// v2's tool block carries its own `id` where v1's part carried a
			// separate `callID` (`session-message.ts:140-152`).
			const callId = asText(entry.id);
			if (!callId) {
				unknown += 1;
				continue;
			}
			const name = asText(entry.name) || UNKNOWN_TOOL_NAME;
			const state = asRecord(entry.state) ?? {};
			content.push({
				type: "toolCall",
				id: callId,
				name,
				arguments: opencodeV2ToolArguments(state.input),
			});
			const output = opencodeV2ToolOutput(state);
			if (output === "") emptyOutputs += 1;
			results.push(toolResultMessage(callId, name, resultContent(output), asText(state.status) === "error", timestamp));
		}
		// A tool block that got this far also pushed its call, so `content` is
		// non-empty whenever `results` is — there is no result-only case to count.
		if (content.length > 0) {
			const calls = content.some((block) => block.type === "toolCall");
			collected.push(assistantMessage({ content, timestamp, stopReason: calls ? "toolUse" : "stop" }));
			collected.push(...results);
		}
	}

	const { entries, dropped } = assembleOpencodeEntries(collected, markers);
	if (synthetic > 0) notes.push({ reason: "tool-injected message", count: synthetic });
	if (system > 0) notes.push({ reason: "system message", count: system });
	if (shells > 0) notes.push({ reason: "shell record, with its output", count: shells });
	if (switches > 0) notes.push({ reason: "agent or model switch", count: switches });
	if (attachments > 0) notes.push({ reason: "file attachment", count: attachments });
	if (unknown > 0) notes.push({ reason: "message this build does not read", count: unknown });
	if (emptyOutputs > 0) notes.push({ reason: "tool call with no recorded output", count: emptyOutputs });
	if (summaries > 0) notes.push({ reason: "compaction summary", count: summaries });
	if (dropped > 0) notes.push({ reason: "unpaired tool call or result", count: dropped });
	return { entries, notes };
}

function readOpencodeSession(sourceId: string, home: string): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const dbPath = opencodeDbPathFor(home);
	if (dbPath === null) return { entries: [], notes: [] };
	// v2 keeps its messages in `session_message`, one row each with the whole body
	// in a JSON column, and reads nothing out of the v1 `message`/`part` pair —
	// `packages/core/src/session/sql.ts:116-137` declares the new table, and there is
	// no query against `message` anywhere under `packages/core/src/`. Asking for the
	// v1 pair first would therefore report an empty conversation for a v2 install
	// that has one, which is the failure this branch exists to prevent.
	const v2 = readOpencodeSessionMessages(dbPath, sourceId);
	if (v2 !== null) return opencodeV2Session(v2);
	const { messages, parts } = readOpencodeConversation(dbPath, sourceId);
	const notes: HistoryNote[] = [];
	let synthetic = 0;
	let ignored = 0;
	let emptyOutputs = 0;
	let summaries = 0;

	const partsByMessage = new Map<string, OpencodePartRow[]>();
	for (const part of parts) {
		const list = partsByMessage.get(part.messageId);
		if (list) list.push(part);
		else partsByMessage.set(part.messageId, [part]);
	}

	// Which user messages triggered a compaction, and what each one summarized.
	//
	// OpenCode splits a compaction across **two** messages and joins them with a
	// link rather than with their order: the user's own message gains a
	// `compaction` part (`CompactionPart`, `packages/schema/src/v1/session.ts:195-201`),
	// and a separate assistant message carries `summary: true` and names the user
	// message in its `parentID` — which is the only field on the pair, since
	// `messageBase` is just `{ id, sessionID }` (`session.ts:327-330`) and
	// `Assistant.parentID` is required (`session.ts:461`). OpenCode's own reader
	// finds the pair the same way, indexing the users that hold a compaction part
	// and reaching them from the assistant through `msg.info.parentID`
	// (`session/compaction.ts:96-112`). Matching on adjacency instead would pair
	// the summary with whichever user message happened to be written before it,
	// which is a different message whenever anything landed in between.
	const compactionHeads = new Set<string>();
	const summaryByHead = new Map<string, string>();
	for (const message of messages) {
		const role = asText(message.data.role);
		const own = partsByMessage.get(message.id) ?? [];
		if (role === "user") {
			if (own.some((part) => part.type === "compaction")) compactionHeads.add(message.id);
			continue;
		}
		// `summary` is `true` on an assistant and an *object* (`{ title, body,
		// diffs }`, `session.ts:339-345`) on a user, so the comparison below is
		// also what keeps a user's own session summary from being read as one.
		if (role === "assistant" && message.data.summary === true) {
			const parent = asText(message.data.parentID);
			if (parent) summaryByHead.set(parent, opencodeSummaryText(own));
		}
	}

	const collected: AgentMessage[] = [];
	// A marker belongs right after the message that triggered it. Its position is
	// kept as an index into the message stream; if the repair pass drops something,
	// the markers move to the end rather than land mid-stream.
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
					// Injected by the tool itself (file contents, reminders) rather
					// than typed by the user.
					if (part.data.synthetic === true) {
						synthetic += 1;
						continue;
					}
					const text = asText(part.data.text);
					if (text) texts.push(text);
					continue;
				}
				if (part.type === "compaction") continue;
				if (part.type !== "step-start" && part.type !== "step-finish") ignored += 1;
			}
			if (texts.length > 0) collected.push(userMessage(texts.join("\n\n"), timestamp));
			if (compactionHeads.has(message.id)) {
				summaries += 1;
				markers.push({
					after: collected.length,
					entry: {
						kind: "compaction",
						summary: summaryByHead.get(message.id) || OPENCODE_MISSING_SUMMARY,
						// `CompactionPart` records no token count, and neither does a
						// guess: zero reads as "not recorded", where an estimate would
						// read as a measurement this importer never took.
						preTokens: 0,
					},
				});
			}
			continue;
		}
		if (role !== "assistant") {
			ignored += own.length;
			continue;
		}
		// The assistant half of a compaction: the summary text is already in the
		// marker, so emitting the message would put it in the transcript twice.
		if (message.data.summary === true) continue;

		const content: AssistantContent[] = [];
		const results: AgentMessage[] = [];
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
				// `state` is a four-way union discriminated on `status`
				// (`session.ts:304-310`), and which field holds the answer depends
				// on the arm: `output` once completed, `error` once it failed, and
				// neither while pending or running. `input` is a record on all four
				// arms, so it is stringified rather than parsed.
				const state = asRecord(part.data.state) ?? {};
				const callId = asText(part.data.callID);
				if (!callId) {
					ignored += 1;
					continue;
				}
				const name = asText(part.data.tool) || UNKNOWN_TOOL_NAME;
				const status = asText(state.status);
				content.push({
					type: "toolCall",
					id: callId,
					name,
					arguments: JSON.stringify(asRecord(state.input) ?? {}),
				});
				const output = asText(state.output) || asText(state.error);
				if (!output) emptyOutputs += 1;
				results.push(toolResultMessage(callId, name, resultContent(output), status === "error", timestamp));
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
	}

	const { entries, dropped } = assembleOpencodeEntries(collected, markers);
	if (synthetic > 0) notes.push({ reason: "tool-injected text part", count: synthetic });
	if (ignored > 0) notes.push({ reason: "unsupported part", count: ignored });
	if (emptyOutputs > 0) notes.push({ reason: "tool call with no recorded output", count: emptyOutputs });
	if (summaries > 0) notes.push({ reason: "compaction summary", count: summaries });
	if (dropped > 0) notes.push({ reason: "unpaired tool call or result", count: dropped });
	return { entries, notes };
}

// ---------------------------------------------------------------------------
// MiMo Code
// ---------------------------------------------------------------------------

/**
 * The database this install reads, resolved once for the same reason
 * `opencodeDbPathFor` resolves one.
 *
 * `$MIMOCODE_DB` can put it anywhere and `:memory:` puts it nowhere at all, and the
 * channel filename for a nightly is a build-time constant no reader can know — so
 * a listing that re-derived the path differently from the reader would report a
 * source as holding transcripts the read phase then finds nowhere.
 */
function miMoCodeDbPathFor(home: string): string | null {
	return mimocodeDatabasePath(mimocodeRoots(home, process.env).data, process.env);
}

/**
 * MiMo Code's sessions, as history candidates.
 *
 * **A subagent session (`parent_id` set) is counted and skipped**, for OpenCode's
 * reason: it is a task the primary ran, not a conversation the user had, and
 * importing it would replay the subagent's turns as though the user had typed them.
 *
 * **An archived session is imported with the flag rather than skipped.** This is a
 * stronger statement than OpenCode's needs to be: `session.time_archived` is a
 * first-class column on the session row
 * (`session/session.sql.ts:41-44`) and the product keeps archiving to it, so an
 * archived session is a real conversation the user chose to put away — and
 * "archived" is a property the target records too.
 */
function listMiMoCodeHistory(home: string): HistoryListing {
	const candidates: HistoryCandidate[] = [];
	let children = 0;
	const dbPath = miMoCodeDbPathFor(home);
	if (dbPath === null) return { candidates, notes: [] };
	for (const session of readMiMoCodeSessions(dbPath)) {
		if (session.parentId) {
			children += 1;
			continue;
		}
		candidates.push({
			source: "mimocode-code",
			sourceId: session.id,
			// `session.directory` is `notNull()` and has been since the first
			// migration, so this is never a fallback — it is the answer.
			cwd: session.directory,
			title: session.title,
			startedAt: session.timeCreated,
			path: dbPath,
			...(session.timeArchived > 0 ? { archived: true } : {}),
		});
	}
	const notes: HistoryNote[] = [];
	if (children > 0) notes.push({ reason: "subagent session", count: children });
	return { candidates, notes };
}

/** Why a compaction's summary arrives empty, when it does. */
const MIMOCODE_MISSING_SUMMARY = "(compaction recorded by MiMo Code; its summary is not in this database)";

/**
 * One MiMo Code session's main thread, as history entries.
 *
 * **The record shape is not inferred, and the strongest evidence is that MiMo
 * Code ships a reader for it.** `session/opencode-import.ts` opens an upstream
 * `opencode.db` through `openReadonly` (`storage/read-sqlite.bun.ts:7-13`) and
 * reads `session` -> `message` -> `part`, `JSON.parse`-ing each `data` column
 * (`:219` and `:236`) into the same `MessageV2` union this function reads. So the
 * `data` blobs below are `MessageV2.Info` and `MessageV2.Part` — `role` of
 * `"user"` (`session/message-v2.ts:527`) or `"assistant"` (`:577`), `parentID`
 * (`:597`) and `summary: boolean` (`:609`); and a part discriminated on `type`
 * with `text` (`:187`), `reasoning` (`:204`), `tool` (`:484`), `compaction`
 * (`:319`) and the step/patch/file family around them.
 *
 * **The one filter this adds is `agent_id = 'main'`**, because MiMo Code's
 * `message` table carries a column an opencode v1 database does not
 * (`session/session.sql.ts:94`). See `mimocode-session.ts`'s header for why a
 * reader that omits it duplicates the main thread with the subagent's work.
 */
function readMiMoCodeSession(sourceId: string, home: string): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const dbPath = miMoCodeDbPathFor(home);
	if (dbPath === null) return { entries: [], notes: [] };
	const { messages, parts } = readMiMoCodeConversation(dbPath, sourceId);
	const notes: HistoryNote[] = [];
	let synthetic = 0;
	let ignored = 0;
	let emptyOutputs = 0;
	let summaries = 0;

	const partsByMessage = new Map<string, MiMoCodePartRow[]>();
	for (const part of parts) {
		const list = partsByMessage.get(part.messageId);
		if (list) list.push(part);
		else partsByMessage.set(part.messageId, [part]);
	}

	// A compaction is split across **two** messages joined by a link rather than by
	// order: the user's own message gains a `compaction` part
	// (`session/message-v2.ts:319`) and a separate assistant message carries
	// `summary: true` and names the user message in its `parentID`. Matching on
	// adjacency instead would pair the summary with whichever user message happened
	// to be written before it, which is a different message whenever anything
	// landed in between.
	const compactionHeads = new Set<string>();
	const summaryByHead = new Map<string, string>();
	for (const message of messages) {
		const role = asText(message.data.role);
		const own = partsByMessage.get(message.id) ?? [];
		if (role === "user") {
			if (own.some((part) => part.type === "compaction")) compactionHeads.add(message.id);
			continue;
		}
		// `summary` is `true` on an assistant and an *object* on a user
		// (`session/message-v2.ts:532` against `:609`), so the comparison below is
		// also what keeps a user's own session summary from being read as one.
		if (role === "assistant" && message.data.summary === true) {
			const parent = asText(message.data.parentID);
			if (parent) summaryByHead.set(parent, miMoCodeSummaryText(own));
		}
	}

	const collected: AgentMessage[] = [];
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
					// Injected by the tool itself (file contents, reminders) rather than
					// typed by the user.
					if (part.data.synthetic === true) {
						synthetic += 1;
						continue;
					}
					const text = asText(part.data.text);
					if (text) texts.push(text);
					continue;
				}
				if (part.type === "compaction") continue;
				if (part.type !== "step-start" && part.type !== "step-finish") ignored += 1;
			}
			if (texts.length > 0) collected.push(userMessage(texts.join("\n\n"), timestamp));
			if (compactionHeads.has(message.id)) {
				summaries += 1;
				markers.push({
					after: collected.length,
					entry: {
						kind: "compaction",
						summary: summaryByHead.get(message.id) || MIMOCODE_MISSING_SUMMARY,
						// A compaction part records no token count and neither does a
						// guess: zero reads as "not recorded", where an estimate would
						// read as a measurement this importer never took.
						preTokens: 0,
					},
				});
			}
			continue;
		}
		if (role !== "assistant") {
			ignored += own.length;
			continue;
		}
		// The assistant half of a compaction: the summary text is already in the
		// marker, so emitting the message would put it in the transcript twice.
		if (message.data.summary === true) continue;

		const content: AssistantContent[] = [];
		const results: AgentMessage[] = [];
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
				// `state` is a four-way union discriminated on `status`
				// (`session/message-v2.ts:395,407,422,443`), and which field holds the
				// answer depends on the arm: `output` once completed, `error` once it
				// failed, and neither while pending or running. `input` is a record on
				// all four arms, so it is stringified rather than parsed.
				const state = asRecord(part.data.state) ?? {};
				const callId = asText(part.data.callID);
				if (!callId) {
					ignored += 1;
					continue;
				}
				const name = asText(part.data.tool) || UNKNOWN_TOOL_NAME;
				const status = asText(state.status);
				content.push({
					type: "toolCall",
					id: callId,
					name,
					arguments: JSON.stringify(asRecord(state.input) ?? {}),
				});
				const output = asText(state.output) || asText(state.error);
				if (!output) emptyOutputs += 1;
				results.push(toolResultMessage(callId, name, resultContent(output), status === "error", timestamp));
				continue;
			}
			if (part.type !== "step-start" && part.type !== "step-finish") ignored += 1;
		}
		if (content.length > 0) {
			const calls = content.some((block) => block.type === "toolCall");
			collected.push(assistantMessage({ content, timestamp, stopReason: calls ? "toolUse" : "stop" }));
			collected.push(...results);
		} else if (results.length > 0) {
			// Results without their call cannot be replayed, and the repair pass below
			// would drop them anyway; counting them is more honest.
			ignored += results.length;
		}
	}

	// Rows the `agent_id = 'main'` filter removed. Reported rather than folded into
	// `ignored`, because "your subagent's turns were left behind" and "parts of a
	// shape this importer does not carry" are different sentences, and a user who
	// ran subagents deserves the first.
	const scope = readMiMoCodeMessageScope(dbPath, sourceId);
	const { entries, dropped } = assembleMiMoCodeEntries(collected, markers);
	if (scope.subagent > 0) {
		notes.push({ reason: "subagent turn (a message whose `agent_id` is not `main`)", count: scope.subagent });
	}
	if (synthetic > 0) notes.push({ reason: "tool-injected text part", count: synthetic });
	if (ignored > 0) notes.push({ reason: "unsupported part", count: ignored });
	if (emptyOutputs > 0) notes.push({ reason: "tool call with no recorded output", count: emptyOutputs });
	if (summaries > 0) notes.push({ reason: "compaction summary", count: summaries });
	if (dropped > 0) notes.push({ reason: "unpaired tool call or result", count: dropped });
	return { entries, notes };
}

/**
 * A compaction's summary text: text parts alone, each trimmed, blanks dropped,
 * joined by a blank line, and the whole trimmed again.
 */
function miMoCodeSummaryText(parts: MiMoCodePartRow[]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => asText(part.data.text).trim())
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

/**
 * Pair the repaired message stream with the compaction markers, in that order.
 *
 * A marker's position is an index into `collected`, and a repair pass that dropped
 * something invalidates it — so when anything was dropped the markers all move to
 * the end rather than land at positions that no longer mean what they said.
 */
function assembleMiMoCodeEntries(
	collected: AgentMessage[],
	markers: Array<{ after: number; entry: HistoryEntry }>,
): { entries: HistoryEntry[]; dropped: number } {
	const repaired = repairToolPairing(collected);
	const entries: HistoryEntry[] = repaired.messages.map((message) => ({ kind: "message", message }));
	if (markers.length > 0) {
		if (repaired.dropped === 0) {
			for (const marker of [...markers].sort((a, b) => b.after - a.after)) {
				entries.splice(Math.min(marker.after, entries.length), 0, marker.entry);
			}
		} else {
			entries.push(...markers.map((marker) => marker.entry));
		}
	}
	return { entries, dropped: repaired.dropped };
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
	/**
	 * Set when the source's list records no directory and every entry was therefore
	 * filed under the directory this run is in.
	 *
	 * A `PromptEntry` is `{ text, cwd, timestamp }` and `loadHistory` drops every
	 * line whose `cwd` is not the project being opened, so an entry filed under no
	 * directory is one ↑ will never offer — which is why sources whose list records
	 * none are normally reported rather than imported. Where a source's list is
	 * worth importing anyway (it is a list the user typed, it simply is not scoped),
	 * the entries are filed under the current project and this field is set, so the
	 * report can say that instead of the sentence it would otherwise print. The
	 * sentence is a claim about where ↑ will offer the prompts, and printing it for
	 * entries whose directory is a guess is the same defect as a silent mismatch.
	 */
	cwdSubstitute?: string;
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

/**
 * OpenCode's ↑ recall list, which is on disk and cannot come across.
 *
 * `<state>/prompt-history.jsonl` is the last 50 entries, one JSON `PromptInfo` per
 * line — `{ input, mode?, parts }` (`packages/tui/src/prompt/history.tsx:14-27`).
 * Two things keep it out of the recall list, and the second is the one that
 * decides it:
 *
 * 1. `mode: "shell"` is a shell line, the same distinction grok records as
 *    `is_bash`. Both append sites pass the mode through
 *    (`prompt/index.tsx:1122-1124` and `:1274-1277`), and recalling a shell line
 *    as a prompt would offer it as the next thing to send to a model.
 * 2. **Nothing in an entry says where it was typed.** `PromptInfo` has no session
 *    id, no directory and no timestamp, and both call sites append exactly
 *    `{...store.prompt, mode}` — so the session that owns a prompt cannot even be
 *    looked up afterwards in the database. A `PromptEntry` here is
 *    `{ text, cwd, timestamp }`, and `loadHistory` drops every line whose `cwd` is
 *    not the project being opened (`history.ts:82`), which makes an entry filed
 *    under no directory one that ↑ will never offer, in this project or any other.
 *
 * So the list is reported rather than imported, and the count is the part that
 * earns its keep: fifty remembered prompts is a fact about what the user is about
 * to leave behind, and silence would read as "you never typed anything here".
 */
function readOpencodePromptHistory(
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	const scan: PromptScan = { candidates: [], counts: new Map(), seen: 0, truncated: false };
	const path = opencodePromptHistoryFile(opencodeRoots(home).state);
	if (!existsSync(path)) return selectPrompts(scan, options);
	const tail = readTailLines(path, PROMPT_HISTORY_BYTES);
	scan.truncated = tail.truncated;
	for (const line of tail.lines) {
		if (!line.trim()) continue;
		const parsed = parseJsonLine(line);
		if (!parsed) {
			bump(scan.counts, "line not in the history shape");
			continue;
		}
		scan.seen += 1;
		if (asText(parsed.mode) === "shell") {
			bump(scan.counts, "line typed in shell mode — a shell command, not a prompt to a model");
			continue;
		}
		bump(
			scan.counts,
			"prompt whose entry records no working directory or session — this build's recall is filtered by " +
				"project, so it would be filed under none and ↑ would never offer it",
		);
	}
	return selectPrompts(scan, options);
}

/**
 * Cursor CLI's ↑ recall list, imported with the directory named as a substitute.
 *
 * `<cli home>/chats/<md5>/view/prompt_history.json` is a **flat JSON array of bare
 * strings** — not the JSONL of every other source here, which is why it gets its
 * own reader rather than a shared line parser. Three properties of it decide the
 * treatment, and the first is the reason this is the one list in the repo that is
 * imported despite recording no directory.
 *
 * **No directory, and no timestamp either.** The entries are strings: there is
 * nowhere in the format to record either, so unlike OpenCode's list — which
 * records a mode and is dropped for the same missing directory — there is nothing
 * here to recover and nothing that could be misread. A prompt the user typed is
 * worth having back, so the entries are filed under the directory this run is in
 * and the report says so: ↑ will offer them in every project, not only this one.
 * That is a real widening and it is stated as one, which is what
 * {@link PromptHistoryInput.cwdSubstitute} exists for.
 *
 * Consequently `--history-scope` cannot filter this list, and the choice is
 * reported rather than left to look like it worked: the filter compares an entry's
 * directory against the current project, and every entry's directory is the
 * current project by construction.
 *
 * **The ordering is the file's, because the format has no other.** As in the Kimi
 * case: the file is append-only, so the entries arrive newest-first and every
 * timestamp is 0, which is what keeps the per-source limit taking the newest end —
 * the selection sorts by that timestamp and is stable, so equal keys keep the order
 * they were read in. The array is reversed on the way in for exactly that reason,
 * and an unsorted middle (an array the CLI rewrote rather than appended to) would
 * defeat it; a list this short is not worth sorting defensively for.
 *
 * **One path, and this is the one Cursor path with no official citation.** The
 * list is `<cli home>/chats/<md5 of this cwd>/view/prompt_history.json` — three
 * directories down, in a subtree whose name is a digest of the working directory.
 * `cursorPromptHistoryFile` returns it when it is there and `null` when it is not;
 * the "not there" sentence then names the exact path that was looked for, because
 * a report that says only "no list" is indistinguishable from one that looked in
 * the wrong place. When nothing is found the source is reported as having no list,
 * which is a different statement from having an empty one.
 */
function readCursorPromptHistory(
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	const scan: PromptScan = { candidates: [], counts: new Map(), seen: 0, truncated: false };
	const located = cursorPromptHistoryFile(home, options.cwd);
	if (!located) {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent: `no prompt list at ${tildePath(home, cursorPromptHistoryPath(home, options.cwd))} — a list is looked for and there is none`,
		};
	}
	const text = readText(located.path);
	if (text === null) {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent: `the prompt list at ${tildePath(home, located.path)} could not be read — it is named in the report rather than skipped silently`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent: `the prompt list at ${tildePath(home, located.path)} is not JSON, so no entry could be read out of it`,
		};
	}
	if (!Array.isArray(parsed)) {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent: `the prompt list at ${tildePath(home, located.path)} is a JSON ${parsed === null ? "null" : typeof parsed} rather than an array of prompts`,
		};
	}
	// Newest first, so the stable sort in `selectPrompts` keeps read order and the
	// per-source limit takes the newest end. See the module comment.
	for (const entry of [...parsed].reverse()) {
		if (typeof entry !== "string") {
			bump(scan.counts, "entry that is not a string, so not a prompt");
			continue;
		}
		const prompt = entry.trim();
		if (!prompt) {
			bump(scan.counts, "empty prompt");
			continue;
		}
		scan.seen += 1;
		if (PASTE_PLACEHOLDER.test(prompt)) {
			bump(scan.counts, "prompt whose text was a pasted block, stored without its body");
			continue;
		}
		// The same reasoning Kimi's reader uses, and for the same reason: this build's
		// recall list is a list of prompts, and a slash command it offered would be
		// sent as one. Cursor's CLI has a slash command surface, so unlike Kimi this
		// is a filter on the text rather than a certainty about what was typed.
		if (prompt.startsWith("/")) {
			bump(scan.counts, "line starting with a slash, which is a command in cursor rather than a prompt to a model");
			continue;
		}
		scan.candidates.push({ text: prompt, cwd: options.cwd, timestamp: 0 });
	}
	if (options.scope === "cwd" && scan.candidates.length > 0) {
		bump(
			scan.counts,
			"prompt from a directory the list does not record — --history-scope cwd cannot narrow this source, because every entry is filed under the current project",
		);
	}
	return { ...selectPrompts(scan, options), cwdSubstitute: options.cwd };
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
	if (source === "opencode") return readOpencodePromptHistory(home, options);
	if (source === "cursor") return readCursorPromptHistory(home, options);

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
	// Qoder's sentence is a weaker claim than Step's or MiniMax's, and it is worded
	// to match what was actually established. There is no cross-session prompt list
	// named anywhere in the desktop bundle — no `promptHistory`, no `history.json`,
	// no `recentPrompts`, no completions store — and the only per-session record the
	// product keeps is the transcript tree this source already counts and does not
	// read. So the ↑ list gets nothing here, and saying so is better than the
	// silent empty the fall-through below would give: a user who pressed ↑ in Qoder
	// is owed the distinction between "there was nothing" and "nothing came across".
	if (source === "qoder") {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent:
				"Qoder keeps no cross-session prompt list this import can find — its bundle names no prompt history file of any kind, and the " +
				"only per-session record it keeps is the transcript tree, which is reported separately and is not read here — so nothing was " +
				"added to the ↑ recall list",
		};
	}
	// Alma has no cross-session prompt list either, and the reason here is
	// structural rather than a search: the prompts *are* the message rows. Every
	// user message this importer converts already arrives with the thread it was
	// typed in and the timestamp it was typed at, so a recall list would be the
	// sessions' own first user turns read a second time. Saying so beats the
	// silent empty the fall-through below would give — a user who pressed ↑ in
	// Alma is owed the difference between "there was nothing" and "nothing came
	// across", and here the truth is the second.
	if (source === "alma") {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent:
				"Alma keeps no cross-session prompt list this import can find — its prompts are the `chat_messages` rows themselves, which arrive " +
				"with their sessions and are imported as those sessions' first user turns, so nothing was added separately to the ↑ recall list",
		};
	}
	// Codewhale's recall list has no home of its own, and the reason is a fact about
	// the product rather than a gap in the search: every user message this importer
	// converts already arrives with the directory it was typed in and the timestamp
	// it was typed at, so the prompts come across **as the sessions' first user
	// turns** rather than as a second, separately-sourced list. Reading them twice
	// would put every prompt in the recall list twice, so nothing is read here and
	// the report says where they came from instead.
	if (source === "codewhale") {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent:
				"Codewhale keeps no separate prompt-history file — its ↑ recall list is the user turns inside the session transcripts, and those come " +
				"across with the sessions below, each with the directory and the moment it was typed recorded — so nothing was added to the ↑ recall " +
				"list here and nothing was lost",
		};
	}
	// MiMo Code's recall list is inside its sessions rather than beside them, so the
	// up-arrow list gets nothing while the prompts it does know about come across with
	// the transcripts. That is worth one sentence rather than the silent empty the
	// fall-through would give: a user who pressed up-arrow in MiMo Code is owed the
	// distinction between "there was nothing" and "nothing came across here".
	//
	// **It is not a case of a file this importer failed to find.** MiMo Code is an
	// opencode fork, and the opencode it forked writes
	// `<state>/prompt-history.jsonl`; MiMo Code's TUI has no such file and its prompts
	// live as `user` messages in the same `message`/`part` rows this importer already
	// reads as transcripts.
	if (source === "mimocode-code") {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent:
				"MiMo Code keeps no cross-session prompt list — unlike the opencode it forked, it writes no prompt-history " +
				"file, and its prompts live as user messages inside the sessions that are imported as transcripts — so nothing " +
				"was added to the up-arrow recall list, and the prompts you sent come across with their sessions",
		};
	}
	// OpenClaw's recall list is its transcripts, so the sentence is the same shape as
	// MiMo Code's above — but the *reason* is a stronger claim than "no file was
	// found", and the wording matches what was established rather than what was
	// looked for. OpenClaw keeps one authoritative store
	// (`<stateDir>/agents/<id>/agent/openclaw-agent.sqlite`) and every prompt is a
	// `user`-role message inside it, which this importer already reads as
	// transcripts. A user who pressed up-arrow in OpenClaw is owed the distinction
	// between "there was nothing" and "nothing came across here".
	if (source === "openclaw") {
		return {
			seen: 0,
			entries: [],
			notes: [],
			overLimit: 0,
			truncated: false,
			absent:
				"OpenClaw keeps no cross-session prompt list — its one authoritative store is the agent SQLite database, and every " +
				"prompt is a user-role message inside it, which this importer reads as transcripts — so nothing was added to the up-arrow " +
				"recall list, and the prompts you sent come across with their sessions",
		};
	}
	return { seen: 0, entries: [], notes: [], overLimit: 0, truncated: false };
}

// ---------------------------------------------------------------------------
// T3 Code
// ---------------------------------------------------------------------------

/**
 * Why a T3 Code transcript arrives without its tool calls.
 *
 * Named once, as a constant, because it is the note most likely to be reworded by
 * whoever reads a report and wonders why. The reason is short and does not depend
 * on the wording: T3 stores a tool call as a row in `projection_thread_activities`
 * with `tone = "tool"`, and that row's payload is `itemType`, `toolCallId`,
 * `status`, `title`, `detail` and an opaque `data` — a projection for T3's own UI,
 * not a call with an argument list and a matching result. The count beside it in
 * the report is how many such rows the offered threads hold.
 */
const T3_TOOL_ACTIVITY_NOTE =
	"tool activity row, not a message — t3 code records a tool call in its activities table with a title, a status and an " +
	"opaque payload rather than as a message with an argument list and a matching result, so imported transcripts carry the " +
	"conversation without the tool calls or their output";

/**
 * Every T3 Code thread, as candidates.
 *
 * **A thread with no recorded directory is still offered.** `cwd` is a required
 * field of a {@link HistoryCandidate}, and T3's thread row has no directory
 * column of its own — the effective one comes from a join, and a project whose
 * `workspace_root` is empty (T3 allows registering a project before opening it in
 * a directory) yields a thread with no path at all. Such a thread is listed with
 * the source's own base directory rather than dropped, because the alternative is
 * a conversation the user can see in T3 and that this importer reports as
 * missing; `narrowCandidates` then decides what the scope means for it, and the
 * report says which directory it was filed under.
 */
function listT3History(home: string): HistoryListing {
	const base = t3BaseDir(home);
	const candidates: HistoryCandidate[] = [];
	const notes: HistoryNote[] = [];
	let withoutCwd = 0;
	let toolRows = 0;
	for (const thread of t3SessionRows(home)) {
		if (thread.cwd === null) withoutCwd += 1;
		toolRows += thread.toolCount;
		candidates.push({
			source: "t3-code",
			sourceId: thread.id,
			cwd: thread.cwd ?? base,
			title: thread.title,
			startedAt: thread.startedAt,
			path: base,
		});
	}
	if (withoutCwd > 0) {
		notes.push({
			reason:
				"thread whose project recorded no directory — listed under t3 code's base directory so it is reachable, and " +
				"filed there on import",
			count: withoutCwd,
		});
	}
	if (toolRows > 0) {
		notes.push({ reason: T3_TOOL_ACTIVITY_NOTE, count: toolRows });
	}
	return { candidates, notes };
}

/**
 * One chosen T3 thread, as transcript entries.
 *
 * **Reasoning folds into the answer that follows it.** T3 records `reasoning` as
 * its own row in the same message table and orders by the same clock
 * (`ProjectionThreadMessages.ts:225`), so a thinking run and the reply it
 * produced are adjacent and the reply is what the user read. Emitting them as two
 * separate assistant messages would show a turn that stops to think and then says
 * nothing before another turn that answers a question already answered — so
 * consecutive reasoning rows are held and prepended to the next assistant message
 * as `thinking` content, exactly as the four file-based sources fold their own.
 *
 * A reasoning run with **no** assistant message after it — a turn that was
 * interrupted mid-thought — becomes its own message rather than being dropped.
 * Losing it would leave an imported transcript that silently omits part of a turn
 * it otherwise carries, which is the kind of gap nobody notices until they try to
 * resume the session.
 *
 * The empty case is reported rather than counted as a failure, and its reason
 * names the roles rather than saying the thread was empty. Those are different
 * statements: a T3 thread that recorded nothing is a real thing, and so is one
 * whose every row is a role this importer does not read.
 */
function readT3History(home: string, candidate: HistoryCandidate): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const messages = t3SessionMessages(home, candidate.sourceId);
	if (messages.length === 0) {
		return {
			entries: [],
			notes: [
				{
					reason:
						"thread with nothing to import — it holds no user, assistant or reasoning rows, which is not the same as " +
						"a thread with no content: t3 code records a tool call as an activity row rather than a message",
					count: 1,
				},
			],
		};
	}
	const collected: AgentMessage[] = [];
	const pending: string[] = [];
	const flushReasoning = (timestamp: number): void => {
		if (pending.length === 0) return;
		collected.push(
			assistantMessage({
				content: pending.map((thinking) => ({ type: "thinking" as const, thinking })),
				timestamp,
				stopReason: "stop",
			}),
		);
		pending.length = 0;
	};
	for (const message of messages) {
		const at = message.at > 0 ? message.at : undefined;
		if (message.role === "user") {
			// A user turn after a thinking run means the run belonged to the reply
			// before it, and that reply never landed — so it is its own message here
			// rather than being prepended to the wrong turn.
			flushReasoning(at ?? Date.now());
			collected.push(userMessage(message.text, at));
			continue;
		}
		if (message.role === "reasoning") {
			pending.push(message.text);
			continue;
		}
		collected.push(
			assistantMessage({
				content: [...pending.map((thinking) => ({ type: "thinking" as const, thinking })), textContent(message.text)],
				timestamp: at ?? Date.now(),
				stopReason: "stop",
			}),
		);
		pending.length = 0;
	}
	flushReasoning(Date.now());
	return {
		entries: collected.map((message) => ({ kind: "message", message })),
		notes: [],
	};
}

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

/**
 * Every Antigravity conversation, as candidates.
 *
 * **No conversation carries a working directory, and that is a finding rather than
 * a gap in the reader.** The compact transcript has no `cwd` field — the product's
 * own record type has none, and neither does the untruncated one, since they are
 * the same records — and nothing beside the transcript fills the hole: the
 * conversation directory's attested siblings are `swarm.md` (the multi-agent
 * coordination board) and `scratch/`, neither of which names a directory the user
 * was working in. Antigravity does associate conversations with projects — its
 * settings carry a `project_conversations` field and a per-project settings file
 * is what `GetSandboxConfig` reads — but **where that file lives could not be
 * established**: no `.gemini/projects`, no `project.json`, no `ProjectSettingsPath`
 * in either binary, and the only `.idea` hits are inside a file-exclusion list.
 *
 * **So every candidate is filed under the directory the user is migrating into,
 * and the report says the directory was assumed.** The alternative — `cwd: ""` —
 * is the value {@link narrowCandidates} counts under "no working directory
 * recorded" and *drops*, which is the right verdict for a source that records
 * directories and had one session without one (dsh's `_no-cwd` bucket) and the
 * wrong one here: applied to a source that records no directory for any session
 * it drops all of them, and since the default scope is `cwd` it would do that on
 * the default run. A history that imports nothing is not a migration that found
 * nothing, and the report must not be able to make the two look alike.
 *
 * The substitute is the user's current project, which is exactly what
 * `readCursorPromptHistory` does for the identical situation and why
 * {@link HistoryCandidate.cwdSubstitute} exists: the session lands in the project
 * being migrated into and `↑` will offer it in every project, and the note below
 * plus the report line both say in words that the directory is a fallback rather
 * than a fact. **Nothing here claims which project a conversation belonged to** —
 * this importer does not know and the product did not record it.
 *
 * Which data root is read is the same decision the reader makes, and for the same
 * reason: {@link antigravityDataDirs} orders them by which tree the current build
 * writes to, and the first with content wins.
 */
function listAntigravityHistory(home: string, options: { cwd: string }): HistoryListing {
	const dataDir = antigravityDataDirs(home).find((dir) => antigravityTreeHasContent(dir));
	if (dataDir === undefined) return { candidates: [], notes: [] };
	const listing = listAntigravityConversations(dataDir);
	const candidates: HistoryCandidate[] = listing.conversations.map((conversation) => ({
		source: "antigravity" as const,
		sourceId: conversation.id,
		cwd: options.cwd,
		// See this function's doc comment: the directory above is the user's, and
		// this is what stops the report calling it the conversation's.
		cwdSubstitute: options.cwd,
		title: "",
		// Read from a bounded head at listing time — see
		// `AntigravityConversationFile.startedAt`. Without it every conversation
		// sorts as `0` and `--history-limit` keeps whichever twenty names came
		// first in the alphabet.
		startedAt: conversation.startedAt,
		path: conversation.path,
	}));
	const notes: HistoryNote[] = [...listing.notes];
	if (candidates.length > 0) {
		notes.push({
			reason:
				"conversation with no working directory of its own — filed under the current project, because Antigravity records a directory for none of them, so --history-scope cwd cannot narrow this source",
			count: candidates.length,
		});
	}
	return { candidates, notes };
}

/**
 * One chosen Antigravity conversation, as transcript entries.
 *
 * **The title is read here and nowhere else, because the listing phase cannot
 * afford it.** Antigravity has no metadata file beside the transcript, so the
 * title is the first *user* turn — and a user turn is not guaranteed to be the
 * first record: line one of a conversation is the product's own system prompt.
 * Finding one means scanning until a user turn appears, which for a listing over
 * a whole tree means reading every conversation on the machine before the user
 * has chosen any of them. The start time has no such problem — line one carries
 * it — and is read from a bounded head at listing time instead, so only this one
 * column is blank in the picker.
 */
function readAntigravityHistory(
	home: string,
	candidate: HistoryCandidate,
): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const dataDir = antigravityDataDirs(home).find((dir) => antigravityTreeHasContent(dir));
	const conversation =
		dataDir === undefined
			? undefined
			: listAntigravityConversations(dataDir).conversations.find((one) => one.id === candidate.sourceId);
	if (conversation === undefined) {
		return {
			entries: [],
			notes: [
				{
					reason:
						"conversation that was offered and is no longer there — a data root that changed between listing and reading",
					count: 1,
				},
			],
		};
	}
	const read = readAntigravityConversation(conversation);
	if ("error" in read) {
		return { entries: [], notes: [{ reason: `transcript that could not be read — ${read.error}`, count: 1 }] };
	}
	// Filled in here rather than at listing: the read is what had the transcript
	// open, and a candidate's own fields are the ones the session is written from.
	// `startedAt` is written too even though the listing already set it — the
	// listing saw a bounded head and this saw the whole file, so the whole-file
	// value is the one the imported session carries.
	candidate.title = read.title;
	candidate.startedAt = read.startedAt;
	return {
		entries: read.messages.map((message) => ({ kind: "message" as const, message })),
		notes: read.notes,
	};
}

// ---------------------------------------------------------------------------
// OpenClaw
// ---------------------------------------------------------------------------

/**
 * Where OpenClaw's agent store is for this home.
 *
 * The state directory is resolved with the product's own precedence — including
 * the `~/.clawdbot` fallback (`state-dir.ts:33-43`) — so an upgraded install whose
 * state never moved is found rather than reported absent. `env` defaults to
 * `process.env` for the same reason every other source's does; every test passes
 * one explicitly.
 */
function openclawDbPathFor(home: string, env: NodeJS.ProcessEnv = process.env): string {
	const stateDir = openclawStateDir(home, env);
	return openclawAgentDbPath(stateDir, "main");
}

/**
 * Every OpenClaw session, as candidates.
 *
 * **The working directory comes from the transcript header, not from a column.**
 * Neither `session_windows` nor `session_nodes` has one; it is in the header event
 * (`{type: "session", …, cwd}`, `transcript-header.ts:18-27`) and in optional
 * `entry_json` fields that are **absent on a session that was not spawned**. The
 * header is read for every session for that reason — it is unconditional, whereas
 * the `entry_json` fields are not.
 *
 * **A session with no directory at all is still offered**, with the state
 * directory as its `cwd`, for the reason `listT3History` gives in its own words: a
 * conversation the user can see in OpenClaw and that this importer reports as
 * missing is the worse outcome. `narrowCandidates` then decides what the scope
 * means for it.
 */
function listOpenClawHistory(home: string, options: { env?: NodeJS.ProcessEnv } = {}): HistoryListing {
	const dbPath = openclawDbPathFor(home, options.env);
	const windows = readOpenClawSessionWindows(dbPath);
	const candidates: HistoryCandidate[] = [];
	const notes: HistoryNote[] = [];
	let withoutCwd = 0;
	let compressed = 0;
	let unreadable = 0;
	for (const window of windows) {
		// A spawned session's transcript belongs to the conversation it was spawned
		// for; importing both would duplicate the parent's turns. Counted, not read.
		if (window.spawnedBy !== null) {
			unreadable += 1;
			continue;
		}
		let cwd = "";
		let title = window.displayName ?? "";
		let startedAt = 0;
		for (const event of readOpenClawEvents(dbPath, window.sessionId)) {
			if (event.compressed) compressed += 1;
			const header = event.json;
			if (header.type === "session") {
				if (typeof header.cwd === "string" && header.cwd !== "") cwd = header.cwd;
				if (!startedAt) {
					const stamped = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
					if (Number.isFinite(stamped)) startedAt = stamped;
				}
				// `seq = 0` is the header and it is written unconditionally
				// (`transcript-header.ts:18-27`), so there is nothing after it that
				// can move the session's start.
				continue;
			}
			if (title !== "") continue;
			const message = asRecord(header.message);
			if (message?.role !== "user") continue;
			const first = firstMessageText(message);
			if (first !== "") title = first;
		}
		if (cwd === "") {
			withoutCwd += 1;
			cwd = join(home, ".openclaw");
		}
		candidates.push({
			source: "openclaw",
			sourceId: window.sessionId,
			cwd,
			title,
			startedAt: startedAt || window.createdAt || window.updatedAt,
			path: dbPath,
		});
	}
	if (compressed > 0) {
		notes.push({
			reason:
				"transcript event stored zstd-compressed rather than as text — this build decompressed and read it, because a reader that only took the text column would have reported a truncated history as the whole one",
			count: compressed,
		});
	}
	if (withoutCwd > 0) {
		notes.push({ reason: "session file with no working directory", count: withoutCwd });
	}
	if (unreadable > 0) {
		notes.push({ reason: "spawned session (kept out of the parent conversation)", count: unreadable });
	}
	return { candidates, notes };
}

/**
 * Convert one OpenClaw session.
 *
 * **The dispatch is on `message.role`, not on the event's `type`** — and that is
 * the whole reason this is not `readClaudeCodeSession`. Claude Code puts the role
 * on the event; OpenClaw puts it on the payload and has **three** roles where
 * Claude Code has two, `toolResult` being a first-class message rather than a
 * block inside a user turn (`packages/llm-core/src/types.ts:369-372,387-395,
 *425-433`). Handing an OpenClaw transcript to the Claude reader makes every line
 * fail its `type` test, be counted as a "non-conversation entry", and import
 * **zero messages while the report claims the file was read**. See the header of
 * `openclaw-session.ts`.
 *
 * The content-block vocabulary *is* the same, which is why the three helpers below
 * are near-copies of `claudeEntriesFromUser` / `claudeAssistant` /
 * `claudeResultContent` rather than something new: `TextContent`, `ThinkingContent`,
 * `ToolCall` and `ImageContent` (`types.ts:264-313`) are the same four shapes.
 */
function readOpenClawSession(
	home: string,
	candidate: HistoryCandidate,
	options: { env?: NodeJS.ProcessEnv } = {},
): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const notes: HistoryNote[] = [];
	const dbPath = openclawDbPathFor(home, options.env);
	const events = readOpenClawEvents(dbPath, candidate.sourceId);
	const collected: AgentMessage[] = [];
	let malformed = 0;
	let ignored = 0;
	let compressed = 0;
	for (const event of events) {
		if (event.compressed) compressed += 1;
		const header = event.json;
		if (header.type !== "message") {
			// The session header is the one non-message event, and it is counted as
			// its own reason rather than as junk: seeing "1 per session" tells a
			// reader the header was found, which is what the `cwd` came from.
			ignored += 1;
			continue;
		}
		const message = asRecord(header.message);
		if (!message) {
			malformed += 1;
			continue;
		}
		const rawTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
		const timestamp = Number.isFinite(rawTime) ? rawTime : candidate.startedAt;
		if (message.role === "user") {
			collected.push(...claudeEntriesFromUser(message.content, timestamp));
			continue;
		}
		if (message.role === "toolResult") {
			const toolCallId = asText(message.toolCallId);
			if (!toolCallId) {
				malformed += 1;
				continue;
			}
			collected.push(
				toolResultMessage(
					toolCallId,
					asText(message.toolName) || UNKNOWN_TOOL_NAME,
					claudeResultContent(message.content),
					message.isError === true,
					timestamp,
				),
			);
			continue;
		}
		if (message.role !== "assistant") {
			ignored += 1;
			continue;
		}
		const assistant = openclawAssistant(message, timestamp);
		if (assistant) collected.push(assistant);
	}
	const repaired = repairToolPairing(rewriteToolNames(collected));
	if (malformed > 0) notes.push({ reason: "malformed line", count: malformed });
	if (ignored > 0) notes.push({ reason: "non-conversation entry", count: ignored });
	if (compressed > 0) {
		notes.push({ reason: "zstd-compressed transcript event", count: compressed });
	}
	if (repaired.dropped > 0) notes.push({ reason: "unpaired tool call or result", count: repaired.dropped });
	return { entries: repaired.messages.map((message) => ({ kind: "message", message })), notes };
}

/**
 * One assistant turn, from OpenClaw's `AssistantMessage`
 * (`packages/llm-core/src/types.ts:387-422`).
 *
 * Structurally `claudeAssistant` with one difference worth naming: **OpenClaw's
 * `stopReason` includes `error` and `aborted`** (`:357`) where Claude Code's has
 * three values, so those two fall through to the tool-call-or-stop default rather
 * than being dropped.
 */
function openclawAssistant(message: Record<string, unknown>, timestamp: number): AgentMessage | null {
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
		if (block.type !== "toolCall") continue;
		const id = asText(block.id);
		const name = asText(block.name);
		if (!id || !name) continue;
		// `arguments` is a real object here (`:310`), not Claude Code's pre-serialized
		// string, so it is serialized rather than parsed.
		content.push({ type: "toolCall", id, name, arguments: JSON.stringify(block.arguments ?? {}) });
	}
	if (content.length === 0) return null;
	const usage = asRecord(message.usage);
	const hasToolCall = content.some((block) => block.type === "toolCall");
	return assistantMessage({
		content,
		model: asText(message.model),
		usage: {
			input: Number(usage?.input ?? 0) || 0,
			output: Number(usage?.output ?? 0) || 0,
			cacheRead: Number(usage?.cacheRead ?? 0) || 0,
			cacheWrite: Number(usage?.cacheWrite ?? 0) || 0,
		} satisfies Usage,
		stopReason: OPENCLAW_STOP_REASONS[asText(message.stopReason)] ?? (hasToolCall ? "toolUse" : "stop"),
		timestamp,
	});
}

/** OpenClaw's `StopReason` (`types.ts:357`), narrowed to this build's three. */
const OPENCLAW_STOP_REASONS: Record<string, "stop" | "toolUse" | "length"> = {
	stop: "stop",
	toolUse: "toolUse",
	length: "length",
};

/** A user turn's leading text, for the session title; `""` when there is none. */
function firstMessageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return firstText(content);
	if (!Array.isArray(content)) return "";
	for (const entry of content) {
		const block = asRecord(entry);
		if (block?.type !== "text") continue;
		const text = asText(block.text);
		if (text) return firstText(text);
	}
	return "";
}

// ---------------------------------------------------------------------------
// Codewhale
// ---------------------------------------------------------------------------

/**
 * Every Codewhale session, as candidates.
 *
 * **This is the one history listing in this file whose `cwd` is not a
 * substitute or a hash lookup.** `SessionMetadata.workspace` is a `PathBuf` with
 * the serde name `workspace` (`crates/tui/src/session_manager.rs:342-343`), so a
 * Codewhale transcript records the directory it ran in — and the on-disk fixture
 * confirms the key is really there, nested under `metadata`
 * (`crates/tui/tests/fixtures/work_graph_session_v1_reader.json:12`).
 *
 * That is why nothing here sets {@link HistoryCandidate.cwdSubstitute}: the
 * default `--history-scope cwd` genuinely narrows, where for most sources it
 * silently keeps everything.
 *
 * **The listing reads a bounded head of each file, not the whole thing.** The
 * envelope is pretty-printed JSON with `metadata` opening second, so a 256 KB
 * window finds every field this function needs without paying for a conversation
 * the user has not chosen yet. See `codewhale-session.ts`.
 */
function listCodewhaleHistory(home: string): HistoryListing {
	const listed = listCodewhaleSessions(home);
	const counts = new Map<string, number>();
	for (const skip of listed.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
	return {
		candidates: listed.sessions.map((session) => ({
			source: "codewhale",
			sourceId: session.id,
			// `metadata.workspace` when the session states one, `""` when it states
			// none — a scope filter is a question about a directory, and `""` is not
			// one. Same convention as kimi, step and MiniMax.
			cwd: session.cwd ?? "",
			title: session.title ?? "",
			startedAt: session.startedAt,
			path: session.path,
		})),
		notes: [...counts].map(([reason, count]) => ({ reason, count })),
	};
}

/**
 * Read one chosen Codewhale session.
 *
 * The listing read a bounded head and this reads the whole file; the session is
 * looked up again by path rather than rebuilt from it, so a file that went away
 * between the two phases is reported rather than reconstructed — the same
 * convention `readStepHistory` and `readMinimaxHistory` follow.
 */
function readCodewhaleHistory(
	home: string,
	candidate: HistoryCandidate,
): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const session = listCodewhaleSessions(home).sessions.find((found) => found.path === candidate.path);
	if (!session) return { entries: [], notes: [{ reason: "session is no longer on disk", count: 1 }] };
	const read = readCodewhaleSession(session);
	if ("error" in read) return { entries: [], notes: [{ reason: read.error, count: 1 }] };
	// Same rule as its neighbours: a session whose every message was dropped is
	// reported by why rather than counted as a session that was empty. "Nothing to
	// import" is a claim about the user's conversation, and this reader is in no
	// position to make it when the reason it holds nothing is a file it could not
	// open.
	if (read.entries.length === 0) {
		if (read.notes.length > 0) return { entries: [], notes: read.notes };
		return { entries: [], notes: [{ reason: "session transcript with no convertible message", count: 1 }] };
	}
	return { entries: read.entries, notes: read.notes };
}

/**
 * Read one chosen Alma thread.
 *
 * **Alma's conversations are rows, not files**, so this is a second query rather
 * than a second read of something already in hand — the same shape as the
 * SQLite-backed sources and unlike the file-backed ones.
 *
 * **The one Alma-specific fact is the working directory, and it is already
 * settled before this runs.** `chat_threads` has no directory column and
 * `metadata` is not one either — the application writes `metadata: {}` when it
 * creates a thread — so the path comes from `workspace_id → workspaces.path`.
 * When that link is gone, `listAlmaHistory` has already filed the candidate under
 * the configuration root and set `cwdSubstitute`, and the report says the
 * directory was assumed rather than recorded. **This function never invents
 * one**: a wrong `cwd` files a conversation under a project it was never had in,
 * which is the one error the rest of the pipeline cannot recover from.
 */
function readAlmaHistory(candidate: HistoryCandidate): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const conversation = readAlmaConversation(candidate.sourceId);
	if (conversation === null) {
		return {
			entries: [],
			notes: [
				{
					reason:
						"thread that was offered and could not be read — the database moved, or Alma was running and held it. Re-run with the app closed",
					count: 1,
				},
			],
		};
	}
	if (conversation.messages.length === 0) {
		if (conversation.notes.length > 0) return { entries: [], notes: conversation.notes };
		return {
			entries: [],
			notes: [
				{
					reason:
						"thread with no message rows — not the same as a thread with nothing to say: Alma records a tool call as its own message row, and only `text` parts become a turn here",
					count: 1,
				},
			],
		};
	}
	return {
		entries: conversation.messages.map((message) => ({ kind: "message" as const, message })),
		notes: conversation.notes,
	};
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
										: source === "opencode"
											? listOpencodeHistory(home)
											: source === "t3-code"
												? listT3History(home)
												: source === "antigravity"
													? listAntigravityHistory(home, options)
													: source === "qoder"
														? listQoderHistory(home)
														: source === "mimocode-code"
															? listMiMoCodeHistory(home)
															: source === "openclaw"
																? listOpenClawHistory(home)
																: source === "codewhale"
																	? listCodewhaleHistory(home)
																	: source === "alma"
																		? listAlmaHistory(home)
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
			else if (source === "opencode") converted = readOpencodeSession(candidate.sourceId, home);
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
			} else if (source === "t3-code") {
				const read = readT3History(home, candidate);
				// Same rule as its neighbours: a thread that could not be read is
				// reported by why, rather than counted as a session that was empty.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else if (source === "antigravity") {
				const read = readAntigravityHistory(home, candidate);
				// Same rule as its neighbours: a conversation that could not be read is
				// reported by why, rather than counted as a session that was empty.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else if (source === "qoder") {
				// Unreachable today: `listQoderHistory` returns no candidates, so a
				// selection cannot produce one. It is here rather than left to the
				// fall-through `else continue` below because that fall-through is
				// silent — a source whose *list* half starts returning sessions and
				// whose read half was never wired would drop every one of them without
				// a word, where this branch says why.
				notes.push({ reason: QODER_HISTORY_NOT_IMPORTED, count: 1 });
				continue;
			} else if (source === "codewhale") {
				const read = readCodewhaleHistory(home, candidate);
				// Same rule as its neighbours: a conversation that could not be read is
				// reported by why, rather than counted as a session that was empty.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else if (source === "mimocode-code") {
				const read = readMiMoCodeSession(candidate.sourceId, home);
				// Same rule as its neighbours: a conversation that could not be read is
				// reported by why, rather than counted as a session that was empty.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else if (source === "openclaw") {
				const read = readOpenClawSession(home, candidate);
				// Same rule as its neighbours: a conversation that could not be read is
				// reported by why, rather than counted as a session that was empty.
				if (read.entries.length === 0) {
					if (read.notes.length > 0) notes.push(...read.notes);
					else failed += 1;
					continue;
				}
				converted = read;
			} else if (source === "alma") {
				const read = readAlmaHistory(candidate);
				// Same rule as its neighbours: a conversation that could not be read is
				// reported by why, rather than counted as a session that was empty. For
				// Alma that covers a thread whose every message was a tool call or an
				// image, which is a real state — `chat_messages.message` holds a JSON
				// blob whose `parts` are filtered to `type === "text"`, so an Alma
				// conversation that was nothing but edits imports as nothing and says so.
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
			// The reader's own reasons are pushed first, for the reason the step and
			// deepseek branches give inline: a session whose every turn was a shape
			// this build cannot carry has been *explained*, and dropping the
			// explanation leaves the user with a bare count and a wrong conclusion
			// ("those sessions were empty" rather than "those sessions were made of
			// images and tool output").
			if (converted.notes.length > 0) notes.push(...converted.notes);
			failed += 1;
			continue;
		}
		notes.push(...converted.notes);
		sessions.push({
			source,
			sourceId: candidate.sourceId,
			cwd: candidate.cwd,
			// Carried rather than resolved here: `cwd` already holds the substitute,
			// so all this does is tell the report which kind of directory it is.
			// Left out entirely for the thirteen sources that record one, so `===`
			// against `undefined` is the test that the thirteen are untouched.
			...(candidate.cwdSubstitute === undefined ? {} : { cwdSubstitute: candidate.cwdSubstitute }),
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
