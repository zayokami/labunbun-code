/**
 * What the `minimax-code` source carries out of `<root>/v2/sessions`, and what it
 * says about the rest.
 *
 * Four things shape this file.
 *
 * The first is that the walk is four directories deep. MiniMax files a session
 * under `v2/sessions/<year>/<month>/<day>/<HH-mm-ss-SSS>-session_<base64url>/`,
 * which is the *tool's own* discovery depth (`listManifestPaths` descends years,
 * months, days and then the session directories, `session-history-location.ts:189-202`),
 * so a fixture that put a session anywhere else would test a reader that does not
 * exist.
 *
 * The second is that the manifest is the authority and the database is a lookup.
 * A directory is a session when its `manifest.json` states a string `sessionId`
 * and a safe-integer `createdAtMs` (the tool's own guard, `isManifestIdentity`,
 * `session-history-location.ts:332`); everything else about it — title, project
 * directory, archived, and the three fields the tool's own list filters on —
 * comes from a read-only `local_runtime_sessions` row, and a session without one
 * is still a session. The tests below pin both halves of that, including what
 * happens when the database is not there at all.
 *
 * The third is that a session the tool hides or files under an internal kind is
 * counted and *named* rather than offered: the listing is where the user finds
 * out that something is not coming across, and a bare count would not say which.
 * The four kinds are `peek`, `task`, `channel` and `cron`; `cron` is excluded by
 * the tool's own list default and `peek` with it (`defaultExcludedKinds` returns
 * `['cron']`, `query-service.ts:231-233`, and the comment at `:139-141` says the
 * shared filter is what keeps both out).
 *
 * The fourth is the prompt list. MiniMax keeps none, and the reader says so with
 * an `absent` line instead of staying silent — a reader who asked for MiniMax
 * history is owed the distinction between "nothing there" and "no such thing".
 * The same run's other sources are unaffected, which is the other half of that
 * test.
 *
 * Fixtures hold fake values only, in a temp home. The source tree is read, never
 * written, and one test says so with a snapshot of it taken before and after.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import type { AgentMessage } from "@labunbun/ai";
import { detectSources, type RunMigrationResult, runMigration } from "../src/migrate.ts";
import { importedSessionId, listHistory, readHistory, readPromptHistory } from "../src/migrate-history.ts";
import { MINIMAX_DATA_DIR_ENV, MINIMAX_LEGACY_DATA_DIR_ENV } from "../src/minimax-home.ts";

/** The fixtures' clock. Every session below is created at or after it. */
const T0 = Date.parse("2026-03-01T00:00:00Z");

/** The directory the listing is asked about, for the `cwd` scope. */
const CWD = process.cwd();

/** Temp directories a test made, swept when it ends. */
const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

function writeFileAt(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/**
 * A home with a MiniMax tree, with the two variables that would otherwise decide
 * where the tree is borrowed away: a developer with `$MINIMAX_DATA_DIR` set would
 * have every fixture read from somewhere else, and one with `$MAVIS_DATA_DIR` set
 * would be handed a tree this test never wrote.
 *
 * `$CLAUDE_CONFIG_DIR` goes too, because one test puts a Claude Code history file
 * in the same home and asks for both sources in one run — a real value there
 * would point the other half of that run at the machine's own home.
 */
function minimaxHome(): { home: string; root: string } {
	const home = makeDir("lbb-mm-history-");
	setEnv(MINIMAX_DATA_DIR_ENV, undefined);
	setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, undefined);
	setEnv("CLAUDE_CONFIG_DIR", undefined);
	const root = join(home, ".minimax");
	mkdirSync(root, { recursive: true });
	return { home, root };
}

/** A directory that exists, so the cwd rules keep the sessions that name it. */
function projectDir(): string {
	return makeDir("lbb-mm-project-");
}

// ---------------------------------------------------------------------------
// Fixtures: the bytes and rows MiniMax writes
// ---------------------------------------------------------------------------

/** One canonical `messages.jsonl` line. */
function envelope(messageId: string, turnId: string, message: Record<string, unknown>): string {
	return JSON.stringify({ message_id: messageId, turn_id: turnId, message });
}

