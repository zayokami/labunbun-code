// MiniMax Code session transcripts (`<root>/v2/sessions`), in two history generations: the released
// snapshot-and-ledger pair, and the canonical `messages.jsonl`.
// Long-form design notes: docs/dev/migration-sources.md
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentMessage,
	type AssistantContent,
	assistantMessage,
	type ImageContent,
	repairToolPairing,
	type StopReason,
	type TextContent,
	type ToolCall,
	type ToolResultContent,
	textContent,
	toolResultMessage,
	type Usage,
	type UserContent,
	userMessage,
} from "@labunbun/ai";
import { minimaxRuntimeStateDb, minimaxSessionsRoot } from "./minimax-home.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Which of the two writers left a session's transcript on disk. */
export type MinimaxHistoryKind = "canonical" | "legacy";

/** One session worth offering: a readable manifest, and history behind it. */
export interface MinimaxSessionFile {
	/** The identity the tool itself uses, from the manifest's `sessionId`. */
	sessionId: string;
	/** The dated session directory. */
	dir: string;
	/** `<yyyy>/<MM>/<dd>/<session directory>` — the tool's own key for it. */
	relativeDir: string;
	/** The file the transcript was found in: `messages.jsonl`, else the legacy pair. */
	path: string;
	/** Which writer left it, so the report can say which format was read. */
	history: MinimaxHistoryKind;
	/** The directory the session ran in; "" when only the metadata row knows it and the row is gone. */
	cwd: string;
	/** `createdAtMs` from the manifest, which the tool refuses to do without. */
	startedAt: number;
	/** The row's `updated_at_ms`, falling back to the manifest's own field. */
	updatedAt: number;
	/** The row's title; "" for a session that was never given one. */
	title: string;
	/** The user filed it away rather than leaving it in the list. */
	archived: boolean;
	/** `session_kind`: conversation | task | peek | channel | cron | unknown; "" with no row. */
	kind: string;
	/** `session_type`: root | branch; "" with no row. */
	sessionType: string;
	/** The session this one hangs under; "" for a top-level one. */
	parentSessionId: string;
}

export interface MinimaxListing {
	sessions: MinimaxSessionFile[];
	notes: Array<{ reason: string; count: number }>;
}

/** One entry of a transcript, in the shape the session file stores it. */
export type MinimaxEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "compaction"; summary: string; preTokens: number };

