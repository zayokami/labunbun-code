/**
 * Read-only access to OpenCode's sqlite database (`<xdgData>/opencode.db`).
 *
 * Structured like `zcode-db.ts`, and for the same reason: `new Database(path)`
 * *creates* a missing database, so a migration run on a machine without OpenCode
 * would leave a brand-new file inside a directory this importer promised only to
 * read — before the user has seen a line of the report. Every entry point here
 * checks the file exists, opens `{ readonly: true }`, and turns any failure into
 * an empty result.
 *
 * Four of OpenCode's tables are never queried, and the reason is in
 * `opencode-read.ts` beside the names: `account`, `control_account`, `credential`
 * and `session_share` hold credentials and nothing this migration wants. The
 * table *names* are read — from `sqlite_master`, which is a query against the
 * schema and not against any row — so the report can say which of them the
 * install actually has.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface OpencodeSessionRow {
	id: string;
	/** Set for subagent sessions; the history importer counts and skips those. */
	parentId: string | null;
	/** The working directory the session ran in — the `notNull` column, not a path join. */
	directory: string;
	title: string;
	timeCreated: number;
	/** Set when the session has been archived; the history importer skips those. */
	timeArchived: number;
}

export interface OpencodeMessageRow {
	id: string;
	sessionId: string;
	timeCreated: number;
	/** The decoded `data` JSON blob. */
	data: Record<string, unknown>;
}

export interface OpencodePartRow {
	id: string;
	messageId: string;
	timeCreated: number;
	/** `data.type` lifted out of the blob so callers can switch on it directly. */
	type: string;
	data: Record<string, unknown>;
}

/**
 * One row of `session_message`, the table v2 actually keeps its messages in.
 *
 * **The whole message body is the `data` column** — a JSON object typed by
 * `SessionMessage.Message` (`packages/schema/src/session-message.ts:190-196`),
 * a union of eight shapes discriminated on `type`. There is no `part` table
 * beside it: a tool call, its output and the text around them are all
 * `content[]` entries of one `assistant` row (`session-message.ts:140-183`).
 */
export interface OpencodeSessionMessageRow {
	id: string;
	sessionId: string;
	/** The `type` column, falling back to `data.type`; see {@link readOpencodeSessionMessages}. */
	type: string;
	/** The per-session ordinal. `(session_id, seq)` is a unique index (`session/sql.ts:133`). */
	seq: number;
	timeCreated: number;
	timeUpdated: number;
	/** The decoded `data` JSON blob. */
	data: Record<string, unknown>;
}

/**
 * Open the database read-only for the duration of `fn`, or return `null`.
 *
 * `fn`'s own errors are swallowed too: the schema belongs to whichever OpenCode
 * build wrote it, and a build that added or renamed a column should cost this
 * importer one query rather than the whole run.
 */
function withDb<T>(dbPath: string, fn: (db: Database) => T): T | null {
	if (!existsSync(dbPath)) return null;
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
 * `session_share` table" instead of naming four tables that may not exist.
 */
export function readOpencodeTableNames(dbPath: string): string[] {
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
 * `parent_id` and `time_archived` are both selected rather than filtered here: the
 * history importer counts subagent sessions and archived ones so the report can
 * say what it left out, which is the same reason `zcode-db.ts` returns subagent
 * sessions instead of dropping them.
 *
 * `time_archived` is a nullable column, so a `notNull` filter in SQL would be
 * wrong; the absent case comes back as `0` and reads as "not archived", which is
 * what an unarchived session's row says.
 */
export function readOpencodeSessions(dbPath: string): OpencodeSessionRow[] {
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

/** Messages and their parts for one session, in write order. */
export function readOpencodeConversation(
	dbPath: string,
	sessionId: string,
): { messages: OpencodeMessageRow[]; parts: OpencodePartRow[] } {
	const empty = { messages: [] as OpencodeMessageRow[], parts: [] as OpencodePartRow[] };
	return (
		withDb(dbPath, (db) => {
			const messages = (
				db
					.query(
						"select id, session_id, time_created, data from message where session_id = ? order by time_created asc, rowid asc",
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
			const parts = (
				db
					.query(
						"select id, message_id, time_created, data from part where session_id = ? order by time_created asc, rowid asc",
					)
					.all(sessionId) as Array<Record<string, unknown>>
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

/**
 * Does this database have v2's `session_message` table?
 *
 * A question about `sqlite_master`, which holds the schema rather than any
 * user's rows — the one query that is safe to ask of a database whose contents
 * are otherwise off limits.
 */
export function hasOpencodeSessionMessages(dbPath: string): boolean {
	return (
		withDb(dbPath, (db) => {
			const row = db
				.query("select name from sqlite_master where type = 'table' and name = 'session_message'")
				.get() as Record<string, unknown> | null;
			return row !== null && row !== undefined;
		}) === true
	);
}

/**
 * v2's messages for one session, in order, or `null` when this install has no
 * `session_message` table at all.
 *
 * **`null` and `[]` mean different things** and the caller has to tell them
 * apart: `[]` is a v2 database holding a session with nothing in it, while
 * `null` is a v1 database, whose messages live in the `message`/`part` pair
 * that {@link readOpencodeConversation} reads. Returning `[]` for a missing
 * table is what would make a v2 install import no conversations while the
 * report said there was nothing there.
 *
 * Ordered by `seq` rather than by time: `(session_id, seq)` is the unique
 * index the source puts on the table (`packages/core/src/session/sql.ts:133`),
 * and two messages can share a millisecond.
 */
export function readOpencodeSessionMessages(dbPath: string, sessionId: string): OpencodeSessionMessageRow[] | null {
	if (!hasOpencodeSessionMessages(dbPath)) return null;
	return (
		withDb(dbPath, (db) => {
			const rows = (
				db
					.query(
						"select id, session_id, type, seq, time_created, time_updated, data from session_message where session_id = ? order by seq asc",
					)
					.all(sessionId) as Array<Record<string, unknown>>
			).flatMap((row) => {
				const data = asRecord(decodeJson(row.data));
				if (!data) return [];
				return [
					{
						id: asString(row.id),
						sessionId: asString(row.session_id),
						// The column is what the union is discriminated on
						// (`sql.ts:120-131`); the blob carries its own copy, and a row
						// written by a build that filled only one of the two still reads.
						type: asString(row.type) || asString(data.type),
						seq: asNumber(row.seq),
						timeCreated: asNumber(row.time_created),
						timeUpdated: asNumber(row.time_updated),
						data,
					},
				];
			});
			return rows;
		}) ?? []
	);
}
