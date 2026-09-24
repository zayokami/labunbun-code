/**
 * What the MiniMax Code importer reads out of `<root>/v2/sessions`, and what it
 * says about what it leaves behind.
 *
 * The fixtures are the bytes MiniMax writes, in the spelling its own writer uses:
 * a manifest per dated session directory, `messages.jsonl` under the current
 * writer, and `snapshot.json` plus `ledger.jsonl` under the released one, with
 * the session's metadata in `v2/sqlite/runtime-state.sqlite` beside the tree.
 * Four properties of that format shape this file.
 *
 * The first is that the canonical file is a *context and not a journal*: when the
 * tool compacts, it replaces the file, so the record of the compaction is the
 * file's first line and there is nothing before it to lose. The tests below pin
 * that the import starts with a compaction entry rather than presenting a
 * compacted session as a complete one.
 *
 * The second is that the tool's answer to a damaged transcript is a *partition*
 * and not a single verdict: a malformed line, an identity used twice, a boundary
 * that is not first, or a `turn_config` off its message refuses the session whole,
 * while an orphan tool result, an interrupted round, or a call with no identity is
 * repaired away. Both halves are asserted, because a reader that refused on the
 * second list would lose conversations the tool itself still opens, and one that
 * repaired across the first would import a transcript whose meaning it cannot
 * establish.
 *
 * The third is that the released pair is a *cache over a ledger*: the snapshot can
 * be rebuilt from the ledger, so a corrupt snapshot is recovered from, a gap in
 * the sequence is not, and a half-written last line is not damage at all.
 *
 * The fourth is that most of what a session file holds is not conversation. A
 * skip is asserted with the count the report prints, because the reader's value is
 * not only that it keeps the conversation but that it says which parts of it were
 * left behind: the harness's own system prompt, an archive marker, a redacted
 * reasoning block, an image with no bytes in it, a message of a role this build
 * does not carry.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import {
	listMinimaxSessions,
	type MinimaxEntry,
	type MinimaxRead,
	type MinimaxSessionFile,
	readMinimaxSession,
} from "../src/minimax-session.ts";

/** The directory the fixtures ran in; a session with no row is scoped nowhere. */
const CWD = "R:/work/proj";

/** The fixtures' clock: every record below counts from here, one second apiece. */
const T0 = Date.parse("2026-03-01T00:00:00Z");

/** The dated path segments, which the walk descends one by one. */
const YEAR = "2026";
const MONTH = "03";
const DAY = "01";
const SESSION_DIR = "10-30-00-000-session_c2Vzc2lvbi0x";

/** Temp roots, swept with the test that made them. */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The clock the fixture writers tick; reset per test so timestamps are pinned. */
let clock = T0;
beforeEach(() => {
	clock = T0;
});
const tick = (): number => (clock += 1000);

/** A throwaway data directory (`$MINIMAX_DATA_DIR`'s tree, without the variable). */
function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lbb-minimax-session-"));
	roots.push(root);
	return root;
}

// ---------------------------------------------------------------------------
// Fixtures: the bytes MiniMax writes
// ---------------------------------------------------------------------------

/** One canonical envelope, as `messages.jsonl` holds it. */
function envelope(messageId: string, turnId: string, message: Record<string, unknown>, extra = {}): string {
	return JSON.stringify({ message_id: messageId, turn_id: turnId, message, ...extra });
}

/** A pi message, with the clock's timestamp unless the test says otherwise. */
function message(body: Record<string, unknown>): Record<string, unknown> {
	return { timestamp: tick(), ...body };
}

/** The user half of a turn. */
function user(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return message({ role: "user", content: [{ type: "text", text }], ...extra });
}

/** An assistant message, with the fields the tool's writer fills in. */
function assistant(body: Record<string, unknown> = {}): Record<string, unknown> {
	return message({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		provider: "minimax",
		model: "MiniMax-M2",
		usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 0.001 } },
		stopReason: "stop",
		...body,
	});
}

/** A tool result, as the tool's writer records one. */
function toolResult(toolCallId: string, body: Record<string, unknown> = {}): Record<string, unknown> {
	return message({
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		...body,
	});
}

/** One `local_runtime_sessions` row. */
interface RowFixture {
	sessionId: string;
	title?: string;
	cwd?: string;
	archived?: 0 | 1;
	visibility?: string;
	kind?: string;
	sessionType?: string;
	parentSessionId?: string | null;
	updatedAt?: number;
}

interface SessionFixture {
	/** The manifest's session id; the directory's own name does not carry it. */
	id?: string;
	/** `manifest.json`; `null` writes none at all. */
	manifest?: Record<string, unknown> | null;
	/** `messages.jsonl` lines, joined with newlines and terminated; `null` writes none. */
	messages?: string[] | null;
	/** `ledger.jsonl` lines; `null` writes none. */
	ledger?: string[] | null;
	/** Exact ledger bytes, for a test about a half-written line; replaces `ledger`. */
	ledgerRaw?: string;
	/** `snapshot.json`; `null` writes none. */
	snapshot?: Record<string, unknown> | null;
	/** Other files in the session directory, keyed by relative path. */
	extra?: Record<string, string>;
	/** Rows for the metadata database; `undefined` writes no database at all. */
	rows?: RowFixture[] | "corrupt";
	/** Path segments, for a test that wants two sessions. */
	name?: string;
	day?: string;
}

/** Write one session directory the way MiniMax lays one out, and the metadata beside it. */
function writeSession(root: string, fixture: SessionFixture = {}): string {
	const id = fixture.id ?? "session-1";
	const dir = join(root, "v2", "sessions", YEAR, MONTH, fixture.day ?? DAY, fixture.name ?? SESSION_DIR);
	mkdirSync(dir, { recursive: true });
	if (fixture.manifest !== null) {
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({
				schemaVersion: 1,
				sessionId: id,
				createdAtMs: T0,
				updatedAtMs: T0,
				source: "local-runtime",
				layout: "v2-final-dated-session",
				paths: { sessionDir: dir, messages: join(dir, "messages.jsonl") },
				...(fixture.manifest ?? {}),
			}),
		);
	}
	if (fixture.messages) writeFileSync(join(dir, "messages.jsonl"), `${fixture.messages.join("\n")}\n`);
	if (fixture.ledger) writeFileSync(join(dir, "ledger.jsonl"), `${fixture.ledger.join("\n")}\n`);
	if (fixture.ledgerRaw !== undefined) writeFileSync(join(dir, "ledger.jsonl"), fixture.ledgerRaw);
	if (fixture.snapshot) writeFileSync(join(dir, "snapshot.json"), JSON.stringify(fixture.snapshot));
	for (const [name, content] of Object.entries(fixture.extra ?? {})) writeFileSync(join(dir, name), content);
	if (fixture.rows !== undefined) writeRows(root, fixture.rows, id);
	return dir;
}

/** The metadata database, with the columns the reader's query asks for. */
function writeRows(root: string, rows: RowFixture[] | "corrupt", defaultId: string): void {
	const path = join(root, "v2", "sqlite", "runtime-state.sqlite");
	mkdirSync(dirname(path), { recursive: true });
	if (rows === "corrupt") {
		writeFileSync(path, "this is not a sqlite database");
		return;
	}
	const db = new Database(path);
	try {
		db.run(
			"create table if not exists local_runtime_sessions (session_id text, title text, workspace_dir text, archived integer, visibility text, session_kind text, session_type text, parent_session_id text, created_at_ms integer, updated_at_ms integer, history_relative_dir text)",
		);
		for (const row of rows) {
			db.run("insert into local_runtime_sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
				row.sessionId || defaultId,
				row.title ?? "",
				row.cwd ?? CWD,
				row.archived ?? 0,
				row.visibility ?? "visible",
				row.kind ?? "conversation",
				row.sessionType ?? "root",
				row.parentSessionId ?? null,
				T0,
				row.updatedAt ?? T0,
				null,
			]);
		}
	} finally {
		db.close();
	}
}

/** The one listed session, or a failure that names what was listed instead. */
function listed(root: string, id = "session-1"): MinimaxSessionFile {
	const session = listMinimaxSessions(root).sessions.find((found) => found.sessionId === id);
	if (!session) throw new Error(`no listed session ${id} under ${root}`);
	return session;
}

