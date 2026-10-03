/**
 * OpenClaw's session store, and why `claude-session.ts` could **not** be reused.
 *
 * **The short answer: the transcript is Claude Code's shape at the *envelope*
 * level and a different shape at the *discriminator*, and the discriminator is the
 * only thing that matters to a reader.**
 *
 * `migrate-history.ts`'s `readClaudeCodeSession` (`:674-716`) switches on
 * `parsed.type === "user"` / `"assistant"`. OpenClaw's header event is
 * `{type: "session", version, id, timestamp, cwd}` (`session-accessor.sqlite-
 * transcript-message-append.ts:18-27` writes it unconditionally) and **every
 * message event is `{type: "message", id, parentId, timestamp, message}`**
 * (`:89-95`, `:255-262`). Handed to the Claude reader, every line fails the `type`
 * test, is counted as a "non-conversation entry", and the session imports **zero
 * messages while the report claims the file was read**. That is the failure mode
 * this module exists to avoid, and it is why the answer is "adapted, not reused":
 *
 *   - **Reused in substance.** The content-block vocabulary is the same one.
 *     `packages/llm-core/src/types.ts` gives `TextContent` (`:264-268`),
 *     `ThinkingContent` (`:271-279`), `ToolCall` (`:304-313`) and `ImageContent`
 *     (`:297-301`) — the same four shapes `claudeAssistant` walks — and `Usage`
 *     (`:316`) and `StopReason` (`:357`) line up field for field with what this
 *     build's `assistantMessage` takes.
 *   - **Not reused in dispatch.** Claude Code puts the role on the *event*
 *     (`type`); OpenClaw puts it on the *payload* (`message.role`), and has three
 *     roles where Claude Code has two: `user`, `assistant` and **`toolResult`**
 *     (`:369-372`, `:387-395`, `:425-433`; the three-way test at
 *     `cli-runner/session-history.ts:504-507`). A `toolResult` is a first-class
 *     message, not a content block inside a user turn, so the Claude reader's
 *     user-turn loop — which looks for `tool_result` *inside* `content[]` — finds
 *     nothing.
 *
 * **Two storage facts an importer cannot skip, both verified against the released
 * fixture rather than the TypeScript.**
 *
 *   - **`transcript_events.event_json` or `event_json` `NULL` + `event_zstd`
 *     `BLOB`.** The current schema is a `CHECK` that makes the two mutually
 *     exclusive (`src/state/openclaw-agent-schema.sql:566-585`), and the
 *     compressed arm carries its original byte length plus a `navigation_json`
 *     sidecar. Reading only `event_json` and treating a NULL as "no event" reports
 *     a **truncated** history as the whole history — every turn of a compressed
 *     session silently missing. {@link readOpenClawEvents} therefore asks SQLite
 *     which column is populated rather than assuming.
 *   - **The released `2026.9.2` / `2026.9.3` fixtures have no `event_zstd` column
 *     at all** (agent schema 19) — their `transcript_events` is
 *     `(session_id, seq, event_json TEXT NOT NULL, created_at)`. So the column
 *     itself must be probed through `sqlite_master` rather than assumed from the
 *     current schema file. {@link hasCompressedEvents} does exactly that.
 *
 * **`cwd` is not in the schema.** Neither `session_windows` nor `session_nodes` has
 * a working-directory column; it is in the transcript header's `cwd`, and in
 * optional `entry_json` fields (`types.ts:342,344,351,359,491`) that are **absent
 * on a session that was not spawned**. {@link readOpenClawSessionWindows} reads
 * the header for every session for that reason, and falls back to the optional
 * fields in the order the product prefers them.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type OpenClawEnv, openclawStateDir } from "./openclaw-home.ts";

/** A session's identity, as `session_windows` records it. */
export interface OpenClawSessionWindowRow {
	sessionId: string;
	/** The stable key (`agent:main:corpus-one`); the FK every other table hangs off. */
	sessionKey: string;
	createdAt: number;
	updatedAt: number;
	/** `null` on a session that was not spawned from another one. */
	spawnedBy: string | null;
	status: string | null;
	displayName: string | null;
}

