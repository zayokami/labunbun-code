/**
 * What the Command Code importer carries out of `projects/<slug>/<id>.jsonl`,
 * and what it says about what it does not.
 *
 * The transcripts are written here line by line against the format the CLI's
 * own loader validates (`isSessionHeaderV3`/`isSessionEntryV3` in the bundle):
 * a header object, then entries chained by `parentId`. Four rules shape this
 * file, and each is a place where the easy implementation is the wrong one:
 *
 *   - **the file is a tree and the import is one path.** A session keeps every
 *     branch that was ever taken; `buildSessionPath` in the bundle walks from
 *     the newest entry up to the root, and so does the reader. Branches the
 *     session left are counted, not imported — the alternative is importing
 *     conversations the user abandoned;
 *   - **the header's `cwd` is the directory fact**, which is why none of this
 *     needs a slug-decode; a session with an empty `cwd` is dropped by
 *     `narrowCandidates` with the note every source shares, not by a guess;
 *   - **the prompt list has no per-entry ordering left to trust.** The product
 *     rewrites `history.jsonl` whole and stamps every line with the newest
 *     append's time, so the scan must walk the tail newest-first for the limit
 *     to take the newest end. That is a behaviour no single line proves, so it
 *     is tested with equal timestamps — the state the product actually writes;
 *   - **the gate is part of the importer.** `historySourcePresent` has its own
 *     `command-code` arm, and a test that only calls `listHistory`/`readHistory`
 *     would not exercise it; the last section goes through `runMigration`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentMessage, INTERRUPTED_TOOL_RESULT_TEXT } from "@labunbun/ai";
import { COMMAND_CODE_DEFAULT_DIR } from "../src/command-code-home.ts";
import { COMMAND_CODE_BRANCH_SUMMARY_LEAD, COMMAND_CODE_BRANCH_SUMMARY_TAIL } from "../src/command-code-session.ts";
import { runMigration } from "../src/migrate.ts";
import {
	type HistoryCandidate,
	type HistoryEntry,
	type HistoryNote,
	type HistoryScope,
	listHistory,
	readHistory,
	readPromptHistory,
} from "../src/migrate-history.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The fixtures' clock: every timestamp below is counted from here. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
/** The same clock in whole seconds, which is the unit `history.jsonl` stores. */
const sec = (seconds: number): number => Math.floor((T0 + seconds * 1000) / 1000);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

interface CcFixture {
	home: string;
	/** A real directory, because a candidate whose directory is gone is dropped before any reader sees it. */
	cwd: string;
}

function ccFixture(): CcFixture {
	return { home: makeDir("lbb-cc-hist-"), cwd: makeDir("lbb-cc-hist-cwd-") };
}

/** Write the lines of a session file, one JSON object per line. */
function sessionText(lines: unknown[]): string {
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** The v3 header, spelled the way `isSessionHeaderV3` validates it. */
function header(id: string, cwd: string, timestamp: string): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp, cwd };
}

/** One entry: the four validated fields, then whatever the type carries. */
function entry(
	id: string,
	parentId: string | null,
	type: string,
	rest: Record<string, unknown>,
	timestamp = at(1),
): Record<string, unknown> {
	return { type, id, parentId, timestamp, ...rest };
}

function messageEntry(
	id: string,
	parentId: string | null,
	role: string,
	content: unknown,
	options: { timestamp?: string; meta?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
	return entry(
		id,
		parentId,
		"message",
		{
			message: { role, content, ...(options.meta === undefined ? {} : { meta: options.meta }) },
			...(options.extra ?? {}),
		},
		options.timestamp ?? at(1),
	);
}

/** A text block, typed as the readers' `TextContent` so it can stand on either side of an `toEqual`. */
const text = (value: string): { type: "text"; text: string } => ({ type: "text", text: value });

/** Write a transcript under `projects/<slug>/`, with an optional meta sidecar. */
function writeSession(
	home: string,
	id: string,
	lines: unknown[],
	options: { meta?: Record<string, unknown>; slug?: string } = {},
): string {
	const dir = join(home, COMMAND_CODE_DEFAULT_DIR, "projects", options.slug ?? "proj-a");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, sessionText(lines));
	if (options.meta !== undefined) writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(options.meta));
	return path;
}

