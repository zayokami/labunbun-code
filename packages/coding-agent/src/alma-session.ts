// Alma's conversations, out of `chat_threads.db`: the queries, the
// no-workspace note, and the role filter.
// Long-form design notes: docs/dev/migration-sources.md

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AgentMessage, assistantMessage, textContent, userMessage } from "@labunbun/ai";
import { ALMA_USER_DATA_DIR, type AlmaEnv, almaAppData, almaDbPath, almaUserDataDir } from "./alma-home.ts";
import type { HistoryCandidate, HistoryListing, HistoryNote } from "./migrate-history.ts";

/** One thread, as far as this importer is concerned. */
export interface AlmaThread {
	id: string;
	title: string;
	/** `null` when the thread names no workspace, or one that has been deleted. */
	cwd: string | null;
	createdAt: number;
	updatedAt: number;
}

/** One message row's JSON blob, narrowed to the two fields a transcript needs. */
export interface AlmaMessage {
	role: string;
	/** Concatenated `text` parts, or `null` when the row carries none. */
	text: string | null;
	timestamp: number;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Where the database is, or `null` when there is no application-data path. No `home` argument: only `APPDATA` names the root. */
export function almaDbLocation(env: AlmaEnv = process.env): string | null {
	const userData = almaUserDataDir(almaAppData(env), ALMA_USER_DATA_DIR);
	return userData === null ? null : almaDbPath(userData);
}

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

function timestamp(value: unknown): number {
	if (typeof value !== "string") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Every thread, with its working directory where one is reachable. The `LEFT JOIN` keeps orphaned threads in the listing. */
export function readAlmaThreads(dbPath: string): AlmaThread[] {
	if (!existsSync(dbPath)) return [];
	const rows = withDatabase(dbPath, (db) =>
		db
			.query(
				`SELECT t.id AS id, t.title AS title, t.created_at AS created_at,
				        t.updated_at AS updated_at, w.path AS cwd
				 FROM chat_threads t
				 LEFT JOIN workspaces w ON w.id = t.workspace_id
				 ORDER BY t.created_at ASC, t.id ASC`,
			)
			.all(),
	);
	return (rows ?? []).map((row) => {
		const record = row as { id?: unknown; title?: unknown; created_at?: unknown; updated_at?: unknown; cwd?: unknown };
		const cwd = typeof record.cwd === "string" && record.cwd.trim() !== "" ? record.cwd : null;
		return {
			id: text(record.id),
			title: text(record.title),
			cwd,
			createdAt: timestamp(record.created_at),
			updatedAt: timestamp(record.updated_at),
		};
	});
}

// Long-form design notes: docs/dev/migration-sources.md
/** One thread's messages, oldest first. Rows whose blob will not parse are counted, not dropped in silence. */
export function readAlmaMessages(dbPath: string, threadId: string): { messages: AlmaMessage[]; unparsable: number } {
	const rows = withDatabase(dbPath, (db) =>
		db
			.query(
				`SELECT message, timestamp FROM chat_messages
				 WHERE thread_id = ? ORDER BY created_at ASC, depth ASC`,
			)
			.all(threadId),
	);
	if (rows === null) return { messages: [], unparsable: 0 };
	const messages: AlmaMessage[] = [];
	let unparsable = 0;
	for (const row of rows) {
		const record = row as { message?: unknown; timestamp?: unknown };
		const blob = typeof record.message === "string" ? record.message : "";
		let parsed: unknown;
		try {
			parsed = JSON.parse(blob);
		} catch {
			unparsable += 1;
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) {
			unparsable += 1;
			continue;
		}
		const message = parsed as { role?: unknown; parts?: unknown };
		const role = typeof message.role === "string" ? message.role : "";
		let text_ = "";
		if (Array.isArray(message.parts)) {
			for (const part of message.parts) {
				if (typeof part !== "object" || part === null) continue;
				const block = part as { type?: unknown; text?: unknown };
				if (block.type !== "text") continue;
				if (typeof block.text === "string" && block.text.trim() !== "") text_ += block.text;
			}
		}
		messages.push({ role, text: text_.trim() === "" ? null : text_, timestamp: timestamp(record.timestamp) });
	}
	return { messages, unparsable };
}

/**
 * The reason an Alma thread records no directory, in one sentence.
 *
 * Stated as a constant rather than built at the call site so a test can assert
 * the *text*: a note whose reason drifts is a note nobody can check.
 */
export const ALMA_NO_WORKSPACE =
	"thread whose workspace was never set, or was set to one that has since been deleted — Alma stores a thread's directory only as a `workspace_id` and the column is `ON DELETE SET NULL`, so there is no path left to read and none was guessed at. It was listed under Alma's own configuration root so it is reachable, and filed there on import";

/** What a listing found beyond the candidates themselves. */

// Long-form design notes: docs/dev/migration-sources.md
/** List Alma's threads. `cwdSubstitute` files each orphan under the configuration root and carries the flag to the report. */
export function listAlmaHistory(home: string, env: AlmaEnv = process.env): HistoryListing {
	const candidates: HistoryCandidate[] = [];
	const notes: HistoryNote[] = [];
	const dbPath = almaDbLocation(env);
	if (dbPath === null) {
		notes.push({
			reason:
				"this platform has no application-data directory this importer resolves, so Alma's userData root was not located and its database was not opened",
			count: 1,
		});
		return { candidates, notes };
	}
	if (!existsSync(dbPath)) {
		notes.push({
			reason:
				"no `chat_threads.db` at the userData path — Alma creates it on first launch, so an Alma that has never run has no conversations to bring",
			count: 1,
		});
		return { candidates, notes };
	}
	const substitute = join(home, ".config", "alma");
	let orphaned = 0;
	for (const thread of readAlmaThreads(dbPath)) {
		if (thread.id === "") continue;
		if (thread.cwd === null) orphaned += 1;
		candidates.push({
			source: "alma",
			sourceId: thread.id,
			cwd: thread.cwd ?? substitute,
			...(thread.cwd === null ? { cwdSubstitute: substitute } : {}),
			title: thread.title,
			startedAt: thread.createdAt,
			path: dbPath,
		});
	}
	if (orphaned > 0) notes.push({ reason: ALMA_NO_WORKSPACE, count: orphaned });
	return { candidates, notes };
}

/** One message row, as the conversion needs it. */
export interface AlmaRow {
	role: string;
	text: string | null;
	timestamp: number;
}

/** What one chosen thread converts to, before `migrate-history.ts` wraps it. */
export interface AlmaConversation {
	messages: AgentMessage[];
	title: string;
	startedAt: number;
	notes: HistoryNote[];
}

/** Why a row carried nothing a transcript can hold, in one sentence a report prints. */
export const ALMA_ROW_DROPPED =
	'message row with no `text` part — Alma stores a message as `{ role, parts: [{ type, … }] }` and only `type: "text"` parts become a turn here, so a row that was entirely a tool call or an image imports as nothing. That is the same filter Alma\'s own markdown archive uses, and it is why an archive of this conversation has no actions in it';

/** Why a message row's JSON blob could not be read at all. */
export const ALMA_ROW_UNPARSABLE =
	"message row whose `message` column is not a JSON object this importer could read — Alma writes one JSON blob per row and a hand-edited or half-written one is reported rather than skipped in silence";

// Long-form design notes: docs/dev/migration-sources.md
/** Read one thread's rows and convert them. Only `user` and `assistant` become turns, and no tool calls are rebuilt. */
export function readAlmaConversation(sourceId: string, env: AlmaEnv = process.env): AlmaConversation | null {
	const dbPath = almaDbLocation(env);
	if (dbPath === null) return null;
	const { messages, unparsable } = readAlmaMessages(dbPath, sourceId);
	const converted: AgentMessage[] = [];
	let dropped = 0;
	let otherRole = 0;
	for (const row of messages) {
		if (row.text === null) {
			dropped += 1;
			continue;
		}
		if (row.role === "user") {
			converted.push(userMessage(row.text, row.timestamp || undefined));
			continue;
		}
		if (row.role === "assistant") {
			converted.push(
				assistantMessage({
					content: [textContent(row.text)],
					timestamp: row.timestamp || undefined,
					stopReason: "stop",
				}),
			);
			continue;
		}
		otherRole += 1;
	}
	const notes: HistoryNote[] = [];
	if (dropped > 0) notes.push({ reason: ALMA_ROW_DROPPED, count: dropped });
	if (otherRole > 0) {
		notes.push({
			reason:
				"message row whose role is neither `user` nor `assistant` — Alma passes a third role through unchanged, and this build has no message type for it",
			count: otherRole,
		});
	}
	if (unparsable > 0) notes.push({ reason: ALMA_ROW_UNPARSABLE, count: unparsable });
	return { messages: converted, title: "", startedAt: 0, notes };
}