/** One transcript event, decoded from whichever storage column held it. */
export interface OpenClawEvent {
	seq: number;
	createdAt: number;
	/** The decoded envelope: `{type: "session"|"message", …}`. */
	json: Record<string, unknown>;
	/** True when the payload came out of the zstd column rather than the text one. */
	compressed: boolean;
}

/**
 * Open the agent store read-only for `fn`, or return `null`.
 *
 * Structured as `opencode-db.ts` is, for the same reason: `new Database(path)`
 * *creates* a missing database, so a migration run on a machine without OpenClaw
 * would leave a brand-new file inside a tree this importer promised only to read —
 * before the user has seen a line of the report. Every entry point checks the file
 * exists, opens `{ readonly: true }`, and turns any failure into an empty result.
 *
 * **One consequence worth naming:** a read-only open of a WAL-mode database creates
 * `-wal` and `-shm` sidecars beside it. That is normal SQLite behaviour and is
 * harmless against a live install, but it is why this module never opens a
 * *fixture* — `test/fixtures/state-corpus/` ships closed snapshots, and its own
 * README warns that a plain read-only open leaves sidecars in the tree. The tests
 * here build their own database instead.
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

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Every table the store has, sorted.
 *
 * Read from `sqlite_master`, which holds the schema rather than any user's rows.
 * This is the one query that is safe to make about a database whose contents are
 * off limits, and it is what lets {@link hasCompressedEvents} answer without
 * assuming a schema version.
 */
