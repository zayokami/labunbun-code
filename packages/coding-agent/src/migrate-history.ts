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
import { dshRoot } from "./dsh-home.ts";
import { listDshSessions, readDshLog } from "./dsh-session.ts";
import type { MigrationSourceId } from "./migrate.ts";
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
		const out: string[] = [];
		let used = 0;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (out.length > 0 && used + line.length > maxBytes) break;
			out.push(line);
			used += line.length;
		}
		return out;
	} catch {
		return [];
	}
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

/** `rollout-*.jsonl` under `~/.codex/sessions/YYYY/MM/DD/`, newest first. */
function listRolloutFiles(root: string): Array<{ name: string; path: string; mtimeMs: number }> {
	const out: Array<{ name: string; path: string; mtimeMs: number }> = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) return;
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(path, depth + 1);
					continue;
				}
				if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
				out.push({ name: entry.name, path, mtimeMs: mtimeOf(path) });
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

function listClaudeCodeHistory(home: string): HistoryListing {
	const root = join(home, ".claude", "projects");
	const candidates: HistoryCandidate[] = [];
	const notes: HistoryNote[] = [];
	let subagents = 0;
	let skippedDirs = 0;
	let unreadable = 0;
	try {
		if (!existsSync(root)) return { candidates, notes };
		for (const project of readdirSync(root, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			const projectDir = join(root, project.name);
			for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
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

function readCodexMeta(path: string): { cwd: string; sessionId: string; child: boolean; startedAt: number } | null {
	let startedAt = 0;
	for (const line of readHeadLines(path, 16_384)) {
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

function listCodexHistory(home: string): HistoryListing {
	const candidates: HistoryCandidate[] = [];
	let children = 0;
	let unreadable = 0;
	for (const file of listRolloutFiles(join(home, ".codex", "sessions"))) {
		const meta = readCodexMeta(file.path);
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
			sourceId: meta.sessionId || file.name.replace(/^rollout-/, "").replace(/\.jsonl$/, ""),
			cwd: meta.cwd,
			title: "",
			startedAt: meta.startedAt || file.mtimeMs,
			path: file.path,
		});
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

	for (const line of readFileSync(path, "utf8").split("\n")) {
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
 * `~/.codex/history.jsonl`: `{session_id, text, ts}`.
 *
 * It names the session, not the directory, so the directory comes from the
 * rollout of that session — the same metadata the session listing reads. A
 * prompt whose session has no rollout left on disk cannot be located to a
 * project, and an entry that no directory can recall is not worth writing.
 */
function readCodexPromptHistory(
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	const scan: PromptScan = { candidates: [], counts: new Map(), seen: 0, truncated: false };
	// Before the rollout scan, not after: locating each prompt costs a head-read
	// per rollout, and a home with no prompt history has nothing to locate.
	if (!existsSync(join(home, ".codex", "history.jsonl"))) return selectPrompts(scan, options);
	const directories = new Map<string, string>();
	for (const candidate of listCodexHistory(home).candidates) {
		if (candidate.cwd) directories.set(candidate.sourceId, candidate.cwd);
	}
	const tail = readTailLines(join(home, ".codex", "history.jsonl"), PROMPT_HISTORY_BYTES);
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

/** Prompts a source remembers, ready to be merged into the recall list. */
export function readPromptHistory(
	source: MigrationSourceId,
	home: string,
	options: { cwd: string; scope: HistoryScope; limit: number },
): PromptHistoryInput {
	if (options.scope === "none") return { seen: 0, entries: [], notes: [], overLimit: 0, truncated: false };
	if (source === "claude-code") return readClaudePromptHistory(home, options);
	if (source === "codex") return readCodexPromptHistory(home, options);
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
