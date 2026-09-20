/**
 * DeepSeek Harness session logs (`$DSH_HOME/sessions`).
 *
 * The harness keeps one append-only JSONL artifact per session, inside a
 * directory named after the project it ran in, and only the numerically highest
 * canonical generation in that directory is live: a format migration writes a
 * successor and leaves its predecessor behind, so a reader that took whichever
 * file it found first would replay a session as it stood several formats ago.
 * Compression is on by default, which makes the artifact a run of concatenated
 * zstd frames — nothing can be read before it is decompressed.
 *
 * What the log holds is not the conversation but the events the conversation was
 * derived from: a message only reaches the model through one of four event types,
 * and compaction rewrites the surface by replacing a range of those events with a
 * later one. This module folds that surface (so a compacted session imports as
 * the harness would replay it) and skips everything else as bookkeeping.
 *
 * Reading is bounded the way the importer's other sources are: the listing keeps
 * a head of every log for the picker, and only a log the user chose is read end
 * to end. Nothing here writes, and session logs are the only files it opens —
 * the credentials dsh keeps in the same home stay shut.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentMessage,
	type AssistantContent,
	assistantMessage,
	repairToolPairing,
	type ToolResultContent,
	textContent,
	toolResultMessage,
	userMessage,
} from "@labunbun/ai";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One readable session log, after picking its live generation. */
export interface DshSessionFile {
	/** Absolute path of the log to read. */
	path: string;
	/** Header id. */
	sessionId: string;
	/** Header cwd, "" when the log has none (the `_no-cwd` bucket). */
	cwd: string;
	/** Header createdAt (epoch ms). */
	startedAt: number;
	/** Title if the log states one, else "". */
	title: string;
}

export interface DshListing {
	sessions: DshSessionFile[];
	notes: Array<{ reason: string; count: number }>;
}

/** Every live session log under `<dshHome>/sessions`, newest first is NOT required — order is not part of the contract. */
export function listDshSessions(dshHome: string): DshListing {
	const sessions: DshSessionFile[] = [];
	const counts = new Map<string, number>();
	const root = join(dshHome, "sessions");
	for (const bucket of subdirectories(root)) {
		for (const dir of subdirectories(join(root, bucket))) {
			const path = liveGeneration(join(root, bucket, dir));
			if (path === null) continue;
			const head = readHead(path);
			if ("reason" in head) {
				bump(counts, head.reason);
				continue;
			}
			sessions.push({
				path,
				sessionId: head.header.sessionId,
				cwd: head.header.cwd,
				startedAt: head.header.startedAt,
				title: head.title,
			});
		}
	}
	return { sessions, notes: toNotes(counts) };
}

export type DshEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "compaction"; summary: string; preTokens: number };

export interface DshRead {
	entries: DshEntry[];
	notes: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Log files
// ---------------------------------------------------------------------------

/**
 * A canonical generation filename, as the harness's `parseGenerationLogFilename`
 * defines one: the untagged `session.jsonl` is generation zero, every later one
 * carries a lowercase `vN` with no leading zero, and the compression suffix is
 * the only thing that may follow. Anything else in a session directory — a
 * temporary write, a name from a format this build does not read — is ignored
 * rather than guessed at, because the file behind it may be half-written.
 */
const CANONICAL_GENERATION = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/** How much of a log's head the listing keeps; see {@link readHead}. */
const HEAD_BYTES = 256 * 1024;

function subdirectories(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		// An unreadable level contributes nothing; the rest of the walk stands.
		return [];
	}
}

/** The live generation of one session directory: highest version, raw over compressed. */
function liveGeneration(dir: string): string | null {
	let best: { version: number; compressed: boolean; path: string } | null = null;
	try {
		for (const name of readdirSync(dir)) {
			const match = CANONICAL_GENERATION.exec(name);
			if (!match) continue;
			const version = match[1] === undefined ? 0 : Number(match[1]);
			const compressed = match[2] !== undefined;
			// Both spellings of one generation means the writer left the plain text
			// behind, and plain text is the cheaper read; the higher version always
			// wins over the lower one.
			const better =
				best === null || version > best.version || (version === best.version && best.compressed && !compressed);
			if (better) best = { version, compressed, path: join(dir, name) };
		}
	} catch {
		return null;
	}
	return best?.path ?? null;
}

