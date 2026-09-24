/**
 * What the Kimi Code importer reads out of `$KIMI_CODE_HOME/sessions`, and what
 * it says about what it leaves behind.
 *
 * The fixtures are the records Kimi writes, in the spelling its own writer uses:
 * one `wire.jsonl` per agent under `agents/<agentId>/`, a `state.json` beside
 * it, and `session_index.jsonl` at the root. Two properties of that format shape
 * this file.
 *
 * The first is that the wire is a *journal*, not a transcript: a message is
 * several records (`step.begin`, then `content.part`, then `step.end`),
 * `context.undo` and `context.clear` rewrite a context the journal keeps, and
 * `context.apply_compaction` can land before or after the `full_compaction.begin`
 * record it belongs to. A reader that took the records at face value would
 * import turns the user rewound away and lose the ones they kept — so the tests
 * below pin the fold, record by record, rather than the happy path alone.
 *
 * The second is that most of what a wire holds is not conversation. A skip is
 * asserted with the count the report prints, because the reader's value is not
 * only that it keeps the conversation but that it says which parts of it were
 * left behind: an injected reminder, a `!` command, a subagent thread, a session
 * Kimi spawned for a task.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import {
	type KimiEntry,
	type KimiRead,
	type KimiSessionFile,
	listKimiSessions,
	readKimiSession,
} from "../src/kimi-session.ts";

/** The project the fixtures ran in; a session with no cwd is scoped nowhere. */
const CWD = process.cwd();

/** The fixtures' clock: every record below counts from here, one second apiece. */
const T0 = Date.parse("2026-03-01T00:00:00Z");

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

/** A throwaway Kimi Code home (`$KIMI_CODE_HOME`'s tree, without the variable). */
function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lbb-kimi-session-"));
	roots.push(root);
	return root;
}

// ---------------------------------------------------------------------------
// Fixtures: the bytes Kimi writes
// ---------------------------------------------------------------------------

/** The `metadata` record every wire opens with. */
function metadata(protocolVersion = "1.5"): string {
	return JSON.stringify({
		type: "metadata",
		time: tick(),
		protocol_version: protocolVersion,
		created_at: T0,
	});
}

/** One record of the journal. */
function record(body: Record<string, unknown>): string {
	return JSON.stringify({ time: tick(), ...body });
}

/** A message appended as context. */
function append(message: Record<string, unknown>): string {
	return record({ type: "context.append_message", message });
}

/** A user turn, with the `origin` the journal states for it. */
function user(text: string, extra: Record<string, unknown> = {}): string {
	return append({ role: "user", content: [{ type: "text", text }], ...extra });
}

/** A loop event: the records that make up an assistant turn. */
function loop(event: Record<string, unknown>): string {
	return record({ type: "context.append_loop_event", event });
}

function stepBegin(uuid: string): string {
	return loop({ type: "step.begin", uuid });
}

function stepEnd(uuid: string, options: { finishReason?: string; usage?: Record<string, number> } = {}): string {
	return loop({ type: "step.end", uuid, ...options });
}

function part(uuid: string, block: Record<string, unknown>): string {
	return loop({ type: "content.part", stepUuid: uuid, part: block });
}

function call(uuid: string, id: string, name: string, args: unknown): string {
	return loop({ type: "tool.call", stepUuid: uuid, toolCallId: id, name, args });
}

function result(id: string, body: Record<string, unknown>): string {
	return loop({ type: "tool.result", toolCallId: id, result: body });
}

/** An assistant turn in one go: text and calls inside a step the journal opened. */
function assistantStep(
	uuid: string,
	text: string,
	calls: Array<[string, string, unknown]> = [],
	usage?: Record<string, number>,
): string[] {
	return [
		stepBegin(uuid),
		...(text ? [part(uuid, { type: "text", text })] : []),
		...calls.map(([id, name, args]) => call(uuid, id, name, args)),
		stepEnd(uuid, usage === undefined ? {} : { usage }),
	];
}

interface SessionFixture {
	/** Directory under `sessions/`, i.e. the workspace bucket. */
	bucket?: string;
	id?: string;
	/** `state.json`; `null` writes none at all. */
	state?: Record<string, unknown> | null;
	/** `session-meta/state.json`, the legacy location, when a test wants it. */
	legacyState?: Record<string, unknown>;
	/** `agents/main/wire.jsonl` lines, joined with newlines and terminated. */
	lines?: string[];
	/** Other agents' wires, keyed by agent id. */
	otherAgents?: Record<string, string[]>;
	/** `session_index.jsonl` lines for the whole root. */
	index?: unknown[];
	/** Extra files in the session directory, keyed by relative path. */
	extra?: Record<string, string>;
}

