/**
 * What the T3 Code importer carries out of `state.sqlite`, and what it says
 * about what it does not.
 *
 * The database is written here — by the fixture, with `bun:sqlite` — against the
 * DDL T3 itself ships (`apps/server/src/persistence/Migrations/005_Projections.ts`,
 * plus `008`'s `sequence` column), and read by the production code with
 * `{readonly: true}`. Four rules shape the file:
 *
 *   - **listing is cheap and reading is not.** `t3SessionRows` selects no message
 *     text, so opening a session picker does not read every conversation; the
 *     messages of a thread are read only for the sessions actually chosen, which
 *     is the two-phase schedule every source here uses;
 *   - **a tool call is an activity row, not a message.** T3 records it in
 *     `projection_thread_activities` with a `tone`/`kind`/`summary`/`payload_json`
 *     shaped for its own UI, so an imported transcript carries the conversation
 *     and the report counts what was left behind. The count is the assertion: a
 *     reader that dropped the number would let a user find out by scrolling;
 *   - **reasoning folds into the answer it precedes.** `reasoning` is a role in
 *     the same message table (`OrchestrationMessageRole`,
 *     `packages/contracts/src/orchestration.ts:563-571`), and emitting it as its
 *     own turn would show a reply that stops to think and then says nothing;
 *   - **a thread with no directory is still offered.** `cwd` is required by
 *     `HistoryCandidate` and T3's thread row has no directory column of its own —
 *     it comes from a join, and a project registered before being opened has
 *     none. Such a thread is filed under T3's base directory and counted,
 *     because the alternative is a conversation the user can see in T3 that this
 *     importer reports as missing.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import { runMigration } from "../src/migrate.ts";
import { listHistory, readHistory } from "../src/migrate-history.ts";
import { T3_DEFAULT_DIR, t3StateDatabase } from "../src/t3-home.ts";
import { t3SessionMessages, t3SessionRows } from "../src/t3-read.ts";

/** The fixtures' clock: every timestamp below is counted from here. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

/**
 * Where a fixture's project `proj-a` lives: a real directory inside the
 * throwaway home, because a candidate whose directory is gone is dropped by
 * `narrowCandidates` before the reader under test is ever reached.
 */
function projectRoot(home: string, project = "proj-a"): string {
	return join(home, "work", project);
}

/** Temp homes, swept with the test that made them. */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Environment variables a test borrowed, restored after it. */
const borrowed = new Map<string, string | undefined>();
afterEach(() => {
	for (const [name, value] of borrowed) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	borrowed.clear();
});

