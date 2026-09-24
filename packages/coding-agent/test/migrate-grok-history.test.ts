/**
 * What the Grok Build importer carries out of `$GROK_HOME/sessions`, and what it
 * says about what it does not.
 *
 * Two rules shape this file. The first is that the fixtures are the bytes grok
 * writes: an envelope with `method`/`params`, a legacy line with neither, the
 * `sessionUpdate` tag one level down where nothing else looks for it, and the two
 * `_meta` maps — the chunk's and the text block's — that hold run markers and
 * `displayText` respectively. A fixture that flattened any of that would test a
 * reader that does not exist and would pass while the real thing dropped every
 * line in the file.
 *
 * The second is that every skip is asserted with the count the report prints.
 * The reader's value is not that it keeps the conversation but that it says which
 * parts of it were left behind: a `!` command, a host-injected turn, a tool call,
 * a turn the user rewound away, a whole session grok hides.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import type { AgentMessage } from "@labunbun/ai";
import { type GrokEntry, type GrokRead, listGrokSessions, readGrokSession } from "../src/grok-session.ts";
import { type RunMigrationResult, runMigration } from "../src/migrate.ts";
import { importedSessionId, listHistory, readHistory, readPromptHistory } from "../src/migrate-history.ts";

/** A project that exists on disk, so the cwd rules keep the sessions that name it. */
const CWD = process.cwd();

/** The fixtures' clock: every envelope below counts from here, one second per line. */
const T0 = Date.parse("2026-03-01T00:00:00Z");

const SESSION_ID = "0199a1f6-7c2e-7b31-9a4d-6f0b2c8e1d55";

/** Temp roots, swept with the test that made them. */
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