/** A read that has to have succeeded; the reader's own words are the failure. */
function minimaxRead(root: string, id = "session-1"): MinimaxRead {
	const read = readMinimaxSession(listed(root, id));
	if ("error" in read) throw new Error(`readMinimaxSession refused ${id}: ${read.error}`);
	return read;
}

/** The reason a read was refused; a read that succeeded is the failure. */
function refusal(root: string, id = "session-1"): string {
	const read = readMinimaxSession(listed(root, id));
	if (!("error" in read)) throw new Error(`readMinimaxSession accepted ${id}`);
	return read.error;
}

/** The messages a read produced, in order, with any compaction marker left out. */
function messagesOf(entries: MinimaxEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
}

/** The entry kinds a read produced, so a test can see where a marker stands. */
function kindsOf(entries: MinimaxEntry[]): string[] {
	return entries.map((entry) => entry.kind);
}

/** All the text a message carries, so an assertion can look for a canary. */
function textOf(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.map((block) =>
				block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : block.arguments,
			)
			.join("\n");
	}
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** The note a read wrote for one reason, or undefined when it wrote none. */
function note(read: { notes: Array<{ reason: string; count: number }> }, reason: string): number | undefined {
	return read.notes.find((entry) => entry.reason === reason)?.count;
}

/** Everything a read said it left behind, for assertions on the whole list. */
function reasons(read: { notes: Array<{ reason: string; count: number }> }): string[] {
	return read.notes.map((entry) => entry.reason);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("minimax: listing sessions", () => {
	test("a session is listed from its manifest, and its row supplies what the manifest does not", () => {
		const root = freshRoot();
		const dir = writeSession(root, {
			messages: [envelope("msg-1", "turn-1", user("hello"))],
			rows: [{ sessionId: "session-1", title: "Fix the parser", updatedAt: T0 + 90_000 }],
		});
		const listing = listMinimaxSessions(root);
		expect(listing.notes).toEqual([]);
		const found = listing.sessions[0];
		expect(found.sessionId).toBe("session-1");
		expect(found.dir).toBe(dir);
		expect(found.relativeDir).toBe(`${YEAR}/${MONTH}/${DAY}/${SESSION_DIR}`);
		expect(found.path).toBe(join(dir, "messages.jsonl"));
		expect(found.history).toBe("canonical");
		// The project directory, the title and the archived flag live only in the row:
		// the manifest is written once, when the directory is created, and knows
		// identity and paths and nothing else.
		expect(found.cwd).toBe(CWD);
		expect(found.title).toBe("Fix the parser");
		expect(found.archived).toBe(false);
		expect(found.kind).toBe("conversation");
		expect(found.sessionType).toBe("root");
		expect(found.parentSessionId).toBe("");
		// The manifest's own times, and the row's when it has a later one.
		expect(found.startedAt).toBe(T0);
		expect(found.updatedAt).toBe(T0 + 90_000);
	});

	test("the walk is the authority: no manifest, no conversation", () => {
		const root = freshRoot();
		writeSession(root, { id: "session-kept", messages: [envelope("msg-1", "turn-1", user("hello"))] });
		// A directory with history in it but no manifest is not a session this reader
		// can name — the manifest's `sessionId` is the only identity that survives
		// both writers, and inventing one from the directory name would invent a
		// session the tool itself does not have.
		writeSession(root, { id: "session-nameless", name: "11-00-00-000-session_x", manifest: null });
		// A manifest with no session id, and one whose creation time is a string: both
		// fail `isManifestIdentity`, and both are counted rather than guessed at.
		writeSession(root, {
			id: "session-bad",
			name: "12-00-00-000-session_y",
			manifest: { sessionId: 7 },
		});
		writeSession(root, {
			id: "session-odd",
			name: "13-00-00-000-session_z",
			manifest: { sessionId: "session-odd", createdAtMs: String(T0) },
		});
		// And a manifest with nothing behind it at all: there is no conversation here
		// to import, which is different from a conversation that cannot be read.
		writeSession(root, { id: "session-empty", name: "14-00-00-000-session_e" });

		const listing = listMinimaxSessions(root);
		expect(listing.sessions.map((session) => session.sessionId)).toEqual(["session-kept"]);
		expect(note(listing, "session directory with no readable manifest.json")).toBe(3);
		expect(note(listing, "session whose history files are gone")).toBe(1);
	});

	test("the tool's own list rules are applied when the row states them", () => {
		const root = freshRoot();
		const messages = [envelope("msg-1", "turn-1", user("hello"))];
		writeSession(root, { id: "session-ok", messages });
		writeSession(root, { id: "session-hidden", name: "11-00-00-000-a", messages });
		writeSession(root, { id: "session-peek", name: "12-00-00-000-b", messages });
		writeSession(root, { id: "session-task", name: "13-00-00-000-c", messages });
		writeSession(root, { id: "session-cron", name: "14-00-00-000-d", messages });
		writeSession(root, { id: "session-child", name: "15-00-00-000-e", messages });
		writeSession(root, { id: "session-archived", name: "16-00-00-000-f", messages });
		writeSession(root, { id: "session-rowless", name: "17-00-00-000-g", messages });
		writeRows(
			root,
			[
				{ sessionId: "session-hidden", visibility: "hidden" },
				{ sessionId: "session-peek", kind: "peek" },
				{ sessionId: "session-task", kind: "task" },
				{ sessionId: "session-cron", kind: "cron" },
				{ sessionId: "session-child", parentSessionId: "session-ok" },
				{ sessionId: "session-archived", archived: 1 },
				{ sessionId: "session-ok" },
			],
			"session-ok",
		);

		const listing = listMinimaxSessions(root);
		// Named, not counted: a filter that stopped working would otherwise show up as
		// "8 instead of 3" without saying which conversation was invented.
		expect(listing.sessions.map((session) => session.sessionId).sort()).toEqual([
			"session-archived",
			"session-ok",
			"session-rowless",
		]);
		expect(note(listing, "hidden session")).toBe(1);
		expect(note(listing, "internal session (peek)")).toBe(1);
		expect(note(listing, "internal session (task)")).toBe(1);
		expect(note(listing, "internal session (cron)")).toBe(1);
		expect(note(listing, "sub-session of another session")).toBe(1);
		// Archived is carried, not skipped: the user filed it away, and a migration
		// that dropped it would lose a conversation the user chose to keep.
		expect(listed(root, "session-archived").archived).toBe(true);
		// A session with no row is listed and counted: the directory and its history are
		// the record, and a missing row is a fact about the database.
		expect(note(listing, "session with no metadata row")).toBe(1);
		expect(listed(root, "session-rowless").cwd).toBe("");
	});

	test("a database that is not there, or not readable, costs titles and nothing else", () => {
		const root = freshRoot();
		const messages = [envelope("msg-1", "turn-1", user("hello"))];
		writeSession(root, { id: "session-1", messages });
		// No database at all: every session is still listed, and the report says what
		// was lost. A hidden or internal session slips through here, which is the price
		// of not guessing at a classification the walk cannot make.
		const absent = listMinimaxSessions(root);
		expect(absent.sessions.map((session) => session.sessionId)).toEqual(["session-1"]);
		expect(note(absent, "session metadata database not present (no titles or project directories)")).toBe(1);
		expect(note(absent, "hidden session")).toBeUndefined();

		// A file that is not a database: the same answer, with the other note.
		const corrupt = freshRoot();
		writeSession(corrupt, { id: "session-1", messages, rows: "corrupt" });
		const unreadable = listMinimaxSessions(corrupt);
		expect(unreadable.sessions.map((session) => session.sessionId)).toEqual(["session-1"]);
		expect(note(unreadable, "session metadata database not readable (no titles or project directories)")).toBe(1);
		expect(listed(corrupt).title).toBe("");
		// Nothing was created beside it: the reader opens the database and never makes one.
		expect(listed(corrupt).cwd).toBe("");
	});

	test("the canonical file wins over the released pair, and the newest session is first", () => {
		const root = freshRoot();
		const canonical = writeSession(root, {
			id: "session-both",
			messages: [envelope("msg-1", "turn-1", user("from the canonical file"))],
			ledger: [`{"sessionId":"session-both","seq":1,"eventId":"e1","kind":"message.pi_history_appended"}`],
			rows: [{ sessionId: "session-both", updatedAt: T0 + 5_000 }],
		});
		writeSession(root, {
			id: "session-legacy",
			name: "11-00-00-000-older",
			snapshot: legacySnapshot("session-legacy", [user("from the snapshot")]),
			rows: [{ sessionId: "session-legacy", updatedAt: T0 + 1_000 }],
		});
		const listing = listMinimaxSessions(root);
		// Recency is the row's, with the session id breaking ties, which is the tool's
		// own ordering: a history limit then means the sessions last used.
		expect(listing.sessions.map((session) => session.sessionId)).toEqual(["session-both", "session-legacy"]);
		expect(listing.sessions[0].path).toBe(join(canonical, "messages.jsonl"));
		expect(listing.sessions[0].history).toBe("canonical");
		expect(listing.sessions[1].history).toBe("legacy");
		expect(textOf(messagesOf(minimaxRead(root, "session-both").entries)[0])).toBe("from the canonical file");
	});

	test("a manifest that states no update time is dated by its creation time", () => {
		const root = freshRoot();
		// The manifest is written when the directory is made and updated in place, and
		// the reader falls back to the creation time when it carries no update time at
		// all (`readManifest`, `:275`): a session that was never touched is as old as it
		// is, not ageless.
		writeSession(root, {
			manifest: { createdAtMs: T0 - 60_000, updatedAtMs: undefined },
			messages: [envelope("msg-1", "turn-1", user("hello"))],
		});
		const found = listed(root);
		expect(found.updatedAt).toBe(T0 - 60_000);
		// The same instant, from the field that is always there.
		expect(found.startedAt).toBe(T0 - 60_000);
	});

	test("two sessions the same age are ordered by their ids, as the tool's own index orders them", () => {
		const root = freshRoot();
		// The tool's index is `updated_at_ms DESC` with the session id breaking ties
		// (`:244-247`), so two sessions last used in the same instant still come back in
		// one order rather than in whatever order the walk happened to find them. The
		// fixture directory names run the other way round, so the tie-break is what puts
		// them in this order.
		writeSession(root, {
			id: "session-zz",
			name: "10-00-00-000-zz",
			messages: [envelope("msg-1", "turn-1", user("zz"))],
		});
		writeSession(root, {
			id: "session-aa",
			name: "11-00-00-000-aa",
			messages: [envelope("msg-1", "turn-1", user("aa"))],
		});
		expect(listMinimaxSessions(root).sessions.map((session) => session.sessionId)).toEqual([
			"session-aa",
			"session-zz",
		]);
	});

	test("a row whose visibility is empty is not a hidden session", () => {
		const root = freshRoot();
		// An empty visibility is not "hidden" but "not stated", which is what the
		// tool's own predicate reads it as (`:210`): the column is newer than some of
		// the rows beside it, and a session the tool still lists is not dropped from the
		// import for a column it never had.
		writeSession(root, {
			rows: [{ sessionId: "session-1", visibility: "" }],
			messages: [envelope("msg-1", "turn-1", user("here"))],
		});
		const listing = listMinimaxSessions(root);
		expect(listing.sessions.map((session) => session.sessionId)).toEqual(["session-1"]);
		expect(note(listing, "hidden session")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// The canonical file
// ---------------------------------------------------------------------------

describe("minimax: folding a canonical session", () => {
	test("a session folds to the messages the model saw, with their usage and their ending", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("what is here?")),
				envelope(
					"msg-2",
					"turn-1",
					assistant({
						content: [
							{ type: "thinking", thinking: "let me look", thinkingSignature: "sig-abc" },
							{ type: "text", text: "looking" },
							{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" }, thoughtSignature: "s" },
						],
						stopReason: "toolUse",
					}),
				),
				envelope("msg-3", "turn-1", toolResult("call-1", { content: [{ type: "text", text: "a.txt" }] })),
				envelope("msg-4", "turn-2", user("thanks")),
				envelope("msg-5", "turn-2", assistant({ content: [{ type: "text", text: "welcome" }] })),
			],
		});
		const read = minimaxRead(root);
		expect(read.notes).toEqual([]);
		const messages = messagesOf(read.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
		expect(messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "what is here?" }],
			timestamp: T0 + 1000,
		});
		const first = messages[1];
		if (first.role !== "assistant") throw new Error("expected an assistant message");
		expect(first.provider).toBe("minimax");
		expect(first.model).toBe("MiniMax-M2");
		// The four buckets the two builds share; `cost` and `totalTokens` are derived
		// numbers in the source and have no field here.
		expect(first.usage).toEqual({ input: 10, output: 4, cacheRead: 2, cacheWrite: 1 });
		expect(first.stopReason).toBe("toolUse");
		// Thinking text is carried; a provider signature is not, because the provider a
		// resumed session talks to is in no position to verify another one's blob.
		expect(first.content[0]).toEqual({ type: "thinking", thinking: "let me look" });
		expect(Object.hasOwn(first.content[0], "signature")).toBe(false);
		// `arguments` is raw JSON text here and an object in the source: the adapters
		// never parse partial JSON, so the text is what the target stores.
		expect(first.content[2]).toEqual({
			type: "toolCall",
			id: "call-1",
			name: "bash",
			arguments: '{"command":"ls"}',
		});
		const result = messages[2];
		if (result.role !== "toolResult") throw new Error("expected a tool result");
		expect(result.toolCallId).toBe("call-1");
		expect(result.toolName).toBe("bash");
		expect(result.isError).toBe(false);
		expect(result.timestamp).toBe(T0 + 3000);
	});

	test("a compaction boundary is the head of the import, not a message", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-9", {
					role: "compactionSummary",
					summary: "The user is fixing a parser.",
					tokensBefore: 41_000,
					timestamp: T0 + 500,
				}),
				envelope("msg-2", "turn-9", user("carry on")),
			],
		});
		const read = minimaxRead(root);
		expect(kindsOf(read.entries)).toEqual(["compaction", "message"]);
		expect(read.entries[0]).toEqual({
			kind: "compaction",
			summary: "The user is fixing a parser.",
			preTokens: 41_000,
		});
		// The boundary is a marker the file *starts* with, and the import says so: a
		// reader of the session can see that it is a continuation.
		expect(messagesOf(read.entries).length).toBe(1);
		expect(read.notes).toEqual([]);
	});

	test("the older Archon marker is a boundary too, and its summary is what survives", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-4", {
					role: "user",
					content: [{ type: "text", text: "the transcript before this is gone" }],
					archonCompaction: { schemaVersion: 1, summary: "Compacted at generation 3." },
					timestamp: T0 + 500,
				}),
				envelope("msg-2", "turn-4", user("and now?")),
			],
		});
		const read = minimaxRead(root);
		expect(read.entries[0]).toEqual({
			kind: "compaction",
			summary: "Compacted at generation 3.",
			// An Archon marker records no pre-compaction token count, and a guess would
			// be worse than the zero the entry states.
			preTokens: 0,
		});
		expect(kindsOf(read.entries)).toEqual(["compaction", "message"]);
	});

	test("a summary that states only a role and its text is a boundary, not a malformed message", () => {
		const root = freshRoot();
		// The minimal form of a compaction summary is exactly `{role, summary}` — the
		// two fields the tool requires, and nothing else allowed beside them
		// (`:537-543`). It is what a writer records when it has no token count to
		// state, and a reader that insisted on the larger form would refuse the whole
		// session rather than lose the boundary.
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-9", { role: "compactionSummary", summary: "The user is fixing a parser." }),
				envelope("msg-2", "turn-9", user("carry on")),
			],
		});
		const read = minimaxRead(root);
		expect(read.entries[0]).toEqual({
			kind: "compaction",
			summary: "The user is fixing a parser.",
			// Nothing recorded how large the context was, and the entry says zero
			// rather than a number this reader made up.
			preTokens: 0,
		});
		expect(kindsOf(read.entries)).toEqual(["compaction", "message"]);
		expect(read.notes).toEqual([]);
	});

	test("the harness's own turn configuration and the archive marker are counted, not carried", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello"), {
					// The system prompt and the model the tool ran the turn with: the
					// tool's own scaffolding, not the user's conversation.
					turn_config: {
						system_prompt: "You are MiniMax Code.",
						model: { provider: "minimax", model: "MiniMax-M2" },
						tools: [{ tool_name: "bash", description: "run", schema: { type: "object" } }],
					},
					history_artifact: {
						schemaVersion: 1,
						generation: 2,
						producedBy: "tool_trim",
						parentSnapshot: {
							generation: 1,
							compactionId: "c-1",
							revision: `sha256:${"a".repeat(64)}`,
						},
					},
				}),
				envelope("msg-2", "turn-1", assistant()),
			],
		});
		const read = minimaxRead(root);
		expect(read.notes).toEqual([
			{ reason: "turn configuration (system prompt and model)", count: 1 },
			{ reason: "message whose earlier tool results the tool archived", count: 1 },
		]);
		// The message itself survives whole: the config is dropped from beside it, not
		// the message the config was attached to.
		expect(textOf(messagesOf(read.entries)[0])).toBe("hello");
	});

	test("a tool pairing that never finished is repaired, and the text the user saw is kept", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("start something long")),
				envelope(
					"msg-2",
					"turn-1",
					assistant({
						content: [
							{ type: "text", text: "running the build" },
							{ type: "toolCall", id: "call-lost", name: "bash", arguments: { command: "make" } },
						],
						stopReason: "toolUse",
					}),
				),
			],
		});
		const read = minimaxRead(root);
		// The tool's own read of a session the user quit mid-run keeps that message and
		// reports no issue for it; the target, though, refuses a transcript holding a
		// call with no result, so the call goes and the sentence stays. The count is
		// what tells the report how much of the tail never returned.
		expect(note(read, "unpaired tool call or result")).toBe(1);
		expect(kindsOf(read.entries)).toEqual(["message", "message"]);
		const last = messagesOf(read.entries)[1];
		if (last.role !== "assistant") throw new Error("expected an assistant message");
		expect(last.content).toEqual([{ type: "text", text: "running the build" }]);
		expect(last.stopReason).toBe("toolUse");
	});

	test("an assistant turn that held nothing but the lost call is dropped whole", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("go")),
				envelope(
					"msg-2",
					"turn-1",
					assistant({ content: [{ type: "toolCall", id: "call-lost", name: "bash", arguments: {} }] }),
				),
			],
		});
		const read = minimaxRead(root);
		// An assistant message with no content is not a valid message at all: the repair
		// drops both the call and the turn that held only it.
		expect(note(read, "unpaired tool call or result")).toBe(2);
		expect(messagesOf(read.entries).length).toBe(1);
		expect(textOf(messagesOf(read.entries)[0])).toBe("go");
	});

	test("an orphan tool result is repaired away rather than refusing the session", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				envelope("msg-2", "turn-1", assistant()),
				// A result whose call was dropped upstream: the tool's own recovery lists
				// this as `orphan-tool-result` and drops it, and a reader that refused
				// instead would lose a conversation the tool still opens.
				envelope("msg-3", "turn-1", toolResult("call-gone")),
				envelope("msg-4", "turn-2", user("still here")),
			],
		});
		const read = minimaxRead(root);
		expect(note(read, "unpaired tool call or result")).toBe(1);
		expect(messagesOf(read.entries).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
	});

	test("a call and a result with no identity are dropped, and both are counted", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("go")),
				envelope(
					"msg-2",
					"turn-1",
					assistant({
						content: [
							{ type: "text", text: "calling" },
							{ type: "toolCall", name: "bash", arguments: {} },
						],
					}),
				),
				envelope("msg-3", "turn-1", toolResult("")),
			],
		});
		const read = minimaxRead(root);
		// Neither half can be paired with anything: a call the target cannot name is one
		// whose result it cannot match, and the result names no call at all.
		expect(note(read, "tool call with no identity")).toBe(1);
		expect(note(read, "tool result with no call identity")).toBe(1);
		expect(messagesOf(read.entries).map((message) => message.role)).toEqual(["user", "assistant"]);
		// And both are gone *before* the pairing repair runs. The repair is for a
		// transcript the tool's own writer left half-written, so a result this reader
		// decided to drop must not be dropped again by the repair: that would mean the
		// fold handed on a transcript the target refuses, and the reader would be
		// reporting the repair's work as its own.
		expect(note(read, "unpaired tool call or result")).toBeUndefined();
	});

	test("a result with nothing in it still says something, so the target accepts it", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("go")),
				envelope(
					"msg-2",
					"turn-1",
					assistant({ content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] }),
				),
				envelope("msg-3", "turn-1", toolResult("call-1", { content: [], isError: true })),
			],
		});
		const read = minimaxRead(root);
		const result = messagesOf(read.entries)[2];
		if (result.role !== "toolResult") throw new Error("expected a tool result");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "(no output recorded)" }]);
		expect(read.notes).toEqual([]);
	});

	test("a reason this build has not been taught is read from the content the turn ended on", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("go")),
				// A reason from a vocabulary this build has never seen, on a turn whose
				// content called a tool. The derivation is not "this build does not know,
				// so it stopped": a call is an unfinished turn, and reading the ending
				// from the blocks that are there is what every source without a reason
				// field does — including this product's own older writer.
				envelope(
					"msg-2",
					"turn-1",
					assistant({
						content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
						stopReason: "somethingBrandNew",
					}),
				),
				envelope("msg-3", "turn-1", toolResult("call-1")),
			],
		});
		const read = minimaxRead(root);
		expect(note(read, "unknown stop reason (somethingBrandNew)")).toBe(1);
		const turn = messagesOf(read.entries)[1];
		if (turn.role !== "assistant") throw new Error("expected an assistant message");
		expect(turn.stopReason).toBe("toolUse");
	});

	test("what this build cannot carry is counted and named, and never invented", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", {
					role: "user",
					content: [
						{ type: "text", text: "look at this" },
						{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
						{ type: "image", mimeType: "image/png", url: "https://example.invalid/a.png" },
					],
					timestamp: tick(),
				}),
				envelope(
					"msg-2",
					"turn-1",
					assistant({
						content: [
							{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "encrypted" },
							{ type: "text", text: "seen" },
							{ type: "video", url: "https://example.invalid/v.mp4" },
						],
						// A stop reason from a vocabulary this build has not been taught:
						// counted, and the answer is read from the content instead.
						stopReason: "somethingNew",
					}),
				),
				envelope("msg-3", "turn-2", {
					role: "custom",
					content: [{ type: "text", text: "host-only bookkeeping" }],
					timestamp: tick(),
				}),
			],
		});
		const read = minimaxRead(root);
		// The image with bytes is carried; the one that is a place to fetch from is not,
		// because a transcript is not where a migration starts doing network I/O.
		const first = messagesOf(read.entries)[0];
		if (first.role !== "user" || typeof first.content === "string") throw new Error("expected user blocks");
		expect(first.content).toEqual([
			{ type: "text", text: "look at this" },
			{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
		]);
		expect(note(read, "image with no inline data")).toBe(1);
		// Redacted reasoning is the provider's payload in the signature field: nothing a
		// resumed session could send back.
		expect(note(read, "reasoning block that carried no text")).toBe(1);
		expect(note(read, "assistant content this build does not carry (video)")).toBe(1);
		expect(note(read, "message of a role this build does not carry (custom)")).toBe(1);
		expect(note(read, "unknown stop reason (somethingNew)")).toBe(1);
		const assistantTurn = messagesOf(read.entries)[1];
		if (assistantTurn.role !== "assistant") throw new Error("expected an assistant message");
		// No call survived, so the ending is read from what is there.
		expect(assistantTurn.stopReason).toBe("stop");
		expect(assistantTurn.content).toEqual([{ type: "text", text: "seen" }]);
		expect(reasons(read)).toEqual([
			"image with no inline data",
			"reasoning block that carried no text",
			"assistant content this build does not carry (video)",
			"unknown stop reason (somethingNew)",
			"message of a role this build does not carry (custom)",
		]);
	});

	test("a user message whose whole content is the empty string carries no blocks", () => {
		const root = freshRoot();
		// pi writes a user message's content as a string or as blocks, and the empty
		// string is a message that was sent with nothing in it: the target's content is
		// a list, so it is the empty list rather than one empty text block (`:1245`).
		writeSession(root, {
			messages: [envelope("msg-1", "turn-1", { role: "user", content: "", timestamp: tick() })],
		});
		const read = minimaxRead(root);
		const message = messagesOf(read.entries)[0];
		if (message.role !== "user") throw new Error("expected a user message");
		expect(message.content).toEqual([]);
	});

	test("an assistant turn whose text holds nothing does not reach the transcript", () => {
		const root = freshRoot();
		// An empty text block is a block the writer recorded and never filled in, and
		// the reader does not carry it (`:1258-1259`). The turn then holds nothing at
		// all, and an empty content array is not a message: the target's own repair
		// drops it, so nothing of that turn is imported.
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				envelope("msg-2", "turn-1", assistant({ content: [{ type: "text", text: "" }] })),
			],
		});
		const read = minimaxRead(root);
		expect(messagesOf(read.entries).map((message) => message.role)).toEqual(["user"]);
	});

	test("a redacted reasoning block is left behind even when it carries text", () => {
		const root = freshRoot();
		// A redacted block is one whose payload the provider encrypted into the
		// signature field, and the `thinking` written beside it is not that payload: a
		// resumed session talks to a provider that never issued the blob, so the block
		// goes whatever text came with it (`:1300-1306`). The turn then holds nothing,
		// and the count says the block was seen and left behind rather than missed.
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				envelope(
					"msg-2",
					"turn-1",
					assistant({
						content: [{ type: "thinking", thinking: "the payload", redacted: true, thinkingSignature: "encrypted" }],
					}),
				),
			],
		});
		const read = minimaxRead(root);
		expect(messagesOf(read.entries).map((message) => message.role)).toEqual(["user"]);
		expect(note(read, "reasoning block that carried no text")).toBe(1);
	});

	test("an abort is a reason this build knows rather than one it has to guess at", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				envelope("msg-2", "turn-1", assistant({ stopReason: "aborted" })),
			],
		});
		const read = minimaxRead(root);
		const turn = messagesOf(read.entries)[1];
		if (turn.role !== "assistant") throw new Error("expected an assistant message");
		// The user stopped the turn, and the ending is part of the transcript: reading
		// it as a plain stop would tell a resumed session that the turn had finished
		// (`:1417-1426`).
		expect(turn.stopReason).toBe("aborted");
		expect(note(read, "unknown stop reason (aborted)")).toBeUndefined();
	});

	test("an image that names no MIME type is not carried as one", () => {
		const root = freshRoot();
		// The target's image block is the bytes and the type together, and a type the
		// block does not state is not one this reader may guess (`:1396-1404`):
		// counted, dropped, and the text beside it kept.
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", {
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", data: "aGVsbG8=" },
					],
					timestamp: tick(),
				}),
			],
		});
		const read = minimaxRead(root);
		const message = messagesOf(read.entries)[0];
		if (message.role !== "user" || typeof message.content === "string") throw new Error("expected user blocks");
		expect(message.content).toEqual([{ type: "text", text: "look" }]);
		expect(note(read, "image with no inline data")).toBe(1);
	});

	test("a tool result written as a plain string is the text it holds", () => {
		const root = freshRoot();
		// A tool result's content is blocks under the current writer and a plain string
		// under the older one, and both mean the same thing to the model (`:1364-1366`):
		// the string is the block it stands for, not a result with no content.
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				envelope(
					"msg-2",
					"turn-1",
					assistant({ content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] }),
				),
				envelope("msg-3", "turn-1", toolResult("call-1", { content: "the output" })),
			],
		});
		const read = minimaxRead(root);
		const result = messagesOf(read.entries)[2];
		if (result.role !== "toolResult") throw new Error("expected a tool result");
		expect(result.content).toEqual([{ type: "text", text: "the output" }]);
	});
});