function user(text: string, at: number): Record<string, unknown> {
	return { timestamp: at, role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string, at: number): Record<string, unknown> {
	return {
		timestamp: at,
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "minimax",
		model: "MiniMax-M2",
		stopReason: "stop",
	};
}

interface SessionFixture {
	id?: string;
	/** The directory name under the day: `<HH-mm-ss-SSS>-session_<base64url>`. */
	name?: string;
	createdAt?: number;
	/** Envelope lines, joined and newline-terminated. */
	messages?: string[];
	/** Written verbatim instead of `messages`, for the malformed cases. */
	rawMessages?: string;
	/** Leave `messages.jsonl` out entirely, so the session has nothing to read. */
	noMessages?: boolean;
}

/**
 * One session, four levels deep, in the layout MiniMax's own walk descends:
 * `v2/sessions/<year>/<month>/<day>/<dir>/messages.jsonl`, with the manifest
 * beside it stating the id and the creation time.
 */
function writeSession(root: string, fixture: SessionFixture = {}): string {
	const dir = join(root, "v2", "sessions", "2026", "03", "01", fixture.name ?? "10-30-00-000-session_1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			sessionId: fixture.id ?? "session-1",
			createdAtMs: fixture.createdAt ?? T0,
			updatedAtMs: fixture.createdAt ?? T0,
		}),
	);
	if (fixture.noMessages) return dir;
	if (fixture.rawMessages !== undefined) writeFileSync(join(dir, "messages.jsonl"), fixture.rawMessages);
	else
		writeFileSync(
			join(dir, "messages.jsonl"),
			`${(fixture.messages ?? [envelope("msg-1", "turn-1", user("hi", T0 + 1000))]).join("\n")}\n`,
		);
	return dir;
}

interface RowFixture {
	sessionId: string;
	title?: string;
	cwd?: string;
	archived?: number;
	visibility?: string;
	kind?: string;
	parentSessionId?: string | null;
	updatedAt?: number;
}

/**
 * The read-only metadata table, as much of it as this reader selects.
 *
 * The database is written here — by the fixture, with `bun:sqlite` — and read by
 * the production code with `{readonly: true}`; the test that snapshots the tree
 * exists to prove the second half of that.
 */