/** Borrow one environment variable for the rest of the test. */
function setEnv(name: string, value: string | undefined): void {
	if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * Run `body` against a throwaway home with `$GROK_HOME` unset, so what is read is
 * `~/.grok`. Anything the machine already has in `GROK_HOME` is borrowed away
 * first: a developer's own grok home would otherwise decide the outcome.
 */
function withHome(body: (home: string) => void): string {
	const home = mkdtempSync(join(tmpdir(), "lbb-grok-history-"));
	roots.push(home);
	setEnv("USERPROFILE", home);
	setEnv("HOME", home);
	setEnv("GROK_HOME", undefined);
	body(home);
	return home;
}

/** `<home>/.grok` — where the sessions of a fake grok home live. */
function grokHome(home: string): string {
	return join(home, ".grok");
}

// ---------------------------------------------------------------------------
// Fixtures: the bytes grok writes
// ---------------------------------------------------------------------------

/** One update line as grok's envelope writer stores it. */
function envelope(method: string, update: unknown, timestamp: number): string {
	return JSON.stringify({ timestamp, method, params: { sessionId: SESSION_ID, update } });
}

/** An ACP update: the shape every prompt, reply, thought and tool frame uses. */
function acp(update: unknown, timestamp = 1): string {
	return envelope("session/update", update, timestamp);
}

/** An xAI extension: where rewind markers and compaction checkpoints live. */
function xai(update: unknown, timestamp = 1): string {
	return envelope("_x.ai/session/update", update, timestamp);
}

/** The pre-envelope shape: `{sessionId, update}` with no `method` at all. */
function legacy(update: unknown): string {
	return JSON.stringify({ sessionId: SESSION_ID, update });
}

/**
 * A user message chunk.
 *
 * `runMeta` is the chunk's own `_meta` (a sibling of `content`), which is where
 * `promptIndex`, `hostTurn` and `interjection` live; `blockMeta` is the text
 * block's, which is where `displayText` and `bash_command` live. The two are
 * different maps in the same line, and conflating them is the mistake the
 * fixtures are shaped to catch.
 */
function userChunk(
	text: string,
	options: { runMeta?: Record<string, unknown>; blockMeta?: Record<string, unknown> } = {},
): unknown {
	const content: Record<string, unknown> = { type: "text", text };
	if (options.blockMeta) content._meta = options.blockMeta;
	const update: Record<string, unknown> = { sessionUpdate: "user_message_chunk", content };
	if (options.runMeta) update._meta = options.runMeta;
	return update;
}

/** An assistant text delta. Consecutive deltas are one message. */
function agentChunk(text: string): unknown {
	return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

/** A completed tool frame: the flush point that splits the assistant text. */
function toolDone(id: string): unknown {
	return { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" };
}

function toolStarted(id: string, title: string): unknown {
	return { sessionUpdate: "tool_call", toolCallId: id, title, rawInput: { command: "ls" } };
}

function reasoning(text: string): unknown {
	return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } };
}

/** A rewind marker, in the spelling grok persists it in: snake_case target. */
function rewind(target: number): unknown {
	return { sessionUpdate: "rewind_marker", target_prompt_index: target, created_at: "2026-03-01T00:00:01Z" };
}

/** The persist-only event grok writes when compaction replaces the conversation. */
function checkpoint(id: string, promptIndex: number): unknown {
	return {
		sessionUpdate: "compaction_checkpoint",
		checkpoint_id: id,
		checkpoint_file: `compaction_checkpoints/${id}.json`,
		prompt_index_at_compaction: promptIndex,
		schema_version: 2,
		created_at: "2026-03-01T00:00:05Z",
	};
}

/** A session's `summary.json`, as the fields this reader uses. */
function summary(fields: Record<string, unknown>): string {
	return `${JSON.stringify({
		info: { id: SESSION_ID, cwd: CWD },
		session_summary: "a fixture session",
		created_at: "2026-03-01T00:00:00Z",
		updated_at: "2026-03-01T00:10:00Z",
		num_messages: 4,
		...fields,
	})}\n`;
}

interface SessionFixture {
	/** Directory under `sessions/`, which is how grok encodes the working directory. */
	cwdDir?: string;
	id?: string;
	/** `summary.json`; pass `null` for a session whose summary cannot be read. */
	summary?: string | null;
	/** `updates.jsonl` lines; the array is joined with newlines and terminated. */
	lines?: string[];
	/** `compaction/segment_NNN.md` files, keyed by file name. */
	segments?: Record<string, string>;
	/** Extra files in the session directory, keyed by relative path. */
	extra?: Record<string, string>;
}

/** Write one session directory the way grok lays one out. */
function writeSession(root: string, fixture: SessionFixture): string {
	const dir = join(root, "sessions", fixture.cwdDir ?? encodeURIComponent(CWD), fixture.id ?? SESSION_ID);
	mkdirSync(dir, { recursive: true });
	if (fixture.summary !== null) writeFileSync(join(dir, "summary.json"), fixture.summary ?? summary({}));
	if (fixture.lines) writeFileSync(join(dir, "updates.jsonl"), `${fixture.lines.join("\n")}\n`);
	for (const [name, content] of Object.entries(fixture.segments ?? {})) {
		mkdirSync(join(dir, "compaction"), { recursive: true });
		writeFileSync(join(dir, "compaction", name), content);
	}
	for (const [name, content] of Object.entries(fixture.extra ?? {})) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return join(dir, "updates.jsonl");
}

/** A read that has to have succeeded; the reader's own words are the failure. */
function grokRead(root: string, id = SESSION_ID): GrokRead {
	const session = listGrokSessions(root).sessions.find((found) => found.sessionId === id);
	if (!session) throw new Error(`no listed session ${id} under ${root}`);
	const read = readGrokSession(session);
	if ("error" in read) throw new Error(`readGrokSession refused ${id}: ${read.error}`);
	return read;
}

/** The converted messages, in order, with any compaction entry left out. */
function messagesOf(entries: GrokEntry[]): AgentMessage[] {
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

/** Every file and directory under a root, with its size, mtime and content digest. */
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

/** The history writes in a plan, as `~`-relative paths. */
function historyWrites(result: RunMigrationResult, home: string): string[] {
	return result.plan.writes
		.filter((write) => write.kind === "history")
		.map((write) => write.path.replace(/\\/g, "/").replace(home.replace(/\\/g, "/"), "~"))
		.sort();
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("migrate: grok session listing", () => {
	test("a session is listed from its summary, and the transcript is its updates file", () => {
		withHome((home) => {
			const path = writeSession(grokHome(home), {
				lines: [acp(userChunk("hello"))],
			});
			const listing = listGrokSessions(grokHome(home));
			expect(listing.sessions.length).toBe(1);
			expect(listing.sessions[0]?.sessionId).toBe(SESSION_ID);
			expect(listing.sessions[0]?.cwd).toBe(CWD);
			expect(listing.sessions[0]?.path).toBe(path);
			expect(listing.sessions[0]?.title).toBe("a fixture session");
			expect(listing.sessions[0]?.startedAt).toBe(T0);
			expect(grokRead(grokHome(home)).entries.length).toBe(1);
		});
	});

	test("a generated title wins over the summary, and both are collapsed onto one line", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				summary: summary({ generated_title: "  Fix   the\nparser " }),
				lines: [acp(userChunk("go"))],
			});
			expect(listGrokSessions(grokHome(home)).sessions[0]?.title).toBe("Fix the parser");
			// The summary is the fallback, and a session that has only that is titled
			// by it rather than listed as unnamed.
			writeSession(grokHome(home), {
				id: "s-summary-only",
				summary: summary({ session_summary: "  from the summary " }),
				lines: [acp(userChunk("go"))],
			});
			expect(listGrokSessions(grokHome(home)).sessions.find((s) => s.sessionId === "s-summary-only")?.title).toBe(
				"from the summary",
			);
		});
	});

	test("the cwd comes from the summary, and from the directory name when the summary has none", () => {
		withHome((home) => {
			// A summary with no `info.cwd`: the directory name still decodes to a path,
			// and the alternative is a session with no project — which the cwd scope
			// would then drop for a reason that is not true.
			writeSession(grokHome(home), {
				summary: summary({ info: { id: SESSION_ID } }),
				lines: [acp(userChunk("go"))],
			});
			expect(listGrokSessions(grokHome(home)).sessions[0]?.cwd).toBe(CWD);
		});
	});

	test("hidden and subagent sessions are skipped the way grok hides them, not the way they look", () => {
		withHome((home) => {
			writeSession(grokHome(home), { id: "s-plain", lines: [acp(userChunk("plain"))] });
			writeSession(grokHome(home), { id: "s-hidden", summary: summary({ hidden: true }) });
			writeSession(grokHome(home), { id: "s-sub", summary: summary({ session_kind: "subagent" }) });
			writeSession(grokHome(home), { id: "s-subfork", summary: summary({ session_kind: "subagent_fork" }) });
			writeSession(grokHome(home), { id: "s-subresume", summary: summary({ session_kind: "subagent_resume" }) });
			// The one that makes the rule `hidden.unwrap_or(kind starts with subagent)`
			// rather than the obvious reading: grok *shows* this session, so an
			// importer that hid it would drop something the user can see in the tool.
			writeSession(grokHome(home), {
				id: "s-sub-shown",
				summary: summary({ session_kind: "subagent_resume", hidden: false }),
				lines: [acp(userChunk("shown"))],
			});
			const listing = listGrokSessions(grokHome(home));
			expect(listing.sessions.map((session) => session.sessionId).sort()).toEqual(["s-plain", "s-sub-shown"]);
			// Four, not one: a subagent session is hidden by grok's own default rule
			// rather than by a flag, and the report counts what grok hides.
			expect(note(listing, "hidden session")).toBe(4);
		});
	});

	test("a session that was never used, or never got a transcript, is counted rather than imported", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				id: "s-husk",
				summary: summary({ session_summary: "", num_messages: 0, generated_title: null }),
			});
			// A fork is exempt from the husk rule even with nothing in it: it has
			// provenance, and grok lists it.
			writeSession(grokHome(home), {
				id: "s-fork-empty",
				summary: summary({ session_summary: "", num_messages: 0, session_kind: "fork", parent_session_id: "p" }),
				lines: [acp(userChunk("go"))],
			});
			writeSession(grokHome(home), { id: "s-noturn", summary: summary({}), lines: undefined });
			const listing = listGrokSessions(grokHome(home));
			expect(listing.sessions.map((session) => session.sessionId)).toEqual(["s-fork-empty"]);
			expect(note(listing, "session with no title and no messages")).toBe(1);
			expect(note(listing, "session with no transcript")).toBe(1);
		});
	});

	test("a session directory with no summary.json is not a session at all", () => {
		withHome((home) => {
			// grok writes the summary last as its commit marker, so a directory without
			// one is a session it was still creating — or one whose import was
			// interrupted, which grok itself recreates rather than resumes.
			writeSession(grokHome(home), { id: "s-uncommitted", summary: null, lines: [acp(userChunk("half"))] });
			expect(listGrokSessions(grokHome(home)).sessions).toEqual([]);
			expect(listGrokSessions(grokHome(home)).notes).toEqual([]);
		});
	});

	test("an unreadable summary is counted, and one bad file does not cost the walk", () => {
		withHome((home) => {
			writeSession(grokHome(home), { id: "s-broken", extra: {} });
			writeFileSync(join(grokHome(home), "sessions", encodeURIComponent(CWD), "s-broken", "summary.json"), "{not json");
			writeSession(grokHome(home), { id: "s-good", lines: [acp(userChunk("fine"))] });
			const listing = listGrokSessions(grokHome(home));
			expect(listing.sessions.map((session) => session.sessionId)).toEqual(["s-good"]);
			expect(note(listing, "summary.json that could not be read")).toBe(1);
		});
	});

	test("the sessions root is $GROK_HOME's, and a home with none lists nothing", () => {
		withHome((home) => {
			const elsewhere = mkdtempSync(join(tmpdir(), "lbb-grok-elsewhere-"));
			roots.push(elsewhere);
			writeSession(elsewhere, { lines: [acp(userChunk("elsewhere"))] });
			setEnv("GROK_HOME", elsewhere);
			expect(listGrokSessions(elsewhere).sessions.length).toBe(1);
			// The default home has no sessions tree, so nothing is listed and nothing is
			// claimed: an empty listing here is the tree being absent, not a failure.
			expect(listGrokSessions(grokHome(home)).sessions).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

describe("migrate: grok transcript conversion", () => {
	test("both envelope shapes are read: the one with a method and the legacy one without", () => {
		// A reader that insisted on the envelope would drop the legacy line, and the
		// fixture says which happened: the two chunks are consecutive, so grok's
		// reducer appends them into one message. A reader that skipped the second
		// line answers "enveloped" and one that read it says "envelopedbare".
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [acp(userChunk("enveloped", { runMeta: { promptIndex: 0 } }), 1), legacy(userChunk("bare"))],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual(["envelopedbare"]);
		});
	});

	test("a prompt run concatenates its chunks, with no separator invented between them", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("one ", { runMeta: { promptIndex: 0 } })),
					acp(userChunk("two", { runMeta: { promptIndex: 0 } })),
					acp(agentChunk("Look")),
					acp(agentChunk("ing")),
				],
			});
			expect(messagesOf(grokRead(grokHome(home)).entries).map(textOf)).toEqual(["one two", "Looking"]);
		});
	});

	test("a new promptIndex opens a new message, and an unmarked phantom does not", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("first", { runMeta: { promptIndex: 0 } })),
					acp(agentChunk("reply")),
					acp(userChunk("second", { runMeta: { promptIndex: 1 } })),
					// A mid-turn phantom: text the model was sent without a turn of its
					// own. grok keeps the text and does not count it as a prompt, which is
					// why it arrives appended to the run in front of it rather than alone.
					acp(userChunk(" and more")),
				],
			});
			expect(messagesOf(grokRead(grokHome(home)).entries).map(textOf)).toEqual(["first", "reply", "second and more"]);
		});
	});

	test("displayText is the prompt when the wire text is an expansion of it", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(
						userChunk("\n\n# Commit\nFull skill body the model was sent\n", {
							runMeta: { promptIndex: 0 },
							blockMeta: { displayText: "/commit fix the tests" },
						}),
					),
				],
			});
			expect(messagesOf(grokRead(grokHome(home)).entries).map(textOf)).toEqual(["/commit fix the tests"]);
		});
	});

	test("an interjection is its own message, unwrapped to the words the user typed", () => {
		withHome((home) => {
			const frame = (inner: string): string =>
				`The user sent a message while you were working:\n<user_query>\n${inner}\n</user_query>\n` +
				"Make sure to complete any unfinished tasks from previous turns.";
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("start", { runMeta: { promptIndex: 0 } })),
					acp(agentChunk("working on it")),
					// The live drain persists the model-facing frame and, with it, the typed
					// text in the block's meta: the frame is what the model saw, and the
					// display text is what the user should see again.
					acp(
						userChunk(frame("stop and fix the test first"), {
							runMeta: { interjection: true },
							blockMeta: { displayText: "stop and fix the test first" },
						}),
					),
					// A chunk written without that meta — an older writer, or one whose
					// display text was empty — is unwrapped by the envelope's own shape.
					acp(userChunk(frame("and then rerun"), { runMeta: { interjection: true } })),
				],
			});
			expect(messagesOf(grokRead(grokHome(home)).entries).map(textOf)).toEqual([
				"start",
				"working on it",
				"stop and fix the test first",
				"and then rerun",
			]);
		});
	});

	test("a completed tool frame splits the assistant text, and the frame itself is counted", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("run it", { runMeta: { promptIndex: 0 } })),
					acp(agentChunk("Let me check")),
					acp(toolStarted("c1", "bash")),
					acp(agentChunk(" the directory.")),
					acp(toolDone("c1")),
					acp(agentChunk("It is empty.")),
				],
			});
			const read = grokRead(grokHome(home));
			// grok's reducer flushes the assistant item when a tool completes, so the
			// text before the call and the text after it are two messages there — and a
			// reader that merged them would answer with a sentence no model ever wrote.
			expect(messagesOf(read.entries).map(textOf)).toEqual(["run it", "Let me check the directory.", "It is empty."]);
			// Two, because two lines went: the call and its completion. The count is of
			// lines, not of calls, which is what makes it add up against the file.
			expect(note(read, "tool call or result")).toBe(2);
		});
	});

	test("a `!` command, a host turn and a reasoning block are counted and left behind", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					// The block's own meta is what marks a shell escape: its text is the
					// command the user typed, and it was never asked of the model.
					acp(userChunk("! ls -la", { runMeta: { promptIndex: 0 }, blockMeta: { bash_command: "ls -la" } })),
					acp(userChunk("real question", { runMeta: { promptIndex: 1 } })),
					acp(reasoning("thinking about it")),
					acp(userChunk("host says something", { runMeta: { hostTurn: true } })),
					acp(agentChunk("the answer")),
				],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual(["real question", "the answer"]);
			expect(note(read, "`!` command")).toBe(1);
			// A host turn ends both runs, exactly as `flush_host_turn_boundary` does, so
			// the answer after it is its own message rather than a continuation.
			expect(note(read, "host-injected turn")).toBe(1);
			expect(note(read, "reasoning block")).toBe(1);
		});
	});

	test("a user chunk with no text is counted, and an empty one is not written", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp({ sessionUpdate: "user_message_chunk", content: { type: "image_url", url: "data:image/png" } }),
					acp(userChunk("   ")),
					acp(userChunk("kept")),
				],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual(["kept"]);
			expect(note(read, "user message with no text")).toBe(1);
			expect(note(read, "empty prompt")).toBe(1);
		});
	});

	test("the fork and resume wrappers are stripped, keeping the prompt outside them", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("<fork-context>\nparent: fix the bug\n</fork-context>\nNow add a test", {})),
					// A prompt that was *only* a wrapper carries nothing once the wrapper
					// is gone, and an empty message is worse than none: it would be sent
					// back to the model as a blank turn.
					acp(userChunk("<resume-context>\nold preamble\n</resume-context>")),
				],
			});
			const read = grokRead(grokHome(home));
			// The wrapper and what it carried go; what followed it stays, with the
			// wrapper's own newline trimmed off the front.
			expect(messagesOf(read.entries).map(textOf)).toEqual(["Now add a test"]);
			expect(note(read, "empty prompt")).toBe(1);
		});
	});

	test("a malformed line costs a note and the conversation survives it", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("before")),
					"{not json at all",
					JSON.stringify({ method: "session/update", params: {} }),
					acp({ sessionUpdate: "available_commands_update", availableCommands: [] }),
					acp(agentChunk("after")),
				],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual(["before", "after"]);
			expect(note(read, "malformed line")).toBe(1);
			expect(note(read, "line with no session update")).toBe(1);
			expect(note(read, "session event")).toBe(1);
		});
	});

	test("each message carries the line's clock, and a line without one keeps the one running", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					// The envelope's stamp is seconds since the epoch, which is what grok
					// writes and what the session file stores in milliseconds.
					acp(userChunk("first"), 1_700_000_000),
					// The legacy shape has no stamp field at all: the clock running when it
					// was read stands, and the message it merges into keeps that time.
					legacy(userChunk(" and more")),
					acp(agentChunk("reply"), 1_700_000_005),
					// An unstamped line that opens a message of its own is the only place
					// the running clock is observable: the line above lands inside a message
					// a stamped line opened, so it carries that line's time either way, and a
					// reader that zeroed the clock would still pass. Here the message is this
					// line's own, and its time is the one still running.
					legacy(userChunk("a line of its own")),
				],
			});
			const messages = messagesOf(grokRead(grokHome(home)).entries);
			expect(messages.map(textOf)).toEqual(["first and more", "reply", "a line of its own"]);
			expect(messages.map((message) => message.timestamp)).toEqual([
				1_700_000_000_000, 1_700_000_005_000, 1_700_000_005_000,
			]);
		});
	});
});