/**
 * A log's text, decompressing it when the artifact is compressed.
 *
 * `zstdDecompressSync` decodes the concatenated frames the writer produces. A
 * failure is a reason string rather than an exception, so a damaged session
 * costs the picker one entry instead of the whole import.
 */
function readLogText(path: string): { text: string } | { reason: string } {
	let buffer: Buffer;
	try {
		buffer = readFileSync(path);
	} catch {
		return { reason: "unreadable session log" };
	}
	if (!path.endsWith(".zstd")) return { text: buffer.toString("utf8") };
	try {
		return { text: Bun.zstdDecompressSync(buffer).toString("utf8") };
	} catch {
		return { reason: "unreadable zstd log" };
	}
}

/** The header line dsh writes first, as far as this reader needs it. */
interface DshHeader {
	sessionId: string;
	cwd: string;
	startedAt: number;
}

function parseHeader(text: string): DshHeader | null {
	const newline = text.indexOf("\n");
	const parsed = parseJsonLine(newline === -1 ? text : text.slice(0, newline));
	if (parsed?.type !== "session") return null;
	const sessionId = asText(parsed.id);
	if (!sessionId) return null;
	return { sessionId, cwd: asText(parsed.cwd), startedAt: asNumber(parsed.createdAt, 0) };
}

/**
 * What the listing needs from one log: its header, and its title when the log
 * states one.
 *
 * This is the importer's head-read idiom (`readHeadLines`), which reads the file
 * and keeps a capped prefix of it: only the first {@link HEAD_BYTES} of the text is
 * retained, and the lines past the window are dropped. A header and an opening
 * prompt are a few KB where a log from a week-long session is tens of MB, so the
 * window is generous by three orders of magnitude. For a compressed artifact
 * decompression still sees the whole thing — the frames are one stream, so the cap
 * bounds what is retained rather than what is read.
 */
function readHead(path: string): { header: DshHeader; title: string } | { reason: string } {
	const opened = readLogText(path);
	if ("reason" in opened) return opened;
	const head = opened.text.slice(0, HEAD_BYTES);
	const header = parseHeader(head);
	if (!header) return { reason: "session log without a header" };
	let title = "";
	let prompt = "";
	for (const line of head.split("\n").slice(1)) {
		if (!line.trim()) continue;
		const row = parseJsonLine(line);
		if (!row) continue;
		if (row.type === "session/title") {
			title = firstText(asText(asRecord(row.data)?.title));
			if (title) break;
			continue;
		}
		// The opening prompt is the fallback, and it is genuinely a fallback: dsh
		// titles a session after its first model reply, so the title event lands
		// *after* the first message and taking whichever of the two comes first
		// would hand the picker a prompt for every session the harness ever titled.
		// A log too young to have a title still has the prompt.
		if (!prompt && row.type === "user/message") prompt = firstText(userText(asRecord(row.data)?.content));
	}
	return { header, title: title || prompt };
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

// The same handful of private helpers every source reader here carries. They are
// written out rather than imported from `migrate-history.ts`, because that module
// imports this one: a source reader that depended on its importer would only be
// able to run once the importer had, and the readers exist to be independent of
// what consumes them.

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return asRecord(JSON.parse(trimmed));
	} catch {
		return null;
	}
}