function writeRows(root: string, rows: RowFixture[]): void {
	const path = join(root, "v2", "sqlite", "runtime-state.sqlite");
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	try {
		db.run(
			"create table if not exists local_runtime_sessions (session_id text, title text, workspace_dir text, archived integer, visibility text, session_kind text, session_type text, parent_session_id text, created_at_ms integer, updated_at_ms integer, history_relative_dir text)",
		);
		for (const row of rows) {
			db.run("insert into local_runtime_sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
				row.sessionId,
				row.title ?? "",
				row.cwd ?? "",
				row.archived ?? 0,
				row.visibility ?? "visible",
				row.kind ?? "conversation",
				"sessions",
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

// ---------------------------------------------------------------------------
// Reading the results
// ---------------------------------------------------------------------------

/** The note a reader wrote for one reason, or undefined when it wrote none. */
function note(read: { notes: Array<{ reason: string; count: number }> }, reason: string): number | undefined {
	return read.notes.find((entry) => entry.reason === reason)?.count;
}

/** The converted messages, in order, with any compaction entry left out. */
function messagesOf(entries: Array<{ kind: string; message?: AgentMessage }>): AgentMessage[] {
	return entries.flatMap((entry) => (entry.kind === "message" && entry.message ? [entry.message] : []));
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

/**
 * The session file a converted session is written to.
 *
 * The shape is `sessionFilePath`'s: `<home>/.labunbun/projects/<sanitized
 * cwd>/<id>.jsonl`, where the directory is the working directory with every
 * separator and drive colon folded to `-` (`sanitizeCwd`). Written out here
 * rather than called, so a change to either half is a failing test and not a
 * test that follows the change.
 */
function expectedHistoryPath(project: string, sourceId: string, home: string): string {
	return join(
		home,
		".labunbun",
		"projects",
		project.replace(/[:\\/]/g, "-"),
		`${importedSessionId("minimax-code", sourceId)}.jsonl`,
	);
}

/** The history writes of a run, as home-relative labels. */
function historyWrites(result: RunMigrationResult, home: string): string[] {
	return result.plan.writes
		.filter((write) => write.kind === "history")
		.map((write) => write.path.replace(/\\/g, "/").replace(home.replace(/\\/g, "/"), "~"))
		.sort();
}

/** Every file under a root, with its size, mtime and content digest. */
function snapshotTree(root: string): string[] {
	const lines: string[] = [];
	for (const entry of readdirSync(root, { recursive: true }).map(String).sort()) {
		const path = join(root, entry);
		const stat = statSync(path);
		const body = stat.isDirectory() ? "<dir>" : createHash("sha256").update(readFileSync(path)).digest("hex");
		lines.push(`${entry.replace(/\\/g, "/")} ${stat.size} ${stat.mtimeMs} ${body}`);
	}
	return lines;
}

function planItems(
	result: RunMigrationResult,
	from: string | RegExp,
): Array<{ action: string; detail: string; from: string }> {
	return result.plan.items.filter((item) => (typeof from === "string" ? item.from === from : from.test(item.from)));
}

describe("migrate: minimax session listing", () => {
	test("a session four levels deep is offered with its row's project, title and start", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-1" });
		writeRows(root, [{ sessionId: "session-1", title: "Fix the parser", cwd: project }]);
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		expect(listing.candidates).toHaveLength(1);
		const [candidate] = listing.candidates;
		expect(candidate.source).toBe("minimax-code");
		expect(candidate.sourceId).toBe("session-1");
		// The project directory and the title are the *row's*: the manifest does not
		// carry them, and a reader that invented them would file the session under the
		// wrong project.
		expect(candidate.cwd).toBe(project);
		expect(candidate.title).toBe("Fix the parser");
		// The start is the manifest's `createdAtMs`, not the row's `updated_at_ms`:
		// the manifest is what proves a directory is a session, and the time the user
		// sat down is the one this reader has.
		expect(candidate.startedAt).toBe(T0);
		expect(candidate.path).toBe(
			join(root, "v2", "sessions", "2026", "03", "01", "10-30-00-000-session_1", "messages.jsonl"),
		);
		expect(candidate.archived).toBeUndefined();
		// Nothing was wrong with this listing, so it says nothing: notes are for the
		// things that did not come across, and a listing that always had something to
		// report would train the user to ignore them.
		expect(listing.notes).toEqual([]);
	});

	test("a hidden session, an internal one and a sub-session are counted and named", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-ok", name: "09-00-00-000-ok" });
		writeSession(root, { id: "session-hidden", name: "10-00-00-000-hidden" });
		writeSession(root, { id: "session-sub", name: "11-00-00-000-sub" });
		// The four kinds `INTERNAL_SESSION_KINDS` holds, one session each, with a
		// directory apiece so each one is a session this reader would otherwise offer.
		const kinds = ["peek", "task", "channel", "cron"];
		kinds.forEach((kind, index) => {
			writeSession(root, { id: `session-${kind}`, name: `12-0${index}-00-000-${kind}` });
		});
		writeRows(root, [
			{ sessionId: "session-ok", title: "kept", cwd: project },
			{ sessionId: "session-hidden", visibility: "hidden", cwd: project },
			{ sessionId: "session-sub", parentSessionId: "session-ok", cwd: project },
			...kinds.map((kind) => ({ sessionId: `session-${kind}`, kind, cwd: project })),
		]);
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		// Only the conversation: the others are things the tool itself would not show
		// the user, and offering them would import transcripts the user never had.
		expect(listing.candidates.map((candidate) => candidate.sourceId)).toEqual(["session-ok"]);
		// Named, not just counted: "3 sessions skipped" would leave the user unable to
		// tell a hidden thread from a cron job.
		expect(note(listing, "hidden session")).toBe(1);
		expect(note(listing, "sub-session of another session")).toBe(1);
		for (const kind of kinds) expect(note(listing, `internal session (${kind})`)).toBe(1);
	});

	test("scope cwd keeps this project and counts the others", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-here", name: "09-00-00-000-here" });
		writeSession(root, { id: "session-there", name: "10-00-00-000-there" });
		writeRows(root, [
			{ sessionId: "session-here", cwd: CWD },
			{ sessionId: "session-there", cwd: project },
		]);
		const here = listHistory("minimax-code", home, { cwd: CWD, scope: "cwd" });
		expect(here.candidates.map((candidate) => candidate.sourceId)).toEqual(["session-here"]);
		// Counted rather than dropped in silence: a user who asked for this project's
		// history should be able to see that the other one exists.
		expect(note(here, 'another project (scope is "cwd")')).toBe(1);
		const all = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		expect(all.candidates.map((candidate) => candidate.sourceId).sort()).toEqual(["session-here", "session-there"]);
		expect(note(all, 'another project (scope is "cwd")')).toBeUndefined();
	});

	test("a session whose project is gone, and one that never had a project, are told apart", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-ok", name: "09-00-00-000-ok" });
		writeSession(root, { id: "session-gone", name: "10-00-00-000-gone" });
		writeRows(root, [
			{ sessionId: "session-ok", cwd: project },
			{ sessionId: "session-gone", cwd: join(project, "deleted-subdirectory") },
		]);
		rmSync(join(project, "deleted-subdirectory"), { recursive: true, force: true });
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		// Two different facts, two different notes: sending the user to look for a
		// project they deleted is recoverable, telling them about a directory they
		// never had is not.
		expect(note(listing, "working directory no longer exists")).toBe(1);
		expect(note(listing, "no working directory recorded")).toBeUndefined();
		expect(listing.candidates.map((candidate) => candidate.sourceId)).toEqual(["session-ok"]);
	});

	test("a session with no metadata row is listed, and counted", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-rowless", createdAt: T0 + 60_000 });
		writeRows(root, [{ sessionId: "someone-else", cwd: project }]);
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		// A manifest-only session has no project, so the cwd rules drop it — but it is
		// counted by the reason that actually applied to it, which is the row, not the
		// directory. The distinction is what tells the user their database, rather than
		// their disk, is what is out of step.
		expect(note(listing, "session with no metadata row")).toBe(1);
		expect(note(listing, "no working directory recorded")).toBe(1);
		expect(listing.candidates).toHaveLength(0);
	});

	test("with no metadata database the sessions are still found, and the cost is named", () => {
		const { home, root } = minimaxHome();
		writeSession(root, { id: "session-1" });
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		// No database: a missing file is not opened, because `new Database(path)`
		// *creates* it, and a migration that creates the file it is reading has
		// written to the user's tool.
		expect(note(listing, "session metadata database not present (no titles or project directories)")).toBe(1);
		// And the consequence is stated rather than hidden: without the row there is no
		// project directory, so nothing can be filed into the right project, and every
		// session is turned away by the cwd rule rather than imported into a guess.
		expect(note(listing, "no working directory recorded")).toBe(1);
		expect(listing.candidates).toHaveLength(0);
	});
});