// ---------------------------------------------------------------------------
// Rewind
// ---------------------------------------------------------------------------

describe("migrate: grok rewind markers", () => {
	test("a rewind drops the target turn and everything after it, and keeps what came before", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("turn zero", { runMeta: { promptIndex: 0 } })),
					acp(agentChunk("answer zero")),
					acp(userChunk("turn one", { runMeta: { promptIndex: 1 } })),
					acp(agentChunk("answer one")),
					acp(userChunk("turn two", { runMeta: { promptIndex: 2 } })),
					acp(agentChunk("answer two")),
					// The user rewound to turn two: it went back into the composer, so it
					// was never asked, and neither was anything after it.
					xai(rewind(2)),
					acp(userChunk("turn two, rewritten", { runMeta: { promptIndex: 2 } })),
					acp(agentChunk("answer two, rewritten")),
				],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual([
				"turn zero",
				"answer zero",
				"turn one",
				"answer one",
				"turn two, rewritten",
				"answer two, rewritten",
			]);
			expect(note(read, "dropped by a rewind marker")).toBe(2);
		});
	});

	test("a rewind target the transcript no longer holds keeps every survivor", () => {
		withHome((home) => {
			// grok's `unwrap_or` folds an out-of-range target to the current length, and
			// the case is ordinary: a marker for a turn that predates a compaction names
			// a prompt the file no longer numbers.
			writeSession(grokHome(home), {
				lines: [acp(userChunk("only turn", { runMeta: { promptIndex: 0 } })), xai(rewind(4))],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual(["only turn"]);
			expect(note(read, "dropped by a rewind marker")).toBeUndefined();
		});
	});

	test("unmarked runs count as turns until the first marker, and phantoms after it do not", () => {
		withHome((home) => {
			// The counting rule is grok's `UserRunTurnTracker`, and it is asymmetric on
			// purpose: an old session has no indices at all, so every run counted, while
			// a session that has them also has mid-turn phantoms, which must not.
			//
			// The fixture is built so the rule is what decides the answer: if the two
			// unmarked turns did not count, the marker's target would be past the end of
			// the run list and turn B would survive.
			writeSession(grokHome(home), {
				lines: [
					// Two chunks with nothing between them are one run — the unit that is
					// counted is the run, not the line.
					acp(userChunk("turn ")),
					acp(userChunk("A")),
					acp(agentChunk("answer A")),
					acp(userChunk("turn B")),
					acp(agentChunk("answer B")),
					xai(rewind(1)),
					acp(userChunk("turn B, rewritten")),
					acp(agentChunk("answer B, rewritten")),
				],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual([
				"turn A",
				"answer A",
				"turn B, rewritten",
				"answer B, rewritten",
			]);
			// The whole turn went, not just the prompt: the count is of what the
			// transcript lost, and the answer to a rewound question is as gone as the
			// question.
			expect(note(read, "dropped by a rewind marker")).toBe(2);
		});
	});

	test("a second marked run opens a new counted turn even with no reply in between", () => {
		withHome((home) => {
			// Two prompts with different indices and nothing between them: the reducer
			// still appends them into one message (grok's own reducer only flushes on a
			// role change), but they are two counted turns, and the marker below proves
			// it — a rewind to turn 1 keeps the first prompt and loses the second.
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("first prompt", { runMeta: { promptIndex: 0 } })),
					acp(userChunk("sent before the reply landed", { runMeta: { promptIndex: 1 } })),
					acp(agentChunk("the reply")),
					xai(rewind(1)),
				],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual(["first prompt"]);
			expect(note(read, "dropped by a rewind marker")).toBe(2);
		});
	});

	test("a mid-turn phantom does not open a turn once the file has indices", () => {
		withHome((home) => {
			// The mirror of the fixture above. Here the file has `promptIndex` marks, so
			// an unmarked chunk is a phantom — text the model was sent inside a turn the
			// user already opened. Counting it would move the second turn's opening one
			// chunk earlier, and the rewind below would then drop the phantom and the
			// answer around it, which is a conversation the user never had.
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("turn zero", { runMeta: { promptIndex: 0 } })),
					acp(agentChunk("answer zero")),
					acp(userChunk("a reminder the model was sent")),
					acp(agentChunk("answer to the reminder")),
					acp(userChunk("turn one", { runMeta: { promptIndex: 1 } })),
					xai(rewind(1)),
				],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual([
				"turn zero",
				"answer zero",
				"a reminder the model was sent",
				"answer to the reminder",
			]);
			expect(note(read, "dropped by a rewind marker")).toBe(1);
		});
	});

	test("a rewind marker with no usable target truncates nothing and is counted", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("turn", { runMeta: { promptIndex: 0 } })),
					xai({ sessionUpdate: "rewind_marker", created_at: "2026-03-01T00:00:01Z" }),
					xai({ sessionUpdate: "rewind_marker", target_prompt_index: -1 }),
					// An ACP line wearing the rewind tag: grok only honours the marker on
					// its own extension method, and a reader that did not check would
					// truncate a conversation on a line from another namespace.
					acp(rewind(0)),
				],
			});
			const read = grokRead(grokHome(home));
			expect(messagesOf(read.entries).map(textOf)).toEqual(["turn"]);
			expect(note(read, "rewind marker with no prompt index")).toBe(2);
		});
	});
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

