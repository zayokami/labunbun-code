/**
 * Read-only access to MiMo Code's session database (`<data>/mimocode.db`).
 *
 * Structured like `opencode-db.ts`, and for the same reason: `new Database(path)`
 * *creates* a missing database, so a migration run on a machine without MiMo Code
 * would leave a brand-new file inside a directory this importer promised only to
 * read — before the user has seen a line of the report. Every entry point here
 * checks the file exists, opens `{ readonly: true }`, and turns any failure into
 * an empty result.
 *
 * **MiMo Code ships its own reader for exactly this schema, so none of the shape
 * below is inferred.** `packages/cli/src/session/opencode-import.ts` imports an
 * upstream `opencode.db` through `openReadonly` (`storage/read-sqlite.bun.ts:7-13`,
 * `new Database(path, { readonly: true })`) with three queries, and this module
 * reproduces them with two changes:
 *
 * ```js
 * // opencode-import.ts:96
 * srcDb.all("SELECT * FROM session ORDER BY time_created DESC")
 * // opencode-import.ts:141
 * srcDb.all("SELECT * FROM message WHERE session_id = ? ORDER BY id", sess.id)
 * // opencode-import.ts:154
 * `SELECT * FROM part WHERE session_id = ? AND message_id IN (${placeholders}) ORDER BY id`
 * ```
 *
 *   1. **The columns are named rather than `SELECT *`.** The product reads a
 *      fixed set into a hand-written type; this importer names the columns it uses
 *      so a MiMo Code release that adds one cannot silently change what it reads.
 *   2. **`agent_id = 'main'` is a filter the product's own importer does not
 *      need and this one does.** MiMo Code's `message` table gives `agent_id` a
 *      `notNull()` default of `"main"` (`session/session.sql.ts:94`) and both of
 *      its readers filter on it — `session/session.ts:964`
 *      (`eq(MessageTable.agent_id, "main")`) and `session/message-v2.ts:1217`
 *      (`input.agentID === "*" ? undefined : eq(MessageTable.agent_id, input.agentID ?? "main")`).
 *      **Subagent turns are written into the same session's `message` and `part`
 *      rows**, so a reader that takes every row gets the user's turn followed by
 *      the whole of a task the agent ran on their behalf — and the report would say
 *      the user asked for it. `MIMOCODE_SUBAGENT_ROWS` counts what the filter
 *      removed, because "nothing came across" and "what came across was someone
 *      else's turn" must not print the same line.
 *
 * **Tables that are never queried, and why.** `account` and `session_share` hold
 * credentials (`mimocode-home.ts`'s {@link MIMOCODE_CREDENTIAL_TABLES}), and
 * `history_fts` is SQLite's full-text shadow over the message bodies — the text
 * in it is a copy of what `message.data` already says, so reading it would
 * duplicate every turn and present the duplicates as separate messages. The table
 * *names* are read — from `sqlite_master`, which is a query against the schema
 * and not against any row — so the report can say which of them the install has.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface MiMoCodeSessionRow {
	id: string;
	/** Set for a subagent session; the history importer counts and skips those. */
	parentId: string | null;
	/**
	 * The working directory the session ran in.
	 *
	 * **`directory` is `notNull()` and has been since the first migration**
	 * (`session/session.sql.ts:27`, and the same column in the first migration,
	 * `migration/20260127222353_` followed by `/migration.sql`), so this importer never has to
	 * ask "where did this session run" — the answer is on the row. It is also why
	 * no project-slug hashing is needed here the way Qoder's reader needs one.
	 */
	directory: string;
	title: string;
	timeCreated: number;
	/** Set when the session has been archived; **history IS archivable.** */
	timeArchived: number;
}

export interface MiMoCodeMessageRow {
	id: string;
	sessionId: string;
	timeCreated: number;
	/** The decoded `data` JSON blob: a union discriminated on `role`. */
	data: Record<string, unknown>;
}

export interface MiMoCodePartRow {
	id: string;
	messageId: string;
	timeCreated: number;
	/** `data.type` lifted out of the blob so callers can switch on it directly. */
	type: string;
	data: Record<string, unknown>;
}

/**
 * Open the database read-only for the duration of `fn`, or return `null`.
 *
 * `fn`'s own errors are swallowed too: the schema belongs to whichever MiMo Code
 * build wrote it, and a build that added or renamed a column should cost this
 * importer one query rather than the whole run.
 */
