/**
 * Read-only access to ZCode's sqlite database (`~/.zcode/cli/db/db.sqlite`).
 *
 * One of two modules in the repository that import `bun:sqlite` — the other is
 * `minimax-session.ts`, reading MiniMax's `runtime-state.sqlite` under the same
 * rules — and it is deliberately careful about how it opens the file.
 * `new Database(path)` *creates* a missing database, so a migration run on a
 * machine without ZCode
 * would leave a brand-new file inside the source tool's own directory — writing
 * to a source the migration promised only to read, and doing it before the user
 * has seen a single line of the report. Every entry point therefore checks the
 * file exists, opens with `{ readonly: true }`, and turns any failure into an
 * empty result: a locked, half-written, or newer-schema database contributes
 * nothing to the import instead of aborting it or starting a file of its own.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface ZcodeSessionRow {
	id: string;
	/** Set for subagent sessions; the history importer counts and skips those. */
	parentId: string | null;
	directory: string;
	title: string;
	timeCreated: number;
}

export interface ZcodeMessageRow {
	id: string;
	sessionId: string;
	timeCreated: number;
	/** The decoded `data` JSON blob: `{role, time, modelID, providerID, finish, ...}`. */
	data: Record<string, unknown>;
}

export interface ZcodePartRow {
	id: string;
	messageId: string;
	timeCreated: number;
	/** `data.type` lifted out of the blob so callers can switch on it directly. */
	type: string;
	data: Record<string, unknown>;
}

export interface ZcodeSettingRow {
	scope: string;
	scopeId: string;
	namespace: string;
	key: string;
	value: unknown;
}

/**
 * Open the database read-only for the duration of `fn`, or return `null`.
 *
 * `fn`'s own errors are swallowed too — a row written by a newer ZCode can be
 * missing a column this importer knows about, and that should cost the caller
 * the query, not the whole migration.
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

/** Every session in the database, newest first. Subagent sessions are included. */
export function readZcodeSessions(dbPath: string): ZcodeSessionRow[] {
	return (
		withDb(dbPath, (db) => {
			const rows = db
				.query("select id, parent_id, directory, title, time_created from session order by time_created desc")
				.all() as Array<Record<string, unknown>>;
			return rows.map((row) => ({
				id: asString(row.id),
				parentId: typeof row.parent_id === "string" ? row.parent_id : null,
				directory: asString(row.directory),
				title: asString(row.title),
				timeCreated: asNumber(row.time_created),
			}));
		}) ?? []
	);
}

/** Messages and their parts for one session, in write order. */
export function readZcodeConversation(
	dbPath: string,
	sessionId: string,
): { messages: ZcodeMessageRow[]; parts: ZcodePartRow[] } {
	const empty = { messages: [] as ZcodeMessageRow[], parts: [] as ZcodePartRow[] };
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

/** Every `local_setting` row: ZCode's per-scope key/value store. */
export function readZcodeSettings(dbPath: string): ZcodeSettingRow[] {
	return (
		withDb(dbPath, (db) => {
			const rows = db.query("select scope, scope_id, namespace, key, value from local_setting").all() as Array<
				Record<string, unknown>
			>;
			return rows.map((row) => ({
				scope: asString(row.scope),
				scopeId: asString(row.scope_id),
				namespace: asString(row.namespace),
				key: asString(row.key),
				value: decodeJson(row.value),
			}));
		}) ?? []
	);
}