describe("migrate: grok compaction", () => {
	test("segments are read in index order, ahead of the messages, with no token count", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [acp(userChunk("after compaction", { runMeta: { promptIndex: 4 } }))],
				segments: {
					"segment_010.md": "# Segment 10\n\nlater work\n",
					"segment_002.md": "# Segment 2\n\nearly work\n",
					// grok's own index file and a name that is not a segment are not
					// conversation; `parse_segment_index` refuses both.
					"INDEX.md": "| Segment | File |\n",
					"notes.md": "scratch\n",
					// The same rule for the names that get past the shape check: the index is
					// digits and nothing else, so this one — a copy someone made by hand, or
					// a name a future grok stops writing — is not read as a segment either.
					// A reader that took any `segment_*.md` would import it beside the
					// segment it copies.
					"segment_backup.md": "# Segment copy\n\nstale hand-made copy\n",
				},
			});
			const read = grokRead(grokHome(home));
			expect(read.entries.map((entry) => entry.kind)).toEqual(["compaction", "compaction", "message"]);
			expect(read.entries[0]?.kind === "compaction" && read.entries[0].summary).toContain("early work");
			expect(read.entries[1]?.kind === "compaction" && read.entries[1].summary).toContain("later work");
			// The source records turns, tools and files in a segment, and no token
			// count at all — zero says "not measured" rather than "measured as none".
			expect(read.entries[0]?.kind === "compaction" && read.entries[0].preTokens).toBe(0);
		});
	});

	test("a checkpoint line is counted, and the transcript it shadows still arrives", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("before compaction", { runMeta: { promptIndex: 0 } })),
					acp(agentChunk("answer")),
					xai(checkpoint("ckpt-1", 1)),
					acp(userChunk("after compaction", { runMeta: { promptIndex: 1 } })),
				],
				segments: { "segment_001.md": "# Segment 1\n" },
			});
			const read = grokRead(grokHome(home));
			// The messages before the checkpoint are kept: the checkpoint file this
			// reader leaves alone holds the conversation grok replayed instead, and a
			// reader without that file would have to drop the turns it cannot rebuild.
			expect(messagesOf(read.entries).map(textOf)).toEqual(["before compaction", "answer", "after compaction"]);
			expect(note(read, "compaction checkpoint")).toBe(1);
		});
	});

	test("a resumed session keeps every message, and the summary, when the file is loaded", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [acp(userChunk("the only turn", { runMeta: { promptIndex: 0 } })), acp(agentChunk("the answer"))],
				segments: { "segment_001.md": "# Segment 1\n\nwhat came before\n" },
			});
			const listing = listHistory("grok-build", home, { cwd: CWD, scope: "all" });
			const read = readHistory("grok-build", home, listing.candidates);
			const session = read.sessions[0];
			expect(session).toBeDefined();
			const result = runMigration({
				home,
				from: "grok-build",
				only: ["history"],
				historyScope: "all",
				apply: true,
			});
			expect(result.error).toBeUndefined();
			const path = result.plan.writes.find((write) => write.kind === "history")?.path;
			expect(path).toBeDefined();
			const store = SessionStore.load(path ?? "");
			const context = store.contextMessages();
			// `contextMessages` resumes from the last compaction entry, so a summary
			// placed at the end of the transcript would leave a resumed session holding
			// nothing but the summary. At the front, the boundary is behind every
			// message and all of them travel.
			expect(context.length).toBe(3);
			expect(context[0]?.role).toBe("user");
			expect(textOf(context[0] as AgentMessage)).toContain("what came before");
			expect(context.slice(1).map(textOf)).toEqual(["the only turn", "the answer"]);
		});
	});
});