function setEnv(name: string, value: string | undefined): void {
	if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * Every variable a source reads, so a developer's real home cannot decide an
 * outcome — including the two that name the home itself, which are borrowed for
 * the same reason.
 */
const TREE_ENV = [
	"T3CODE_HOME",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"CODEX_HOME",
	"CURSOR_CONFIG_DIR",
	"CURSOR_DATA_DIR",
	"DSH_HOME",
	"GROK_HOME",
	"KIMI_CODE_HOME",
	"KIMI_SHARE_DIR",
	"MAVIS_DATA_DIR",
	"MINIMAX_DATA_DIR",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_DB",
	"STEP_CODING_AGENT_DIR",
	"STEP_CODING_AGENT_SESSION_DIR",
	"STEPCODE_CONFIG_DIR",
	"STEPCODE_STORAGE_ROOT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"ZCODE_DATA_BASE_DIR",
	"ZCODE_SESSION_DB",
	"ZCODE_SESSION_DB_PATH",
	"ZCODE_STORAGE_DIR",
];

/** A thread, as a fixture writes it. */
interface ThreadFixture {
	id: string;
	project?: string;
	title?: string;
	worktreePath?: string | null;
	/** Overrides the project row's `workspace_root`, to write a recorded-but-empty one. */
	workspaceRoot?: string | null;
	createdAt?: string;
	deletedAt?: string | null;
}

/** A message, as a fixture writes it. */
interface MessageFixture {
	thread: string;
	role: string;
	text: string;
	createdAt: string;
	streaming?: number;
}

/** An activity row, as a fixture writes it. */
interface ActivityFixture {
	thread: string;
	tone: string;
	kind: string;
	summary: string;
	createdAt: string;
}

interface DatabaseFixture {
	threads?: ThreadFixture[];
	messages?: MessageFixture[];
	activities?: ActivityFixture[];
}

/** The projections T3's own migration creates, verbatim where the reader names them. */
const DDL = [
	`CREATE TABLE projection_projects (
		project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
		default_model TEXT, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL, deleted_at TEXT
	)`,
	`CREATE TABLE projection_threads (
		thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
		model TEXT NOT NULL, branch TEXT, worktree_path TEXT, latest_turn_id TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
	)`,
	`CREATE TABLE projection_thread_messages (
		message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL,
		text TEXT NOT NULL, is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE projection_thread_activities (
		activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, tone TEXT NOT NULL,
		kind TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
	)`,
	`CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL)`,
];

/**
 * A home with a T3 state directory and a projection database in it.
 *
 * A project is always written, because the reader's only source of a working
 * directory is the join to one — a fixture with threads and no projects would be
 * testing the inner half of a join that cannot happen. Its `workspace_root` is a
 * directory that **exists**: `narrowCandidates` drops a candidate whose directory
 * is gone (`migrate-history.ts:399-425`), which is the right rule for a real
 * install and would otherwise turn every test here into a test of that rule.
 */
function t3Home(fixture: DatabaseFixture = {}, subdir = "userdata"): { home: string; stateDir: string } {
	const home = mkdtempSync(join(tmpdir(), "lbb-t3-history-"));
	roots.push(home);
	for (const name of TREE_ENV) setEnv(name, undefined);
	const stateDir = join(home, T3_DEFAULT_DIR, subdir);
	mkdirSync(stateDir, { recursive: true });
	// `settings.json` so the tree is what T3 leaves behind rather than a database
	// alone, which no install has.
	writeFileSync(join(stateDir, "settings.json"), "{}");

	const db = new Database(t3StateDatabase(stateDir));
	try {
		for (const statement of DDL) db.run(statement);
		// One row per project, keyed by the threads' own `project`. A `workspaceRoot`
		// on any thread overrides that project's row, which is how a fixture writes a
		// project registered before it was ever opened in a directory.
		const projects = new Map<string, string | null>([["proj-a", null]]);
		for (const thread of fixture.threads ?? []) {
			const project = thread.project ?? "proj-a";
			projects.set(project, thread.workspaceRoot ?? null);
		}
		for (const [project, override] of projects) {
			mkdirSync(projectRoot(home, project), { recursive: true });
			db.run("insert into projection_projects values (?, ?, ?, ?, ?, ?, ?, ?)", [
				project,
				project,
				override ?? projectRoot(home, project),
				null,
				"[]",
				at(0),
				at(0),
				null,
			]);
		}
		let messageId = 0;
		for (const thread of fixture.threads ?? []) {
			db.run("insert into projection_threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
				thread.id,
				thread.project ?? "proj-a",
				thread.title ?? thread.id,
				"gpt-5.1",
				null,
				thread.worktreePath ?? null,
				null,
				thread.createdAt ?? at(0),
				at(0),
				thread.deletedAt ?? null,
			]);
		}
		for (const message of fixture.messages ?? []) {
			messageId += 1;
			db.run("insert into projection_thread_messages values (?, ?, ?, ?, ?, ?, ?, ?)", [
				`m${messageId}`,
				message.thread,
				null,
				message.role,
				message.text,
				message.streaming ?? 0,
				message.createdAt,
				message.createdAt,
			]);
		}
		let activityId = 0;
		for (const activity of fixture.activities ?? []) {
			activityId += 1;
			db.run("insert into projection_thread_activities values (?, ?, ?, ?, ?, ?, ?, ?)", [
				`a${activityId}`,
				activity.thread,
				null,
				activity.tone,
				activity.kind,
				activity.summary,
				"{}",
				activity.createdAt,
			]);
		}
	} finally {
		db.close();
	}
	return { home, stateDir };
}