/** A raw file under `~/.commandcode/`, which is not a session. */
function writeRaw(home: string, relative: string, content: string): void {
	const path = join(home, COMMAND_CODE_DEFAULT_DIR, ...relative.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

const listing = (home: string, options: { cwd?: string; scope?: HistoryScope } = {}) =>
	listHistory("command-code", home, { cwd: options.cwd ?? "C:\\anywhere", scope: options.scope ?? "all" });

function candidateFor(home: string, id: string): HistoryCandidate {
	const found = listing(home).candidates.find((candidate) => candidate.sourceId === id);
	expect(found).toBeDefined();
	return found as HistoryCandidate;
}

function messagesOf(entries: HistoryEntry[]): AgentMessage[] {
	return entries.flatMap((item) => (item.kind === "message" ? [item.message] : []));
}

/** The text of a message's blocks, joined — every assertion below reads text this way. */
function textsOf(message: AgentMessage): string[] {
	// A user message may hold its content as one plain string rather than a
	// block array (`UserMessage.content: string | UserContent[]`), which is the
	// shape the branch-summary framing arrives in.
	const content = message.content;
	if (typeof content === "string") return [content];
	return content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

function noteCount(notes: HistoryNote[], needle: string): number {
	return notes.find((note) => note.reason.includes(needle))?.count ?? 0;
}

/** A session whose directory is real, so `narrowCandidates` keeps it. */
function simpleSession(home: string, cwd: string, id = "sess-1", seconds = 0): void {
	writeSession(home, id, [
		header(id, cwd, at(seconds)),
		messageEntry("e1", null, "user", [text("hello")], { timestamp: at(seconds) }),
	]);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("listing", () => {
	test("the header's cwd and timestamp are the candidate's, and the title comes from the sidecar", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "sess-1", [header("sess-1", cwd, at(0)), messageEntry("e1", null, "user", [text("hi")])], {
			meta: { title: "the title" },
		});
		const [candidate] = listing(home).candidates;
		expect(candidate.source).toBe("command-code");
		expect(candidate.sourceId).toBe("sess-1");
		expect(candidate.cwd).toBe(cwd);
		expect(candidate.startedAt).toBe(T0);
		expect(candidate.title).toBe("the title");
	});

	test("without a sidecar the title falls back the way the product's own list does: last session_info name, then first user text", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "a", [
			header("a", cwd, at(0)),
			entry("e1", null, "session_info", { name: "first name" }, at(0)),
			entry("e2", "e1", "session_info", { name: "second name" }, at(1)),
			messageEntry("e3", "e2", "user", [text("the words")], { timestamp: at(2) }),
		]);
		writeSession(home, "b", [
			header("b", cwd, at(0)),
			messageEntry("e1", null, "user", [text("   only   text  ")], { timestamp: at(0) }),
		]);
		const byId = new Map(listing(home).candidates.map((candidate) => [candidate.sourceId, candidate]));
		expect(byId.get("a")?.title).toBe("second name");
		expect(byId.get("b")?.title).toBe("only text");
	});

	test("the fallback text is one collapsed line, cut at sixty characters", () => {
		const { home, cwd } = ccFixture();
		const long = "x".repeat(80);
		writeSession(home, "long", [
			header("long", cwd, at(0)),
			messageEntry("e1", null, "user", [text(long)], { timestamp: at(0) }),
		]);
		const title = candidateFor(home, "long").title;
		expect(title).toHaveLength(60);
		expect(title.endsWith("…")).toBe(true);
	});

	test("an injected message is not a title: it was put in front of the model, not the user", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "meta", [
			header("meta", cwd, at(0)),
			messageEntry("e1", null, "user", [text("context nobody typed")], { timestamp: at(0), meta: { isMeta: true } }),
			messageEntry("e2", "e1", "user", [text("what was typed")], { timestamp: at(1) }),
		]);
		expect(candidateFor(home, "meta").title).toBe("what was typed");
	});

	test("a session started with `-p` is reported in the product's own terms and not offered", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "scripted", [header("scripted", cwd, at(0))], { meta: { entrypoint: "print" } });
		const listed = listing(home);
		expect(listed.candidates).toEqual([]);
		expect(noteCount(listed.notes, "`-p`")).toBe(1);
	});

	test("each way a first line can be wrong gets its own sentence, because they are different facts", () => {
		const cases: Array<{ id: string; text: string; needle: string }> = [
			{
				id: "old",
				text: sessionText([{ type: "session", version: 2, id: "old", timestamp: at(0), cwd: "C:\\x" }]),
				needle: "older format",
			},
			{
				id: "new",
				text: sessionText([{ type: "session", version: 4, id: "new", timestamp: at(0), cwd: "C:\\x" }]),
				needle: "newer format (version 4",
			},
			{ id: "notjson", text: "not json at all\n", needle: "first line is not JSON" },
			{
				id: "half",
				text: sessionText([{ type: "session", version: 3, id: "half", timestamp: at(0) }]),
				needle: "missing a field a version 3 header carries",
			},
		];
		for (const item of cases) {
			const { home } = ccFixture();
			writeRaw(home, `projects/proj-a/${item.id}.jsonl`, item.text);
			const listed = listing(home);
			expect(listed.candidates).toEqual([]);
			expect(noteCount(listed.notes, item.needle)).toBe(1);
		}
	});

	test("the sidecars that share the extension are not sessions", () => {
		const { home, cwd } = ccFixture();
		simpleSession(home, cwd);
		writeRaw(home, "projects/proj-a/sess-1.checkpoints.jsonl", "{}\n");
		writeRaw(home, "projects/proj-a/sess-1.prompts.jsonl", "{}\n");
		writeRaw(home, "projects/proj-a/sess-1.meta.json", "{}\n");
		expect(listing(home).candidates.map((candidate) => candidate.sourceId)).toEqual(["sess-1"]);
	});

	test("a session with no directory and one whose directory is gone are both dropped with the note every source shares", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "nowhere", [
			header("nowhere", "", at(0)),
			messageEntry("e1", null, "user", [text("x")], { timestamp: at(0) }),
		]);
		writeSession(home, "gone", [
			header("gone", join(home, "no-such-dir"), at(1)),
			messageEntry("e1", null, "user", [text("x")], { timestamp: at(1) }),
		]);
		simpleSession(home, cwd, "kept", 2);
		const listed = listing(home);
		expect(listed.candidates.map((candidate) => candidate.sourceId)).toEqual(["kept"]);
		expect(noteCount(listed.notes, "no working directory recorded")).toBe(1);
		expect(noteCount(listed.notes, "working directory no longer exists")).toBe(1);
	});

	test("scope cwd filters on the header's own directory, which the format requires to be there", () => {
		const { home, cwd } = ccFixture();
		const other = makeDir("lbb-cc-hist-other-");
		simpleSession(home, cwd, "here", 0);
		simpleSession(home, other, "elsewhere", 1);
		const listed = listing(home, { cwd, scope: "cwd" });
		expect(listed.candidates.map((candidate) => candidate.sourceId)).toEqual(["here"]);
		expect(noteCount(listed.notes, 'another project (scope is "cwd")')).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("reading a chosen session", () => {
	function readOne(home: string, id: string) {
		const candidate = candidateFor(home, id);
		return readHistory("command-code", home, [candidate]);
	}

	test("the active branch is the path from the newest entry up — a branch the session left is counted, not imported", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "branched", [
			header("branched", cwd, at(0)),
			messageEntry("e1", null, "user", [text("one")], { timestamp: at(1) }),
			messageEntry("e2", "e1", "assistant", [text("two")], { timestamp: at(2) }),
			messageEntry("e3", "e2", "user", [text("left behind")], { timestamp: at(3) }),
			messageEntry("e4", "e2", "assistant", [text("three")], { timestamp: at(4) }),
		]);
		const read = readOne(home, "branched");
		const messages = messagesOf(read.sessions[0].entries);
		expect(messages.flatMap(textsOf)).toEqual(["one", "two", "three"]);
		expect(noteCount(read.notes, "entry on a branch the session left")).toBe(1);
	});

	test("a tool call and its result pair up, and the result gets the call's name back", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "tools", [
			header("tools", cwd, at(0)),
			messageEntry("e1", null, "user", [text("read it")], { timestamp: at(1) }),
			messageEntry(
				"e2",
				"e1",
				"assistant",
				[{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/x" } }],
				{ timestamp: at(2) },
			),
			messageEntry(
				"e3",
				"e2",
				"user",
				[{ type: "tool_result", tool_use_id: "tu-1", content: "file body", is_error: true }],
				{ timestamp: at(3) },
			),
		]);
		const messages = messagesOf(readOne(home, "tools").sessions[0].entries);
		const call = messages.find((message) => message.role === "assistant");
		expect(call?.stopReason).toBe("toolUse");
		expect(call?.content).toEqual([
			{ type: "toolCall", id: "tu-1", name: "Read", arguments: JSON.stringify({ file_path: "/x" }) },
		]);
		const result = messages.find((message) => message.role === "toolResult");
		expect(result?.toolCallId).toBe("tu-1");
		// The name is copied from the call, because a result block carries none.
		expect(result?.toolName).toBe("Read");
		expect(result?.isError).toBe(true);
		expect(result?.content).toEqual([text("file body")]);
	});

	test("an unpaired call is answered and an unpaired result goes, and the count says so", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "unpaired", [
			header("unpaired", cwd, at(0)),
			messageEntry(
				"e1",
				null,
				"assistant",
				[text("with text"), { type: "tool_use", id: "tu-x", name: "Read", input: {} }],
				{ timestamp: at(1) },
			),
			messageEntry("e2", "e1", "user", [{ type: "tool_result", tool_use_id: "tu-other", content: "orphan" }], {
				timestamp: at(2),
			}),
		]);
		const read = readOne(home, "unpaired");
		const messages = messagesOf(read.sessions[0].entries);
		// The turn that asked for the tool keeps its words and its call; the orphan
		// result — an answer to nothing — is the only message that goes.
		expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
		expect(messages[0].role === "assistant" && messages[0].content).toEqual([
			text("with text"),
			{ type: "toolCall", id: "tu-x", name: "Read", arguments: "{}" },
		]);
		const answered = messages[1];
		if (answered.role !== "toolResult") throw new Error("expected the synthesized result");
		expect(answered.toolCallId).toBe("tu-x");
		expect(answered.toolName).toBe("Read");
		expect(answered.isError).toBe(true);
		expect(answered.content).toEqual([text(INTERRUPTED_TOOL_RESULT_TEXT)]);
		expect(noteCount(read.notes, "unpaired tool call or result")).toBe(2);
	});

	test("thinking keeps its signature, because a replay without it is one the provider rejects", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "think", [
			header("think", cwd, at(0)),
			messageEntry(
				"e1",
				null,
				"assistant",
				[
					{ type: "thinking", thinking: "hmm", signature: "sig-1" },
					{ type: "thinking", thinking: "unsigned" },
					text("answer"),
				],
				{ timestamp: at(1) },
			),
		]);
		const messages = messagesOf(readOne(home, "think").sessions[0].entries);
		expect(messages[0].content).toEqual([
			{ type: "thinking", thinking: "hmm", signature: "sig-1" },
			{ type: "thinking", thinking: "unsigned" },
			{ type: "text", text: "answer" },
		]);
		expect(messages[0].role === "assistant" && messages[0].stopReason).toBe("stop");
	});

	test("usage and model are read off the entry, where the product writes them", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "usage", [
			header("usage", cwd, at(0)),
			messageEntry("e1", null, "assistant", [text("answer")], {
				timestamp: at(1),
				extra: {
					usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 },
					model: "claude-sonnet-5",
					effort: "high",
				},
			}),
		]);
		const [message] = messagesOf(readOne(home, "usage").sessions[0].entries);
		expect(message.role === "assistant" && message.model).toBe("claude-sonnet-5");
		expect(message.role === "assistant" && message.usage).toEqual({
			input: 10,
			output: 20,
			cacheRead: 3,
			cacheWrite: 4,
		});
	});

	test("a compaction entry keeps its place in the transcript and the product's own measured size", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "compact", [
			header("compact", cwd, at(0)),
			messageEntry("e1", null, "user", [text("before")], { timestamp: at(1) }),
			entry("e2", "e1", "compaction", { summary: "the summary", tokensBefore: 1234 }, at(2)),
			messageEntry("e3", "e2", "user", [text("after")], { timestamp: at(3) }),
		]);
		const entries = readOne(home, "compact").sessions[0].entries;
		expect(entries.map((item) => item.kind)).toEqual(["message", "compaction", "message"]);
		expect(entries[1]).toEqual({ kind: "compaction", summary: "the summary", preTokens: 1234 });
	});

	test("a branch summary arrives wearing the product's own framing", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "branch", [
			header("branch", cwd, at(0)),
			entry("e1", null, "branch_summary", { summary: "the old work" }, at(1)),
		]);
		const [message] = messagesOf(readOne(home, "branch").sessions[0].entries);
		expect(message.role).toBe("user");
		expect(textsOf(message)).toEqual([
			`${COMMAND_CODE_BRANCH_SUMMARY_LEAD}the old work${COMMAND_CODE_BRANCH_SUMMARY_TAIL}`,
		]);
	});

	test("a custom message shows only when it was displayed, and an injected user message never does", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "custom", [
			header("custom", cwd, at(0)),
			messageEntry("e1", null, "user", [text("normal")], { timestamp: at(1) }),
			entry("e2", "e1", "custom_message", { customType: "x", content: "shown note", display: true }, at(2)),
			entry("e3", "e2", "custom_message", { customType: "x", content: "injected note" }, at(3)),
			messageEntry("e4", "e3", "user", [text("context")], { timestamp: at(4), meta: { isMeta: true } }),
		]);
		const read = readOne(home, "custom");
		expect(messagesOf(read.sessions[0].entries).flatMap(textsOf)).toEqual(["normal", "shown note"]);
		expect(noteCount(read.notes, "the product injects rather than shows")).toBe(2);
	});

	test("the five bookkeeping types become no message at all, and the count names them for what they are", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "book", [
			header("book", cwd, at(0)),
			entry("e1", null, "model_change", { model: "m" }, at(1)),
			entry("e2", "e1", "effort_change", { effort: "high" }, at(2)),
			entry("e3", "e2", "label", { label: "l" }, at(3)),
			entry("e4", "e3", "session_info", { name: "n" }, at(4)),
			entry("e5", "e4", "custom", { data: 1 }, at(5)),
		]);
		const read = readOne(home, "book");
		// No session at all, by `readHistory`'s rule for every source: a session
		// whose every entry was bookkeeping is reported by why rather than offered
		// as an empty transcript.
		expect(read.sessions).toEqual([]);
		expect(noteCount(read.notes, "bookkeeping entry")).toBe(5);
	});

	test("a base64 image is carried; a URL image is a reference this build cannot fetch and is counted", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "images", [
			header("images", cwd, at(0)),
			messageEntry(
				"e1",
				null,
				"user",
				[
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
					{ type: "image", source: { type: "url", url: "https://example.com/i.png" } },
				],
				{ timestamp: at(1) },
			),
		]);
		const read = readOne(home, "images");
		expect(messagesOf(read.sessions[0].entries)[0].content).toEqual([
			{ type: "image", mimeType: "image/png", data: "aGk=" },
		]);
		expect(noteCount(read.notes, "not base64 with a mime type")).toBe(1);
	});

	test("a tool result with nothing in it reads as the placeholder the messages API needs", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "empty-result", [
			header("empty-result", cwd, at(0)),
			messageEntry("e1", null, "assistant", [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }], {
				timestamp: at(1),
			}),
			messageEntry("e2", "e1", "user", [{ type: "tool_result", tool_use_id: "tu-1", content: "" }], {
				timestamp: at(2),
			}),
		]);
		const result = messagesOf(readOne(home, "empty-result").sessions[0].entries).find(
			(message) => message.role === "toolResult",
		);
		expect(result?.content).toEqual([text("(no output recorded)")]);
	});

	test("a message with no content blocks and an empty compaction are counted, not imported as blanks", () => {
		const { home, cwd } = ccFixture();
		writeSession(home, "blanks", [
			header("blanks", cwd, at(0)),
			messageEntry("e1", null, "user", [], { timestamp: at(1) }),
			entry("e2", "e1", "compaction", { summary: "", tokensBefore: 5 }, at(2)),
			messageEntry("e3", "e2", "system", [text("roleless")], { timestamp: at(3) }),
			messageEntry("e4", "e3", "user", [text("kept")], { timestamp: at(4) }),
		]);
		const read = readOne(home, "blanks");
		expect(messagesOf(read.sessions[0].entries).flatMap(textsOf)).toEqual(["kept"]);
		expect(noteCount(read.notes, "message with no content blocks")).toBe(1);
		expect(noteCount(read.notes, "compaction entry that recorded no summary")).toBe(1);
		expect(noteCount(read.notes, "`system` message, which this build has no role for")).toBe(1);
	});

	test("lines that are not version 3 entries are counted under one note", () => {
		const { home, cwd } = ccFixture();
		// Written by hand, because two of the four lines must be genuinely bad
		// text: a raw string passed to `sessionText` would be stringified into a
		// valid JSON string and test a different branch than the one claimed.
		const dir = join(home, COMMAND_CODE_DEFAULT_DIR, "projects", "proj-a");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "garbled.jsonl"),
			`${[
				JSON.stringify(header("garbled", cwd, at(0))),
				JSON.stringify(messageEntry("e1", null, "user", [text("kept")], { timestamp: at(1) })),
				"this is not json",
				JSON.stringify({ type: "bogus", id: "x", parentId: null, timestamp: at(2) }),
			].join("\n")}\n`,
		);
		const read = readOne(home, "garbled");
		expect(messagesOf(read.sessions[0].entries).flatMap(textsOf)).toEqual(["kept"]);
		expect(noteCount(read.notes, "line that is not a version 3 entry")).toBe(2);
	});

	test("a drop in the middle shifts nothing: the entry list is built from the repaired stream", () => {
		// The repair can still remove a whole message — an unpaired result — and an
		// entry list laid back over the *pre-repair* slots would hand the dropped
		// slot's message to the next entry and end on an entry with no message at
		// all.
		const { home, cwd } = ccFixture();
		writeSession(home, "mid-drop", [
			header("mid-drop", cwd, at(0)),
			messageEntry("e1", null, "user", [text("one")], { timestamp: at(1) }),
			messageEntry("e2", "e1", "user", [{ type: "tool_result", tool_use_id: "tu-other", content: "orphan" }], {
				timestamp: at(2),
			}),
			messageEntry("e3", "e2", "user", [text("two")], { timestamp: at(3) }),
		]);
		const read = readOne(home, "mid-drop");
		const entries = read.sessions[0].entries;
		expect(entries.map((item) => item.kind)).toEqual(["message", "message"]);
		expect(messagesOf(entries).flatMap(textsOf)).toEqual(["one", "two"]);
		expect(noteCount(read.notes, "unpaired tool call or result")).toBeGreaterThan(0);
	});

	test("when the repair changes the stream, a compaction mark moves to the end rather than land mid-stream", () => {
		// The documented trade (the dsh and ZCode readers make the same one): a
		// marker's exact offset is unrecoverable once a message is gone or a
		// synthetic result inserted, and a marker claiming the wrong boundary
		// would misstate which turns the product summarized.
		const { home, cwd } = ccFixture();
		writeSession(home, "mark-trade", [
			header("mark-trade", cwd, at(0)),
			messageEntry("e1", null, "user", [text("one")], { timestamp: at(1) }),
			entry("e2", "e1", "compaction", { summary: "sum", tokensBefore: 9 }, at(2)),
			messageEntry("e3", "e2", "assistant", [{ type: "tool_use", id: "tu-x", name: "Read", input: {} }], {
				timestamp: at(3),
			}),
			messageEntry("e4", "e3", "user", [text("two")], { timestamp: at(4) }),
		]);
		const entries = readOne(home, "mark-trade").sessions[0].entries;
		expect(entries.map((item) => item.kind)).toEqual(["message", "message", "message", "message", "compaction"]);
		expect(messagesOf(entries).flatMap(textsOf)).toEqual(["one", INTERRUPTED_TOOL_RESULT_TEXT, "two"]);
	});

	test("a session that moved since the listing is reported by that fact", () => {
		const { home, cwd } = ccFixture();
		const path = writeSession(home, "moved", [
			header("moved", cwd, at(0)),
			messageEntry("e1", null, "user", [text("x")], { timestamp: at(1) }),
		]);
		const candidate = candidateFor(home, "moved");
		rmSync(path);
		const read = readHistory("command-code", home, [candidate]);
		// The reader holds no entries and a reason, so `readHistory` reports the
		// reason and offers no session — the same shape as any unreadable file.
		expect(read.sessions).toEqual([]);
		expect(noteCount(read.notes, "could not be read — it moved or was removed since the listing")).toBe(1);
	});

	test("a file that changed under the listing and is no longer a version 3 transcript is reported as that", () => {
		const { home, cwd } = ccFixture();
		const path = writeSession(home, "changed", [
			header("changed", cwd, at(0)),
			messageEntry("e1", null, "user", [text("x")], { timestamp: at(1) }),
		]);
		const candidate = candidateFor(home, "changed");
		writeFileSync(path, sessionText([{ type: "session", version: 2, id: "changed", timestamp: at(0), cwd }]));
		const read = readHistory("command-code", home, [candidate]);
		expect(noteCount(read.notes, "no longer a version 3 transcript")).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Prompt history
// ---------------------------------------------------------------------------

describe("the ↑ recall list", () => {
	const promptsFile = (home: string, lines: Array<Record<string, unknown>>): void => {
		writeRaw(home, "history.jsonl", `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	};

	test("every line carries the newest append's time, so the limit takes the end the product itself writes last", () => {
		const { home, cwd } = ccFixture();
		// The state the product actually leaves behind: one `t` for the whole
		// file, and the file order — oldest first — as the only ordering left.
		promptsFile(home, [
			{ p: "one", t: sec(0) },
			{ p: "two", t: sec(0) },
			{ p: "three", t: sec(0) },
			{ p: "four", t: sec(0) },
		]);
		const read = readPromptHistory("command-code", home, { cwd, scope: "all", limit: 2 });
		expect(read.seen).toBe(4);
		expect(read.entries.map((prompt) => prompt.text)).toEqual(["four", "three"]);
		expect(read.overLimit).toBe(2);
	});

	test("with real timestamps the newest end wins and the entries come back oldest first", () => {
		const { home, cwd } = ccFixture();
		promptsFile(home, [
			{ p: "one", t: sec(1) },
			{ p: "two", t: sec(2) },
			{ p: "three", t: sec(3) },
		]);
		const read = readPromptHistory("command-code", home, { cwd, scope: "all", limit: 2 });
		expect(read.entries.map((prompt) => prompt.text)).toEqual(["two", "three"]);
		expect(read.overLimit).toBe(1);
	});

	test("the legacy `text` key is read, and `p` wins when both are present", () => {
		const { home, cwd } = ccFixture();
		promptsFile(home, [
			{ text: "legacy", t: sec(1) },
			{ p: "both", text: "ignored", t: sec(2) },
		]);
		const read = readPromptHistory("command-code", home, { cwd, scope: "all", limit: 10 });
		expect(read.entries.map((prompt) => prompt.text).sort()).toEqual(["both", "legacy"]);
	});

	test("empties, slash commands and the product's own two paste tokens are left behind and counted by reason", () => {
		const { home, cwd } = ccFixture();
		promptsFile(home, [
			{ p: "   ", t: sec(0) },
			{ p: "/compact", t: sec(0) },
			{ p: "[preview +42L]", t: sec(0) },
			{ p: "[Image #1]", t: sec(0) },
			{ p: "keep [preview +42L] mid", t: sec(0) },
			{ p: "good", t: sec(0) },
		]);
		const read = readPromptHistory("command-code", home, { cwd, scope: "all", limit: 10 });
		// `keep … mid` is a real prompt that merely contains a token; the anchored
		// pattern is what tells the two apart.
		expect(read.entries.map((prompt) => prompt.text)).toEqual(["good", "keep [preview +42L] mid"]);
		expect(noteCount(read.notes, "empty prompt")).toBe(1);
		expect(noteCount(read.notes, "slash command")).toBe(1);
		expect(noteCount(read.notes, "collapsed paste")).toBe(1);
		expect(noteCount(read.notes, "only a pasted image")).toBe(1);
	});

	test("nothing in the list records where a prompt was typed, so every entry is filed under the run's directory and marked", () => {
		const { home, cwd } = ccFixture();
		promptsFile(home, [{ p: "hello", t: sec(1) }]);
		const read = readPromptHistory("command-code", home, { cwd, scope: "all", limit: 10 });
		expect(read.entries[0].cwd).toBe(cwd);
		expect(read.cwdSubstitute).toBe(cwd);
	});

	test("scope cwd cannot narrow this source, and the note says why rather than pretending it did", () => {
		const { home, cwd } = ccFixture();
		promptsFile(home, [{ p: "hello", t: sec(1) }]);
		const read = readPromptHistory("command-code", home, { cwd, scope: "cwd", limit: 10 });
		expect(read.entries).toHaveLength(1);
		expect(noteCount(read.notes, "cannot narrow this source")).toBe(1);
	});

	test("no list at all is the ordinary state of a home that never had one, not a failure", () => {
		const { home, cwd } = ccFixture();
		const read = readPromptHistory("command-code", home, { cwd, scope: "all", limit: 10 });
		expect(read).toEqual({ seen: 0, entries: [], notes: [], overLimit: 0, truncated: false });
	});

	test("a line that is not in the history shape is counted, not recalled", () => {
		const { home, cwd } = ccFixture();
		writeRaw(
			home,
			"history.jsonl",
			`not json\n${JSON.stringify({ p: 42, t: sec(1) })}\n${JSON.stringify({ p: "ok", t: sec(2) })}\n`,
		);
		const read = readPromptHistory("command-code", home, { cwd, scope: "all", limit: 10 });
		expect(read.entries.map((prompt) => prompt.text)).toEqual(["ok"]);
		expect(read.seen).toBe(1);
		expect(noteCount(read.notes, "line not in the history shape")).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("through runMigration", () => {
	test("a home with sessions plans history writes — the gate answers for command-code, not for a neighbour", () => {
		// Every other test here calls the readers directly, which is the wrong
		// level to prove the importer works: `runMigration` first asks
		// `historySourcePresent` whether the source is worth walking, and a
		// missing arm would silently report zero sessions while all of them pass.
		const { home, cwd } = ccFixture();
		writeSession(home, "sess-1", [
			header("sess-1", cwd, at(0)),
			messageEntry("e1", null, "user", [text("hello from the session")], { timestamp: at(1) }),
		]);
		writeRaw(home, "history.jsonl", `${JSON.stringify({ p: "a recalled prompt", t: sec(2) })}\n`);
		const result = runMigration({
			home,
			cwd,
			from: "command-code",
			only: ["history"],
			historyScope: "all",
			apply: false,
		});
		expect(result.error).toBeUndefined();
		const historyWrites = result.plan.writes.filter((write) => write.kind === "history");
		expect(historyWrites).toHaveLength(1);
		expect(historyWrites[0].content).toContain("hello from the session");
		const promptWrites = result.plan.writes.filter((write) => write.kind === "prompt-history");
		expect(promptWrites).toHaveLength(1);
		expect(promptWrites[0].content).toContain("a recalled prompt");
	});

	test("an empty home plans no history and no prompts", () => {
		const home = makeDir("lbb-cc-hist-empty-");
		const cwd = makeDir("lbb-cc-hist-empty-cwd-");
		const result = runMigration({
			home,
			cwd,
			from: "command-code",
			only: ["history"],
			historyScope: "all",
			apply: false,
		});
		expect(result.error).toBeUndefined();
		expect(result.plan.writes.filter((write) => write.kind === "history" || write.kind === "prompt-history")).toEqual(
			[],
		);
	});
});
