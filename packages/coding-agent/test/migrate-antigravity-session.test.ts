/**
 * `antigravity-session.ts`: what one `brain/<id>/` conversation imports as.
 *
 * Every test here is pinned to a claim the module makes about the product, and
 * the four load-bearing ones are these:
 *
 *   - **`source` is the role field, not `role` and not `type`.** The product's own
 *     record carries `source`, and its `CortexStepType` enum has 122 values that
 *     overlap both roles. The negative tests below exist to make a reader that
 *     switched on the wrong field fail: a `type: "USER_INPUT"` line whose `source`
 *     is `MODEL` must come out as the *assistant*.
 *   - **There are two user sources, not one** — `USER_EXPLICIT` and
 *     `USER_IMPLICIT` — and the importer must treat both as a person typing.
 *   - **A tool call has no result beside it.** The record has `tool_calls` and no
 *     `tool_results`, so the call and its output are both dropped rather than
 *     imported unpaired, and the count says so.
 *   - **A compact line can be cut, and the full file is the untruncation of the
 *     same record.** `truncated_fields` is what says so, per line.
 *
 * Fixtures hold fake values only. Nothing here opens a real Antigravity install,
 * and `~/.gemini` under the temporary directory is the only `.gemini` these tests
 * ever see.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import { antigravityTranscriptPaths } from "../src/antigravity-home.ts";
import {
	ANTIGRAVITY_USER_SOURCES,
	listAntigravityConversations,
	readAntigravityConversation,
} from "../src/antigravity-session.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A data root holding one conversation whose transcript holds `lines`.
 *
 * The compact transcript is written from `lines`; `fullLines` goes to
 * `transcript_full.jsonl`, and leaving it out is how a test says "this
 * conversation has no full transcript" rather than "this one has an empty one".
 */