/** The note a reader wrote for one reason, or undefined when it wrote none. */
function note(read: { notes: Array<{ reason: string; count: number }> }, fragment: string): number | undefined {
	return read.notes.find((entry) => entry.reason.includes(fragment))?.count;
}

/** The converted messages, in order. */
function messagesOf(entries: Array<{ kind: string; message?: AgentMessage }>): AgentMessage[] {
	return entries.flatMap((entry) => (entry.kind === "message" && entry.message ? [entry.message] : []));
}

/** Every text a message carries, so an assertion can look for a canary. */
function textOf(message: AgentMessage): string {
	return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("listing the threads", () => {
	/** Every listing in this file asks for everything, from any directory. */
	const listing = (home: string) => listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" });

	test("a thread is offered with the directory its project recorded", () => {
		const { home } = t3Home({ threads: [{ id: "th-1", title: "Fix the parser" }] });
		const found = listing(home);
		expect(found.candidates).toHaveLength(1);
		expect(found.candidates[0]).toMatchObject({
			source: "t3-code",
			sourceId: "th-1",
			title: "Fix the parser",
			// `projection_projects.workspace_root` — the thread row has no directory
			// of its own, so this join is the only place one can come from.
			cwd: projectRoot(home),
		});
		expect(found.candidates[0].startedAt).toBe(T0);
	});

	test("a thread whose project is gone is not offered, and that is stated", () => {
		// `narrowCandidates` drops a candidate whose directory no longer exists,
		// because the target file lives under a project named after that cwd and a
		// session in a deleted project cannot be resumed from anywhere. Saying so is
		// the difference between a project the user removed and data lost in a
		// migration.
		const { home } = t3Home({ threads: [{ id: "th-1" }] });
		rmSync(projectRoot(home), { recursive: true, force: true });
		const found = listing(home);
		expect(found.candidates).toEqual([]);
		expect(note(found, "working directory no longer exists")).toBe(1);
	});

	test("a worktree wins over the project root, because that is where the turn ran", () => {
		// A thread opened in a worktree ran in the worktree. Filing the transcript
		// under the project it belongs to would put it in a project `--continue` looks
		// in for a different directory.
		const { home } = t3Home({ threads: [{ id: "th-1" }] });
		const worktree = join(projectRoot(home), ".worktrees", "fix");
		mkdirSync(worktree, { recursive: true });
		const db = new Database(t3StateDatabase(join(home, T3_DEFAULT_DIR, "userdata")));
		db.run("update projection_threads set worktree_path = ?", [worktree]);
		db.close();

		expect(listing(home).candidates[0].cwd).toBe(worktree);
	});

	test("a thread whose project recorded no directory is listed under T3's base, and counted", () => {
		// A project can be registered before it is ever opened in a directory, and
		// `HistoryCandidate.cwd` is required. Dropping such a thread would report a
		// conversation the user can see in T3 as missing — so it is filed under the
		// base directory, which exists, and the count says how many needed that.
		const { home } = t3Home({ threads: [{ id: "th-nowhere", workspaceRoot: "" }] });
		const found = listing(home);
		expect(found.candidates).toHaveLength(1);
		expect(found.candidates[0].cwd).toBe(join(home, T3_DEFAULT_DIR));
		expect(note(found, "recorded no directory")).toBe(1);
		// And it is *not* counted as a missing directory: it never had one, and
		// telling the user to go looking for a directory T3 never recorded sends them
		// after something that was never there.
		expect(note(found, "working directory no longer exists")).toBeUndefined();
	});

	test("a soft-deleted thread is not offered, and an archived one still is", () => {
		// Deleted means the user threw it away; re-importing it would put back
		// something they removed. Archived is a view, not a deletion, and T3 has a
		// second listing for it — an archived conversation is still one they paid for.
		const { home, stateDir } = t3Home({
			threads: [{ id: "th-live" }, { id: "th-archived" }, { id: "th-gone", deletedAt: at(10) }],
		});
		const db = new Database(t3StateDatabase(stateDir));
		db.run("alter table projection_threads add column archived_at TEXT");
		db.run("update projection_threads set archived_at = ? where thread_id = 'th-archived'", [at(10)]);
		db.close();

		// The two survivors share a `created_at`, so their order is the id tiebreak
		// (see the next test) and the newest-first sort the picker applies.
		expect(listing(home).candidates.map((candidate) => candidate.sourceId)).toEqual(["th-archived", "th-live"]);
	});

	test("threads are listed newest first, and the id is the tiebreak for equal clocks", () => {
		// The picker sorts descending by start time (`narrowCandidates`,
		// `migrate-history.ts:433`), so the reader's own `ORDER BY` is not what the
		// user sees — it is what makes the *tie* stable. `created_at` is not unique,
		// and without the second key SQLite is free to return two identical runs in
		// different orders, which a session picker cannot distinguish from a bug.
		const { home } = t3Home({
			threads: [
				{ id: "th-c", createdAt: at(2) },
				{ id: "th-a", createdAt: at(1) },
				{ id: "th-b", createdAt: at(2) },
			],
		});
		const first = listing(home).candidates.map((candidate) => candidate.sourceId);
		const second = listing(home).candidates.map((candidate) => candidate.sourceId);
		expect(first).toEqual(["th-b", "th-c", "th-a"]);
		expect(second).toEqual(first);
	});

	test("listing reads no message text, so opening a picker costs the listing and not the history", () => {
		// The architecture is explicit about reading the conversation once, and only
		// for the sessions that were chosen. A listing that read `text` would make
		// the picker cost the whole history on a database that can hold a lot of it.
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [{ thread: "th-1", role: "user", text: "CANARY-IN-A-LISTING", createdAt: at(1) }],
		});
		expect(JSON.stringify(listing(home).candidates)).not.toContain("CANARY-IN-A-LISTING");
		expect(t3SessionRows(home)[0].title).toBe("th-1");
		expect(t3SessionMessages(home, "th-1")[0].text).toBe("CANARY-IN-A-LISTING");
	});

	test("tool activity is counted, because the transcript will not carry it", () => {
		// T3 records a tool call as an activity row, not as a message. The
		// conversation imports; the calls do not, and the report is the only place
		// that can say so before the user scrolls back and finds one.
		const { home } = t3Home({
			threads: [{ id: "th-1" }, { id: "th-2" }],
			activities: [
				{ thread: "th-1", tone: "tool", kind: "tool.started", summary: "Read file.ts", createdAt: at(1) },
				{ thread: "th-1", tone: "tool", kind: "tool.completed", summary: "Read file.ts", createdAt: at(2) },
				{ thread: "th-2", tone: "tool", kind: "tool.started", summary: "Bash", createdAt: at(1) },
				{ thread: "th-1", tone: "note", kind: "notice", summary: "checkpoint", createdAt: at(3) },
			],
		});
		// Three tool rows across two threads, and the non-tool row is not counted —
		// `tone = 'tool'` is what makes it a tool call.
		expect(note(listing(home), "tool activity row")).toBe(3);
		expect(t3SessionRows(home).map((row) => row.toolCount)).toEqual([2, 1]);
	});

	test("no tool rows means no note, because a zero is not information", () => {
		const { home } = t3Home({ threads: [{ id: "th-1" }] });
		expect(note(listing(home), "tool activity row")).toBeUndefined();
	});

	test("a database whose schema is from another build costs the conversations and nothing else", () => {
		// A T3 release that renamed a projection table should cost this importer its
		// history, not its settings — which is why the query is separately caught.
		const home = mkdtempSync(join(tmpdir(), "lbb-t3-badschema-"));
		roots.push(home);
		for (const name of TREE_ENV) setEnv(name, undefined);
		const stateDir = join(home, T3_DEFAULT_DIR, "userdata");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "settings.json"), '{"defaultRuntimeMode":"full-access"}');
		const db = new Database(t3StateDatabase(stateDir));
		db.run("create table projection_projects (project_id text primary key)");
		db.close();

		expect(listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates).toEqual([]);
		expect(t3SessionRows(home)).toEqual([]);
	});

	test("a state directory with no database lists nothing, and the file is not created", () => {
		// `new Database(path)` *creates* the file, so a reader that opened one
		// unconditionally would write to a tool the user is still running.
		const { home, stateDir } = t3Home({ threads: [{ id: "th-1" }] });
		rmSync(t3StateDatabase(stateDir), { force: true });
		for (const sibling of ["-wal", "-shm"]) rmSync(`${t3StateDatabase(stateDir)}${sibling}`, { force: true });
		expect(listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates).toEqual([]);
		expect(() => statSync(t3StateDatabase(stateDir))).toThrow();
	});

	test("--history-scope none reads nothing at all", () => {
		const { home } = t3Home({ threads: [{ id: "th-1" }] });
		expect(listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "none" })).toEqual({ candidates: [], notes: [] });
	});

	// -------------------------------------------------------------------------
	// The gate between this reader and the run
	// -------------------------------------------------------------------------

	test("a run asked for T3 history actually plans it", () => {
		// Every test above calls `listHistory`/`readHistory` directly, which is the
		// wrong level to prove this importer works: `runMigration` first asks
		// `historySourcePresent` whether the source is worth walking, and that gate
		// had no `t3-code` arm — it fell through to the *agents* source's `present`.
		// A T3 install with no agents tree therefore reported zero T3 sessions and
		// planned zero writes while every test in this file passed, because none of
		// them went through the gate. This is the test that goes through it.
		const { home } = t3Home({
			threads: [{ id: "th-1", title: "the thread" }],
			messages: [
				{ thread: "th-1", role: "user", text: "hello", createdAt: at(1) },
				{ thread: "th-1", role: "assistant", text: "hi", createdAt: at(2) },
			],
		});
		const result = runMigration({ home, from: "t3-code", only: ["history"], historyScope: "all", apply: false });
		expect(result.error).toBeUndefined();
		const writes = result.plan.writes.filter((write) => write.kind === "history");
		expect(writes).toHaveLength(1);
		expect(writes[0].content).toContain("hello");
		expect(result.plan.items.some((item) => item.action === "map")).toBe(true);
	});

	test("a home with no T3 tree plans no T3 history, and says the source is absent", () => {
		// The negative, so the arm added above cannot be "always true". An empty
		// throwaway home has no T3 tree, so the gate must answer false rather than
		// letting an unrelated source's presence stand in for this one.
		const home = mkdtempSync(join(tmpdir(), "lbb-t3-empty-"));
		roots.push(home);
		for (const name of TREE_ENV) setEnv(name, undefined);
		const result = runMigration({ home, from: "t3-code", only: ["history"], historyScope: "all", apply: false });
		expect(result.error).toBeUndefined();
		expect(result.plan.writes.filter((write) => write.kind === "history")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("reading a chosen thread", () => {
	test("the turns are the ones that were typed, in T3's own order", () => {
		// `ORDER BY created_at ASC, message_id ASC` is T3's ordering
		// (`ProjectionThreadMessages.ts:225`) and the second key is load-bearing:
		// two messages in the same millisecond would otherwise come back in
		// whatever order the index happened to yield.
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [
				{ thread: "th-1", role: "user", text: "second asked", createdAt: at(2) },
				{ thread: "th-1", role: "user", text: "first asked", createdAt: at(1) },
				{ thread: "th-1", role: "assistant", text: "first answered", createdAt: at(1) },
			],
		});
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const read = readHistory("t3-code", home, [candidate]);
		expect(read.sessions).toHaveLength(1);
		const messages = messagesOf(read.sessions[0].entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(messages.map((message) => textOf(message))).toEqual([
			expect.stringContaining("first asked"),
			expect.stringContaining("first answered"),
			expect.stringContaining("second asked"),
		]);
	});

	test("reasoning folds into the answer it precedes, rather than becoming its own turn", () => {
		// Emitting them separately would show a turn that stops to think and then
		// says nothing before a turn that answers a question already answered — the
		// same fold the four file-based sources do with their own thinking runs.
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [
				{ thread: "th-1", role: "user", text: "why?", createdAt: at(1) },
				{ thread: "th-1", role: "reasoning", text: "considering the parser", createdAt: at(2) },
				{ thread: "th-1", role: "assistant", text: "because of the grammar", createdAt: at(3) },
			],
		});
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const messages = messagesOf(readHistory("t3-code", home, [candidate]).sessions[0].entries);
		expect(messages).toHaveLength(2);
		expect(textOf(messages[1])).toContain("considering the parser");
		expect(textOf(messages[1])).toContain("because of the grammar");
		expect(messages[1].role).toBe("assistant");
	});

	test("several reasoning rows before one answer all fold into it", () => {
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [
				{ thread: "th-1", role: "reasoning", text: "step one", createdAt: at(1) },
				{ thread: "th-1", role: "reasoning", text: "step two", createdAt: at(2) },
				{ thread: "th-1", role: "assistant", text: "done", createdAt: at(3) },
			],
		});
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const messages = messagesOf(readHistory("t3-code", home, [candidate]).sessions[0].entries);
		expect(messages).toHaveLength(1);
		expect(textOf(messages[0])).toContain("step one");
		expect(textOf(messages[0])).toContain("step two");
	});

	test("a thinking run with no answer after it becomes its own message, not a dropped one", () => {
		// A turn interrupted mid-thought. Losing it would leave a transcript that
		// silently omits part of a turn it otherwise carries — the kind of gap nobody
		// notices until they try to resume the session.
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [
				{ thread: "th-1", role: "user", text: "go", createdAt: at(1) },
				{ thread: "th-1", role: "reasoning", text: "I was thinking about", createdAt: at(2) },
			],
		});
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const messages = messagesOf(readHistory("t3-code", home, [candidate]).sessions[0].entries);
		expect(messages).toHaveLength(2);
		expect(textOf(messages[1])).toContain("I was thinking about");
		expect(textOf(messages[1])).not.toContain('"type":"text"');
	});

	test("a thinking run followed by a new question is its own message too", () => {
		// The run belonged to the reply before it and that reply never landed, so
		// prepending it to the *next* turn's answer would attribute one turn's
		// thinking to another.
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [
				{ thread: "th-1", role: "user", text: "first", createdAt: at(1) },
				{ thread: "th-1", role: "reasoning", text: "abandoned", createdAt: at(2) },
				{ thread: "th-1", role: "user", text: "second", createdAt: at(3) },
				{ thread: "th-1", role: "assistant", text: "answering the second", createdAt: at(4) },
			],
		});
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const messages = messagesOf(readHistory("t3-code", home, [candidate]).sessions[0].entries);
		expect(messages).toHaveLength(4);
		expect(textOf(messages[1])).toContain("abandoned");
		expect(textOf(messages[3])).not.toContain("abandoned");
	});

	test("a system row is left out, because it is the other client's framing", () => {
		// A migration has already put the conversation in a different client, and
		// replaying another client's system preamble reads as though the assistant
		// had said it.
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [
				{ thread: "th-1", role: "system", text: "You are t3 code.", createdAt: at(0) },
				{ thread: "th-1", role: "user", text: "hi", createdAt: at(1) },
				{ thread: "th-1", role: "assistant", text: "hello", createdAt: at(2) },
			],
		});
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const read = readHistory("t3-code", home, [candidate]);
		expect(messagesOf(read.sessions[0].entries)).toHaveLength(2);
		expect(JSON.stringify(read.sessions[0].entries)).not.toContain("You are t3 code.");
	});

	test("a thread with no readable row is reported by why, not counted as empty", () => {
		// "Nothing to import" is a claim about the user's conversation, and this
		// reader is in no position to make it when the reason it holds nothing is
		// that there is nothing there in the roles it reads — T3 records a tool call
		// as an activity row, so a turn that was all tool calls looks like this.
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			activities: [{ thread: "th-1", tone: "tool", kind: "tool.started", summary: "Bash", createdAt: at(1) }],
		});
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const read = readHistory("t3-code", home, [candidate]);
		expect(read.sessions).toEqual([]);
		expect(note(read, "no user, assistant or reasoning rows")).toBe(1);
		// The generic count is for sessions that were *not* explained, and this one
		// was — so it must not also appear as a bare "nothing to import".
		expect(note(read, "session with nothing to import")).toBeUndefined();
	});

	test("only the chosen threads are read", () => {
		// The whole point of the two-phase schedule: a run that imports one session
		// must not pay to read the other ninety-nine.
		const { home } = t3Home({
			threads: [{ id: "th-1" }, { id: "th-2" }],
			messages: [
				{ thread: "th-1", role: "user", text: "CHOSEN", createdAt: at(1) },
				{ thread: "th-1", role: "assistant", text: "CHOSEN-ANSWER", createdAt: at(2) },
				{ thread: "th-2", role: "user", text: "NOT-CHOSEN", createdAt: at(1) },
				{ thread: "th-2", role: "assistant", text: "NOT-CHOSEN-ANSWER", createdAt: at(2) },
			],
		});
		const candidates = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const chosen = candidates.filter((candidate) => candidate.sourceId === "th-1");
		const read = readHistory("t3-code", home, chosen);
		expect(read.sessions).toHaveLength(1);
		expect(JSON.stringify(read.sessions)).toContain("CHOSEN-ANSWER");
		expect(JSON.stringify(read.sessions)).not.toContain("NOT-CHOSEN");
	});

	test("an empty message row is dropped rather than imported as a blank turn", () => {
		const { home } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [
				{ thread: "th-1", role: "user", text: "", createdAt: at(1) },
				{ thread: "th-1", role: "user", text: "real", createdAt: at(2) },
				{ thread: "th-1", role: "assistant", text: "answer", createdAt: at(3) },
			],
		});
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		const read = readHistory("t3-code", home, [candidate]);
		expect(messagesOf(read.sessions[0].entries)).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Reading is reading
