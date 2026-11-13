// Cindy's conversations, out of `<userData>/cindy-<ownerId>.db`: the session
// listing, the message conversion, and the rows this build cannot carry.
// Long-form design notes: docs/dev/migration-sources.md

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
	type AgentMessage,
	type AssistantContent,
	assistantMessage,
	repairToolPairing,
	textContent,
	toolResultMessage,
	userMessage,
} from "@labunbun/ai";
import { type CindyEnv, cindyOwnerDatabases } from "./cindy-home.ts";
import { isRecord } from "./migrate-core.ts";
import type { HistoryCandidate, HistoryEntry, HistoryListing, HistoryNote } from "./migrate-history.ts";

/** One session row, as the listing phase sees it. */
export interface CindySessionRow {
	id: string;
	title: string;
	/** `null` when the task records no directory, or one on another machine. */
	cwd: string | null;
	/** `created_at` in epoch ms. */
	startedAt: number;
	/** `status = 'archived'`. */
	archived: boolean;
}

/** One message row, narrowed to the fields a transcript needs. */
export interface CindyMessageRow {
	id: string;
	role: string;
	/** The JSON string the column stores, or the raw text when it is not JSON. */
	content: string;
	toolUseId: string | null;
	/** `created_at` in epoch ms. */
	at: number;
}