describe("migrate: minimax session conversion", () => {
	test("a converted session resumes, and its turns are the ones that were typed", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, {
			id: "session-1",
			messages: [
				envelope("msg-1", "turn-1", user("what the user typed", T0 + 1000)),
				envelope("msg-2", "turn-1", assistant("what the model said", T0 + 2000)),
			],
		});
		writeRows(root, [{ sessionId: "session-1", title: "Fix the parser", cwd: project }]);
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		const read = readHistory("minimax-code", home, listing.candidates);
		expect(read.sessions).toHaveLength(1);
		expect(messagesOf(read.sessions[0]?.entries ?? []).map((message) => message.role)).toEqual(["user", "assistant"]);

		const result = runMigration({ home, from: "minimax-code", only: ["history"], historyScope: "all", apply: true });
		expect(result.error).toBeUndefined();
		// The target is the project the session ran in, named after the source session
		// so a second run is a no-op rather than a second copy of the conversation.
		expect(historyWrites(result, home)).toEqual([
			`~/.labunbun/projects/${project.replace(/[:\\/]/g, "-")}/${importedSessionId("minimax-code", "session-1")}.jsonl`,
		]);
		const path = result.plan.writes.find((write) => write.kind === "history")?.path ?? "";
		expect(path).toBe(expectedHistoryPath(project, "session-1", home));
		const store = SessionStore.load(path);
		const context = store.contextMessages();
		expect(context.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(context.map(textOf)).toEqual(["what the user typed", "what the model said"]);
		// The header is what makes the import a session rather than a pile of lines:
		// it carries the project the conversation belongs to and the time it started,
		// which is what `--continue` reads to find it again.
		const header = store.linearEntries()[0];
		expect(header.type === "header" && header.cwd).toBe(project);
		expect(header.type === "header" && header.createdAt).toBe(T0);
		expect(header.type === "header" && header.sessionId).toBe(importedSessionId("minimax-code", "session-1"));
		// The line the user reads: the title they gave it, the count of turns, and the
		// fact that this one can be picked up where it left off.
		const [item] = planItems(result, /^MiniMax Code session session-1/);
		expect(item.action).toBe("map");
		expect(item.detail).toBe("transcript with 2 entries — resumable with --continue");
		expect(planItems(result, "MiniMax Code session session-1 — Fix the parser")).toHaveLength(1);
	});

	test("a second run keeps the session it already wrote", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-1", messages: [envelope("msg-1", "turn-1", user("once", T0 + 1000))] });
		writeRows(root, [{ sessionId: "session-1", cwd: project }]);
		const first = runMigration({ home, from: "minimax-code", only: ["history"], historyScope: "all", apply: true });
		const path = expectedHistoryPath(project, "session-1", home);
		const bytes = readFileSync(path, "utf8");
		const second = runMigration({ home, from: "minimax-code", only: ["history"], historyScope: "all", apply: true });
		// Kept, and *said* to be kept: a run that quietly rewrote the file would break
		// the guarantee that ids are derived rather than generated, which is what makes
		// re-running safe.
		const [item] = planItems(second, /^MiniMax Code session session-1/);
		expect(item.action).toBe("skip");
		expect(item.detail).toBe("already imported — kept (use --force to overwrite)");
		expect(readFileSync(path, "utf8")).toBe(bytes);
		expect(first.plan.writes.filter((write) => write.kind === "history")).toHaveLength(1);
		expect(second.plan.writes.filter((write) => write.kind === "history")).toHaveLength(0);
	});

	test("reading the source leaves it exactly as it was", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, {
			id: "session-1",
			messages: [
				envelope("msg-1", "turn-1", user("a question", T0 + 1000)),
				envelope("msg-2", "turn-1", assistant("an answer", T0 + 2000)),
			],
		});
		writeRows(root, [{ sessionId: "session-1", title: "kept", cwd: project }]);
		const before = snapshotTree(root);
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		readHistory("minimax-code", home, listing.candidates);
		runMigration({ home, from: "minimax-code", only: ["history"], historyScope: "all", apply: true });
		// The whole tree — the manifest, the transcript and the sqlite database — is
		// byte-for-byte what it was, mtimes included: this importer reads the user's
		// running tool, and a read that touched it (a journal beside the database, a
		// rewritten manifest) would be a write to a live install.
		expect(snapshotTree(root)).toEqual(before);
	});

	test("a session the reader refused is reported by why, not as an empty one", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, {
			id: "session-malformed",
			name: "09-00-00-000-bad",
			rawMessages: "{not json}\n",
		});
		writeSession(root, { id: "session-unreadable", name: "10-00-00-000-unreadable", noMessages: true });
		// A directory where the transcript should be: the file exists, and cannot be
		// read as a file.
		mkdirSync(join(root, "v2", "sessions", "2026", "03", "01", "10-00-00-000-unreadable", "messages.jsonl"), {
			recursive: true,
		});
		writeRows(root, [
			{ sessionId: "session-malformed", cwd: project },
			{ sessionId: "session-unreadable", cwd: project },
		]);
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		const read = readHistory("minimax-code", home, listing.candidates);
		expect(read.sessions).toHaveLength(0);
		expect(note(read, "canonical history is malformed at line 1: invalid JSON")).toBe(1);
		expect(note(read, "canonical history file could not be read")).toBe(1);
		// And not the other thing: "nothing to import" is a claim about the user's
		// conversation, and a reader that could not open the file is in no position to
		// make it.
		expect(note(read, "session with nothing to import")).toBeUndefined();
		const result = runMigration({ home, from: "minimax-code", only: ["history"], historyScope: "all", apply: false });
		expect(planItems(result, "MiniMax Code history").map((item) => item.detail)).toEqual([
			"canonical history is malformed at line 1: invalid JSON — 1 turned away",
			"canonical history file could not be read — 1 turned away",
		]);
	});

	test("a session with nothing in it is counted as an empty one", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-empty", rawMessages: "" });
		writeRows(root, [{ sessionId: "session-empty", cwd: project }]);
		const listing = listHistory("minimax-code", home, { cwd: CWD, scope: "all" });
		const read = readHistory("minimax-code", home, listing.candidates);
		// An empty file is not a refusal: the reader opened it and it held nothing, so
		// the bare count is the honest report — the same file with a malformed line in
		// it would have produced a reason instead.
		expect(note(read, "session with nothing to import")).toBe(1);
		expect(read.notes).toHaveLength(1);
		const result = runMigration({ home, from: "minimax-code", only: ["history"], historyScope: "all", apply: false });
		expect(planItems(result, "MiniMax Code history").map((item) => item.detail)).toEqual([
			"session with nothing to import — 1 turned away",
		]);
		expect(result.plan.writes.filter((write) => write.kind === "history")).toHaveLength(0);
	});
});