function firstText(value: string, max = 60): string {
	const single = value.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** Count one skip reason; the notes come out in first-seen order. */
function bump(counts: Map<string, number>, reason: string, by = 1): void {
	if (by <= 0) return;
	counts.set(reason, (counts.get(reason) ?? 0) + by);
}

function toNotes(counts: Map<string, number>): Array<{ reason: string; count: number }> {
	return [...counts].map(([reason, count]) => ({ reason, count }));
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
 * Fill in a tool result's tool name from the call it answers: only the call
 * records the name, and a result that arrives without one renders as an unnamed
 * tool in the transcript view.
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

// ---------------------------------------------------------------------------
// Reading one log
// ---------------------------------------------------------------------------

/**
 * The event vocabulary this build understands, copied from the harness's own
 * `KNOWN_SESSION_EVENT_TYPES` (`packages/core/session/src/known-event-types.ts`).
 *
 * dsh states the obligation and this is where it is honoured: an event whose type
 * a reader does not recognize may change how the rest of the log reads, so a log
 * carrying one that did not declare itself skippable is refused instead of
 * silently thinned out. There is no package shared between the two projects to
 * import the list from, so a harness newer than this copy lands in the refuse
 * case — which is the direction that reports a session as unreadable rather than
 * importing a gutted one.
 */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
	"agent-preset/selected",
	"agent/inbox/spliced",
	"approval/asked",
	"approval/decided",
	"approval/policy",
	"assistant/attempt",
	"assistant/message",
	"command/done",
	"command/run",
	"compaction/end",
	"compaction/prune",
	"compaction/start",
	"compaction/summary",
	"deliverables/presented",
	"feedback/message-delete",
	"feedback/message-put",
	"feedback/record",
	"goal/change",
	"hook/invoked",
	"hook/result",
	"image/offload",
	"llm/retry",
	"llm/retry-started",
	"model/selection",
	"permission/preset",
	"plan/mode",
	"request/context",
	"request/header",
	"sandbox/mode",
	"schedule/change",
	"session-log-deepseek/delivery-accepted",
	"session/end-seed",
	"session/title",
	"session/title-llm-request",
	"step/end",
	"step/start",
	"subagent/catalog",
	"subagent/descriptor",
	"subagent/model-selection-policy",
	"system/message",
	"team/member",
	"team/message/delivered",
	"team/message/queued",
	"team/task",
	"todo/write",
	"tool-workflow/agent-end",
	"tool-workflow/agent-start",
	"tool-workflow/run-end",
	"tool-workflow/run-start",
	"tool/call",
	"tool/ptc-dispatch",
	"tool/ptc-dispatch-start",
	"tool/result",
	"turn/end",
	"turn/start",
	"user/message",
	"web/deepseek-search-llm-request",
	"workspace/changes",
]);

/** The four event types that reach the model; every other known type is bookkeeping. */
const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set([
	"system/message",
	"user/message",
	"assistant/message",
	"tool/result",
]);

/** One model-visible node: the event that placed it, and what it contributes. */
interface SurfaceNode {
	/** Sequence of the event that placed this node on the surface. */
	seq: number;
	/** Entries this node adds to the imported transcript; empty for a system prompt. */
	entries: DshEntry[];
}

/**
 * The sequence a row carries, which is its position in the log.
 *
 * Committed logs do not store one: a row holds `type`, `data`, and a `surfaceOp`
 * when it has one, nothing else. The harness reconstructs the number from the log
 * offset and refuses a log whose stored sequence is not contiguous with it
 * (`planSurfaceEvent` in `packages/core/session/src/surface.ts`), so position is
 * not a guess at a missing field — it is the rule the ranged replacements in a
 * file are written against. The recorded logs confirm it: `compaction-recovery`'s
 * `compaction/summary` states `shadowedRange {start: 8, end: 9}` for the two
 * prompts on file rows 9 and 10 — the header is row zero of the file but not
 * event zero, which is why this is `index - 1` and not `index`.
 */
function eventSeq(index: number): number {
	return index - 1;
}

/** The text blocks of a `user/message` payload's content, joined as they are imported. */
function userText(content: unknown): string {
	const texts: string[] = [];
	for (const raw of Array.isArray(content) ? content : []) {
		const block = asRecord(raw);
		if (block?.type !== "text") continue;
		const text = asText(block.text);
		if (text) texts.push(text);
	}
	return texts.join("\n\n");
}

/** How many blocks of a `user/message` point at attachments, which do not travel. */
function attachmentCount(content: unknown): number {
	let count = 0;
	for (const raw of Array.isArray(content) ? content : []) {
		const type = asRecord(raw)?.type;
		if (type === "image" || type === "file") count += 1;
	}
	return count;
}

/**
 * A `user/message` as a labunbun user message, or null when it carries no text.
 *
 * Image and file blocks point into the harness's attachment store, which is not
 * part of the transcript; the text around them is kept and every dropped
 * attachment is counted. A message that was *only* an attachment is dropped
 * rather than emitted empty: an empty user turn is a message the API can refuse,
 * and a transcript that fails on the first `--continue` is worse than a shorter
 * one — the same bet {@link resultContent} makes for a tool output.
 */
function dshUserMessage(
	data: Record<string, unknown> | null,
	timestamp: number,
	counts: Map<string, number>,
): AgentMessage | null {
	const content = data?.content;
	bump(counts, "attachment not carried", attachmentCount(content));
	const text = userText(content);
	return text ? userMessage(text, timestamp) : null;
}