function withDb<T>(dbPath: string | null, fn: (db: Database) => T): T | null {
	if (dbPath === null || !existsSync(dbPath)) return null;
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		return fn(db);
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			// closing a failed handle is best-effort
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Decode a TEXT column that holds JSON; a value that already parsed passes through. */
function decodeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Every table the database has, sorted.
 *
 * Read from `sqlite_master`, which holds the schema rather than any user's rows.
 * This is the one query that is safe to make about a database whose other tables
 * are off limits, and it is what lets the report say "this install has a
 * `session_share` table" instead of naming tables that may not exist.
 */
export function readMiMoCodeTableNames(dbPath: string | null): string[] {
	return (
		withDb(dbPath, (db) => {
			const rows = db
				.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
				.all() as Array<Record<string, unknown>>;
			return rows
				.map((row) => asString(row.name))
				.filter((name) => name !== "")
				.sort();
		}) ?? []
	);
}

/**
 * Every session, newest first.
 *
 * `parent_id` and `time_archived` are both **selected rather than filtered** here:
 * the history importer counts subagent sessions and carries the archived flag so
 * the report can say what it did with them. `time_archived` is nullable, so a
 * `notNull` filter in SQL would be wrong; the absent case arrives as `0` and reads
 * as "not archived", which is what an unarchived session's row says.
 */
export function readMiMoCodeSessions(dbPath: string | null): MiMoCodeSessionRow[] {
	return (
		withDb(dbPath, (db) => {
			const rows = db
				.query(
					"select id, parent_id, directory, title, time_created, coalesce(time_archived, 0) as time_archived from session order by time_created desc",
				)
				.all() as Array<Record<string, unknown>>;
			return rows.map((row) => ({
				id: asString(row.id),
				parentId: typeof row.parent_id === "string" && row.parent_id !== "" ? row.parent_id : null,
				directory: asString(row.directory),
				title: asString(row.title),
				timeCreated: asNumber(row.time_created),
				timeArchived: asNumber(row.time_archived),
			}));
		}) ?? []
	);
}

/**
 * How many rows in `message` this install has for a session **beside** the main
 * thread, and how many messages the main thread has.
 *
 * Asked rather than inferred because "this session had no messages" and "this
 * session's messages were all subagent turns" are different reports. The count is
 * of *messages*, not parts: a subagent turn is one `message` row plus its parts,
 * and the parts are only ever reached through a message this importer kept.
 */
export function readMiMoCodeMessageScope(
	dbPath: string | null,
	sessionId: string,
): {
	main: number;
	subagent: number;
} {
	return (
		withDb(dbPath, (db) => {
			const row = db
				.query(
					"select sum(case when agent_id = ? then 1 else 0 end) as main_count, sum(case when agent_id <> ? then 1 else 0 end) as other_count from message where session_id = ?",
				)
				.get("main", "main", sessionId) as Record<string, unknown> | null;
			if (row === null || row === undefined) return { main: 0, subagent: 0 };
			return { main: asNumber(row.main_count), subagent: asNumber(row.other_count) };
		}) ?? { main: 0, subagent: 0 }
	);
}

/** Messages and their parts for one session's **main thread**, in write order. */
export function readMiMoCodeConversation(
	dbPath: string | null,
	sessionId: string,
): { messages: MiMoCodeMessageRow[]; parts: MiMoCodePartRow[] } {
	const empty = { messages: [] as MiMoCodeMessageRow[], parts: [] as MiMoCodePartRow[] };
	return (
		withDb(dbPath, (db) => {
			const messages = (
				db
					.query(
						// `agent_id = 'main'` is the product's own filter — see the header.
						// `rowid` is the tiebreak because two messages written in the
						// same millisecond have equal `time_created` and nothing else to
						// order them by.
						"select id, session_id, time_created, data from message where session_id = ? and agent_id = 'main' order by time_created asc, rowid asc",
					)
					.all(sessionId) as Array<Record<string, unknown>>
			).flatMap((row) => {
				const data = asRecord(decodeJson(row.data));
				if (!data) return [];
				return [
					{
						id: asString(row.id),
						sessionId: asString(row.session_id),
						timeCreated: asNumber(row.time_created),
						data,
					},
				];
			});
			// **`part` has no `agent_id` column** (`session/session.sql.ts:97-110`:
			// `id`, `message_id`, `session_id`, the timestamps and the JSON `data`),
			// so filtering by `session_id` alone would sweep in the parts of the
			// subagent turns the message query just excluded — and those parts would
			// then be attached to whichever main-thread message shared their
			// timestamp. The filter is by the message ids that survived, which is what
			// the product's own importer does too (`opencode-import.ts:154`).
			const keptIds = messages.map((message) => message.id);
			const parts =
				keptIds.length === 0
					? []
					: (
							db
								.query(
									`select id, message_id, time_created, data from part where message_id in (${keptIds.map(() => "?").join(",")}) order by time_created asc, rowid asc`,
								)
								.all(...keptIds) as Array<Record<string, unknown>>
						).flatMap((row) => {
							const data = asRecord(decodeJson(row.data));
							if (!data) return [];
							return [
								{
									id: asString(row.id),
									messageId: asString(row.message_id),
									timeCreated: asNumber(row.time_created),
									type: asString(data.type),
									data,
								},
							];
						});
			return { messages, parts };
		}) ?? empty
	);
}