describe("minimax: refusals, where the tool refuses", () => {
	test("a malformed line refuses the session and names the line but not its text", () => {
		const root = freshRoot();
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				"{not json at all",
				envelope("msg-3", "turn-1", assistant()),
			],
		});
		// The reason names the line and the failure rather than quoting the line back:
		// a history line holds whatever the user typed, and a migration that echoed it
		// into a report would move it somewhere nobody asked for it to be.
		expect(refusal(root)).toBe("canonical history is malformed at line 2: invalid JSON");
	});

	test("a blank line is malformed wherever it is, and the writer's own newline is not one", () => {
		const root = freshRoot();
		writeSession(root, {
			id: "session-blank",
			name: "10-30-00-000-blank",
			messages: [envelope("msg-1", "turn-1", user("hello")), "", envelope("msg-3", "turn-1", assistant())],
		});
		expect(refusal(root, "session-blank")).toBe("canonical history is malformed at line 2: blank line");

		// `readJsonl` drops exactly one trailing empty string — the newline the writer
		// put after the last record — and calls every other blank line malformed, the
		// empty line after a complete record included. A file with a record cut in half
		// cannot arise here either: `appendJsonl` writes whole lines and adds the line
		// boundary itself when the file it is appending to lacks one.
		writeSession(root, {
			id: "session-blank-end",
			name: "11-00-00-000-blank-end",
			messages: [envelope("msg-1", "turn-1", user("hello")), ""],
		});
		expect(refusal(root, "session-blank-end")).toBe("canonical history is malformed at line 2: blank line");

		// The ordinary file — one record and the writer's newline — reads.
		writeSession(root, {
			id: "session-ok",
			name: "12-00-00-000-ok",
			messages: [envelope("msg-1", "turn-1", user("hello"))],
		});
		expect(messagesOf(minimaxRead(root, "session-ok").entries).length).toBe(1);
	});

	test("a line of nothing but spaces is a blank line, not malformed JSON", () => {
		const root = freshRoot();
		// The blank-line rule is the *trimmed* line (`:440`), because a writer that
		// pads its records leaves exactly that behind. Which of the two it is decides
		// what the report says, and the difference is the report's whole point: a blank
		// line is a fact about how the file was written, while a parse failure would
		// name a line that only looks broken.
		writeSession(root, {
			messages: [envelope("msg-1", "turn-1", user("hello")), "   ", envelope("msg-3", "turn-1", assistant())],
		});
		expect(refusal(root)).toBe("canonical history is malformed at line 2: blank line");
	});

	test("an envelope the reader does not understand refuses the session", () => {
		const root = freshRoot();
		const cases: Array<[string, string]> = [
			[
				"envelope contains unsupported key something_new",
				JSON.stringify({
					message_id: "msg-1",
					turn_id: "turn-1",
					message: user("hello"),
					something_new: true,
				}),
			],
			["message_id must match msg-.+ or contain only digits", envelope("mavis-1", "turn-1", user("hello"))],
			["turn_id must be a non-empty string", envelope("msg-1", "   ", user("hello"))],
			[
				"message.timestamp must be finite",
				envelope("msg-1", "turn-1", { role: "user", content: [], timestamp: "yesterday" }),
			],
			["message.role must be a non-empty string", envelope("msg-1", "turn-1", { content: [], timestamp: T0 })],
			[
				"turn_config is allowed only on user messages",
				envelope("msg-1", "turn-1", assistant(), {
					turn_config: { system_prompt: "s", model: { provider: "p", model: "m" } },
				}),
			],
			["turn_config is malformed", envelope("msg-1", "turn-1", user("hello"), { turn_config: { system_prompt: 5 } })],
			[
				"history_artifact is malformed",
				envelope("msg-1", "turn-1", user("hello"), { history_artifact: { schemaVersion: 1 } }),
			],
			[
				"minimal message.compactionSummary must contain only role and summary",
				envelope("msg-1", "turn-1", { role: "compactionSummary", summary: "s", extra: 1 }),
			],
			[
				"message.compactionSummary.tokensBefore must be a non-negative safe integer",
				envelope("msg-1", "turn-1", {
					role: "compactionSummary",
					summary: "s",
					tokensBefore: 1.5,
					timestamp: T0,
				}),
			],
		];
		for (const [index, [reason, line]] of cases.entries()) {
			const id = `session-bad-${index}`;
			writeSession(root, { id, messages: [line], name: `10-30-00-000-bad${index}` });
			const read = readMinimaxSession(listed(root, id));
			if (!("error" in read)) throw new Error(`accepted: ${line}`);
			// The reason names the rule that was broken rather than only that something
			// was, which is what lets the report explain itself.
			expect(read.error.endsWith(reason)).toBe(true);
			expect(read.error.startsWith("canonical history envelope is invalid at line 1: ")).toBe(true);
		}
	});

	test("a sequence the tool refuses is refused here, and named record by record", () => {
		const root = freshRoot();
		// An identity used twice makes a message unaddressable; a tool-call identity
		// used twice makes a result ambiguous. Both fail in the tool's own recovery
		// invariants, which is the point at which repairing stops.
		writeSession(root, {
			id: "session-dup",
			name: "10-30-00-000-dup",
			messages: [envelope("msg-1", "turn-1", user("hello")), envelope("msg-1", "turn-1", assistant(), {})],
		});
		expect(refusal(root, "session-dup")).toBe(
			"canonical history sequence is invalid at record 2: duplicate message identity msg-1",
		);

		writeSession(root, {
			id: "session-dup-call",
			name: "11-00-00-000-dup-call",
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				envelope(
					"msg-2",
					"turn-1",
					assistant({ content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] }),
				),
				envelope("msg-3", "turn-1", toolResult("call-1")),
				envelope(
					"msg-4",
					"turn-1",
					assistant({ content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] }),
				),
			],
		});
		expect(refusal(root, "session-dup-call")).toBe(
			"canonical history sequence is invalid at record 4: duplicate tool call identity call-1",
		);

		// A compaction boundary anywhere but the first record contradicts the file's own
		// layout: a compaction replaces the file, so a marker in the middle claims a
		// replacement the records around it do not show.
		writeSession(root, {
			id: "session-late",
			name: "12-00-00-000-late",
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				envelope("msg-2", "turn-2", {
					role: "compactionSummary",
					summary: "s",
					tokensBefore: 10,
					timestamp: T0,
				}),
			],
		});
		expect(refusal(root, "session-late")).toBe(
			"canonical history sequence is invalid at record 2: compaction boundary must be the unique first message",
		);

		// An Archon marker whose generation chain does not line up: the tool validates
		// the chain rather than trusting either number, and so does this reader.
		writeSession(root, {
			id: "session-chain",
			name: "13-00-00-000-chain",
			messages: [
				envelope("msg-1", "turn-1", {
					role: "user",
					content: [{ type: "text", text: "compacted" }],
					archonCompaction: {
						schemaVersion: 2,
						generation: 4,
						parentSnapshot: {
							generation: 2,
							compactionId: "c-2",
							revision: `sha256:${"b".repeat(64)}`,
						},
					},
					timestamp: T0,
				}),
			],
		});
		expect(refusal(root, "session-chain")).toBe(
			"canonical history sequence is invalid at record 1: Archon compaction generation chain is malformed",
		);
	});

	test("an archive marker on any record but the first is refused", () => {
		const root = freshRoot();
		// The marker describes the *file*, not a message in it, so a second one claims a
		// lineage the records around it do not show.
		const artifact = {
			schemaVersion: 1,
			generation: 2,
			producedBy: "tool_trim",
			parentSnapshot: { generation: 1, compactionId: "c-1", revision: `sha256:${"a".repeat(64)}` },
		};
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello"), { history_artifact: artifact }),
				envelope("msg-2", "turn-1", assistant(), { history_artifact: artifact }),
			],
		});
		expect(refusal(root)).toBe(
			"canonical history sequence is invalid at record 2: history artifact marker must be attached only to the first envelope",
		);
	});

	test("a turn configuration on the wrong message of its turn is refused", () => {
		const root = freshRoot();
		// A `turn_config` is a system prompt: attached to the second user message of a
		// turn it no longer describes the turn it was recorded with, and the tool fails
		// closed on exactly this rather than moving it.
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello")),
				envelope("msg-2", "turn-1", assistant()),
				envelope("msg-3", "turn-1", user("again"), {
					turn_config: { system_prompt: "s", model: { provider: "p", model: "m" } },
				}),
			],
		});
		expect(refusal(root)).toBe(
			"canonical history sequence is invalid at record 3: turn_config must be attached only to the first user message of turn turn-1",
		);
	});

	test("a turn configuration carrying a key this reader has not been taught is refused", () => {
		const root = freshRoot();
		// `turn_config` records the system prompt and the model a turn ran with, and
		// `TURN_CONFIG_KEYS` is exact (`:559-567`): an extra key means a writer whose
		// configuration this reader does not fully know, and the session is refused
		// rather than imported with a prompt it cannot account for.
		writeSession(root, {
			messages: [
				envelope("msg-1", "turn-1", user("hello"), {
					turn_config: { system_prompt: "s", model: { provider: "p", model: "m" }, something_new: true },
				}),
			],
		});
		expect(refusal(root)).toBe("canonical history envelope is invalid at line 1: turn_config is malformed");
	});
});