/**
 * An `assistant/message` as one labunbun assistant message, or null when nothing
 * model-facing is left of it.
 *
 * dsh groups a step's blocks into one message already, so this is a per-block
 * translation with nothing to accumulate across events.
 */
function dshAssistant(
	data: Record<string, unknown> | null,
	timestamp: number,
	counts: Map<string, number>,
): AgentMessage | null {
	const message = asRecord(data?.message);
	const content: AssistantContent[] = [];
	for (const raw of Array.isArray(message?.content) ? message.content : []) {
		const block = asRecord(raw);
		if (!block) continue;
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) content.push(textContent(text));
			continue;
		}
		if (block.type === "reasoning") {
			// Counted, not carried: the text is the model's own scratchpad, and a
			// thinking block handed back without the signature of the provider that
			// issued it is one the target API can refuse.
			bump(counts, "reasoning block");
			continue;
		}
		if (block.type !== "tool-call") continue;
		const id = asText(block.id);
		if (!id) continue;
		content.push({
			type: "toolCall",
			id,
			name: asText(block.name) || UNKNOWN_TOOL_NAME,
			// dsh keeps the model's raw argument string, which is often not valid JSON;
			// normalizing here is what stops an invalid call from reaching a request.
			arguments: JSON.stringify(parseArguments(asText(block.arguments))),
		});
	}
	if (content.length === 0) return null;
	const source = asRecord(message?.source);
	const calls = content.some((block) => block.type === "toolCall");
	return assistantMessage({
		content,
		provider: asText(source?.provider),
		model: asText(source?.model),
		stopReason: calls ? "toolUse" : "stop",
		timestamp,
	});
}

/** A `tool/result` as a labunbun tool result, or null when it names no call. */
function dshToolResult(
	data: Record<string, unknown> | null,
	timestamp: number,
	callNames: Map<string, string>,
): AgentMessage | null {
	const message = asRecord(data?.message);
	const callId = asText(asRecord(message?.source)?.callId);
	if (!callId) return null;
	const block = asRecord(Array.isArray(message?.content) ? message.content[0] : null);
	const texts: string[] = [];
	for (const raw of Array.isArray(block?.content) ? block.content : []) {
		const inner = asRecord(raw);
		if (inner?.type !== "text") continue;
		const text = asText(inner.text);
		if (text) texts.push(text);
	}
	// The failure identity beside the message is optional (the loop records the
	// tool's own error info, and a tool may fail without one), so the model-facing
	// `isError` on the result block counts too.
	const isError = asRecord(data?.error) !== null || block?.isError === true;
	return toolResultMessage(
		callId,
		callNames.get(callId) || UNKNOWN_TOOL_NAME,
		resultContent(texts.join("\n")),
		isError,
		timestamp,
	);
}

/** The summary a `compaction/summary` states, or null when it carries no text. */
function compactionSummary(data: Record<string, unknown> | null): { summary: string; preTokens: number } | null {
	const summary = userText(data?.summary);
	// No text means no boundary worth writing: the replacement event that follows
	// carries the harness's own framing and is imported as the message it is.
	return summary ? { summary, preTokens: asNumber(data?.shadowedTokenCount, 0) } : null;
}

/**
 * Read one log end to end. Returns `{ error }` when the log must not be reconstructed.
 *
 * The fold is the harness's own, over the four message-producing event types: a
 * node is appended to the surface, or replaces the surface range its `surfaceOp`
 * names, exactly as `foldSurface` does. Reading the events without folding would
 * replay a compacted session at full length — the context the harness dropped
 * comes back, and the boundary it wrote is missing.
 */