function conversation(
	lines: unknown[],
	fullLines?: unknown[],
): {
	dataDir: string;
	dir: string;
	path: string;
	fullPath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "lbb-ag-session-"));
	made.push(root);
	const dir = join(root, "brain", "conv-1");
	const [compact, full] = antigravityTranscriptPaths(dir);
	mkdirSync(join(dir, ".system_generated", "logs"), { recursive: true });
	writeFileSync(compact, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	if (fullLines !== undefined)
		writeFileSync(full, `${fullLines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return { dataDir: root, dir, path: compact, fullPath: fullLines === undefined ? "" : full };
}

/** A record in the vendor's own spelling, with the fields that are always present. */
function record(over: Record<string, unknown>): Record<string, unknown> {
	return { type: "GENERIC", status: "DONE", ...over };
}

// ---------------------------------------------------------------------------
// Helpers for reading the result
// ---------------------------------------------------------------------------

function read(lines: unknown[], fullLines?: unknown[]) {
	const file = conversation(lines, fullLines);
	const [listed] = listAntigravityConversations(file.dataDir).conversations;
	const result = readAntigravityConversation(listed ?? { ...file, id: "conv-1", startedAt: 0 });
	if ("error" in result) throw new Error(`unexpected read failure: ${result.error}`);
	return result;
}

function roles(messages: AgentMessage[]): string[] {
	return messages.map((message) => message.role);
}

function textOf(message: AgentMessage | undefined): string {
	if (message === undefined || message.role !== "assistant") return "";
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

function thinkingOf(message: AgentMessage | undefined): string[] {
	if (message === undefined || message.role !== "assistant") return [];
	return message.content.filter((part) => part.type === "thinking").map((part) => part.thinking);
}

function noteReasons(notes: Array<{ reason: string }>): string {
	return notes.map((note) => note.reason).join(" | ");
}

// ---------------------------------------------------------------------------
// `source` is the role field
// ---------------------------------------------------------------------------

test("both user sources are a person typing, and the model source is the answer", () => {
	expect([...ANTIGRAVITY_USER_SOURCES].sort()).toEqual(["USER_EXPLICIT", "USER_IMPLICIT"]);
	const { messages } = read([
		record({ step_index: 0, source: "USER_EXPLICIT", content: "typed" }),
		record({ step_index: 1, source: "USER_IMPLICIT", content: "implied" }),
		record({ step_index: 2, source: "MODEL", content: "answered" }),
	]);
	expect(roles(messages)).toEqual(["user", "user", "assistant"]);
	expect(messages[0].role === "user" && messages[0].content).toBe("typed");
	expect(textOf(messages[2])).toBe("answered");
});

/**
 * The negative that pins the *field*, not just the values.
 *
 * `CortexStepType` has 122 members including `USER_INPUT`, so a reader that
 * switched on `type` would get this conversation backwards while passing every
 * test above it. Here `type` says `USER_INPUT` on every line and only `source`
 * tells the truth.
 */
test("a line whose type says USER_INPUT but whose source says MODEL is the assistant's", () => {
	const { messages } = read([
		record({ step_index: 0, source: "USER_EXPLICIT", content: "question" }),
		record({ step_index: 1, source: "MODEL", type: "USER_INPUT", content: "answer" }),
	]);
	expect(roles(messages)).toEqual(["user", "assistant"]);
	expect(textOf(messages[1])).toBe("answer");
});

test("a line with no source at all is not a user turn, however its type reads", () => {
	const { messages, notes } = read([
		record({ step_index: 0, source: "USER_EXPLICIT", content: "question" }),
		record({ step_index: 1, type: "USER_INPUT", content: "no source stated" }),
	]);
	expect(roles(messages)).toEqual(["user"]);
	expect(noteReasons(notes)).toContain("source is not a user turn or a model answer");
});

test("the product's own system prompts are counted and dropped, not imported as prompts", () => {
	const { messages, notes } = read([
		record({ step_index: 0, source: "SYSTEM", content: "you are antigravity" }),
		record({ step_index: 1, source: "SYSTEM_SDK", content: "sdk prompt" }),
		record({ step_index: 2, source: "USER_EXPLICIT", content: "hi" }),
	]);
	expect(roles(messages)).toEqual(["user"]);
	// Two records, one reason — the count has to be the number of records, or a
	// report line understates what was left out.
	expect(notes.find((note) => note.reason.includes("source is not a user turn"))?.count).toBe(2);
});

test("a source value this build has never heard of is dropped, not treated as a user", () => {
	const { messages, notes } = read([
		record({ step_index: 0, source: "SOMETHING_NEW_IN_A_LATER_BUILD", content: "?" }),
		record({ step_index: 1, source: "USER_EXPLICIT", content: "hi" }),
	]);
	expect(roles(messages)).toEqual(["user"]);
	expect(noteReasons(notes)).toContain("source is not a user turn or a model answer");
});

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

test("a thinking run belongs to the answer that follows it, as one message", () => {
	const { messages } = read([
		record({ step_index: 0, source: "USER_EXPLICIT", content: "q" }),
		record({ step_index: 1, source: "MODEL", thinking: "considering" }),
		record({ step_index: 2, source: "MODEL", thinking: "still considering" }),
		record({ step_index: 3, source: "MODEL", content: "a" }),
	]);
	expect(roles(messages)).toEqual(["user", "assistant"]);
	expect(thinkingOf(messages[1])).toEqual(["considering", "still considering"]);
	expect(textOf(messages[1])).toBe("a");
});

test("a thinking run with no answer after it is its own message rather than a loss", () => {
	const { messages } = read([
		record({ step_index: 0, source: "USER_EXPLICIT", content: "q" }),
		record({ step_index: 1, source: "MODEL", thinking: "interrupted mid-thought" }),
	]);
	expect(roles(messages)).toEqual(["user", "assistant"]);
	expect(thinkingOf(messages[1])).toEqual(["interrupted mid-thought"]);
	expect(textOf(messages[1])).toBe("");
});

test("a user turn after a thinking run does not steal it", () => {
	const { messages } = read([
		record({ step_index: 0, source: "MODEL", thinking: "belongs to the turn that never landed" }),
		record({ step_index: 1, source: "USER_EXPLICIT", content: "new question" }),
		record({ step_index: 2, source: "MODEL", content: "answer to the new one" }),
	]);
	expect(roles(messages)).toEqual(["assistant", "user", "assistant"]);
	expect(thinkingOf(messages[0])).toEqual(["belongs to the turn that never landed"]);
	expect(textOf(messages[0])).toBe("");
	expect(textOf(messages[2])).toBe("answer to the new one");
	expect(thinkingOf(messages[2])).toEqual([]);
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

test("a cut line is recovered from the full transcript at the same step", () => {
	const { messages, notes } = read(
		[
			record({ step_index: 0, source: "USER_EXPLICIT", content: "q" }),
			record({ step_index: 1, source: "MODEL", content: "first thirty…", truncated_fields: ["content"] }),
		],
		[
			record({ step_index: 0, source: "USER_EXPLICIT", content: "q" }),
			record({ step_index: 1, source: "MODEL", content: "the whole sentence, which is longer than the cut one" }),
		],
	);
	expect(textOf(messages[1])).toBe("the whole sentence, which is longer than the cut one");
	expect(noteReasons(notes)).not.toContain("is not in transcript_full.jsonl");
});

test("a cut thinking run is recovered too, not only a cut answer", () => {
	const { messages } = read(
		[
			record({ step_index: 0, source: "MODEL", thinking: "trunc…", truncated_fields: ["thinking"] }),
			record({ step_index: 1, source: "MODEL", content: "answer" }),
		],
		[
			record({ step_index: 0, source: "MODEL", thinking: "the whole reasoning run, untruncated" }),
			record({ step_index: 1, source: "MODEL", content: "answer" }),
		],
	);
	expect(thinkingOf(messages[0])).toEqual(["the whole reasoning run, untruncated"]);
	expect(textOf(messages[0])).toBe("answer");
});

test("a cut line with no counterpart in the full file imports as it stands, counted", () => {
	const { messages, notes } = read(
		[
			record({ step_index: 0, source: "MODEL", content: "cut…", truncated_fields: ["content"] }),
			record({ step_index: 7, source: "MODEL", content: "a different step" }),
		],
		[record({ step_index: 7, source: "MODEL", content: "a different step" })],
	);
	expect(textOf(messages[0])).toBe("cut…");
	expect(noteReasons(notes)).toContain("is not in transcript_full.jsonl");
});

test("the full file is not consulted when no line says it was cut", () => {
	const { messages } = read(
		[
			record({ step_index: 0, source: "MODEL", content: "compact answer" }),
			record({ step_index: 1, source: "MODEL", content: "cut…", truncated_fields: ["content"] }),
		],
		[
			record({ step_index: 0, source: "MODEL", content: "SHOULD NOT BE USED" }),
			record({ step_index: 1, source: "MODEL", content: "recovered" }),
		],
	);
	expect(textOf(messages[0])).toBe("compact answer");
	expect(textOf(messages[1])).toBe("recovered");
});

// ---------------------------------------------------------------------------
// What is dropped
// ---------------------------------------------------------------------------

test("a tool call with no result beside it is dropped and counted", () => {
	const { messages, notes } = read([
		record({ step_index: 0, source: "USER_EXPLICIT", content: "q" }),
		record({ step_index: 1, source: "MODEL", content: "ran it", tool_calls: [{ name: "run", args: { cmd: "ls" } }] }),
	]);
	// The message survives with its text; what must not appear is a tool call with
	// no result, which fails the API on the first `--continue`.
	expect(roles(messages)).toEqual(["user", "assistant"]);
	expect(textOf(messages[1])).toBe("ran it");
	expect(JSON.stringify(messages)).not.toContain('"toolCall"');
	expect(notes.find((note) => note.reason.includes("tool call with no result"))?.count).toBe(1);
});

test("an attachment the turn names is counted and never opened", () => {
	const { messages, notes } = read([
		record({
			step_index: 0,
			source: "USER_EXPLICIT",
			content: "look",
			media: [{ mime_type: "image/png", uri: "file:///etc/passwd" }],
		}),
	]);
	expect(messages[0].role === "user" && messages[0].content).toBe("look");
	expect(noteReasons(notes)).toContain("attachment named by the transcript");
	expect(noteReasons(notes)).not.toContain("file:///etc/passwd");
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("lines are ordered by step_index, not by where they sit in the file", () => {
	const { messages } = read([
		record({ step_index: 2, source: "MODEL", content: "second" }),
		record({ step_index: 0, source: "USER_EXPLICIT", content: "first" }),
		record({ step_index: 1, source: "MODEL", content: "middle" }),
	]);
	expect(roles(messages)).toEqual(["user", "assistant", "assistant"]);
	expect(messages[0].role === "user" && messages[0].content).toBe("first");
	expect(textOf(messages[1])).toBe("middle");
	expect(textOf(messages[2])).toBe("second");
});

test("a file whose lines are only partly indexed keeps file order and loses nothing", () => {
	const { messages } = read([
		record({ source: "USER_EXPLICIT", content: "no index" }),
		record({ step_index: 9, source: "MODEL", content: "indexed" }),
	]);
	// Sorting on a key half the file lacks would interleave the two halves by a
	// rule neither was written under; the guarantee here is that nothing is lost.
	expect(roles(messages)).toEqual(["user", "assistant"]);
	expect(messages[0].role === "user" && messages[0].content).toBe("no index");
	expect(textOf(messages[1])).toBe("indexed");
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test("a line that is not JSON, an array, or an object is counted and the rest still imports", () => {
	const file = conversation([record({ step_index: 0, source: "USER_EXPLICIT", content: "kept" })]);
	// Three different wrong shapes: unparseable, JSON but not an object, and JSON
	// whose top level is an array. A reader that only tried `JSON.parse` would let
	// the last two through and then read `record.source` off an array.
	writeFileSync(file.path, `${readFileSync(file.path, "utf8")}not json at all\n[1,2,3]\n"a string"\n`, "utf8");
	const [listed] = listAntigravityConversations(file.dataDir).conversations;
	if (listed === undefined) throw new Error("the fixture wrote a transcript the listing did not offer");
	const result = readAntigravityConversation(listed);
	if ("error" in result) throw new Error(result.error);
	expect(roles(result.messages)).toEqual(["user"]);
	expect(badLineCount(result.notes)).toBe(3);
});

test("a transcript with nothing in it is reported by why, not as an empty conversation", () => {
	const { messages, notes } = read([]);
	expect(messages).toEqual([]);
	expect(noteReasons(notes)).toContain("holds no record");
	expect(noteReasons(notes)).toContain("tool call as a step");
});

test("an unparseable created_at leaves the start time unset rather than throwing", () => {
	const { messages, startedAt } = read([
		record({ step_index: 0, source: "USER_EXPLICIT", content: "q", created_at: "not a time" }),
		record({ step_index: 1, source: "MODEL", content: "a", created_at: "2026-09-01T10:00:00Z" }),
	]);
	expect(roles(messages)).toEqual(["user", "assistant"]);
	expect(startedAt).toBe(Date.parse("2026-09-01T10:00:00Z"));
});

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

test("the listing reads a start time from the head, so the picker can sort", () => {
	const file = conversation([
		record({ step_index: 0, source: "USER_EXPLICIT", content: "q", created_at: "2026-09-01T10:00:00Z" }),
		record({ step_index: 1, source: "MODEL", content: "a", created_at: "2026-09-01T10:00:05Z" }),
	]);
	const [listed] = listAntigravityConversations(file.dataDir).conversations;
	expect(listed?.startedAt).toBe(Date.parse("2026-09-01T10:00:00Z"));
});

test("the listing offers only conversations that have a transcript", () => {
	const root = mkdtempSync(join(tmpdir(), "lbb-ag-list-"));
	made.push(root);
	const brain = join(root, "brain");
	mkdirSync(join(brain, "with-transcript", ".system_generated", "logs"), { recursive: true });
	writeFileSync(
		join(brain, "with-transcript", ".system_generated", "logs", "transcript.jsonl"),
		`${JSON.stringify(record({ source: "USER_EXPLICIT", content: "hi" }))}\n`,
	);
	mkdirSync(join(brain, "empty-one"), { recursive: true });
	writeFileSync(join(brain, "a-stray-file"), "not a conversation");

	const listed = listAntigravityConversations(root);
	expect(listed.conversations.map((one) => one.id)).toEqual(["with-transcript"]);
	const reasons = noteReasons(listed.notes);
	expect(reasons).toContain("conversation with no transcript at .system_generated/logs/transcript.jsonl");
	expect(reasons).toContain("file directly under the conversations tree");
});

test("a conversation with no full transcript says so with an empty path", () => {
	const file = conversation([record({ source: "USER_EXPLICIT", content: "hi" })]);
	const [listed] = listAntigravityConversations(file.dataDir).conversations;
	expect(listed?.fullPath).toBe("");
	expect(listed?.path.endsWith("transcript.jsonl")).toBe(true);
});

test("a data root with no brain at all lists nothing and says nothing", () => {
	const root = mkdtempSync(join(tmpdir(), "lbb-ag-nobrain-"));
	made.push(root);
	const listed = listAntigravityConversations(root);
	expect(listed.conversations).toEqual([]);
	expect(listed.notes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Helpers used above, declared late so the fixtures read first
// ---------------------------------------------------------------------------

/** How many lines the reader rejected as "not a JSON object". */
function badLineCount(list: Array<{ reason: string; count: number }>): number {
	return list.find((note) => note.reason.includes("not a JSON object"))?.count ?? 0;
}