// ---------------------------------------------------------------------------
// The released pair
// ---------------------------------------------------------------------------

describe("minimax: replaying the released ledger", () => {
	test("the snapshot is the state at the watermark, and the events after it are replayed", () => {
		const root = freshRoot();
		writeSession(root, {
			snapshot: {
				...legacySnapshot("session-1", [
					user("what is here?"),
					assistant({ content: [{ type: "text", text: "a snapshot" }] }),
				]),
				// The watermark says the snapshot already accounts for the first event.
				watermark: { sessionId: "session-1", lastSeq: 1, lastEventId: "e1", updatedAtMs: T0, byteOffset: 0 },
			},
			ledger: [
				// At the watermark, so it is *not* replayed: doing so would duplicate the
				// message the snapshot already holds.
				legacyEvent(1, "message.pi_history_appended", [user("already counted")]),
				legacyEvent(2, "message.pi_history_appended", [assistant({ content: [{ type: "text", text: "appended" }] })]),
				// A retraction carries the whole history it leaves behind, so it *replaces*
				// the list — the snapshot included — rather than trimming a tail.
				legacyEvent(3, "message.pi_history_replaced", [
					user("what is here?"),
					assistant({ content: [{ type: "text", text: "rewritten" }] }),
				]),
				legacyEvent(4, "message.pi_history_appended", [assistant({ content: [{ type: "text", text: "after" }] })]),
			],
		});
		const read = minimaxRead(root);
		expect(read.notes).toEqual([]);
		expect(messagesOf(read.entries).map((message) => textOf(message))).toEqual(["what is here?", "rewritten", "after"]);
	});

	test("a delete empties the history, and a session with no conversation reads empty", () => {
		const root = freshRoot();
		// A snapshot's messages are cleared by the event that says they were deleted; the
		// transcript is empty, which is the state the tool shows.
		writeSession(root, {
			snapshot: legacySnapshot("session-1", [assistant({ content: [{ type: "text", text: "gone" }] })]),
			ledger: [legacyEvent(1, "message.state_deleted")],
		});
		expect(minimaxRead(root).entries).toEqual([]);

		// Neither file says a conversation ever happened: the tool's `isAuthoritative`
		// gate says a session is a session only when something in it says so, and the
		// answer is an empty transcript rather than a refusal — nothing is wrong with it,
		// it just never had a conversation.
		writeSession(root, {
			id: "session-quiet",
			name: "11-00-00-000-quiet",
			snapshot: { ...legacySnapshot("session-quiet", []), piHistoryFacts: false },
			ledger: [`{"sessionId":"session-quiet","seq":1,"eventId":"e1","kind":"session.created","createdAtMs":${T0}}`],
		});
		const quiet = minimaxRead(root, "session-quiet");
		expect(quiet.entries).toEqual([]);
		expect(note(quiet, "legacy history with no conversation record")).toBe(1);

		// The retraction spelling the earlier writer used, which is the same rule under a
		// second name: the event carries the history it leaves behind, so the snapshot is
		// superseded rather than appended to.
		writeSession(root, {
			id: "session-retracted",
			name: "13-00-00-000-retracted",
			snapshot: legacySnapshot("session-retracted", [user("the original question")]),
			ledger: [
				legacyEvent(1, "message.turn_retracted", [user("the retracted turn")], {
					sessionId: "session-retracted",
				}),
			],
		});
		expect(messagesOf(minimaxRead(root, "session-retracted").entries).map((message) => textOf(message))).toEqual([
			"the retracted turn",
		]);
	});

	test("a half-written last line is not damage, and identical duplicates are not either", () => {
		const root = freshRoot();
		writeSession(root, {
			snapshot: legacySnapshot("session-1", [user("start")]),
			// An append that died mid-write, with no newline after it: the tool cuts the
			// text at the last newline rather than calling the ledger corrupt, and so does
			// this reader. The bytes are written as they would be found, because a writer
			// that terminated the line would be testing a different rule.
			ledgerRaw: `${legacyEvent(1, "message.pi_history_appended", [user("one")])}\n{"sessionId":"session-1","seq":2,"eventId":"e2","kind":"message.pi_histor`,
		});
		expect(messagesOf(minimaxRead(root).entries).map((message) => textOf(message))).toEqual(["start", "one"]);

		// The same event twice — a replay after a crash — is dropped, not replayed twice,
		// and the event the snapshot already accounts for is not part of the tail. The
		// record is built once and written twice, because "the same event" means the same
		// bytes: an event re-serialised later has a later timestamp in its messages and is
		// a *conflicting* duplicate, which is a refusal rather than a drop.
		const duplicated = freshRoot();
		const repeated = user("two");
		writeSession(duplicated, {
			snapshot: {
				...legacySnapshot("session-1", [user("start")]),
				watermark: { sessionId: "session-1", lastSeq: 1, lastEventId: "e1", updatedAtMs: T0, byteOffset: 0 },
			},
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("already in the snapshot")]),
				legacyEvent(2, "message.pi_history_appended", [repeated]),
				legacyEvent(2, "message.pi_history_appended", [repeated]),
			],
		});
		expect(messagesOf(minimaxRead(duplicated).entries).map((message) => textOf(message))).toEqual(["start", "two"]);

		// Two *different* events claiming one sequence: the ledger does not say which
		// happened, and both the tail read and the recovery refuse rather than pick.
		writeSession(root, {
			id: "session-conflict",
			name: "12-00-00-000-conflict",
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("one")], { sessionId: "session-conflict" }),
				legacyEvent(2, "message.pi_history_appended", [user("two")], { sessionId: "session-conflict" }),
				legacyEvent(2, "message.pi_history_appended", [user("and something else")], {
					sessionId: "session-conflict",
					eventId: "e9",
				}),
			],
		});
		expect(refusal(root, "session-conflict")).toBe(
			"legacy history could not be read (the ledger has a conflicting duplicate at sequence 2) and could not be recovered from its ledger (the ledger has a conflicting duplicate at sequence 2)",
		);
	});

	test("a ledger line that is not an event refuses the session, and names the line only", () => {
		const root = freshRoot();
		// Every line of the ledger has to be an event: a record with no sequence, no
		// identity, no kind, or one that belongs to another session is not an event this
		// reader can place, and a line it cannot place is refused whole rather than
		// guessed at. The line number is named and the line's own text is not, because a
		// ledger line can hold whatever the user typed.
		writeSession(root, {
			id: "session-line",
			name: "17-00-00-000-line",
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("one")], { sessionId: "session-line" }),
				// JSON, and not an event: it names no `kind`.
				JSON.stringify({ sessionId: "session-line", seq: 2, eventId: "e2" }),
			],
		});
		expect(refusal(root, "session-line")).toContain("the ledger event at line 2 is corrupt");

		// A message event with no messages to carry: the record says a conversation was
		// appended and then does not carry one, which is a ledger the tool refuses too.
		writeSession(root, {
			id: "session-nolist",
			name: "18-00-00-000-nolist",
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("one")], { sessionId: "session-nolist" }),
				legacyEvent(2, "message.pi_history_appended", undefined, { sessionId: "session-nolist" }),
			],
		});
		expect(refusal(root, "session-nolist")).toContain("the ledger event e2 has no messages");
	});

	test("a corrupt snapshot is recovered from, and a gap is not", () => {
		const root = freshRoot();
		// The snapshot is a cache over the ledger, so a snapshot that cannot be read is
		// recovered from by replaying the ledger from its first sequence.
		writeSession(root, {
			snapshot: { schemaVersion: 1, sessionId: "session-1" },
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("one")]),
				legacyEvent(2, "message.pi_history_appended", [assistant({ content: [{ type: "text", text: "two" }] })]),
			],
		});
		expect(messagesOf(minimaxRead(root).entries).map((message) => textOf(message))).toEqual(["one", "two"]);

		// A gap is not: the events after a missing one cannot be positioned, and neither
		// the tail read nor the complete-ledger recovery will guess.
		writeSession(root, {
			id: "session-gap",
			name: "11-00-00-000-gap",
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("one")], { sessionId: "session-gap" }),
				legacyEvent(3, "message.pi_history_appended", [user("three")], { sessionId: "session-gap" }),
			],
		});
		expect(refusal(root, "session-gap")).toBe(
			"legacy history could not be read (the ledger is incomplete at sequence 2) and could not be recovered from its ledger (the ledger is incomplete at sequence 2)",
		);

		// A watermark past the end of the ledger is a state the tool refuses to read and
		// recovers from; with the ledger itself starting at sequence 4, the recovery has no
		// first sequence to accept either, so the session is refused with both reasons.
		writeSession(root, {
			id: "session-shrunk",
			name: "12-00-00-000-shrunk",
			snapshot: {
				...legacySnapshot("session-shrunk", [user("from the snapshot")]),
				watermark: {
					sessionId: "session-shrunk",
					lastSeq: 9,
					lastEventId: "e9",
					updatedAtMs: T0,
					byteOffset: 999,
				},
			},
			ledger: [legacyEvent(4, "message.pi_history_appended", [user("later")], { sessionId: "session-shrunk" })],
		});
		const shrunk = refusal(root, "session-shrunk");
		expect(shrunk).toContain("the snapshot watermark exceeds the ledger");
		expect(shrunk).toContain("the ledger is incomplete at sequence 1");

		// Recovering from the complete ledger is only worth doing when the ledger holds a
		// conversation: a ledger of session bookkeeping with no Pi-history fact in it says
		// nothing about what the user saw, so the recovery refuses rather than reporting a
		// session with an empty transcript and no explanation.
		writeSession(root, {
			id: "session-factless",
			name: "13-00-00-000-factless",
			snapshot: { schemaVersion: 1, sessionId: "session-factless" },
			ledger: [legacyEvent(1, "session.created", [user("not a conversation")], { sessionId: "session-factless" })],
		});
		const factless = refusal(root, "session-factless");
		expect(factless).toContain("the snapshot is corrupt");
		expect(factless).toContain("the complete ledger contains no conversation record");
	});

	test("a snapshot wrong in one field is corrupt, and the ledger is believed instead", () => {
		// `readLegacySnapshot` is all-or-nothing, and each case below is a snapshot that
		// is complete and plausible except for one field: a schema this reader has not
		// been taught, another session's name, and a snapshot that says it was deleted
		// and still carries the messages of the session it says was deleted. None is a
		// snapshot with one odd field to be half-believed — each is damage, and the
		// ledger is the conversation the reader falls back to.
		const root = freshRoot();
		writeSession(root, {
			id: "session-schema",
			name: "14-00-00-000-schema",
			snapshot: { ...legacySnapshot("session-schema", [user("from the snapshot")]), schemaVersion: 2 },
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("from the ledger")], { sessionId: "session-schema" }),
			],
		});
		expect(messagesOf(minimaxRead(root, "session-schema").entries).map((message) => textOf(message))).toEqual([
			"from the ledger",
		]);

		// The name on the payload is what the reader asked for; the name on the
		// snapshot's own copy is a different session, so this is not this session's
		// cache of itself.
		writeSession(root, {
			id: "session-other",
			name: "15-00-00-000-other",
			snapshot: { ...legacySnapshot("session-other", [user("from the snapshot")]), sessionId: "someone-else" },
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("from the ledger")], { sessionId: "session-other" }),
			],
		});
		expect(messagesOf(minimaxRead(root, "session-other").entries).map((message) => textOf(message))).toEqual([
			"from the ledger",
		]);

		// A deleted session has no messages: the tool clears them when it deletes, so a
		// snapshot that says both is two halves that contradict each other.
		writeSession(root, {
			id: "session-deleted",
			name: "16-00-00-000-deleted",
			snapshot: { ...legacySnapshot("session-deleted", [user("from the snapshot")]), deleted: true },
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("from the ledger")], { sessionId: "session-deleted" }),
			],
		});
		expect(messagesOf(minimaxRead(root, "session-deleted").entries).map((message) => textOf(message))).toEqual([
			"from the ledger",
		]);
	});

	test("events are replayed in sequence order, whatever order the file holds them in", () => {
		const root = freshRoot();
		// A ledger is appended to concurrently and its lines are not guaranteed to be in
		// sequence order, which is why the tool sorts before replaying: the order the
		// model saw is the order the conversation has.
		writeSession(root, {
			ledger: [
				legacyEvent(3, "message.pi_history_appended", [assistant({ content: [{ type: "text", text: "third" }] })]),
				legacyEvent(1, "message.pi_history_appended", [user("first")]),
				legacyEvent(2, "message.pi_history_appended", [user("second")]),
			],
		});
		expect(messagesOf(minimaxRead(root).entries).map((message) => textOf(message))).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	test("the sequence decides the order, and the event id only breaks its ties", () => {
		const root = freshRoot();
		// The sort is `seq` first and the event id second (`:952`). An event id is
		// opaque, and a ledger whose ids run the other way from its sequence is a
		// ledger that would replay backwards under an id-first sort.
		writeSession(root, {
			ledger: [
				legacyEvent(1, "message.pi_history_appended", [user("first")], { eventId: "zz" }),
				legacyEvent(2, "message.pi_history_appended", [user("second")], { eventId: "aa" }),
			],
		});
		expect(messagesOf(minimaxRead(root).entries).map((message) => textOf(message))).toEqual(["first", "second"]);
	});

	test("a snapshot holding messages is a conversation, whatever its own flags say", () => {
		const root = freshRoot();
		// `isAuthoritative` is the tool's own question — is there anything here to read
		// (`:994-1001`) — and messages in the snapshot answer it yes on their own, even
		// when the facts flag beside them is false. That pair is what a snapshot written
		// by a build that recorded no facts looks like, and the conversation in it is
		// still the conversation.
		writeSession(root, {
			snapshot: { ...legacySnapshot("session-1", [user("still here")]), piHistoryFacts: false },
		});
		expect(messagesOf(minimaxRead(root).entries).map((message) => textOf(message))).toEqual(["still here"]);
	});

	test("a ledger that simply is not there is replayed from its snapshot alone", () => {
		const root = freshRoot();
		// `readLegacyLedgerTail` answers `undefined` for a missing file and its caller
		// reads that as no events — not as damage, and not as a cause for recovery — so a
		// session whose ledger was never written is still read.
		writeSession(root, {
			snapshot: legacySnapshot("session-1", [user("only the snapshot")]),
		});
		const read = minimaxRead(root);
		expect(messagesOf(read.entries).map((message) => textOf(message))).toEqual(["only the snapshot"]);
		expect(read.notes).toEqual([]);
	});

	test("a legacy message's identity and time are derived the way the tool derives them", () => {
		const root = freshRoot();
		writeSession(root, {
			snapshot: legacySnapshot("session-1", [
				// A bare message with no identity and no time: both are derived — the
				// identity from the record's own bytes, the time from the snapshot.
				{ role: "user", content: [{ type: "text", text: "no identity" }] },
				// A message with its own id in the spelling a canonical id may take, and a
				// string stamp the canonical decoder would reject: the stamp is normalized
				// from the string, which is the compatibility retry the tool added.
				{
					role: "assistant",
					content: [{ type: "text", text: "identified" }],
					id: "msg-9",
					timestamp: "2026-03-02T12:00:00.000Z",
				},
			]),
		});
		const first = minimaxRead(root);
		const messages = messagesOf(first.entries);
		expect(messages.length).toBe(2);
		// Reading the same bytes twice produces the same transcript, which is what makes a
		// re-run of the migration one transcript rather than two. The derived identity
		// itself is invisible here — the target has no field for it — so the derivation is
		// checked where it is observable, by the duplicate-identity refusal below.
		const again = minimaxRead(root);
		expect(JSON.stringify(again.entries)).toBe(JSON.stringify(first.entries));
		// The snapshot's own creation time for a message that does not carry one, and the
		// message's own stamp when it does: the offset from the snapshot's time is what
		// shows the stamp was read rather than replaced by the fallback.
		expect(messages[0].timestamp).toBe(T0);
		expect(messages[1].timestamp).toBe(Date.parse("2026-03-02T12:00:00.000Z"));
		expect(messages[1].timestamp).not.toBe(T0);
	});

	test("a legacy entry that is not a message refuses the session, and so does one with no time", () => {
		const root = freshRoot();
		// A `piHistory` holding a bare number: the tool hands every entry to the canonical
		// decoder, which refuses anything that is not a plain object, so the session fails
		// to open there — and it is refused here rather than quietly imported without it.
		writeSession(root, {
			id: "session-stray",
			name: "11-00-00-000-stray",
			snapshot: legacySnapshot("session-stray", [{ role: "user", content: [{ type: "text", text: "fine" }] }, 42]),
		});
		expect(refusal(root, "session-stray")).toBe("a legacy history message is invalid (message must be a plain object)");

		// A message with no stamp at all, in an event that carries no time either: the
		// canonical shape requires a finite stamp and this reader will not invent one — the
		// tool's fallback is the time of the thing the record came from, and there is none.
		writeSession(root, {
			id: "session-timeless",
			name: "12-00-00-000-timeless",
			ledger: [
				JSON.stringify({
					sessionId: "session-timeless",
					seq: 1,
					eventId: "e1",
					kind: "message.pi_history_appended",
					messages: [{ role: "user", content: [{ type: "text", text: "no time at all" }] }],
				}),
			],
		});
		expect(refusal(root, "session-timeless")).toBe(
			"a legacy history message is invalid (message.timestamp must be finite)",
		);
	});

	test("a legacy message that carries an identity keeps the one it carries", () => {
		const root = freshRoot();
		// Two messages bearing one explicit id: the identity a message carries is the one
		// the sequence is checked against, so this is a duplicate rather than two records
		// that happen to disagree. The id never reaches the target model, which is why the
		// assertion is on the refusal and not on the transcript.
		writeSession(root, {
			snapshot: legacySnapshot("session-1", [
				{ role: "user", content: [{ type: "text", text: "one" }], id: "msg-9" },
				{ role: "assistant", content: [{ type: "text", text: "two" }], id: "msg-9" },
			]),
		});
		expect(refusal(root)).toBe("canonical history sequence is invalid at record 2: duplicate message identity msg-9");
	});

	test("a legacy message whose own id is in another spelling has one derived for it", () => {
		const root = freshRoot();
		// An id is an identity only when it is spelled the way the canonical format
		// spells one (`legacyMessageId`, `:1161-1164`); anything else is a field the
		// legacy writer happened to carry, and reading it as an identity would let two
		// unrelated messages collide. The derived id is a digest of the record itself,
		// so both of these import — which is where the difference is observable, since
		// the derived identity does not reach the target model.
		writeSession(root, {
			snapshot: legacySnapshot("session-1", [
				{ role: "user", content: [{ type: "text", text: "one" }], id: "note" },
				{ role: "assistant", content: [{ type: "text", text: "two" }], id: "note" },
			]),
		});
		expect(messagesOf(minimaxRead(root).entries).map((message) => textOf(message))).toEqual(["one", "two"]);
	});
});

/**
 * A legacy event line, with its messages.
 *
 * The session id defaults to the fixtures' usual one and can be overridden through
 * `extra`, which is spread last; the same is true of every other field, so a test
 * about one rule can state only that rule's difference.
 */
function legacyEvent(
	seq: number,
	kind: string,
	messages?: Array<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		sessionId: "session-1",
		seq,
		eventId: `e${seq}`,
		kind,
		createdAtMs: T0 + seq * 1000,
		...(messages ? { messages } : {}),
		...extra,
	});
}

/** A released snapshot around a list of messages. */
function legacySnapshot(sessionId: string, piHistory: unknown[]): Record<string, unknown> {
	return {
		schemaVersion: 1,
		sessionId,
		snapshotId: "snap-1",
		createdAtMs: T0,
		watermark: { sessionId, lastSeq: 0, lastEventId: "", updatedAtMs: T0, byteOffset: 0 },
		displayMessages: [],
		piHistory,
		piHistoryFacts: piHistory.length > 0,
		deleted: false,
	};
}