describe("migrate: minimax prompt history", () => {
	test("a run says MiniMax keeps no prompt list, and says what it keeps instead", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-1", messages: [envelope("msg-1", "turn-1", user("a prompt", T0 + 1000))] });
		writeRows(root, [{ sessionId: "session-1", cwd: project }]);
		const prompts = readPromptHistory("minimax-code", home, { cwd: CWD, scope: "all", limit: 100 });
		expect(prompts.seen).toBe(0);
		expect(prompts.entries).toEqual([]);
		// The three things on disk that could be mistaken for a prompt list, each
		// ruled out by name: the drafts are text never sent, the sessions hold the
		// prompts (and come across as transcripts), and the shell's history is a file
		// MiniMax protects rather than reads.
		expect(prompts.absent).toContain("keeps no cross-session prompt list");
		expect(prompts.absent).toContain("its sessions hold the prompts themselves");
		expect(prompts.absent).toContain("its drafts hold text you never sent");
		expect(prompts.absent).toContain("shell history is a file it protects rather than reads");
		expect(prompts.absent).toContain("nothing was added to the ↑ recall list");

		const result = runMigration({ home, from: "minimax-code", only: ["history"], historyScope: "all", apply: false });
		// Exactly one item, and it is a skip with the explanation on it — not silence,
		// and not a silent absence either. A user who asked for MiniMax history and got
		// no line about prompts would have to guess whether the reader looked.
		const items = planItems(result, "MiniMax Code prompt history");
		expect(items).toHaveLength(1);
		expect(items[0]?.action).toBe("skip");
		// The reader types `absent` as optional, so the comparison goes through a plain
		// string; the five assertions above already pin that it is set (and they compare
		// the same text the planner put on the item).
		const absent = prompts.absent ?? "";
		expect(items[0]?.detail).toEqual(absent);
		// `toEqual` for the same reason as the line above: the found item is optional.
		const promptItem = result.plan.items.find((item) => item.from === "MiniMax Code prompt history");
		expect(promptItem?.to).toEqual("—");
		// Nothing was merged into the recall file, and the sessions are unaffected: the
		// prompts arrive inside their sessions, which is what the line says.
		expect(result.plan.writes.filter((write) => write.kind === "prompt-history")).toHaveLength(0);
		expect(result.plan.writes.filter((write) => write.kind === "history")).toHaveLength(1);
	});

	test("a source that does have prompt history still imports it in the same run", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-1", messages: [envelope("msg-1", "turn-1", user("a prompt", T0 + 1000))] });
		writeRows(root, [{ sessionId: "session-1", cwd: project }]);
		writeFileAt(
			join(home, ".claude", "history.jsonl"),
			`${[
				JSON.stringify({ display: "claude prompt here", project: CWD, timestamp: T0 + 5000 }),
				JSON.stringify({ display: "another claude prompt", project: CWD, timestamp: T0 + 6000 }),
			].join("\n")}\n`,
		);
		const result = runMigration({
			home,
			from: "minimax-code,claude-code",
			only: ["history"],
			historyScope: "all",
			apply: false,
		});
		// MiniMax's line is the same skip it was on its own: a source with no list does
		// not become a source with one because another source was asked for too.
		expect(planItems(result, "MiniMax Code prompt history")).toHaveLength(1);
		expect(planItems(result, "MiniMax Code prompt history")[0]?.action).toBe("skip");
		// And Claude Code's prompts are merged as usual — the absent line is per source,
		// not a decision about the run.
		const [claude] = planItems(result, "Claude Code prompt history");
		expect(claude.action).toBe("map");
		expect(claude.detail).toContain("2 prompt(s) added to the recall history");
		const write = result.plan.writes.find((candidate) => candidate.kind === "prompt-history");
		expect(write?.content).toContain("claude prompt here");
		expect(write?.content).toContain("another claude prompt");
		// The imported prompts go in ahead of whatever the user already had, so the
		// newest entries ↑ offers are the ones typed here.
		expect(write?.content.trimEnd().split("\n")).toHaveLength(2);
	});
});