/** What one chosen session converts to, before `migrate-history.ts` wraps it. */
export interface CindyConversation {
	messages: AgentMessage[];
	notes: HistoryNote[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Stand-in for a tool name the source did not record; pairing repair replaces it when a call names it. */
const UNKNOWN_TOOL_NAME = "unknown";

/** The placeholder a result without text imports as, matching every other reader here. */
const NO_OUTPUT = "(no output recorded)";

/** Why a database that exists was not opened, in the words the report prints. */
export const CINDY_DB_UNREADABLE =
	"Cindy's database could not be opened read-only — it may be locked by a running Cindy, or its schema may predate this importer. Close Cindy and run the migration again";

/** Why a database was not found at all. */
export const CINDY_DB_ABSENT =
	"no owner database (`<userData>/cindy-<ownerId>.db`) — Cindy creates it when an account first signs in, so an installation that was never used has no conversations to bring";

/** Why a remote task's directory is not imported as its own path. */
export const CINDY_REMOTE_CWD =
	"task whose working directory is on another machine (`remote_host_id` or `agent_device_id` is set) — the recorded path does not exist on this computer, so the session was filed under Cindy's own configuration root instead";

/** `void` on any failure: a database the app holds locked is a database to skip. */
function withDatabase<T>(dbPath: string, work: (db: Database) => T): T | null {
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		return work(db);
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			// best-effort; the caller already has its answer
		}
	}
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function rowText(row: Record<string, unknown>, key: string): string {
	return text(row[key]);
}

/** Sessions this importer can list, plus the counts the listing has to explain. */
interface CindySessionListing {
	sessions: CindySessionRow[];
	deleted: number;
	hidden: number;
	workers: number;
	remote: number;
	withoutCwd: number;
}

/** Read `sessions`, degrading to the columns a pre-upgrade database has. */
function readCindySessionListing(dbPath: string): CindySessionListing | null {
	return withDatabase(dbPath, (db) => {
		let rows: unknown[];
		let narrowed = true;
		try {
			rows = db
				.query(
					`SELECT id, title, working_dir, status, created_at, hidden_at, orca_role, remote_host_id, agent_device_id
					 FROM sessions ORDER BY created_at ASC, id ASC`,
				)
				.all();
		} catch {
			narrowed = false;
			rows = db
				.query("SELECT id, title, working_dir, status, created_at FROM sessions ORDER BY created_at ASC, id ASC")
				.all();
		}
		const listing: CindySessionListing = {
			sessions: [],
			deleted: 0,
			hidden: 0,
			workers: 0,
			remote: 0,
			withoutCwd: 0,
		};
		for (const value of rows) {
			if (!isRecord(value)) continue;
			const status = rowText(value, "status");
			if (status === "deleted") {
				listing.deleted += 1;
				continue;
			}
			if (narrowed) {
				if (value.hidden_at !== null && value.hidden_at !== undefined) {
					listing.hidden += 1;
					continue;
				}
				if (value.orca_role === "worker") {
					listing.workers += 1;
					continue;
				}
			}
			const id = rowText(value, "id");
			if (id === "") continue;
			const recordedCwd = rowText(value, "working_dir").trim();
			const remote =
				narrowed && (rowText(value, "remote_host_id").trim() !== "" || rowText(value, "agent_device_id").trim() !== "");
			if (remote) listing.remote += 1;
			else if (recordedCwd === "") listing.withoutCwd += 1;
			const created = value.created_at;
			listing.sessions.push({
				id,
				title: rowText(value, "title"),
				cwd: remote || recordedCwd === "" ? null : recordedCwd,
				startedAt: typeof created === "number" && Number.isFinite(created) ? created : 0,
				archived: status === "archived",
			});
		}
		return listing;
	});
}

// Long-form design notes: docs/dev/migration-sources.md
/** List Cindy's tasks. Deleted, hidden background and Orca worker sessions are counted and left out. */
export function listCindyHistory(home: string, env: CindyEnv = process.env): HistoryListing {
	const candidates: HistoryCandidate[] = [];
	const notes: HistoryNote[] = [];
	const dbPath = cindyOwnerDatabases(home, env)[0]?.path ?? null;
	if (dbPath === null) {
		notes.push({ reason: CINDY_DB_ABSENT, count: 1 });
		return { candidates, notes };
	}
	if (!existsSync(dbPath)) {
		notes.push({ reason: CINDY_DB_UNREADABLE, count: 1 });
		return { candidates, notes };
	}
	const listing = readCindySessionListing(dbPath);
	if (listing === null) {
		notes.push({ reason: CINDY_DB_UNREADABLE, count: 1 });
		return { candidates, notes };
	}
	// A session that records no directory, or one on another machine, is filed
	// under the userData directory holding this database: it exists by
	// construction (the database was found in it), so `narrowCandidates` keeps the
	// candidate instead of reporting a directory that never existed. `~/.cindy` is
	// not that directory — it is optional, and on a fresh Windows install absent.
	const substitute = dirname(dbPath);
	for (const session of listing.sessions) {
		candidates.push({
			source: "cindy",
			sourceId: session.id,
			cwd: session.cwd ?? substitute,
			...(session.cwd === null ? { cwdSubstitute: substitute } : {}),
			title: session.title,
			startedAt: session.startedAt,
			path: dbPath,
			...(session.archived ? { archived: true } : {}),
		});
	}
	if (listing.deleted > 0) {
		notes.push({
			reason:
				"deleted session — Cindy keeps the row only so an undelete is possible, and a deleted task is not one to import",
			count: listing.deleted,
		});
	}
	if (listing.hidden > 0) {
		notes.push({
			reason:
				"hidden background task — a plugin-created task kept out of Cindy's task list, so it was kept out of this listing too",
			count: listing.hidden,
		});
	}
	if (listing.workers > 0) {
		notes.push({
			reason:
				"Orca worker session — the worker half of a Lead task, already represented by that task's own transcript, so importing it would duplicate the work",
			count: listing.workers,
		});
	}
	if (listing.remote > 0) notes.push({ reason: CINDY_REMOTE_CWD, count: listing.remote });
	if (listing.withoutCwd > 0) {
		notes.push({
			reason:
				"task whose working directory was never set — listed under Cindy's own configuration root so it is reachable, and filed there on import",
			count: listing.withoutCwd,
		});
	}
	return { candidates, notes };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Why a column that should hold JSON did not. */
export const CINDY_CONTENT_UNPARSABLE =
	"message row whose `content` column is not JSON this importer could read — Cindy stores every message as a JSON string, and a hand-edited or half-written one is reported rather than dropped in silence";

/** Why a row was bookkeeping rather than conversation. */
export const CINDY_BOOKKEEPING_ROW =
	"message row that records bookkeeping rather than conversation — an agent switch, a context rebuild or a deletion tombstone; none has a turn this build could carry";

/** Read one session's message rows, oldest first, with rewound rows excluded. */
function readCindyMessages(
	dbPath: string,
	sessionId: string,
): { rows: CindyMessageRow[]; rewound: number; noRewind: boolean } | null {
	return withDatabase(dbPath, (db) => {
		let rows: unknown[];
		let hasRewind = true;
		try {
			rows = db
				.query(
					`SELECT id, role, content, tool_use_id, created_at FROM messages
					 WHERE session_id = ? AND rewind_at IS NULL ORDER BY created_at ASC, id ASC`,
				)
				.all(sessionId);
		} catch {
			hasRewind = false;
			rows = db
				.query(
					"SELECT id, role, content, tool_use_id, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
				)
				.all(sessionId);
		}
		let rewound = 0;
		if (hasRewind) {
			try {
				const counted = db
					.query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND rewind_at IS NOT NULL")
					.get(sessionId) as { n?: unknown } | null;
				rewound = typeof counted?.n === "number" ? counted.n : 0;
			} catch {
				rewound = 0;
			}
		}
		const messages: CindyMessageRow[] = [];
		for (const value of rows) {
			if (!isRecord(value)) continue;
			const created = value.created_at;
			messages.push({
				id: rowText(value, "id"),
				role: rowText(value, "role"),
				content: rowText(value, "content"),
				toolUseId: typeof value.tool_use_id === "string" && value.tool_use_id !== "" ? value.tool_use_id : null,
				at: typeof created === "number" && Number.isFinite(created) ? created : 0,
			});
		}
		return { rows: messages, rewound, noRewind: !hasRewind };
	});
}

/** A JSON value parsed from a content column, or the raw text when it is not JSON. */
function cindyContent(raw: string): { value: unknown; parsed: boolean } {
	try {
		return { value: JSON.parse(raw), parsed: true };
	} catch {
		return { value: raw, parsed: false };
	}
}

/** The text of a user turn, plus how many attachments it carried. */
function cindyUserText(value: unknown): { text: string; attachments: number } {
	if (typeof value === "string") return { text: value, attachments: 0 };
	if (!isRecord(value)) return { text: "", attachments: 0 };
	const images = Array.isArray(value.images) ? value.images.length : 0;
	const files = Array.isArray(value.files) ? value.files.length : 0;
	return { text: typeof value.text === "string" ? value.text : "", attachments: images + files };
}

/** The text blocks of an assistant row, whether it stored a string or an array of blocks. */
function cindyAssistantText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) {
		if (!Array.isArray(value)) return "";
		const parts: string[] = [];
		for (const block of value) {
			if (typeof block === "string") parts.push(block);
			else if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
		return parts.join("\n\n");
	}
	return typeof value.text === "string" ? value.text : "";
}

/** Tool input encoded as the JSON-object string the message type expects. */
function cindyToolArguments(value: unknown): string {
	if (isRecord(value)) return JSON.stringify(value);
	if (typeof value === "string" && value.trim() !== "") {
		try {
			const parsed = JSON.parse(value);
			return JSON.stringify(isRecord(parsed) ? parsed : { input: parsed });
		} catch {
			return JSON.stringify({ input: value });
		}
	}
	return "{}";
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Convert one task into transcript entries.
 *
 * The row model is flat: a turn is several rows, one per block, in write order.
 * Thinking rows are merged into one assistant message until the next non-thinking
 * row, tool calls become assistant messages with a `toolCall` block, and tool
 * results become `toolResult` messages paired by the row's `tool_use_id`.
 * `repairToolPairing` finishes what an interrupted turn left unpaired.
 */
export function readCindyConversation(dbPath: string, sessionId: string): CindyConversation | null {
	if (!existsSync(dbPath)) return null;
	const read = readCindyMessages(dbPath, sessionId);
	if (read === null) return null;
	const collected: AgentMessage[] = [];
	const pendingThinking: Array<{ text: string; at: number }> = [];
	const notes: HistoryNote[] = [];
	let unparsable = 0;
	let emptyThinking = 0;
	let attachments = 0;
	let interactive = 0;
	let errors = 0;
	let bookkeeping = 0;
	let dropped = 0;
	let unsupported = 0;

	const flushThinking = (): void => {
		if (pendingThinking.length === 0) return;
		const content: AssistantContent[] = pendingThinking.map((entry) => ({ type: "thinking", thinking: entry.text }));
		collected.push(
			assistantMessage({
				content,
				timestamp: pendingThinking[0].at || undefined,
				stopReason: "stop",
			}),
		);
		pendingThinking.length = 0;
	};

	for (const row of read.rows) {
		const at = row.at > 0 ? row.at : undefined;
		const { value, parsed } = cindyContent(row.content);
		if (
			!parsed &&
			row.content.trim() !== "" &&
			row.role !== "user" &&
			row.role !== "assistant" &&
			row.role !== "tool_result"
		) {
			unparsable += 1;
			continue;
		}
		if (row.role === "user") {
			flushThinking();
			const user = cindyUserText(value);
			attachments += user.attachments;
			if (user.text.trim() === "") {
				dropped += 1;
				continue;
			}
			collected.push(userMessage(user.text, at));
			continue;
		}
		if (row.role === "assistant") {
			flushThinking();
			const body = cindyAssistantText(value);
			if (body.trim() === "") {
				dropped += 1;
				continue;
			}
			collected.push(assistantMessage({ content: [textContent(body)], timestamp: at, stopReason: "stop" }));
			continue;
		}
		if (row.role === "thinking") {
			const record = isRecord(value) ? value : {};
			const body = typeof record.text === "string" ? record.text : "";
			if (record.isRedacted === true || body.trim() === "") {
				emptyThinking += 1;
				continue;
			}
			pendingThinking.push({ text: body, at: row.at });
			continue;
		}
		if (row.role === "tool_use") {
			flushThinking();
			const record = isRecord(value) ? value : {};
			const callId = text(record.toolUseId) || row.toolUseId || row.id;
			const name = text(record.toolName).trim() || UNKNOWN_TOOL_NAME;
			if (callId === "") {
				dropped += 1;
				continue;
			}
			collected.push(
				assistantMessage({
					content: [{ type: "toolCall", id: callId, name, arguments: cindyToolArguments(record.input) }],
					timestamp: at,
					stopReason: "toolUse",
				}),
			);
			continue;
		}
		if (row.role === "tool_result") {
			flushThinking();
			const record = isRecord(value) ? value : {};
			const callId = row.toolUseId ?? (text(record.toolUseId) || null);
			if (callId === null || callId === "") {
				dropped += 1;
				continue;
			}
			const result = typeof value === "string" ? value : text(record.text);
			collected.push(toolResultMessage(callId, UNKNOWN_TOOL_NAME, [textContent(result || NO_OUTPUT)], false, at));
			continue;
		}
		if (row.role === "ask_user" || row.role === "plan_review") {
			interactive += 1;
			continue;
		}
		if (row.role === "error") {
			errors += 1;
			continue;
		}
		if (row.role === "agent_switch" || row.role === "context_rebuild" || row.role === "message_tombstone") {
			bookkeeping += 1;
			continue;
		}
		unsupported += 1;
	}
	flushThinking();

	const repaired = repairToolPairing(collected);
	const unpaired = repaired.dropped + repaired.synthesized;
	if (read.noRewind) {
		notes.push({
			reason:
				"database has no `rewind_at` column, so rewound messages could not be filtered — this is an older Cindy schema, and it was read whole",
			count: 1,
		});
	} else if (read.rewound > 0) {
		notes.push({
			reason: "rewound message — Cindy keeps the row for audit and hides it in the app, so it was hidden here too",
			count: read.rewound,
		});
	}
	if (unparsable > 0) notes.push({ reason: CINDY_CONTENT_UNPARSABLE, count: unparsable });
	if (emptyThinking > 0) {
		notes.push({
			reason:
				"thinking row with no text — either redacted by the provider or recorded empty, so it has no block to carry",
			count: emptyThinking,
		});
	}
	if (attachments > 0) {
		notes.push({
			reason:
				"image or file attached to a user message — the turn's text was imported and the attachment was not; this build's transcript entries carry no attachment",
			count: attachments,
		});
	}
	if (interactive > 0) {
		notes.push({
			reason:
				"interactive card row (a question to the user or a plan review) — the card's state has no message type here, so the turn around it was imported and the card was not",
			count: interactive,
		});
	}
	if (errors > 0) {
		notes.push({
			reason: "turn-level error row — a persisted failure notice rather than a model reply, so it was not carried",
			count: errors,
		});
	}
	if (bookkeeping > 0) notes.push({ reason: CINDY_BOOKKEEPING_ROW, count: bookkeeping });
	if (dropped > 0) {
		notes.push({
			reason: "message row with no text — an empty user or assistant row, or a user turn that held only an attachment",
			count: dropped,
		});
	}
	if (unsupported > 0) {
		notes.push({
			reason: "message row whose role this importer does not recognise — carried by Cindy, with no counterpart here",
			count: unsupported,
		});
	}
	if (unpaired > 0) notes.push({ reason: "unpaired tool call or result", count: unpaired });
	return { messages: repaired.messages, notes };
}

/** One chosen task, as transcript entries. `candidate.path` is the database the listing read. */
export function readCindyHistory(candidate: HistoryCandidate): { entries: HistoryEntry[]; notes: HistoryNote[] } {
	const conversation = readCindyConversation(candidate.path, candidate.sourceId);
	if (conversation === null) {
		return {
			entries: [],
			notes: [
				{
					reason:
						"task that was offered and could not be read — the database moved, or Cindy was running and held it. Re-run with the app closed",
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