/** Write one session directory the way Kimi lays one out. */
function writeSession(root: string, fixture: SessionFixture): string {
	const dir = join(root, "sessions", fixture.bucket ?? "wd_proj_abc123", fixture.id ?? "s-1");
	mkdirSync(dir, { recursive: true });
	if (fixture.state !== null) {
		writeFileSync(
			join(dir, "state.json"),
			JSON.stringify({ cwd: CWD, agents: { main: { type: "main" } }, ...(fixture.state ?? {}) }),
		);
	}
	if (fixture.legacyState) {
		mkdirSync(join(dir, "session-meta"), { recursive: true });
		writeFileSync(join(dir, "session-meta", "state.json"), JSON.stringify(fixture.legacyState));
	}
	if (fixture.lines) {
		// The directory follows the journal: an agent that never wrote one has no
		// directory under `agents/`, which is what the listing walks.
		mkdirSync(join(dir, "agents", "main"), { recursive: true });
		writeFileSync(join(dir, "agents", "main", "wire.jsonl"), `${fixture.lines.join("\n")}\n`);
	}
	for (const [id, lines] of Object.entries(fixture.otherAgents ?? {})) {
		mkdirSync(join(dir, "agents", id), { recursive: true });
		writeFileSync(join(dir, "agents", id, "wire.jsonl"), `${lines.join("\n")}\n`);
	}
	for (const [name, content] of Object.entries(fixture.extra ?? {})) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	if (fixture.index) {
		writeFileSync(
			join(root, "session_index.jsonl"),
			`${fixture.index.map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
	}
	return dir;
}

/** The one listed session, or a failure that names what was listed instead. */
function listed(root: string, id = "s-1"): KimiSessionFile {
	const session = listKimiSessions(root).sessions.find((found) => found.sessionId === id);
	if (!session) throw new Error(`no listed session ${id} under ${root}`);
	return session;
}

/** A read that has to have succeeded; the reader's own words are the failure. */
function kimiRead(root: string, id = "s-1"): KimiRead {
	const read = readKimiSession(listed(root, id));
	if ("error" in read) throw new Error(`readKimiSession refused ${id}: ${read.error}`);
	return read;
}

/** The messages a read produced, in order, with any compaction boundary left out. */
function messagesOf(entries: KimiEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
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

/** The note a reader wrote for one reason, or undefined when it wrote none. */
function note(read: { notes: Array<{ reason: string; count: number }> }, reason: string): number | undefined {
	return read.notes.find((entry) => entry.reason === reason)?.count;
}

/** The shape of an entry, for assertions that only care what it is. */
function kindOf(entry: KimiEntry | undefined): string {
	return entry?.kind ?? "(none)";
}

/** How the last assistant turn of a read says it ended. */
function stopOf(read: KimiRead): string {
	const assistants = messagesOf(read.entries).filter((message) => message.role === "assistant");
	const last = assistants[assistants.length - 1];
	return last?.role === "assistant" ? last.stopReason : "(no assistant turn)";
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("kimi: listing sessions", () => {
	test("a session is listed from its state, and the tool's own bookkeeping is not a workspace", () => {
		const root = freshRoot();
		// The state's own clock, deliberately later than the wire's: a listing that read
		// the journal's `metadata.created_at` instead would still say T0.
		const path = writeSession(root, {
			state: {
				title: "  Fix   the\nparser ",
				createdAt: T0 + 45_000,
				updatedAt: T0 + 90_000,
				lastPrompt: "ignored",
			},
			lines: [metadata(), user("hello")],
		});
		// `.index-cache` and `.index-dirty` are bookkeeping directories the tool keeps in
		// the same tree, and a session-shaped directory inside one is exactly what the
		// name filter is for: without it both of these would be listed as conversations
		// the user never had.
		writeSession(root, {
			bucket: ".index-cache",
			id: "s-cached",
			state: { title: "a scan cache entry" },
			lines: [metadata(), user("hello")],
		});
		writeSession(root, {
			bucket: ".index-dirty",
			id: "s-dirty",
			state: { title: "a dirty mark" },
			lines: [metadata(), user("hello")],
		});
		// A dotted session directory is not one either.
		writeSession(root, { id: ".s-hidden", state: { title: "hidden" }, lines: [metadata(), user("hello")] });

		const listing = listKimiSessions(root);
		// Named, not counted: a filter that stopped working would otherwise show up as
		// "2 instead of 1" without saying which conversation was invented.
		expect(listing.sessions.map((session) => session.sessionId).sort()).toEqual(["s-1"]);
		const found = listed(root);
		expect(found.sessionId).toBe("s-1");
		expect(found.dir).toBe(path);
		expect(found.path).toBe(join(path, "agents", "main", "wire.jsonl"));
		expect(found.agentId).toBe("main");
		expect(found.cwd).toBe(CWD);
		expect(found.startedAt).toBe(T0 + 45_000);
		expect(found.updatedAt).toBe(T0 + 90_000);
		expect(found.archived).toBe(false);
		expect(found.forkedFrom).toBe("");
		// A title is collapsed onto one line and preferred to the last prompt; the
		// alternative is a list of conversations whose names carry newlines.
		expect(found.title).toBe("Fix the parser");
		expect(listing.notes).toEqual([]);
	});

	test("a title is cut rather than stored whole, and the last prompt is the fallback", () => {
		const root = freshRoot();
		writeSession(root, {
			id: "s-long",
			state: { title: "x".repeat(200) },
			lines: [metadata(), user("hello")],
		});
		writeSession(root, {
			id: "s-prompt",
			state: { title: "  named  ", lastPrompt: "the prompt" },
			lines: [metadata(), user("hello")],
		});
		writeSession(root, {
			id: "s-prompt-only",
			state: { title: "", lastPrompt: "  what did the parser do?  " },
			lines: [metadata(), user("hello")],
		});
		writeSession(root, { id: "s-created", state: { createdAt: T0 + 1000 }, lines: [metadata(), user("hello")] });
		expect(listed(root, "s-long").title.length).toBe(60);
		expect(listed(root, "s-long").title.endsWith("…")).toBe(true);
		// The title wins when there is one, and the last prompt is what a session with
		// no title is called instead of being left unnamed.
		expect(listed(root, "s-prompt").title).toBe("named");
		expect(listed(root, "s-prompt-only").title).toBe("what did the parser do?");
		// Neither field: an untitled session, not a fabricated name.
		writeSession(root, { id: "s-untitled", state: {}, lines: [metadata(), user("hello")] });
		expect(listed(root, "s-untitled").title).toBe("");
		// A state with no `updatedAt` is dated by its creation, not by the epoch.
		expect(listed(root, "s-created").updatedAt).toBe(T0 + 1000);
	});

	test("a child session is skipped, and a session's other agents are counted", () => {
		const root = freshRoot();
		writeSession(root, { id: "s-parent", lines: [metadata(), user("hello")] });
		writeSession(root, {
			id: "s-child",
			state: { custom: { child_session_kind: "child", parent_session_id: "s-parent" } },
			lines: [metadata(), user("a task's own conversation")],
		});
		writeSession(root, {
			id: "s-subagents",
			state: { agents: { main: { type: "main" }, "agent-0": { type: "sub" } } },
			lines: [metadata(), user("hello")],
			otherAgents: { "agent-0": [metadata(), user("a subagent's thread")] },
		});

		const listing = listKimiSessions(root);
		expect(listing.sessions.map((session) => session.sessionId).sort()).toEqual(["s-parent", "s-subagents"]);
		// The marker is exact — the parent's own conversation is not skipped — and the
		// subagent thread is named rather than silently dropped, so the report can say
		// that a subagent conversation stayed behind.
		expect(note(listing, "subagent session")).toBe(1);
		expect(note(listing, "subagent thread in the same session")).toBe(1);
		expect(listed(root, "s-subagents").agentId).toBe("main");
	});

	test("a session with no main agent is counted, and one with a single wire is followed", () => {
		const root = freshRoot();
		// No `agents` map and no agent named `main`: the tool's own reader falls back
		// to "the only agent that has a journal", and two candidates is not one.
		writeSession(root, {
			id: "s-ambiguous",
			state: { agents: {} },
			otherAgents: { alpha: [metadata(), user("a")], beta: [metadata(), user("b")] },
		});
		writeSession(root, {
			id: "s-sole",
			state: { agents: { beta: { type: "sub" } } },
			otherAgents: { beta: [metadata(), user("the session's own words")] },
		});
		// A state file with no inventory at all (the tool's own reader calls this the
		// empty-inventory case), beside a `main` the walk finds on disk: the directory
		// named `main` is the session, and its type comes from the name.
		writeSession(root, {
			id: "s-inventoryless",
			state: { agents: null },
			lines: [metadata(), user("the session's own words")],
			otherAgents: { "agent-0": [metadata(), user("a subagent's thread")] },
		});
		// Both kinds present: the tool names `main` and nothing else, so the session is
		// the main agent's journal even though an independent agent could be its own root.
		writeSession(root, {
			id: "s-independent",
			state: { agents: { "agent-9": { type: "independent" }, main: { type: "main" } } },
			lines: [metadata(), user("the session's own words")],
			otherAgents: { "agent-9": [metadata(), user("an agent with no parent")] },
		});
		// A directory (and a state entry) whose name the tool's own guard refuses: it is
		// not an agent at all, so it is not counted as a subagent thread either.
		writeSession(root, {
			id: "s-unsafe-agent",
			state: { agents: { "a b": { type: "sub" } } },
			lines: [metadata(), user("the session's own words")],
			otherAgents: { "a b": [metadata(), user("not an agent")] },
		});

		const listing = listKimiSessions(root);
		expect(listing.sessions.map((session) => session.sessionId).sort()).toEqual([
			"s-independent",
			"s-inventoryless",
			"s-sole",
			"s-unsafe-agent",
		]);
		expect(note(listing, "session with no main agent transcript")).toBe(1);
		expect(listed(root, "s-independent").agentId).toBe("main");
		expect(listed(root, "s-unsafe-agent").agentId).toBe("main");
		expect(listed(root, "s-unsafe-agent").title).toBe("");
		// An agent the state file types as `sub` *is* the session when it is the only
		// one there: a session whose main agent predates the field would otherwise be
		// reported as having nothing to import.
		expect(listed(root, "s-sole").agentId).toBe("beta");
		expect(listed(root, "s-inventoryless").agentId).toBe("main");
		// Two: `s-inventoryless`'s `agent-0` and `s-independent`'s `agent-9`. Not three,
		// because `s-sole`'s only journal *is* the session, and not four, because the
		// directory the tool's own guard refuses is not an agent at all.
		expect(note(listing, "subagent thread in the same session")).toBe(2);
	});

	test("the working directory comes from the state, then the index, then the wire", () => {
		const root = freshRoot();
		const wire = [metadata(), record({ type: "config.update", cwd: "R:/from-the-wire" }), user("hello")];
		// The state is the authority, and each of its three spellings is one an older
		// release wrote: `cwd`, `workDir`, and a `custom.cwd` from before both.
		writeSession(root, { id: "s-cwd", state: { cwd: "R:/from-the-state" }, lines: wire });
		// Both spellings present: `cwd` is the one the tool's own recovery reads first,
		// and a session is scoped to the project it named last, not to an older alias.
		writeSession(root, {
			id: "s-both",
			state: { cwd: "R:/from-the-state", workDir: "R:/from-workdir" },
			lines: wire,
		});
		writeSession(root, { id: "s-workdir", state: { cwd: "", workDir: "R:/from-workdir" }, lines: wire });
		writeSession(root, { id: "s-custom", state: { cwd: "", custom: { cwd: "R:/from-custom" } }, lines: wire });
		writeSession(root, { id: "s-index", state: { cwd: "" }, lines: wire });
		// The state and the index both name a project, and they disagree: the state is the
		// authority, and the index is only consulted when nothing else names one.
		writeSession(root, { id: "s-index-beaten", state: { cwd: "R:/from-the-state" }, lines: wire });
		writeSession(root, { id: "s-wire", state: { cwd: "" }, lines: wire, bucket: "wd_other_def456" });
		// Nothing of its own names a directory — no state `cwd`, no `config.update` — so
		// this one can only be scoped by the index line below.
		writeSession(root, { id: "s-stale", state: { cwd: "" }, lines: [metadata(), user("hello")] });
		const at = (bucket: string, id: string): string => join(root, "sessions", bucket, id);
		writeFileSync(
			join(root, "session_index.jsonl"),
			`${[
				// The shape the writer appends: absolute, with the bucket in the middle.
				JSON.stringify({
					sessionId: "s-index",
					sessionDir: at("wd_proj_abc123", "s-index"),
					workDir: "R:/from-the-index",
				}),
				// A line for a session whose state already names a project.
				JSON.stringify({
					sessionId: "s-index-beaten",
					sessionDir: at("wd_proj_abc123", "s-index-beaten"),
					workDir: "R:/from-the-index",
				}),
				// A deletion is a line in the same file, and names no directory.
				JSON.stringify({ sessionId: "s-gone", deleted: true }),
				// A line whose directory is real but whose id is not the directory's
				// name: the tool's own reader refuses these, and this one has to as well,
				// or a single line would rename another session's project.
				JSON.stringify({
					sessionId: "s-elsewhere",
					sessionDir: at("wd_proj_abc123", "s-stale"),
					workDir: "R:/not-this-session",
				}),
				// A stale line for a session of the same id in another bucket: the id
				// matches and the path is under `sessions/`, so only the *directory*
				// check can tell that this is not the session the walk found.
				JSON.stringify({
					sessionId: "s-wire",
					sessionDir: at("wd_proj_abc123", "s-wire"),
					workDir: "R:/somewhere-else",
				}),
				// A hand-edited line pointing outside the tree entirely: it names no
				// directory the walk found, so nothing is read from it.
				JSON.stringify({
					sessionId: "s-wire",
					sessionDir: join(root, "elsewhere", "s-wire"),
					workDir: "R:/outside-the-tree",
				}),
				"this line is not JSON at all",
			].join("\n")}\n`,
		);

		expect(listed(root, "s-cwd").cwd).toBe("R:/from-the-state");
		expect(listed(root, "s-both").cwd).toBe("R:/from-the-state");
		expect(listed(root, "s-workdir").cwd).toBe("R:/from-workdir");
		expect(listed(root, "s-custom").cwd).toBe("R:/from-custom");
		expect(listed(root, "s-index").cwd).toBe("R:/from-the-index");
		expect(listed(root, "s-index-beaten").cwd).toBe("R:/from-the-state");
		expect(listed(root, "s-wire").cwd).toBe("R:/from-the-wire");
		// The refused line names `s-stale`'s own directory, so only the id on it keeps it
		// out; a session scoped to a project it never ran in is worse than an unscoped one.
		expect(listed(root, "s-stale").cwd).toBe("");
	});

	test("a session whose state cannot be read is still listed, and the legacy one is read", () => {
		const root = freshRoot();
		// No state file at all: the wire's own `config.update` names the project, and
		// the metadata names the time, so the session is offered rather than lost.
		writeSession(root, {
			id: "s-headless",
			state: null,
			lines: [metadata(), record({ type: "config.update", cwd: "R:/from-the-wire" }), user("hello")],
		});
		// `session-meta/state.json` is where an older release kept the same file.
		writeSession(root, {
			id: "s-legacy",
			state: null,
			legacyState: { cwd: "R:/legacy", title: "from the legacy state", createdAt: T0 },
			lines: [metadata(), user("hello")],
		});
		// A directory that is neither a session nor meant to be one is passed over in
		// silence: a note about something the user never had is a note about nothing.
		mkdirSync(join(root, "sessions", "wd_proj_abc123", "not-a-session", "notes"), { recursive: true });

		const listing = listKimiSessions(root);
		expect(listing.sessions.map((session) => session.sessionId).sort()).toEqual(["s-headless", "s-legacy"]);
		expect(note(listing, "session with no readable state.json")).toBe(1);
		// One note in all, from the two sessions that lost their state — nothing at all
		// for `not-a-session`, which is the silence the rule above promises.
		expect(listing.notes.length).toBe(1);
		expect(listed(root, "s-headless").cwd).toBe("R:/from-the-wire");
		expect(listed(root, "s-headless").startedAt).toBe(T0);
		expect(listed(root, "s-legacy").cwd).toBe("R:/legacy");
		expect(listed(root, "s-legacy").title).toBe("from the legacy state");
	});

	test("a wire is read only as far as its head, so a project named later is not found", () => {
		const root = freshRoot();
		// The `config.update` that names the project sits past the reader's window over
		// the wire (64 KiB). A listing reads that window and stops: reading a whole
		// journal per session is what makes a listing of a long-lived tree slow, and the
		// record is written when the session starts, so a wire that names its directory
		// this late is an anomaly rather than a normal session.
		writeSession(root, {
			id: "s-late-cwd",
			state: null,
			lines: [
				metadata(),
				user(`a turn long enough to push the next record past the window ${"x".repeat(70_000)}`),
				record({ type: "config.update", cwd: "R:/past-the-head" }),
				user("hello"),
			],
		});

		// The head still holds the `metadata` record, so the session keeps its date...
		expect(listed(root, "s-late-cwd").startedAt).toBe(T0);
		// ...and the directory behind the window is reported as absent rather than
		// guessed at or read out of a file the listing was not going to read.
		expect(listed(root, "s-late-cwd").cwd).toBe("");
	});

	test("a root that holds no sessions is an empty listing, not a failure", () => {
		const root = freshRoot();
		expect(listKimiSessions(join(root, "nowhere")).sessions).toEqual([]);
		expect(listKimiSessions(join(root, "nowhere")).notes).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

describe("kimi: reading one session", () => {
	test("a user turn and an assistant turn come back as messages, with the step's usage", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("what does this parser do?"),
				...assistantStep("step-1", "it reads the file", [], {
					inputOther: 10,
					output: 5,
					inputCacheRead: 2,
					inputCacheCreation: 3,
				}),
			],
		});

		const read = kimiRead(root);
		expect(read.notes).toEqual([]);
		const messages = messagesOf(read.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(textOf(messages[0] as AgentMessage)).toBe("what does this parser do?");
		expect(textOf(messages[1] as AgentMessage)).toBe("it reads the file");
		const assistant = messages[1];
		if (assistant?.role !== "assistant") throw new Error("expected an assistant message");
		expect(assistant.stopReason).toBe("stop");
		expect(assistant.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
	});

	test("a tool call and its result stay paired, and the result takes the call's name", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("list the files"),
				...assistantStep("step-1", "", [["t1", "bash", { command: "ls" }]]),
				result("t1", { output: "a.txt\nb.txt", isError: false }),
			],
		});

		const read = kimiRead(root);
		expect(read.notes).toEqual([]);
		const messages = messagesOf(read.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		const assistant = messages[1];
		if (assistant?.role !== "assistant") throw new Error("expected an assistant message");
		// A turn that asked for a tool did not stop on its own, and the target renders
		// the two differently.
		expect(assistant.stopReason).toBe("toolUse");
		expect(assistant.content).toEqual([{ type: "toolCall", id: "t1", name: "bash", arguments: '{"command":"ls"}' }]);
		const toolResult = messages[2];
		if (toolResult?.role !== "toolResult") throw new Error("expected a tool result");
		expect(toolResult.toolCallId).toBe("t1");
		// The journal records the name on the call, not on the result; a result that
		// renders unnamed is a result the user cannot recognise.
		expect(toolResult.toolName).toBe("bash");
		expect(toolResult.isError).toBe(false);
		expect(textOf(toolResult)).toBe("a.txt\nb.txt");
	});

	test("an interrupted call is closed as an error rather than losing both halves", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("run it"),
				stepBegin("step-1"),
				call("step-1", "t1", "bash", { command: "rm -rf /" }),
				// No result and no `step.end`: the process died mid-tool, which is what
				// the fold closes on the next step and what this reader closes at once.
				...assistantStep("step-2", "so, about that"),
			],
		});

		const read = kimiRead(root);
		const messages = messagesOf(read.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const toolResult = messages[2];
		if (toolResult?.role !== "toolResult") throw new Error("expected a tool result");
		expect(toolResult.isError).toBe(true);
		expect(toolResult.toolName).toBe("bash");
		// A message that says a result is missing is information; dropping the pair
		// would leave the transcript claiming a call was never made.
		expect(textOf(toolResult)).toContain("No result was recorded");
	});

	test("a call interrupted at the end of the journal is closed too", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [metadata(), user("run it"), stepBegin("step-1"), call("step-1", "t1", "bash", { command: "ls" })],
		});
		const messages = messagesOf(kimiRead(root).entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(messages[2]?.role === "toolResult" && messages[2].isError).toBe(true);
	});

	test("a message that arrives during a tool run waits behind the result", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("list the files"),
				stepBegin("step-1"),
				call("step-1", "t1", "bash", { command: "ls" }),
				// The user typed while the tool ran: the journal records it here, and
				// the context it rebuilt never holds the two in that order.
				user("actually, stop"),
				result("t1", { output: "a.txt", isError: false }),
			],
		});

		const read = kimiRead(root);
		const messages = messagesOf(read.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(textOf(messages[3] as AgentMessage)).toBe("actually, stop");
	});

	test("an undo takes the turn it rewound over out of the transcript", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				...assistantStep("step-1", "first reply"),
				user("second"),
				...assistantStep("step-2", "second reply"),
				record({ type: "context.undo", count: 1 }),
			],
		});

		const read = kimiRead(root);
		expect(read.entries.map(kindOf)).toEqual(["message", "message"]);
		expect(messagesOf(read.entries).map(textOf)).toEqual(["first", "first reply"]);
	});

	test("a rewind walks past a turn the model started and stops at the user's own", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				...assistantStep("step-1", "first reply"),
				// The model invoked the skill itself, so this is not a user input the
				// rewind counts — and the walk back to one takes the whole turn.
				user("use the skill", { origin: { kind: "skill_activation", trigger: "model" } }),
				...assistantStep("step-2", "used it"),
				record({ type: "context.undo", count: 1 }),
			],
		});

		const read = kimiRead(root);
		expect(read.entries).toEqual([]);
	});

	test("a rewind stops at the summary the context starts from", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				...assistantStep("step-1", "first reply"),
				record({
					type: "context.apply_compaction",
					contextSummary: "the summary",
					compactedCount: 2,
					tokensBefore: 900,
					keptUserMessageCount: 1,
				}),
				user("second"),
				...assistantStep("step-2", "second reply"),
				record({ type: "context.undo", count: 5 }),
				// A compaction after the rewind, slicing from a count shorter than the context:
				// what its tail picks up is the history the undo left behind, which is the
				// only place this reader can show where the rewind stopped.
				record({ type: "context.apply_compaction", summary: "the summary again", count: 0, tokensBefore: 7 }),
			],
		});

		const read = kimiRead(root);
		// The boundary is what the context starts from; a rewind that reached past it
		// would leave the session resuming with no summary at all. That the undo kept
		// the summary is what the second compaction's own tail picks up — `count: 0`
		// slices a history the rewind left one item long — and the note says so.
		expect(read.entries.map(kindOf)).toEqual(["message", "message", "compaction", "compaction"]);
		expect(messagesOf(read.entries).map(textOf)).toEqual(["first", "first reply"]);
		// Two boundaries in one position: the journal's own order, so the newer one is
		// last — the direction a resumed session reads them in.
		const [older, newer] = [read.entries[2], read.entries[3]];
		expect(older?.kind === "compaction" && older.summary).toBe("the summary");
		expect(newer?.kind === "compaction" && newer.summary).toBe("the summary again");
		expect(note(read, "messages kept beside a summary (old compaction shape)")).toBe(1);
	});

	test("a cleared context still imports with everything that was said", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				stepBegin("step-1"),
				part("step-1", { type: "text", text: "running it" }),
				call("step-1", "t1", "bash", { command: "ls" }),
				record({ type: "context.clear" }),
				// The result arrives after the clear: the fold dropped the call it answers,
				// so it pairs with nothing and cannot be part of the new context.
				result("t1", { output: "a.txt", isError: false }),
				user("second"),
				...assistantStep("step-2", "second reply"),
			],
		});

		const read = kimiRead(root);
		// The journal is not the context: a cleared session imports with everything that
		// was said (the fold's clear empties the context its own replay keeps), and the
		// result the clear orphaned is counted rather than dropped in silence.
		expect(messagesOf(read.entries).map(textOf)).toEqual(["first", "running it", "second", "second reply"]);
		expect(note(read, "tool result with no open call")).toBe(1);
		// The call the cleared context no longer holds goes with it, leaving the words the
		// turn still has — the same repair a transcript read back from disk gets.
		expect(note(read, "unpaired tool call or result")).toBe(1);
	});

	test("a compaction becomes a boundary where the journal wrote it", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				...assistantStep("step-1", "first reply"),
				record({
					type: "context.apply_compaction",
					contextSummary: "the summary",
					compactedCount: 2,
					tokensBefore: 900,
					keptUserMessageCount: 1,
				}),
				user("second"),
			],
		});

		const read = kimiRead(root);
		expect(read.entries.map(kindOf)).toEqual(["message", "message", "compaction", "message"]);
		const boundary = read.entries[2];
		expect(boundary?.kind === "compaction" && boundary.summary).toBe("the summary");
		expect(boundary?.kind === "compaction" && boundary.preTokens).toBe(900);
		// The user messages the summary stands in for are re-selected by token budget
		// when the context is rebuilt; the count is reported instead of invented.
		expect(note(read, "user messages the summary stands in for; only the summary is imported")).toBe(1);
	});

	test("the summary binds to the record that opened the compaction, not to the last one", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				record({ type: "full_compaction.begin" }),
				// A message appended while the compaction was running: the fold patches
				// its *last* record and loses the summary here, which is the bug this
				// reader's own search back for the open record avoids.
				user("appended mid-compaction"),
				record({
					type: "context.apply_compaction",
					contextSummary: "the summary",
					compactedCount: 1,
					tokensBefore: 500,
					keptUserMessageCount: 0,
				}),
			],
		});

		const read = kimiRead(root);
		expect(read.entries.map(kindOf)).toEqual(["message", "compaction", "message"]);
		const boundary = read.entries[1];
		expect(boundary?.kind === "compaction" && boundary.summary).toBe("the summary");
		expect(boundary?.kind === "compaction" && boundary.preTokens).toBe(500);
		expect(textOf(messagesOf(read.entries)[1] as AgentMessage)).toBe("appended mid-compaction");
	});

	test("the old compaction shape keeps the tail it names beside the summary", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				...assistantStep("step-1", "first reply"),
				// No `keptUserMessageCount`: the shape that kept `history.slice(count)`.
				record({ type: "context.apply_compaction", summary: "the old summary", count: 1, tokensBefore: 7 }),
				user("second"),
			],
		});

		const read = kimiRead(root);
		// The boundary sits *before* the kept message, so the context the session
		// resumes from is `[summary, first reply, second]` — what the source's own fold
		// rebuilds — rather than a summary with the reply dropped behind it.
		expect(read.entries.map(kindOf)).toEqual(["message", "compaction", "message", "message"]);
		const boundary = read.entries[1];
		expect(boundary?.kind === "compaction" && boundary.summary).toBe("the old summary");
		expect(boundary?.kind === "compaction" && boundary.preTokens).toBe(7);
		expect(messagesOf(read.entries).map(textOf)).toEqual(["first", "first reply", "second"]);
		expect(note(read, "messages kept beside a summary (old compaction shape)")).toBe(1);
	});

	test("a kept tail moves the boundary even when the compaction opened its own record", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				...assistantStep("step-1", "first reply"),
				record({ type: "full_compaction.begin" }),
				record({ type: "context.apply_compaction", summary: "the old summary", count: 1, tokensBefore: 7 }),
			],
		});

		const read = kimiRead(root);
		expect(read.entries.map(kindOf)).toEqual(["message", "compaction", "message"]);
		// One compaction, one boundary: the placeholder is consumed rather than left to
		// be counted as a compaction that never completed.
		expect(note(read, "compaction that never completed")).toBeUndefined();
		expect(note(read, "messages kept beside a summary (old compaction shape)")).toBe(1);
	});

	test("a cancelled compaction leaves nothing, and an unfinished one is counted", () => {
		const root = freshRoot();
		writeSession(root, {
			id: "s-cancelled",
			lines: [
				metadata(),
				user("first"),
				record({ type: "full_compaction.begin" }),
				record({ type: "full_compaction.cancel" }),
				user("second"),
			],
		});
		writeSession(root, {
			id: "s-unfinished",
			lines: [metadata(), user("first"), record({ type: "full_compaction.begin" })],
		});

		const cancelled = kimiRead(root, "s-cancelled");
		expect(cancelled.entries.map(kindOf)).toEqual(["message", "message"]);
		expect(note(cancelled, "compaction that was cancelled")).toBe(1);
		// A compaction that began and never reported a summary replaced nothing the
		// model saw; a boundary at the end of the transcript would claim otherwise.
		const unfinished = kimiRead(root, "s-unfinished");
		expect(unfinished.entries.map(kindOf)).toEqual(["message"]);
		expect(note(unfinished, "compaction that never completed")).toBe(1);
	});

	test("what the harness appended to its own context is counted, not imported", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("the user's own words"),
				user("a reminder the harness injected", { origin: { kind: "injection" } }),
				user("!git status", { origin: { kind: "shell_command" } }),
				user("a cron tick", { origin: { kind: "cron" } }),
				append({ role: "system", content: [{ type: "text", text: "you are a helpful agent" }] }),
				user("/skill use it", { origin: { kind: "skill_activation", trigger: "user-slash" } }),
				append({ role: "user", content: [{ type: "text", text: "" }] }),
			],
		});

		const read = kimiRead(root);
		expect(messagesOf(read.entries).map(textOf)).toEqual(["the user's own words", "/skill use it"]);
		expect(note(read, "injected reminder (the target writes its own)")).toBe(1);
		expect(note(read, "`!` command")).toBe(1);
		expect(note(read, "message the harness appended (cron)")).toBe(1);
		expect(note(read, "system message (the target writes its own)")).toBe(1);
		expect(note(read, "empty user message")).toBe(1);
	});

	test("reasoning with text is carried as it stands, and an encrypted-only block is counted", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("think about it"),
				stepBegin("step-1"),
				part("step-1", { type: "think", think: "let me work through it" }),
				part("step-1", { type: "think", encrypted: "AAAA" }),
				part("step-1", { type: "text", text: "done" }),
				stepEnd("step-1"),
			],
		});

		const read = kimiRead(root);
		const assistant = messagesOf(read.entries)[1];
		if (assistant?.role !== "assistant") throw new Error("expected an assistant message");
		expect(assistant.content).toEqual([
			{ type: "thinking", thinking: "let me work through it" },
			{ type: "text", text: "done" },
		]);
		// The blob is the source model's, and the provider a resumed session talks to
		// is in no position to verify it: it is counted, never carried as a signature.
		expect(note(read, "reasoning block that carried no text")).toBe(1);
	});

	test("an image travels when it carries its bytes, and a URL is counted instead", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				append({
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image_url", imageUrl: { url: "data:image/png;base64,QUJD" } },
						{ type: "image_url", imageUrl: { url: "https://example.invalid/a.png" } },
						{ type: "audio", data: "AAAA" },
					],
				}),
			],
		});

		const read = kimiRead(root);
		const user = messagesOf(read.entries)[0];
		if (user?.role !== "user") throw new Error("expected a user message");
		expect(user.content).toEqual([
			{ type: "text", text: "what is this?" },
			{ type: "image", mimeType: "image/png", data: "QUJD" },
		]);
		expect(note(read, "image referenced by URL")).toBe(1);
		expect(note(read, "message part this build does not carry (audio)")).toBe(1);
	});

	test("an assistant turn the journal opened and never filled is counted as its own kind of loss", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("hello"),
				stepBegin("step-1"),
				// The step was opened and the process died before a single part: an
				// assistant message with nothing in it, which the target cannot hold.
				stepBegin("step-2"),
				part("step-2", { type: "text", text: "recovered" }),
				stepEnd("step-2"),
			],
		});

		const read = kimiRead(root);
		expect(messagesOf(read.entries).map(textOf)).toEqual(["hello", "recovered"]);
		// Not "unpaired tool call or result": that is a different fact, and the note
		// the report prints has to be the one that happened.
		expect(note(read, "assistant turn the journal opened but never filled")).toBe(1);
		expect(note(read, "unpaired tool call or result")).toBeUndefined();
	});

	test("a result with no call, a call with no id and an empty assistant message are counted", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("hello"),
				result("t-ghost", { output: "for a call nobody made" }),
				stepBegin("step-1"),
				// A call the journal recorded without the id its result would name.
				loop({ type: "tool.call", stepUuid: "step-1", name: "bash" }),
				part("step-1", { type: "text", text: "noted" }),
				stepEnd("step-1"),
				append({ role: "assistant", content: [{ type: "think", encrypted: "AAAA" }] }),
			],
		});

		const read = kimiRead(root);
		expect(messagesOf(read.entries).map(textOf)).toEqual(["hello", "noted"]);
		// The fold returns without a word on a result it cannot pair; the counts are
		// this reader's own, and they are what keeps such a line from vanishing.
		expect(note(read, "tool result with no open call")).toBe(1);
		expect(note(read, "tool call with no id")).toBe(1);
		expect(note(read, "empty assistant message")).toBe(1);
		expect(note(read, "reasoning block that carried no text")).toBe(1);
	});

	test("a tool call in the older spelling is read as the call it is", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata("1.0"),
				append({
					role: "assistant",
					content: [{ type: "text", text: "reading it" }],
					// Version 1.0 wrote `{function: {name, arguments}}` and the tool migrates
					// those records forward on read; a journal from before that imports here.
					toolCalls: [{ id: "t1", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
				}),
				// An appended assistant message pairs with an appended tool message: the
				// fold's `tool.result` looks only at calls the *loop* opened, which is why
				// this reader does too.
				append({ role: "tool", toolCallId: "t1", content: [{ type: "text", text: "hello" }] }),
			],
		});

		const read = kimiRead(root);
		expect(read.notes).toEqual([]);
		const messages = messagesOf(read.entries);
		const assistant = messages[0];
		if (assistant?.role !== "assistant") throw new Error("expected an assistant message");
		expect(assistant.content).toEqual([
			{ type: "text", text: "reading it" },
			{ type: "toolCall", id: "t1", name: "read", arguments: '{"path":"a.txt"}' },
		]);
		const toolResult = messages[1];
		if (toolResult?.role !== "toolResult") throw new Error("expected a tool result");
		expect(toolResult.toolName).toBe("read");
		expect(textOf(toolResult)).toBe("hello");
	});

	test("a wire newer than this reader is imported and named", () => {
		const root = freshRoot();
		writeSession(root, {
			id: "s-newer",
			lines: [metadata("1.9"), user("hello")],
		});
		const read = kimiRead(root, "s-newer");
		expect(messagesOf(read.entries).map(textOf)).toEqual(["hello"]);
		expect(note(read, "journal written by a newer wire protocol (1.9): read as 1.5")).toBe(1);
	});

	test("a fork imports whole, and the report says whose words are in it", () => {
		const root = freshRoot();
		writeSession(root, {
			id: "s-fork",
			state: { forkedFrom: "s-parent" },
			lines: [metadata(), user("an inherited turn"), user("the fork's own turn")],
		});
		writeSession(root, { id: "s-empty-fork", state: { forkedFrom: "s-parent" }, lines: [metadata()] });

		const read = kimiRead(root, "s-fork");
		expect(messagesOf(read.entries).map(textOf)).toEqual(["an inherited turn", "the fork's own turn"]);
		// The inherited prefix cannot be told apart from the turns the user typed — a
		// fork copies the parent's records with their ids — so it is imported and named
		// rather than guessed at. A fork with nothing in it says nothing.
		expect(note(read, "forked from session s-parent: its inherited prefix is imported whole")).toBe(1);
		expect(kimiRead(root, "s-empty-fork").notes).toEqual([]);
	});

	test("a journal that cannot be folded is refused rather than half-read", () => {
		const root = freshRoot();
		writeSession(root, {
			id: "s-unfoldable",
			lines: [metadata(), part("step-ghost", { type: "text", text: "for a step nobody opened" })],
		});
		const session = listed(root, "s-unfoldable");
		const read = readKimiSession(session);
		expect("error" in read && read.error).toBe("journal does not replay: content.part for unopened step step-ghost");
		// The same refusal for a call, which the fold cannot place either.
		writeSession(root, {
			id: "s-unfoldable-call",
			lines: [metadata(), call("step-ghost", "t1", "bash", {})],
		});
		const other = readKimiSession(listed(root, "s-unfoldable-call"));
		expect("error" in other && other.error).toContain("tool.call for unopened step step-ghost");
	});

	test("a transcript that cannot be read says so instead of reporting an empty session", () => {
		const root = freshRoot();
		const dir = writeSession(root, { lines: [metadata(), user("hello")] });
		const session = listed(root);
		// A wire that vanished between the listing and the read: an empty transcript
		// would say the session was empty, which is a different fact from gone.
		const read = readKimiSession({ ...session, path: join(dir, "agents", "main", "gone.jsonl") });
		expect("error" in read && read.error).toBe("session transcript could not be read");
	});

	test("a malformed line and an unknown record cost a line, not the session", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("hello"),
				"half a JSON object",
				record({ type: "turn.prompt", prompt: "bookkeeping the journal keeps" }),
				loop({ type: "step.progress", fraction: 0.5 }),
			],
		});

		const read = kimiRead(root);
		expect(messagesOf(read.entries).map(textOf)).toEqual(["hello"]);
		expect(note(read, "malformed line")).toBe(1);
		// A loop event this build does not know could be either bookkeeping or a part
		// of a turn, so it is named rather than guessed at; the bookkeeping records
		// known to change nothing are not counted at all.
		expect(note(read, "unknown loop event")).toBe(1);
		expect(read.notes.length).toBe(2);
	});

	test("a compaction record with no summary is a boundary that was not written", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [metadata(), user("hello"), record({ type: "context.apply_compaction", compactedCount: 1 })],
		});
		const read = kimiRead(root);
		expect(read.entries.map(kindOf)).toEqual(["message"]);
		expect(note(read, "compaction with no summary")).toBe(1);
	});

	test("how the loop says a step ended travels, and a reason it does not know is read from the turn", () => {
		const root = freshRoot();
		// The loop normalizes the provider's reason before the journal sees it, so these
		// are the source's own spellings rather than a provider's.
		const known: Array<[string, string]> = [
			["end_turn", "stop"],
			["tool_use", "toolUse"],
			["max_tokens", "length"],
			["interrupted", "aborted"],
			["error", "error"],
			["filtered", "refusal"],
		];
		for (const [reason, expected] of known) {
			writeSession(root, {
				id: `s-${reason.replace(/_/g, "-")}`,
				lines: [
					metadata(),
					user("go"),
					stepBegin("step-1"),
					part("step-1", { type: "text", text: "the answer" }),
					stepEnd("step-1", { finishReason: reason }),
				],
			});
			expect([reason, stopOf(kimiRead(root, `s-${reason.replace(/_/g, "-")}`))]).toEqual([reason, expected]);
		}
		// A reason this build does not know (`paused`, `other`, and whatever a newer
		// release adds) is not a stop this reader can name, so the turn itself decides.
		writeSession(root, {
			id: "s-unknown-with-call",
			lines: [
				metadata(),
				user("go"),
				...assistantStep("step-1", ""),
				stepBegin("step-2"),
				call("step-2", "t1", "bash", { command: "ls" }),
				stepEnd("step-2", { finishReason: "paused" }),
			],
		});
		// A turn that asked for a tool has not stopped, whatever the provider called it.
		expect(stopOf(kimiRead(root, "s-unknown-with-call"))).toBe("toolUse");
		// A step the journal never ended at all is read the same way: a step that opened a
		// call is `toolUse`, and the pair is closed rather than left looking live.
		writeSession(root, {
			id: "s-open-with-call",
			lines: [metadata(), user("go"), stepBegin("step-1"), call("step-1", "t1", "bash", { command: "ls" })],
		});
		expect(stopOf(kimiRead(root, "s-open-with-call"))).toBe("toolUse");
		// And one that only said something is a stop, which is what the reader has to say
		// about a turn that was cut off mid-stream without a reason.
		writeSession(root, {
			id: "s-open-text",
			lines: [metadata(), user("go"), stepBegin("step-1"), part("step-1", { type: "text", text: "partial" })],
		});
		expect(stopOf(kimiRead(root, "s-open-text"))).toBe("stop");
	});

	test("a cancel cannot un-complete a compaction that already reported its summary", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("first"),
				record({ type: "full_compaction.begin" }),
				record({
					type: "context.apply_compaction",
					contextSummary: "the summary",
					compactedCount: 1,
					tokensBefore: 5,
					keptUserMessageCount: 0,
				}),
				user("second"),
				// A cancel after the summary arrived (which the tool does not emit, but a
				// journal can hold) names no open compaction: the context kept the summary,
				// so the boundary the replay holds has to stay.
				record({ type: "full_compaction.cancel" }),
			],
		});

		const read = kimiRead(root);
		expect(read.entries.map(kindOf)).toEqual(["message", "compaction", "message"]);
		expect(note(read, "compaction that was cancelled")).toBe(1);
		expect(note(read, "compaction that never completed")).toBeUndefined();
	});

	test("a summary binds to the compaction begun last, not the first one still open", () => {
		const root = freshRoot();
		writeSession(root, {
			lines: [
				metadata(),
				user("a"),
				record({ type: "full_compaction.begin" }),
				// A message appended between the two: the second `begin` is the compaction
				// the summary belongs to, and the first is one the journal abandoned.
				user("mid"),
				record({ type: "full_compaction.begin" }),
				record({
					type: "context.apply_compaction",
					contextSummary: "the summary",
					compactedCount: 1,
					tokensBefore: 3,
					keptUserMessageCount: 0,
				}),
				user("c"),
			],
		});

		const read = kimiRead(root);
		// The boundary sits where the summary landed — after `mid` — which is the record
		// the fold binds it to. Binding it to the first open placeholder would put the
		// boundary before a message the compaction never saw.
		expect(read.entries.map(kindOf)).toEqual(["message", "message", "compaction", "message"]);
		expect(messagesOf(read.entries).map(textOf)).toEqual(["a", "mid", "c"]);
		expect(note(read, "compaction that never completed")).toBe(1);
	});

	test("a boundary moves to the end when the repair pass dropped a message", () => {
		const root = freshRoot();
		const head = [
			metadata(),
			user("first"),
			...assistantStep("step-1", "first reply"),
			record({
				type: "context.apply_compaction",
				contextSummary: "the summary",
				compactedCount: 2,
				tokensBefore: 900,
				keptUserMessageCount: 1,
			}),
		];
		writeSession(root, { id: "s-intact", lines: [...head, user("second")] });
		writeSession(root, {
			id: "s-repaired",
			lines: [
				...head,
				user("second"),
				// A turn that asked for a tool whose result never came: the call goes, and
				// the words the turn still has stay.
				append({
					role: "assistant",
					content: [{ type: "text", text: "let me check that" }],
					toolCalls: [{ id: "t-orphan", name: "bash", arguments: "{}" }],
				}),
			],
		});

		const intact = kimiRead(root, "s-intact");
		expect(intact.entries.map(kindOf)).toEqual(["message", "message", "compaction", "message"]);
		expect(note(intact, "unpaired tool call or result")).toBeUndefined();

		const read = kimiRead(root, "s-repaired");
		expect(messagesOf(read.entries).map(textOf)).toEqual(["first", "first reply", "second", "let me check that"]);
		expect(note(read, "unpaired tool call or result")).toBe(1);
		// A boundary counts the messages that came before it, and the repair pass changed
		// that count under it. A boundary landing mid-transcript with a suffix that no
		// longer exists would resume the session with the wrong side of the summary, so a
		// repaired transcript carries its boundaries at the end instead.
		expect(read.entries.map(kindOf)).toEqual(["message", "message", "message", "message", "compaction"]);
	});
});
