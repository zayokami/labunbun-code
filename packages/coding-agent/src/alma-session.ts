/**
 * Alma's conversations, out of `chat_threads.db`.
 *
 * **The layout is settled and awkward.** Two tables and a link:
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS chat_threads (
 *   id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT,
 *   is_generating BOOLEAN DEFAULT FALSE, reasoning_effort TEXT DEFAULT 'medium',
 *   metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 * )
 * CREATE TABLE IF NOT EXISTS chat_messages (
 *   id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, parent_id TEXT, slot_id TEXT,
 *   depth INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL,
 *   timestamp TEXT NOT NULL, metadata TEXT DEFAULT '{}',
 *   created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 *   FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
 * )
 * ```
 *
 * …and then fifteen `ALTER TABLE chat_threads ADD COLUMN` statements, one of
 * which duplicates a column the `CREATE` already made. **The drizzle schema —
 * the one the application itself queries through — declares twenty-two columns**
 * (`we("chat_threads", { id, title, model, tools, tools_compact_view,
 * prompt_app_id, workspace_id, artifact_workspace_id, is_generating,
 * is_favorited, is_favorite_pinned, favorite_pinned_order, sidebar_pin_slot,
 * is_incognito, enable_artifacts, parent_thread_id, reasoning_effort, fast_mode,
 * skill_ids, metadata, created_at, updated_at })`). So the "eight columns" and the
 * "eighteen columns" a reader might quote are both wrong; the number that
 * matters is on the other side of this comment.
 *
 * **There is no `cwd` column, and `metadata` does not stand in for one.** The
 * application's own thread-creation path writes `metadata: {}` — literally an
 * empty object — and the working directory lives on the **workspace**: a thread
 * names one with `workspace_id`, and the path is `workspaces.path`. The column
 * is `REFERENCES workspaces(id) ON DELETE SET NULL`, so deleting a workspace
 * leaves its threads with **no path at all** rather than a stale one, and there
 * is no fallback to try.
 *
 * This module therefore reports the plain fact — "this thread recorded no
 * working directory" — rather than writing a placeholder. A placeholder is the
 * one thing the rest of this pipeline cannot survive: `narrowCandidates` counts
 * an empty `cwd` under "no working directory recorded" and drops the session,
 * and a *wrong* cwd files a conversation under a project it was never had in.
 * {@link HistoryCandidate.cwdSubstitute} is the mechanism the other sources use
 * for exactly this, and it carries a flag to the report so the user is told the
 * directory was assumed rather than recorded.
 */

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

/**
 * Where the database is, or `null` when there is no application-data path.
 *
 * **There is no `home` argument**, which is worth a line of its own: Alma's only
 * database lives under Electron's `userData` root, which `APPDATA` names on its own.
 * Nothing about it is derived from the home directory, and a reader that looked
 * under `~/.alma/chat_threads.db` or `~/.config/alma/chat_threads.db` would never
 * find one. Every other session reader here takes `home`; this one cannot, and the
 * shape difference is the honest one.
 */
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

/**
 * Every thread, with its working directory where one is reachable.
 *
 * **The `LEFT JOIN` is the honest shape.** An inner join would drop every
 * orphaned thread from the listing, and an orphan is precisely the case the
 * report exists to say something about — a user whose conversations exist and
 * whose project mapping does not is exactly who needs to be told rather than
 * quietly given nothing.
 *
 * **Two columns are never selected that could have been**: `metadata` is a JSON
 * blob whose keys are the app's business and `api_key`-shaped columns are not
 * in this table at all, but the column list stays explicit for the same reason
 * `readAlma`'s does — a `*` is one keystroke away from a credential.
 */
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

/**
 * One thread's messages, oldest first.
 *
 * `ORDER BY created_at ASC, depth ASC` — `depth` is the column Alma maintains
 * for a branch of the conversation, so a message edited into existence later
 * still sorts after what it was edited from rather than by whatever its own
 * timestamp happens to be.
 *
 * **The `message` column is a JSON blob, and the record shape is read rather than
 * assumed.** The application writes `{ role, parts: [{ type, … }] }` — `role` is
 * one of `user`, `assistant` or anything else, which it passes through verbatim
 * (`t = "user" === e.role ? "User" : "assistant" === e.role ? "Assistant" :
 * e.role` in its own archiver). Only `type: "text"` parts contribute, which is
 * Alma's own filter and the reason its markdown archive has no tool calls in it.
 *
 * **Rows whose blob will not parse are counted, not skipped silently**: a
 * transcript with a hole in the middle of it is still worth importing, and the
 * count is what tells the user there was one.
 */
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

/**
 * List Alma's threads.
 *
 * **`cwdSubstitute` is set to the configuration root rather than to `cwd`**, and
 * that choice is the whole difference between importing a user's conversations
 * and importing none of them. The default `--history-scope` is `cwd`, so a
 * source whose sessions name no directory would plan zero sessions while the
 * report looked clean; `cwdSubstitute` files each one under a stated directory
 * and carries the flag to the report so the sentence the user reads can name the
 * difference between "recorded" and "assumed". See `HistoryCandidate`'s own
 * comment, which is where that reasoning belongs.
 */
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

/**
 * Read one thread's rows and convert them.
 *
 * **Only `user` and `assistant` become turns, and everything else is counted.**
 * Alma passes a third role through verbatim — its own archiver writes
 * `t = "user" === role ? "User" : "assistant" === role ? "Assistant" : role` — so
 * a row can carry a role this build has no message type for. Dropping it in
 * silence would produce a transcript with a hole and no explanation, so it is
 * counted and the count reaches the report.
 *
 * **No tool calls are reconstructed, and that is a limitation rather than a
 * choice.** `chat_messages.message` holds the whole message JSON, so a tool call
 * *is* in the blob — as a part with a `tool-` type and an `input`. Reconstructing
 * one would mean inventing an id, a name and a matching `toolResult` row, and
 * this build rejects a transcript that half-pairs them: a tool call with no result
 * (or the reverse) fails the messages API on the first `--continue`, which is
 * worse than a shorter transcript. So the text survives and the actions do not,
 * and `alma-plan.ts` says so where the user reads about their conversations.
 */
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