export function readDshLog(path: string): DshRead | { error: string } {
	const opened = readLogText(path);
	if ("reason" in opened) return { error: opened.reason };
	const header = parseHeader(opened.text);
	if (!header) return { error: "session log without a header" };

	const counts = new Map<string, number>();
	const nodes: SurfaceNode[] = [];
	/** callId → tool name: `tool/call` is the only event that records the name. */
	const callNames = new Map<string, string>();
	// A finished summary waits for the event that carries it onto the surface. dsh
	// replaces the compacted range with the `user/message` appended right after
	// `compaction/summary` (`compaction/*` is log-only), so the pair is read as one
	// compaction instead of as a prompt that repeats the summary.
	let summary: { summary: string; preTokens: number } | null = null;
	// The last timestamp seen: a row without a usable `time` inherits it, and the
	// session's creation time is the floor.
	let lastTime = header.startedAt;

	const lines = opened.text.split("\n");
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) continue;
		const row = parseJsonLine(line);
		const type = asText(row?.type);
		if (!row || !type) {
			bump(counts, "malformed line");
			continue;
		}
		if (!KNOWN_EVENT_TYPES.has(type)) {
			// The reader obligation dsh states: an unknown type that did not declare
			// itself skippable may change how the rest of the log reads.
			if (row.ignorable !== true) return { error: `unknown event type "${type}"` };
			continue;
		}
		if (type === "compaction/summary") {
			summary = compactionSummary(asRecord(row.data));
			continue;
		}
		if (type === "tool/call") {
			const data = asRecord(row.data);
			const callId = asText(data?.callId);
			if (callId) callNames.set(callId, asText(data?.name));
			continue;
		}
		// Every other known type is bookkeeping: turn and step boundaries, inbox
		// splices, request headers, todos, hooks, titles. None of them can add,
		// remove, or rewrite a message, so none is counted as a loss — counting them
		// would bury the real skips under a four-figure number.
		if (!SURFACE_EVENT_TYPES.has(type)) continue;

		const seq = eventSeq(index);
		const data = asRecord(row.data);
		const timestamp = asNumber(row.time, lastTime);
		const pending = summary;
		summary = null;
		const op = asRecord(row.surfaceOp);
		const start = op?.op === "replace" ? nodes.findIndex((node) => node.seq === asNumber(op.startSeq, -1)) : -1;
		const end = op?.op === "replace" ? nodes.findIndex((node) => node.seq === asNumber(op.endSeq, -1)) : -1;
		if (op?.op === "replace" && (start === -1 || end === -1 || start > end)) {
			// A range the surface does not hold means this reader and the log disagree
			// about what the conversation was; refusing beats importing a prefix the
			// harness itself dropped.
			return { error: `surface replace at seq ${seq} names a range the surface does not hold` };
		}
		let entries: DshEntry[] = [];
		if (pending && op?.op === "replace" && type === "user/message") {
			// The harness's replacement for a compacted range: carried as a compaction
			// entry, whose boundary reads like the one labunbun writes for itself.
			entries = [{ kind: "compaction", summary: pending.summary, preTokens: pending.preTokens }];
		} else if (type === "user/message") {
			const message = dshUserMessage(data, timestamp, counts);
			if (message) entries = [{ kind: "message", message }];
		} else if (type === "assistant/message") {
			const message = dshAssistant(data, timestamp, counts);
			if (message) entries = [{ kind: "message", message }];
		} else if (type === "tool/result") {
			const message = dshToolResult(data, timestamp, callNames);
			if (message) entries = [{ kind: "message", message }];
		} else {
			// A `system/message` is the harness's rendered system prompt, and this build
			// renders its own on resume; importing it would send two. The node still
			// takes its place on the surface, because a compacted range cites it.
			bump(counts, "system message (injected context)");
		}
		if (type !== "system/message") lastTime = timestamp;
		// A node with no `replace` marker appended to the tail, which is the only
		// other placement the format defines.
		if (op?.op === "replace") nodes.splice(start, end - start + 1, { seq, entries });
		else nodes.push({ seq, entries });
	}

	const ordered: DshEntry[] = [];
	for (const node of nodes) ordered.push(...node.entries);
	const messages: AgentMessage[] = [];
	// A compaction boundary belongs where the harness put it: after the messages of
	// the nodes before it. Its position is kept as an index into the message stream;
	// if the repair pass drops something, the boundaries move to the end rather than
	// land mid-stream (the same trade the ZCode reader makes).
	const markers: Array<{ after: number; entry: DshEntry }> = [];
	for (const entry of ordered) {
		if (entry.kind === "message") messages.push(entry.message);
		else markers.push({ after: messages.length, entry });
	}

	const repaired = repairToolPairing(rewriteToolNames(messages));
	let entries: DshEntry[] = repaired.messages.map((message) => ({ kind: "message", message }));
	if (markers.length > 0) {
		if (repaired.dropped === 0) {
			for (const marker of [...markers].sort((a, b) => b.after - a.after)) {
				entries.splice(Math.min(marker.after, entries.length), 0, marker.entry);
			}
		} else {
			entries = [...entries, ...markers.map((marker) => marker.entry)];
		}
	}
	bump(counts, "unpaired tool call or result", repaired.dropped);
	return { entries, notes: toNotes(counts) };
}