export interface MinimaxRead {
	entries: MinimaxEntry[];
	notes: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The session kinds the tool keeps out of the ordinary session list. */
const INTERNAL_SESSION_KINDS = new Set(["peek", "task", "channel", "cron"]);

// Long-form design notes: docs/dev/migration-sources.md
/** Every session the tool's own walk would find. */
export function listMinimaxSessions(root: string): MinimaxListing {
	const sessions: MinimaxSessionFile[] = [];
	const counts = new Map<string, number>();
	const sessionsRoot = minimaxSessionsRoot(root);
	const rows = readSessionRows(minimaxRuntimeStateDb(root), counts);

	for (const year of subdirectories(sessionsRoot)) {
		const monthsRoot = join(sessionsRoot, year);
		for (const month of subdirectories(monthsRoot)) {
			const daysRoot = join(monthsRoot, month);
			for (const day of subdirectories(daysRoot)) {
				const dayRoot = join(daysRoot, day);
				for (const name of subdirectories(dayRoot)) {
					const dir = join(dayRoot, name);
					const manifest = readManifest(dir);
					if (manifest === null) {
						bump(counts, "session directory with no readable manifest.json");
						continue;
					}
					const found = locateHistory(dir);
					if (found === null) {
						bump(counts, "session whose history files are gone");
						continue;
					}
					const row = rows.readable ? rows.byId.get(manifest.sessionId) : undefined;
					if (row) {
						if (row.visibility !== "" && row.visibility !== "visible") {
							bump(counts, "hidden session");
							continue;
						}
						if (INTERNAL_SESSION_KINDS.has(row.kind)) {
							bump(counts, `internal session (${row.kind})`);
							continue;
						}
						if (row.parentSessionId) {
							bump(counts, "sub-session of another session");
							continue;
						}
					} else if (rows.readable) {
						bump(counts, "session with no metadata row");
					}
					sessions.push({
						sessionId: manifest.sessionId,
						dir,
						relativeDir: [year, month, day, name].join("/"),
						path: found.path,
						history: found.kind,
						cwd: row?.cwd ?? "",
						startedAt: manifest.createdAtMs,
						updatedAt: row?.updatedAt || manifest.updatedAtMs,
						title: row?.title ?? "",
						archived: row?.archived ?? false,
						kind: row?.kind ?? "",
						sessionType: row?.sessionType ?? "",
						parentSessionId: row?.parentSessionId ?? "",
					});
				}
			}
		}
	}
	// The tool's own list is `updated_at_ms DESC` with the session id breaking
	// ties (`idx_local_runtime_sessions_recency_v2`), so sorting here keeps a
	// caller's history limit meaning the sessions the user last used.
	sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
	return { sessions, notes: toNotes(counts) };
}

/** A session directory's identity, from the manifest the tool itself wrote. */
interface MinimaxManifest {
	sessionId: string;
	createdAtMs: number;
	updatedAtMs: number;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<dir>/manifest.json`, or null when it is not a manifest this reader can name. */
function readManifest(dir: string): MinimaxManifest | null {
	const value = parseJsonText(readTextOrNull(join(dir, "manifest.json")));
	if (value === null) return null;
	const sessionId = value.sessionId;
	if (typeof sessionId !== "string" || !Number.isSafeInteger(value.createdAtMs)) return null;
	return {
		sessionId,
		createdAtMs: value.createdAtMs as number,
		updatedAtMs: asNumber(value.updatedAtMs) ?? (value.createdAtMs as number),
	};
}

// Long-form design notes: docs/dev/migration-sources.md
/** Which history a session directory holds, and the file to open first. */
function locateHistory(dir: string): { kind: MinimaxHistoryKind; path: string } | null {
	const messages = join(dir, "messages.jsonl");
	if (existsSync(messages)) return { kind: "canonical", path: messages };
	const ledger = join(dir, "ledger.jsonl");
	if (existsSync(ledger)) return { kind: "legacy", path: ledger };
	const snapshot = join(dir, "snapshot.json");
	if (existsSync(snapshot)) return { kind: "legacy", path: snapshot };
	return null;
}

/** One `local_runtime_sessions` row, as much of it as a migration needs. */
interface MinimaxSessionRow {
	title: string;
	cwd: string;
	archived: boolean;
	visibility: string;
	kind: string;
	sessionType: string;
	parentSessionId: string;
	updatedAt: number;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The session metadata, read-only, or an empty index with a note. */
function readSessionRows(
	dbPath: string,
	counts: Map<string, number>,
): { readable: boolean; byId: Map<string, MinimaxSessionRow> } {
	const byId = new Map<string, MinimaxSessionRow>();
	if (!existsSync(dbPath)) {
		bump(counts, "session metadata database not present (no titles or project directories)");
		return { readable: false, byId };
	}
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		const rows = db
			.query(
				"select session_id, title, workspace_dir, archived, visibility, session_kind, session_type, parent_session_id, updated_at_ms from local_runtime_sessions",
			)
			.all() as Array<Record<string, unknown>>;
		for (const row of rows) {
			const sessionId = asText(row.session_id);
			if (!sessionId) continue;
			byId.set(sessionId, {
				title: asText(row.title),
				cwd: asText(row.workspace_dir),
				archived: asNumber(row.archived) === 1,
				visibility: asText(row.visibility),
				kind: asText(row.session_kind),
				sessionType: asText(row.session_type),
				parentSessionId: asText(row.parent_session_id),
				updatedAt: asNumber(row.updated_at_ms) ?? 0,
			});
		}
		return { readable: true, byId };
	} catch {
		bump(counts, "session metadata database not readable (no titles or project directories)");
		// A row half-read before the failure is not metadata; nothing is claimed.
		byId.clear();
		return { readable: false, byId };
	} finally {
		try {
			db?.close();
		} catch {
			// closing a handle that failed to open is best-effort
		}
	}
}

/** The directory names directly under `path`; a missing or unreadable directory is empty. */
function subdirectories(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/** One record of a session's history, after the envelope around it is checked. */
interface MinimaxRecord {
	messageId: string;
	turnId: string;
	/** The pi message itself, as written. */
	message: Record<string, unknown>;
	/** The record carried a `turn_config` — the harness's own system prompt and model. */
	hasTurnConfig: boolean;
	/** The record carried a `history_artifact` marker. */
	hasArtifact: boolean;
}

/** A step that succeeded, or the reason it could not. */
type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The records a session's history yielded, plus the notes the reading earned. */
interface RecordsOutcome {
	records: MinimaxRecord[];
	notes: Array<[reason: string, count: number]>;
}

/**
 * Read one session end to end.
 *
 * Returns `{ error }` when the transcript cannot be read as a whole; the module
 * header says where that line is drawn and why.
 */
export function readMinimaxSession(session: MinimaxSessionFile): MinimaxRead | { error: string } {
	const counts = new Map<string, number>();
	const records = session.history === "canonical" ? readCanonical(session) : readLegacy(session);
	if (!records.ok) return { error: records.reason };
	const folded = foldRecords(records.value.records, counts);
	for (const [reason, count] of records.value.notes) bump(counts, reason, count);
	const repaired = repairToolPairing(folded.messages);
	bump(counts, "unpaired tool call or result", repaired.dropped);
	// The marker goes first because the validator has already established that the
	// boundary *is* the first record — the repair above can only remove messages
	// after it.
	const entries: MinimaxEntry[] = repaired.messages.map((message) => ({ kind: "message", message }));
	if (folded.compaction) entries.unshift(folded.compaction);
	return { entries, notes: toNotes(counts) };
}

// Long-form design notes: docs/dev/migration-sources.md
/** `messages.jsonl`, decoded and validated the way the tool decodes and validates it. */
function readCanonical(session: MinimaxSessionFile): Outcome<RecordsOutcome> {
	const text = readTextOrNull(session.path);
	if (text === null) return { ok: false, reason: "canonical history file could not be read" };
	const records: MinimaxRecord[] = [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (const [index, line] of lines.entries()) {
		if (line.trim().length === 0) {
			return { ok: false, reason: `canonical history is malformed at line ${index + 1}: blank line` };
		}
		const parsed = parseJsonText(line);
		if (parsed === null) {
			return { ok: false, reason: `canonical history is malformed at line ${index + 1}: invalid JSON` };
		}
		const decoded = decodeEnvelope(parsed);
		if (!decoded.ok) {
			return { ok: false, reason: `canonical history envelope is invalid at line ${index + 1}: ${decoded.reason}` };
		}
		records.push(decoded.value);
	}
	const failure = validateSequence(records);
	if (!failure.ok) return failure;
	const counts = new Map<string, number>();
	for (const record of records) {
		if (record.hasTurnConfig) bump(counts, "turn configuration (system prompt and model)");
		if (record.hasArtifact) bump(counts, "message whose earlier tool results the tool archived");
	}
	return { ok: true, value: { records, notes: [...counts] } };
}

/** The keys an envelope may carry — exactly these, the tool's own `ENVELOPE_KEYS`. */
const ENVELOPE_KEYS = new Set(["message_id", "turn_id", "message", "turn_config", "history_artifact"]);

/** The keys a turn configuration may carry — `TURN_CONFIG_KEYS`. */
const TURN_CONFIG_KEYS = new Set(["system_prompt", "model", "tools"]);

// Long-form design notes: docs/dev/migration-sources.md
/** One canonical envelope, or the reason it is not one. */
function decodeEnvelope(value: Record<string, unknown>): Outcome<MinimaxRecord> {
	for (const key of Object.keys(value)) {
		if (!ENVELOPE_KEYS.has(key)) return { ok: false, reason: `envelope contains unsupported key ${key}` };
	}
	const messageId = value.message_id;
	if (typeof messageId !== "string" || !/^(?:msg-.+|\d+)$/.test(messageId)) {
		return { ok: false, reason: "message_id must match msg-.+ or contain only digits" };
	}
	const turnId = value.turn_id;
	if (typeof turnId !== "string" || turnId.trim().length === 0) {
		return { ok: false, reason: "turn_id must be a non-empty string" };
	}
	const message = asRecord(value.message);
	if (message === null) return { ok: false, reason: "message must be a plain object" };
	const role = message.role;
	if (typeof role !== "string" || role.trim().length === 0) {
		return { ok: false, reason: "message.role must be a non-empty string" };
	}
	if (role === "compactionSummary") {
		const failure = checkCompactionSummary(message);
		if (failure !== null) return { ok: false, reason: failure };
	} else if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
		return { ok: false, reason: "message.timestamp must be finite" };
	}
	const hasTurnConfig = value.turn_config !== undefined;
	if (hasTurnConfig) {
		if (role !== "user") return { ok: false, reason: "turn_config is allowed only on user messages" };
		if (!isTurnConfig(value.turn_config)) return { ok: false, reason: "turn_config is malformed" };
	}
	const hasArtifact = value.history_artifact !== undefined;
	if (hasArtifact && !isHistoryArtifact(value.history_artifact)) {
		return { ok: false, reason: "history_artifact is malformed" };
	}
	return { ok: true, value: { messageId, turnId, message, hasTurnConfig, hasArtifact } };
}

/**
 * `decodeCompactionSummary`: a minimal `{role, summary}`, or the full form that
 * also states how large the context was (`{role, summary, tokensBefore, timestamp}`
 * — the two come together, and the minimal form may carry nothing else).
 */
function checkCompactionSummary(message: Record<string, unknown>): string | null {
	if (typeof message.summary !== "string") return "message.compactionSummary.summary must be a string";
	const hasTokens = Object.hasOwn(message, "tokensBefore");
	const hasTimestamp = Object.hasOwn(message, "timestamp");
	if (!hasTokens && !hasTimestamp) {
		for (const key of Object.keys(message)) {
			if (key !== "role" && key !== "summary") {
				return "minimal message.compactionSummary must contain only role and summary";
			}
		}
		return null;
	}
	if (
		hasTokens !== hasTimestamp ||
		typeof message.tokensBefore !== "number" ||
		!Number.isSafeInteger(message.tokensBefore) ||
		message.tokensBefore < 0
	) {
		return "message.compactionSummary.tokensBefore must be a non-negative safe integer";
	}
	return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
		? null
		: "message.compactionSummary.timestamp must be finite";
}

/** The `turn_config` shape `decodeTurnConfig` insists on: exact keys, a prompt and a model. */
function isTurnConfig(value: unknown): boolean {
	const config = asRecord(value);
	if (config === null) return false;
	for (const key of Object.keys(config)) {
		if (!TURN_CONFIG_KEYS.has(key)) return false;
	}
	if (typeof config.system_prompt !== "string" || asRecord(config.model) === null) return false;
	return config.tools === undefined || Array.isArray(config.tools);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The `history_artifact` shape `decodeCanonicalHistoryArtifact` insists on. */
function isHistoryArtifact(value: unknown): boolean {
	const artifact = asRecord(value);
	if (artifact === null || artifact.schemaVersion !== 1) return false;
	for (const key of Object.keys(artifact)) {
		if (key !== "schemaVersion" && key !== "generation" && key !== "producedBy" && key !== "parentSnapshot") {
			return false;
		}
	}
	const generation = safeInteger(artifact.generation, 1);
	const producedBy = artifact.producedBy;
	if (
		generation === undefined ||
		(producedBy !== "tool_archive" && producedBy !== "tool_trim" && producedBy !== "llm_checkpoint")
	) {
		return false;
	}
	const parent = asRecord(artifact.parentSnapshot);
	if (parent === null) return false;
	for (const key of Object.keys(parent)) {
		if (key !== "generation" && key !== "compactionId" && key !== "revision") return false;
	}
	const parentGeneration = safeInteger(parent.generation, 0);
	return (
		parentGeneration !== undefined &&
		parentGeneration + 1 === generation &&
		typeof parent.compactionId === "string" &&
		parent.compactionId.length > 0 &&
		typeof parent.revision === "string" &&
		/^sha256:[a-f0-9]{64}$/.test(parent.revision)
	);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The rules the tool keeps even while it is repairing (`assertRecoveryInvariants`). */
function validateSequence(records: readonly MinimaxRecord[]): Outcome<null> {
	const messageIds = new Set<string>();
	const toolCallIds = new Set<string>();
	const userTurnIds = new Set<string>();
	let boundarySeen = false;
	for (const [index, record] of records.entries()) {
		const at = index + 1;
		if (record.hasArtifact && index !== 0) {
			return sequenceError(at, "history artifact marker must be attached only to the first envelope");
		}
		if (messageIds.has(record.messageId)) {
			return sequenceError(at, `duplicate message identity ${record.messageId}`);
		}
		messageIds.add(record.messageId);
		if (record.message.role === "user") {
			if (record.hasTurnConfig && userTurnIds.has(record.turnId)) {
				return sequenceError(
					at,
					`turn_config must be attached only to the first user message of turn ${record.turnId}`,
				);
			}
			userTurnIds.add(record.turnId);
		}
		const boundary = compactionBoundary(record.message);
		if (!boundary.ok) return sequenceError(at, boundary.reason);
		if (boundary.value) {
			if (boundarySeen || index !== 0) return sequenceError(at, "compaction boundary must be the unique first message");
			boundarySeen = true;
		}
		if (record.message.role !== "assistant") continue;
		for (const id of assistantToolCallIds(record.message)) {
			if (toolCallIds.has(id)) return sequenceError(at, `duplicate tool call identity ${id}`);
			toolCallIds.add(id);
		}
	}
	return { ok: true, value: null };
}

function sequenceError(at: number, reason: string): Outcome<never> {
	return { ok: false, reason: `canonical history sequence is invalid at record ${at}: ${reason}` };
}

// Long-form design notes: docs/dev/migration-sources.md
/** Whether a record begins a new context, and whether its marker is well formed. */
function compactionBoundary(message: Record<string, unknown>): Outcome<boolean> {
	if (message.role === "compactionSummary") return { ok: true, value: true };
	if (!Object.hasOwn(message, "archonCompaction")) return { ok: true, value: false };
	const marker = asRecord(message.archonCompaction);
	if (message.role !== "user" || marker === null) {
		return { ok: false, reason: "Archon compaction boundary is malformed" };
	}
	if (marker.schemaVersion === 2) {
		const generation = safeInteger(marker.generation, 1);
		const parent = asRecord(marker.parentSnapshot);
		if (generation === undefined || parent === null || !isValidParentSnapshot(parent)) {
			return { ok: false, reason: "Archon compaction boundary is malformed" };
		}
		const parentGeneration = safeInteger(parent.generation, 0);
		if (parentGeneration === undefined || parentGeneration + 1 !== generation) {
			return { ok: false, reason: "Archon compaction generation chain is malformed" };
		}
		return { ok: true, value: true };
	}
	if (!isArchonCompactionMarker(marker)) return { ok: false, reason: "Archon compaction boundary is malformed" };
	return { ok: true, value: true };
}

/** The parent snapshot a generation marker points at. */
function isValidParentSnapshot(parent: Record<string, unknown>): boolean {
	return (
		safeInteger(parent.generation, 0) !== undefined &&
		typeof parent.compactionId === "string" &&
		parent.compactionId.length > 0 &&
		typeof parent.revision === "string" &&
		/^sha256:[a-f0-9]{64}$/.test(parent.revision)
	);
}

/** `isArchonCompactionMarker`: a summary, and the recap structure when it claims a version. */
function isArchonCompactionMarker(marker: Record<string, unknown>): boolean {
	if (typeof marker.summary !== "string") return false;
	if (marker.schemaVersion === 1) return true;
	if (marker.version !== 2 || !Array.isArray(marker.recentUserQueries)) return false;
	const queriesValid = marker.recentUserQueries.every((query) => {
		const record = asRecord(query);
		return (
			record !== null &&
			typeof record.text === "string" &&
			record.text.trim().length > 0 &&
			(record.timestampMs === undefined || asNumber(record.timestampMs) !== undefined)
		);
	});
	if (!queriesValid || marker.todoState === undefined) return queriesValid;
	if (!Array.isArray(marker.todoState)) return false;
	return marker.todoState.every((item) => {
		const record = asRecord(item);
		return (
			record !== null &&
			typeof record.content === "string" &&
			record.content.trim().length > 0 &&
			typeof record.status === "string" &&
			record.status.trim().length > 0 &&
			typeof record.priority === "string" &&
			record.priority.trim().length > 0
		);
	});
}

/**
 * The identities of an assistant message's tool calls, as
 * `assertUniqueToolCallIdentities` reads them: a block without an identity is
 * skipped, because that is a repair (`invalid-assistant-tool-call`) and not an
 * ambiguity.
 */
function assistantToolCallIds(message: Record<string, unknown>): string[] {
	const content = message.content;
	if (!Array.isArray(content)) return [];
	const ids: string[] = [];
	for (const block of content) {
		const record = asRecord(block);
		if (record === null || record.type !== "toolCall") continue;
		const id = asText(record.id);
		if (id) ids.push(id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// The released (snapshot + ledger) history
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The pre-`v2` pair, replayed the way the tool replays it (`released-session-history-reader.ts:68-119`). */
function readLegacy(session: MinimaxSessionFile): Outcome<RecordsOutcome> {
	const snapshot = readLegacySnapshot(join(session.dir, "snapshot.json"), session.sessionId);
	const ledger = readBytesOrNull(join(session.dir, "ledger.jsonl"));
	if (!snapshot.ok) return recoverFromCompleteLedger(ledger, session, snapshot.reason);
	const events = readLedger(ledger, session.sessionId, snapshot.value);
	if (!events.ok) return recoverFromCompleteLedger(ledger, session, events.reason);
	if (!isAuthoritative(snapshot.value, events.value)) {
		return { ok: true, value: { records: [], notes: [["legacy history with no conversation record", 1]] } };
	}
	return replayLegacy(session, snapshot.value, events.value);
}

/**
 * The whole ledger as the record, ignoring the snapshot (`recoverFromCompleteLedger`).
 *
 * The sequence must start at 1 and be unbroken and the ledger must hold at least
 * one conversation record, or there is nothing here to recover.
 */
function recoverFromCompleteLedger(
	ledger: Buffer | null,
	session: MinimaxSessionFile,
	cause: string,
): Outcome<RecordsOutcome> {
	if (ledger === null) return { ok: false, reason: recoveryFailure(cause, "the complete ledger is absent") };
	const events = readLedger(ledger, session.sessionId, null);
	if (!events.ok) return { ok: false, reason: recoveryFailure(cause, events.reason) };
	if (!events.value.some((event) => PI_HISTORY_FACTS.has(event.kind))) {
		return { ok: false, reason: recoveryFailure(cause, "the complete ledger contains no conversation record") };
	}
	return replayLegacy(session, null, events.value);
}

function recoveryFailure(cause: string, recovery: string): string {
	return `legacy history could not be read (${cause}) and could not be recovered from its ledger (${recovery})`;
}

/** A legacy snapshot as far as a reader cares: its messages and its watermark. */
interface LegacySnapshot {
	messages: unknown[];
	createdAtMs: number;
	lastSeq: number;
	byteOffset: number;
	piHistoryFacts: boolean;
	deleted: boolean;
}

/** One legacy ledger event, as far as a reader cares. */
interface LegacyEvent {
	seq: number;
	eventId: string;
	kind: string;
	createdAtMs: number | undefined;
	turnId: string | undefined;
	messages: unknown[] | undefined;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `snapshot.json`, or null when there is none. */
function readLegacySnapshot(path: string, sessionId: string): Outcome<LegacySnapshot | null> {
	const text = readTextOrNull(path);
	if (text === null) return { ok: true, value: null };
	const value = parseJsonText(text);
	if (value === null) return { ok: false, reason: "the snapshot is not readable JSON" };
	const watermark = asRecord(value.watermark);
	const messages = value.piHistory;
	const byteOffset = watermark?.byteOffset;
	if (
		value.schemaVersion !== 1 ||
		value.sessionId !== sessionId ||
		typeof value.snapshotId !== "string" ||
		value.snapshotId.trim().length === 0 ||
		asNumber(value.createdAtMs) === undefined ||
		watermark === null ||
		watermark.sessionId !== sessionId ||
		!isNonNegativeInteger(watermark.lastSeq) ||
		typeof watermark.lastEventId !== "string" ||
		asNumber(watermark.updatedAtMs) === undefined ||
		(byteOffset !== undefined && !isNonNegativeInteger(byteOffset)) ||
		!Array.isArray(value.displayMessages) ||
		!Array.isArray(messages) ||
		typeof value.piHistoryFacts !== "boolean" ||
		typeof value.deleted !== "boolean" ||
		(value.deleted === true && messages.length > 0)
	) {
		return { ok: false, reason: "the snapshot is corrupt" };
	}
	return {
		ok: true,
		value: {
			messages,
			createdAtMs: value.createdAtMs as number,
			lastSeq: watermark.lastSeq as number,
			byteOffset: byteOffset === undefined ? 0 : byteOffset,
			piHistoryFacts: value.piHistoryFacts,
			deleted: value.deleted,
		},
	};
}

// Long-form design notes: docs/dev/migration-sources.md
/** `ledger.jsonl` read from the top, deduplicated, and cut at the snapshot's watermark. */
function readLedger(ledger: Buffer | null, sessionId: string, snapshot: LegacySnapshot | null): Outcome<LegacyEvent[]> {
	if (ledger === null) return { ok: true, value: [] };
	if (snapshot !== null && snapshot.byteOffset > ledger.length) {
		return { ok: false, reason: "the snapshot watermark exceeds the ledger" };
	}
	const events: LegacyEvent[] = [];
	const lines = committedLedgerText(ledger).split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		const value = parseJsonText(line);
		if (
			value === null ||
			value.sessionId !== sessionId ||
			!isNonNegativeInteger(value.seq) ||
			typeof value.eventId !== "string" ||
			value.eventId.length === 0 ||
			typeof value.kind !== "string" ||
			value.kind.length === 0
		) {
			return { ok: false, reason: `the ledger event at line ${index + 1} is corrupt` };
		}
		events.push({
			seq: value.seq as number,
			eventId: value.eventId,
			kind: value.kind,
			createdAtMs: asNumber(value.createdAtMs),
			turnId: nonEmpty(value.turnId),
			messages: Array.isArray(value.messages) ? value.messages : undefined,
		});
	}
	events.sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId));
	const unique: LegacyEvent[] = [];
	const bySeq = new Map<number, LegacyEvent>();
	const byId = new Map<string, LegacyEvent>();
	for (const event of events) {
		const previous = bySeq.get(event.seq) ?? byId.get(event.eventId);
		if (previous) {
			if (stableJson(previous) === stableJson(event)) continue;
			return { ok: false, reason: `the ledger has a conflicting duplicate at sequence ${event.seq}` };
		}
		bySeq.set(event.seq, event);
		byId.set(event.eventId, event);
		unique.push(event);
	}
	const base = snapshot === null ? 0 : snapshot.lastSeq;
	const tail = unique.filter((event) => event.seq > base);
	for (const [index, event] of tail.entries()) {
		if (event.seq !== base + index + 1) {
			return { ok: false, reason: `the ledger is incomplete at sequence ${base + index + 1}` };
		}
	}
	return { ok: true, value: tail };
}

/** The ledger's committed text: a half-written last line is not part of the ledger. */
function committedLedgerText(bytes: Buffer): string {
	const contents = bytes.toString("utf8");
	if (!contents || contents.endsWith("\n")) return contents;
	const lastBoundary = contents.lastIndexOf("\n");
	return lastBoundary < 0 ? "" : contents.slice(0, lastBoundary + 1);
}

/** The ledger kinds that decide whether a session had a conversation at all. */
const PI_HISTORY_FACTS = new Set([
	"message.pi_history_appended",
	"message.pi_history_replaced",
	"message.turn_retracted",
	"message.state_deleted",
	"session.deleted",
]);

/** `isAuthoritative`: a session is one only when something in it says so. */
function isAuthoritative(snapshot: LegacySnapshot | null, events: readonly LegacyEvent[]): boolean {
	return Boolean(
		snapshot?.piHistoryFacts ||
			snapshot?.deleted ||
			(snapshot?.messages.length ?? 0) > 0 ||
			events.some((event) => PI_HISTORY_FACTS.has(event.kind)),
	);
}

/** Replay the snapshot and its tail into records. */
function replayLegacy(
	session: MinimaxSessionFile,
	snapshot: LegacySnapshot | null,
	events: readonly LegacyEvent[],
): Outcome<RecordsOutcome> {
	const records: MinimaxRecord[] = [];
	const snapshotRecords = legacyRecords(
		session.sessionId,
		snapshot?.messages ?? [],
		`snapshot:${session.sessionId}`,
		snapshot?.createdAtMs,
		undefined,
	);
	if (!snapshotRecords.ok) return snapshotRecords;
	records.push(...snapshotRecords.value);
	for (const event of events) {
		if (event.kind === "message.pi_history_appended") {
			const appended = eventRecords(session.sessionId, event);
			if (!appended.ok) return appended;
			records.push(...appended.value);
			continue;
		}
		if (event.kind === "message.pi_history_replaced" || event.kind === "message.turn_retracted") {
			const replacement = eventRecords(session.sessionId, event);
			if (!replacement.ok) return replacement;
			records.length = 0;
			records.push(...replacement.value);
			continue;
		}
		if (event.kind === "message.state_deleted" || event.kind === "session.deleted") records.length = 0;
	}
	const failure = validateSequence(records);
	if (!failure.ok) return failure;
	return { ok: true, value: { records, notes: [] } };
}

/**
 * The turn a legacy event's messages belong to: its own `turnId` when it has one
 * and the sequence otherwise, so a message with no turn still gets an identity
 * that is stable across runs and obviously derived.
 */
function eventRecords(sessionId: string, event: LegacyEvent): Outcome<MinimaxRecord[]> {
	if (event.messages === undefined) {
		// Only the three message kinds get here, and each is *about* a list of
		// messages; one without a list is a ledger the tool refuses too.
		return { ok: false, reason: `the ledger event ${event.eventId} has no messages` };
	}
	return legacyRecords(
		sessionId,
		event.messages,
		`event:${event.eventId}`,
		event.createdAtMs,
		event.turnId ?? `legacy-event-${event.seq}`,
	);
}

// Long-form design notes: docs/dev/migration-sources.md
/** Legacy entries as canonical records. */
function legacyRecords(
	sessionId: string,
	messages: readonly unknown[],
	seedPrefix: string,
	fallbackMs: number | undefined,
	turnId: string | undefined,
): Outcome<MinimaxRecord[]> {
	const records: MinimaxRecord[] = [];
	let turn = 0;
	for (const [index, entry] of messages.entries()) {
		const container = asRecord(entry);
		if (container === null) return legacyNotAMessage();
		const envelope = isCanonicalEnvelopeShape(container) ? container : null;
		const raw = envelope === null ? container : asRecord(envelope.message);
		if (raw === null) return legacyNotAMessage();
		const role = asText(raw.role);
		if (turnId === undefined && (role === "user" || turn === 0)) turn += 1;
		const turnOfRecord = turnId ?? `legacy:${sessionId}:${turn}`;
		const value = asRecord(normalizeLegacyEntry(entry, fallbackMs));
		if (value === null) return legacyNotAMessage();
		if (isCanonicalEnvelopeShape(value)) {
			const decoded = decodeEnvelope(value);
			if (decoded.ok) {
				records.push(decoded.value);
				continue;
			}
			return { ok: false, reason: `a legacy history envelope is invalid (${decoded.reason})` };
		}
		const seed = `${seedPrefix}:${index}`;
		const messageId =
			legacyMessageId(value) ??
			`msg-legacy-${createHash("sha256")
				.update(`${seed}\u0000${JSON.stringify(value)}`)
				.digest("base64url")}`;
		const decoded = decodeEnvelope({ message_id: messageId, turn_id: turnOfRecord, message: value });
		if (!decoded.ok) return { ok: false, reason: `a legacy history message is invalid (${decoded.reason})` };
		records.push(decoded.value);
	}
	return { ok: true, value: records };
}

// Long-form design notes: docs/dev/migration-sources.md
/** The decoder's refusal for an entry that is not a message at all, reused verbatim. */
function legacyNotAMessage(): Outcome<never> {
	return { ok: false, reason: "a legacy history message is invalid (message must be a plain object)" };
}

// Long-form design notes: docs/dev/migration-sources.md
/** `normalizeLegacyHistoryTimestamp`: a legacy stamp made into the finite number the canonical shape requires. */
function normalizeLegacyEntry(entry: unknown, fallbackMs: number | undefined): unknown {
	const container = asRecord(entry);
	if (container === null) return entry;
	const envelope = isCanonicalEnvelopeShape(container) ? container : null;
	const message = asRecord(envelope === null ? container : envelope.message);
	if (message === null) return entry;
	const stamp = timestampMs(message.timestamp) ?? timestampMs(fallbackMs);
	if (stamp === undefined || message.timestamp === stamp) return entry;
	const normalized = { ...message, timestamp: stamp };
	return envelope === null ? normalized : { ...envelope, message: normalized };
}

/** `isCanonicalEnvelopeShape`: the three keys that make a legacy entry an envelope. */
function isCanonicalEnvelopeShape(value: Record<string, unknown>): boolean {
	return Object.hasOwn(value, "message_id") && Object.hasOwn(value, "turn_id") && asRecord(value.message) !== null;
}

/** A legacy message's own id, when it has one in a spelling a canonical id may take. */
function legacyMessageId(message: Record<string, unknown>): string | null {
	const candidate = message.msg_id ?? message.id ?? message.messageId;
	return typeof candidate === "string" && /^(?:msg-.+|\d+)$/.test(candidate) ? candidate : null;
}

/** Epoch ms from a stamp written either way, `undefined` when it is not a time. */
function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string") return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Records to messages
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The records as the target's own messages. */
function foldRecords(
	records: readonly MinimaxRecord[],
	counts: Map<string, number>,
): { messages: AgentMessage[]; compaction: MinimaxEntry | null } {
	const messages: AgentMessage[] = [];
	let compaction: MinimaxEntry | null = null;
	for (const record of records) {
		// The validator has already established that a boundary is the first record
		// and that there is at most one, and a compaction *replaces* the context, so
		// the marker stands where the conversation now begins.
		const boundary = compactionBoundary(record.message);
		if (boundary.ok && boundary.value) {
			compaction = {
				kind: "compaction",
				summary: compactionSummary(record.message),
				preTokens: compactionTokens(record.message),
			};
			continue;
		}
		const message = toMessage(record.message, counts);
		if (message !== null) messages.push(message);
	}
	return { messages, compaction };
}

/** The summary of a boundary record, in whichever of its spellings it was written. */
function compactionSummary(message: Record<string, unknown>): string {
	if (typeof message.summary === "string") return message.summary;
	const marker = asRecord(message.archonCompaction);
	if (marker !== null && typeof marker.summary === "string") return marker.summary;
	// A generation marker need not carry a summary; the user message it is attached
	// to does, and that text is what the context was rebuilt around.
	return textOf(message.content);
}

/** How large the context was before it was compacted, 0 when the source did not say. */
function compactionTokens(message: Record<string, unknown>): number {
	const tokens = message.tokensBefore;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0;
}

/** One pi message as a target message, or null when this build does not carry it. */
function toMessage(message: Record<string, unknown>, counts: Map<string, number>): AgentMessage | null {
	const timestamp = timestampMs(message.timestamp) ?? 0;
	const role = asText(message.role);
	if (role === "user") return userMessage(userContent(message.content, counts), timestamp);
	if (role === "assistant") return assistantRecord(message, timestamp, counts);
	if (role === "toolResult") return toolResultRecord(message, timestamp, counts);
	bump(counts, `message of a role this build does not carry (${role || "unknown"})`);
	return null;
}

/** A user message's content: the string it may be, or the blocks it may carry. */
function userContent(content: unknown, counts: Map<string, number>): UserContent[] {
	if (typeof content === "string") return content ? [textContent(content)] : [];
	return blocks(content, counts);
}

/** An assistant message: its blocks, its four usage buckets, and how it ended. */
function assistantRecord(
	message: Record<string, unknown>,
	timestamp: number,
	counts: Map<string, number>,
): AgentMessage {
	const content: AssistantContent[] = [];
	for (const block of rawBlocks(message.content)) {
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) content.push(textContent(text));
			continue;
		}
		if (block.type === "thinking") {
			const thinking = thinkingContent(block, counts);
			if (thinking !== null) content.push(thinking);
			continue;
		}
		if (block.type === "toolCall") {
			const call = toolCall(block, counts);
			if (call !== null) content.push(call);
			continue;
		}
		// An image or video the assistant produced is content the target cannot
		// re-request, and a URL is not an image until it is fetched. Counted, not
		// fetched, and never carried as a placeholder the model would read as fact.
		bump(counts, `assistant content this build does not carry (${asText(block.type) || "unknown"})`);
	}
	const errorMessage = asText(message.errorMessage);
	return assistantMessage({
		content,
		provider: asText(message.provider),
		model: asText(message.model),
		usage: usageOf(message.usage),
		stopReason: stopReasonOf(message.stopReason, content, counts),
		...(errorMessage ? { errorMessage } : {}),
		timestamp,
	});
}

// Long-form design notes: docs/dev/migration-sources.md
/** A thinking block, or null when there is nothing to carry. */
function thinkingContent(block: Record<string, unknown>, counts: Map<string, number>): AssistantContent | null {
	const thinking = asText(block.thinking);
	if (block.redacted === true || !thinking) {
		if (block.redacted === true || asText(block.thinkingSignature)) {
			bump(counts, "reasoning block that carried no text");
		}
		return null;
	}
	return { type: "thinking", thinking };
}

// Long-form design notes: docs/dev/migration-sources.md
/** A tool call, with its arguments as the raw JSON text the target expects. */
function toolCall(block: Record<string, unknown>, counts: Map<string, number>): ToolCall | null {
	const id = asText(block.id);
	if (!id) {
		bump(counts, "tool call with no identity");
		return null;
	}
	const args = block.arguments;
	return {
		type: "toolCall",
		id,
		name: asText(block.name) || UNKNOWN_TOOL_NAME,
		arguments: typeof args === "string" ? args || "{}" : args === undefined ? "{}" : safeJson(args),
	};
}

/** A tool result's content: text and images, with a placeholder when there is none. */
function toolResultRecord(
	message: Record<string, unknown>,
	timestamp: number,
	counts: Map<string, number>,
): AgentMessage | null {
	const toolCallId = asText(message.toolCallId);
	if (!toolCallId) {
		// The tool's `invalid-tool-result` repair: a result that names no call can
		// never be paired with one, and the target refuses a transcript that holds it.
		bump(counts, "tool result with no call identity");
		return null;
	}
	const content: ToolResultContent[] = blocks(message.content, counts);
	return toolResultMessage(
		toolCallId,
		asText(message.toolName) || UNKNOWN_TOOL_NAME,
		content.length > 0 ? content : [textContent("(no output recorded)")],
		message.isError === true,
		timestamp,
	);
}

/** The blocks of a content field, as the two kinds this build carries. */
function blocks(content: unknown, counts: Map<string, number>): Array<TextContent | ImageContent> {
	const out: Array<TextContent | ImageContent> = [];
	const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
	for (const block of rawBlocks(parts)) {
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) out.push(textContent(text));
			continue;
		}
		const image = imageContent(block, counts);
		if (image !== null) out.push(image);
	}
	return out;
}

/** The plain-object blocks of a content array. */
function rawBlocks(content: unknown): Record<string, unknown>[] {
	if (!Array.isArray(content)) return [];
	const out: Record<string, unknown>[] = [];
	for (const part of content) {
		const block = asRecord(part);
		if (block !== null) out.push(block);
	}
	return out;
}

/** An image block, when it carries its bytes rather than a place to fetch them. */
function imageContent(block: Record<string, unknown>, counts: Map<string, number>): ImageContent | null {
	if (block.type !== "image") {
		if (block.type !== undefined) bump(counts, `message part this build does not carry (${asText(block.type)})`);
		return null;
	}
	const data = asText(block.data);
	const mimeType = asText(block.mimeType);
	// pi stores the base64 payload inline; anything else — a URL, a file path —
	// would have to be fetched, and a transcript is not the place to start doing
	// network I/O on the user's behalf.
	if (!data || !mimeType) {
		bump(counts, "image with no inline data");
		return null;
	}
	return { type: "image", mimeType, data };
}

// Long-form design notes: docs/dev/migration-sources.md
/** How a turn ended, in the target's vocabulary. */
function stopReasonOf(reason: unknown, content: readonly AssistantContent[], counts: Map<string, number>): StopReason {
	switch (reason) {
		case "stop":
		case "length":
		case "toolUse":
		case "error":
		case "aborted":
		case "pending":
		case "refusal":
			return reason;
		default:
			break;
	}
	const text = asText(reason);
	if (text) bump(counts, `unknown stop reason (${text})`);
	return content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
}

/** The four token buckets the two builds share; `cost` and `totalTokens` are derived. */
function usageOf(value: unknown): Usage {
	const usage = asRecord(value);
	return {
		input: asNumber(usage?.input) ?? 0,
		output: asNumber(usage?.output) ?? 0,
		cacheRead: asNumber(usage?.cacheRead) ?? 0,
		cacheWrite: asNumber(usage?.cacheWrite) ?? 0,
	};
}

/** The text of a message's content, however it was written. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return rawBlocks(content)
		.filter((block) => block.type === "text")
		.map((block) => asText(block.text))
		.filter(Boolean)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Stand-in for a tool name the source did not record. */
const UNKNOWN_TOOL_NAME = "unknown";

/** JSON text for a value whose exact spelling the target will parse again. */
function safeJson(value: unknown): string {
	try {
		const encoded = JSON.stringify(value);
		return typeof encoded === "string" ? encoded : "{}";
	} catch {
		return "{}";
	}
}

/** Key-order-stable JSON, so two spellings of one event can be compared. */
function stableJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	const record = asRecord(value);
	if (record === null) return value;
	return Object.fromEntries(
		Object.keys(record)
			.sort()
			.map((key) => [key, sortJson(record[key])]),
	);
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function readBytesOrNull(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}

/** Parse a line or a whole file into a record, or null. */
function parseJsonText(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	const trimmed = text.trim();
	if (!trimmed) return null;
	try {
		return asRecord(JSON.parse(trimmed));
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

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeInteger(value: unknown, minimum: number): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

/** A string that says something, trimmed; `undefined` when it does not. */
function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Count one reason; the notes come out in first-seen order. */
function bump(counts: Map<string, number>, reason: string, by = 1): void {
	if (by <= 0) return;
	counts.set(reason, (counts.get(reason) ?? 0) + by);
}

function toNotes(counts: Map<string, number>): Array<{ reason: string; count: number }> {
	return [...counts].map(([reason, count]) => ({ reason, count }));
}