describe("migrate: minimax source presence", () => {
	test("the session tree alone is enough, with no config.yaml", () => {
		const { home, root } = minimaxHome();
		const project = projectDir();
		writeSession(root, { id: "session-1", messages: [envelope("msg-1", "turn-1", user("hi", T0))] });
		writeRows(root, [{ sessionId: "session-1", cwd: project }]);
		// `historySourcePresent` asks only whether the root is there, because the deep
		// question is four directories down and the count that would answer it lives
		// behind a database this reader opens read-only, if at all. So a home with
		// sessions and no `config.yaml` is a source with history, which is what this
		// says — and the run without `--from` picks it up on the same grounds.
		expect(detectSources(home)).toContain("minimax-code");
		const all = runMigration({ home, only: ["history"], historyScope: "all", apply: false });
		expect(all.plan.sources).toContain("minimax-code");
		expect(all.plan.writes.filter((write) => write.kind === "history")).toHaveLength(1);
	});

	test("an existing but empty root is answered for when named, and skipped when not", () => {
		const { home } = minimaxHome();
		// Detection counts *content* — `sourceHasContent` is a `readdir` length — so a
		// root that exists and holds nothing is not a source a bare `migrate` touches.
		expect(detectSources(home)).not.toContain("minimax-code");
		const all = runMigration({ home, only: ["history"], historyScope: "all", apply: false });
		expect(all.plan.sources).not.toContain("minimax-code");
		// Naming it with `--from` is answered for instead, because presence here is
		// `existsSync(root)`: the tool's directory is on this machine and the user asked
		// about it outright. There is nothing to write and no session to offer, so what
		// is left is the two lines that do not depend on one existing.
		const named = runMigration({ home, from: "minimax-code", only: ["history"], historyScope: "all", apply: false });
		expect(named.error).toBeUndefined();
		expect(named.plan.sources).toEqual(["minimax-code"]);
		expect(named.plan.writes).toHaveLength(0);
		const froms = planItems(named, /^MiniMax Code/).map((item) => item.from);
		expect(froms).toHaveLength(2);
		expect(froms).toContain("MiniMax Code history");
		expect(froms).toContain("MiniMax Code prompt history");
		// The metadata note is a per-*listing* note: the reader bumps it once because
		// the database is absent (`bump`'s default of one), so the "1 turned away" is
		// the line's shape rather than a tally — with no session walked there is nothing
		// to tally. The same shape is what claude-code's auto-memory note has.
		expect(planItems(named, "MiniMax Code history")[0]?.detail).toBe(
			"session metadata database not present (no titles or project directories) — 1 turned away",
		);
	});
});