// ---------------------------------------------------------------------------
// Forks, prompt history and the migration around them
// ---------------------------------------------------------------------------

describe("migrate: grok forks and prompt history", () => {
	test("a fork is imported whole and the report names the parent it inherited from", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				id: "s-child",
				summary: summary({ session_kind: "fork", parent_session_id: "s-parent" }),
				// A fork's updates file is a line-for-line copy of its parent's with the
				// session id rewritten, so the inherited turns cannot be told apart from
				// the ones the user typed: there is no boundary marker to cut at, and
				// `inherited_prefix_len` counts conversation items, not messages.
				lines: [
					acp(userChunk("inherited question", { runMeta: { promptIndex: 0 } })),
					acp(agentChunk("inherited answer")),
					acp(userChunk("the fork's own question", { runMeta: { promptIndex: 1 } })),
				],
			});
			const read = grokRead(grokHome(home), "s-child");
			expect(messagesOf(read.entries).map(textOf)).toEqual([
				"inherited question",
				"inherited answer",
				"the fork's own question",
			]);
			expect(note(read, "forked from session s-parent: its inherited prefix is imported whole")).toBe(1);
		});
	});

	test("a project's prompt history converts, filtering what its own ↑ would not have offered", () => {
		withHome((home) => {
			const dir = join(grokHome(home), "sessions", encodeURIComponent(CWD));
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "prompt_history.jsonl"),
				`${[
					JSON.stringify({ timestamp: "2026-03-01T00:00:01Z", session_id: SESSION_ID, prompt: "fix the tests" }),
					JSON.stringify({
						timestamp: "2026-03-01T00:00:02Z",
						session_id: SESSION_ID,
						prompt: "! ls -la",
						is_bash: true,
					}),
					JSON.stringify({ timestamp: "2026-03-01T00:00:03Z", session_id: SESSION_ID, prompt: "/compact" }),
					JSON.stringify({
						timestamp: "2026-03-01T00:00:04Z",
						session_id: SESSION_ID,
						prompt: "[Pasted text #1 +42 lines]",
					}),
					JSON.stringify({ timestamp: "2026-03-01T00:00:05Z", session_id: SESSION_ID, prompt: "   " }),
					JSON.stringify({ timestamp: "2026-03-01T00:00:06Z", session_id: SESSION_ID, prompt: "and again" }),
				].join("\n")}\n`,
			);
			const prompts = readPromptHistory("grok-build", home, { cwd: CWD, scope: "cwd", limit: 100 });
			expect(prompts.entries.map((entry) => entry.text)).toEqual(["fix the tests", "and again"]);
			expect(prompts.entries.map((entry) => entry.cwd)).toEqual([CWD, CWD]);
			expect(prompts.entries[0]?.timestamp).toBe(Date.parse("2026-03-01T00:00:01Z"));
			expect(note(prompts, "`!` command")).toBe(1);
			expect(note(prompts, "slash command")).toBe(1);
			expect(note(prompts, "empty prompt")).toBe(1);
			expect(note(prompts, "prompt whose text was a pasted block, stored without its body")).toBe(1);
		});
	});

	test("under the cwd scope only this project's prompts are read, and under all, every project's", () => {
		withHome((home) => {
			const mine = join(grokHome(home), "sessions", encodeURIComponent(CWD));
			const theirs = join(grokHome(home), "sessions", encodeURIComponent(join(home, "other-project")));
			mkdirSync(theirs, { recursive: true });
			mkdirSync(mine, { recursive: true });
			const line = (prompt: string, extra: Record<string, unknown> = {}): string =>
				`${JSON.stringify({ timestamp: "2026-03-01T00:00:01Z", session_id: "s", prompt, ...extra })}\n`;
			writeFileSync(join(mine, "prompt_history.jsonl"), line("mine"));
			// The other project's file holds a line this reader would count as a skip.
			// Under the cwd scope it must not be read at all: `seen` and the notes
			// describe what was read, and a reader that walked every project's file
			// while the picker kept only this one would report the other project's
			// `!` commands as something it had looked at.
			writeFileSync(join(theirs, "prompt_history.jsonl"), line("theirs") + line("! ls -la", { is_bash: true }));
			const cwdScope = readPromptHistory("grok-build", home, { cwd: CWD, scope: "cwd", limit: 100 });
			expect(cwdScope.entries.map((entry) => entry.text)).toEqual(["mine"]);
			expect(cwdScope.seen).toBe(1);
			expect(note(cwdScope, "`!` command")).toBeUndefined();
			const all = readPromptHistory("grok-build", home, { cwd: CWD, scope: "all", limit: 100 });
			expect(all.entries.map((entry) => entry.text).sort()).toEqual(["mine", "theirs"]);
			expect(all.entries.find((entry) => entry.text === "theirs")?.cwd).toBe(join(home, "other-project"));
			expect(all.seen).toBe(3);
			expect(note(all, "`!` command")).toBe(1);
		});
	});

	test("a prompt history that names no directory is counted rather than attributed", () => {
		withHome((home) => {
			// A directory name that decodes to nothing absolute and has no `.cwd`
			// sidecar: grok would guess, and a guess here writes one project's prompt
			// into another project's recall list.
			const dir = join(grokHome(home), "sessions", "not-a-path");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "prompt_history.jsonl"),
				`${JSON.stringify({ timestamp: "2026-03-01T00:00:01Z", session_id: "s", prompt: "orphan" })}\n`,
			);
			const prompts = readPromptHistory("grok-build", home, { cwd: CWD, scope: "all", limit: 100 });
			expect(prompts.entries).toEqual([]);
			expect(note(prompts, "prompt history with no working directory recorded")).toBe(1);
		});
	});

	test("a source with no sessions tree contributes no history at all", () => {
		withHome((home) => {
			expect(listHistory("grok-build", home, { cwd: CWD, scope: "all" }).candidates).toEqual([]);
			const result = runMigration({ home, from: "grok-build", only: ["history"], historyScope: "all", apply: false });
			expect(result.error).toBeUndefined();
			expect(historyWrites(result, home)).toEqual([]);
		});
	});

	test("a home that exists but has no sessions still offers its prompts", () => {
		withHome((home) => {
			// The state a home is in after grok's session pruning, or after sessions
			// were removed by hand: the tree is there and holds prompt history, and no
			// session survives to be imported. Reading only the sessions would lose the
			// prompts in silence, which is the loss this asks about.
			const dir = join(grokHome(home), "sessions", encodeURIComponent(CWD));
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "prompt_history.jsonl"),
				`${JSON.stringify({ timestamp: "2026-03-01T00:00:01Z", session_id: "gone", prompt: "from a pruned session" })}\n`,
			);
			writeFileSync(join(grokHome(home), "config.toml"), 'model = "grok-4"\n');
			const listing = listHistory("grok-build", home, { cwd: CWD, scope: "all" });
			expect(listing.candidates).toEqual([]);
			const prompts = readPromptHistory("grok-build", home, { cwd: CWD, scope: "all", limit: 100 });
			expect([...prompts.entries.map((entry) => entry.text), prompts.seen]).toEqual(["from a pruned session", 1]);
			// And the run has to ask. The reader answers, but the plan decides which
			// sources are worth asking, and asking it for a session count first would
			// shut this home out — the prompts are the only thing it has to offer.
			const result = runMigration({ home, from: "grok-build", only: ["history"], historyScope: "all", apply: true });
			expect(result.error).toBeUndefined();
			const write = result.plan.writes.find((entry) => entry.kind === "prompt-history");
			expect(write?.content).toContain("from a pruned session");
		});
	});

	test("a session that went away between the listing and the read is reported, not rebuilt", () => {
		withHome((home) => {
			writeSession(grokHome(home), { lines: [acp(userChunk("go"))] });
			const listing = listHistory("grok-build", home, { cwd: CWD, scope: "all" });
			expect(listing.candidates.length).toBe(1);
			// The listing is a menu and the read happens after the user picks: between
			// the two, grok can prune the session. The candidate still names a path,
			// and a reader that trusted it would import a file that is not there — as
			// an empty transcript, which reads as "you said nothing".
			rmSync(join(grokHome(home), "sessions", encodeURIComponent(CWD), SESSION_ID), { recursive: true, force: true });
			const read = readHistory("grok-build", home, listing.candidates);
			expect(read.sessions).toEqual([]);
			expect(note(read, "session is no longer on disk")).toBe(1);
		});
	});

	test("a transcript that cannot be opened is reported against the session", () => {
		withHome((home) => {
			// A directory where the transcript should be: `existsSync` accepts it, so the
			// listing offers the session, and the read is where it turns out not to be
			// readable. That order is the point — the session is still listed by grok.
			const dir = join(grokHome(home), "sessions", encodeURIComponent(CWD), SESSION_ID);
			mkdirSync(join(dir, "updates.jsonl"), { recursive: true });
			writeFileSync(join(dir, "summary.json"), summary({}));
			const listing = listHistory("grok-build", home, { cwd: CWD, scope: "all" });
			expect(listing.candidates.length).toBe(1);
			const read = readHistory("grok-build", home, listing.candidates);
			expect(read.sessions).toEqual([]);
			expect(note(read, "session transcript could not be read")).toBe(1);
		});
	});

	test("the converted sessions land in the history of a home the source never sees", () => {
		withHome((home) => {
			writeSession(grokHome(home), {
				lines: [
					acp(userChunk("read notes.md", { runMeta: { promptIndex: 0 } }), 5),
					acp(agentChunk("Reading it."), 6),
					acp(toolStarted("c1", "read"), 7),
					acp(toolDone("c1"), 8),
					acp(agentChunk("Done."), 9),
				],
			});
			writeSession(grokHome(home), {
				id: "s-second",
				summary: summary({ info: { id: "s-second", cwd: CWD }, created_at: "2026-03-01T01:00:00Z" }),
				lines: [acp(userChunk("second session"))],
			});
			const before = snapshotTree(grokHome(home));

			const listing = listHistory("grok-build", home, { cwd: CWD, scope: "all" });
			const read = readHistory("grok-build", home, listing.candidates);
			expect(read.sessions.length).toBe(2);

			const result = runMigration({ home, from: "grok-build", only: ["history"], historyScope: "all", apply: true });
			expect(result.error).toBeUndefined();
			expect(historyWrites(result, home).length).toBe(2);

			for (const session of read.sessions) {
				const path = result.plan.writes.find((write) =>
					write.path.includes(importedSessionId("grok-build", session.sourceId)),
				)?.path;
				expect(path).toBeDefined();
				const store = SessionStore.load(path ?? "");
				expect(store.messages().length).toBe(messagesOf(session.entries).length);
				const header = store.linearEntries()[0];
				expect(header.type === "header" && header.cwd).toBe(CWD);
				expect(header.type === "header" && header.createdAt).toBe(session.startedAt);
			}
			expect(read.sessions.find((session) => session.sourceId === "s-second")?.startedAt).toBe(
				Date.parse("2026-03-01T01:00:00Z"),
			);

			// Reading a source must not touch it — not even a directory mtime.
			expect(snapshotTree(grokHome(home))).toEqual(before);
		});
	});
});