// ---------------------------------------------------------------------------

describe("reading the database", () => {
	test("the database and its WAL siblings are byte-identical afterwards", () => {
		// `new Database(path)` without `{readonly: true}` creates the file when it is
		// absent and can write to it when it is not, and `state.sqlite` is open by a
		// live T3 server with a `-wal` beside it. The hashes are the proof, not the
		// absence of an exception.
		const { home, stateDir } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [
				{ thread: "th-1", role: "user", text: "hello", createdAt: at(1) },
				{ thread: "th-1", role: "assistant", text: "hi", createdAt: at(2) },
			],
		});
		const dbPath = t3StateDatabase(stateDir);
		const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		readHistory("t3-code", home, [candidate]);
		t3SessionRows(home);
		expect(createHash("sha256").update(readFileSync(dbPath)).digest("hex")).toBe(before);
		// A reader that opened it read-write would leave a `-wal` behind.
		expect(() => statSync(`${dbPath}-wal`)).toThrow();
	});

	test("the settings file beside the database is untouched by a history read", () => {
		const { home, stateDir } = t3Home({
			threads: [{ id: "th-1" }],
			messages: [{ thread: "th-1", role: "user", text: "hello", createdAt: at(1) }],
		});
		const path = join(stateDir, "settings.json");
		const before = createHash("sha256").update(readFileSync(path)).digest("hex");
		const [candidate] = listHistory("t3-code", home, { cwd: "C:\\anywhere", scope: "all" }).candidates;
		readHistory("t3-code", home, [candidate]);
		expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
	});
});