export function readOpenClawTableNames(dbPath: string): string[] {
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
 * Does this store's `transcript_events` have the compressed column?
 *
 * **A schema question, not a row question**, which is why it is asked against
 * `sqlite_master`: the released agent-schema-19 fixtures the project ships do not
 * have `event_zstd`, and the current schema does. A reader that assumed either one
 * would fail on the other — the first by querying a column that is not there, the
 * second by treating a compressed row's NULL `event_json` as an absent event.
 */
export function hasCompressedEvents(dbPath: string): boolean {
	return (
		withDb(dbPath, (db) => {
			const row = db.query("select sql from sqlite_master where name = 'transcript_events'").get() as {
				sql?: string;
			} | null;
			return typeof row?.sql === "string" && /event_zstd/i.test(row.sql);
		}) === true
	);
}

/** Every session window, newest first. */
export function readOpenClawSessionWindows(dbPath: string): OpenClawSessionWindowRow[] {
	return (
		withDb(dbPath, (db) => {
			const rows = db
				.query(
					"select session_id, session_key, created_at, updated_at, spawned_by, status, display_name from session_windows order by coalesce(updated_at, created_at) desc",
				)
				.all() as Array<Record<string, unknown>>;
			return rows.map((row) => ({
				sessionId: asString(row.session_id),
				sessionKey: asString(row.session_key),
				createdAt: asNumber(row.created_at),
				updatedAt: asNumber(row.updated_at),
				spawnedBy: typeof row.spawned_by === "string" && row.spawned_by !== "" ? row.spawned_by : null,
				status: typeof row.status === "string" && row.status !== "" ? row.status : null,
				displayName: typeof row.display_name === "string" && row.display_name !== "" ? row.display_name : null,
			}));
		}) ?? []
	);
}

/**
 * How many sessions the store holds.
 *
 * Of `session_windows`, which is the table that *names* a session — `transcript_events`
 * holds turns, and counting those would report a number that means something else.
 */
export function countOpenClawSessions(dbPath: string): number {
	return (
		withDb(dbPath, (db) => {
			const row = db.query("select count(*) as c from session_windows").get() as { c?: number } | null;
			return asNumber(row?.c);
		}) ?? 0
	);
}

/**
 * Every event for one session, in write order.
 *
 * **Which storage column is populated is asked, not assumed.** The current schema
 * makes `event_json` and `event_zstd` mutually exclusive with a `CHECK`
 * (`openclaw-agent-schema.sql:576-585`); the released fixtures have no
 * `event_zstd` at all. So this reads `event_zstd is not null` as a flag and takes
 * the JSON from whichever column the row actually filled, and a `NULL` in both is
 * reported as a skipped event rather than as an empty turn.
 */
export function readOpenClawEvents(dbPath: string, sessionId: string): OpenClawEvent[] {
	return (
		withDb(dbPath, (db) => {
			const compressed = hasCompressedEvents(dbPath);
			const select = compressed
				? "select seq, created_at, event_json, event_zstd, event_zstd is not null as is_zstd from transcript_events where session_id = ? order by seq asc"
				: "select seq, created_at, event_json, null as event_zstd, 0 as is_zstd from transcript_events where session_id = ? order by seq asc";
			const rows = db.query(select).all(sessionId) as Array<Record<string, unknown>>;
			return rows.flatMap((row) => {
				const isZstd = row.is_zstd === 1 || row.is_zstd === true;
				const decoded = isZstd ? decodeZstdJson(row.event_zstd) : safeParse(row.event_json);
				if (decoded === null) return [];
				return [
					{
						seq: asNumber(row.seq),
						createdAt: asNumber(row.created_at),
						json: decoded,
						compressed: isZstd,
					},
				];
			});
		}) ?? []
	);
}

/**
 * Decompress an `event_zstd` blob into its JSON.
 *
 * **Bun's zstd, and `null` rather than a throw.** The product compresses with the
 * same framing (`prepareTranscriptPayloadForReuse` stores a physical payload), and
 * a payload this build cannot decompress is one event this importer reports as
 * skipped — the same treatment a malformed JSON line gets, and for the same reason:
 * one unreadable turn must not cost the user the other forty-nine.
 */
function decodeZstdJson(blob: unknown): Record<string, unknown> | null {
	if (!(blob instanceof Uint8Array) && !(blob instanceof ArrayBuffer)) return null;
	const bytes = blob instanceof ArrayBuffer ? new Uint8Array(blob) : blob;
	try {
		return safeParse(new TextDecoder().decode(Bun.zstdDecompressSync(bytes)));
	} catch {
		return null;
	}
}

/** Parse a JSON object, or `null` for anything that is not one. */
function safeParse(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== "string") return asRecord(raw);
	try {
		return asRecord(JSON.parse(raw));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Locating the store
// ---------------------------------------------------------------------------

/**
 * Where this agent's store is, or `null` when there is none.
 *
 * A path join and not a search: the layout is fixed
 * (`<stateDir>/agents/<id>/agent/openclaw-agent.sqlite`) and an `agents[].agentDir`
 * override moves it. Both are resolved by `openclaw-home.ts`; this only composes
 * them, so the reader and the history importer cannot disagree about which file is
 * the store.
 */
export function openclawAgentDbPath(stateDir: string, agentId: string, configuredAgentDir?: string): string {
	const dir =
		typeof configuredAgentDir === "string" && configuredAgentDir.trim() !== ""
			? configuredAgentDir.trim()
			: `${stateDir}/agents/${agentId}/agent`;
	return dir.replace(/[\\/]+$/, "").concat("/openclaw-agent.sqlite");
}

/**
 * The agent store for a home, or `null`.
 *
 * The state directory is resolved with the product's own precedence — including
 * the `.clawdbot` fallback — so an upgraded install whose state never moved is
 * found rather than reported absent.
 */
export function findOpenClawAgentDb(home: string, env: OpenClawEnv, agentId = "main"): string | null {
	const stateDir = openclawStateDir(home, env);
	const candidates = [
		openclawAgentDbPath(stateDir, agentId),
		// `agents[].agentDir` can put the store anywhere; the two spellings below
		// are the layout a default install writes, kept because a profile root moves
		// the whole tree rather than the agent subdirectory.
		openclawAgentDbPath(stateDir, agentId, `${stateDir}/agents/${agentId}/agent`),
	];
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	return null;
}
