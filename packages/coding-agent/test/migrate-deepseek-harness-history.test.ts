/**
 * What the DeepSeek Harness importer carries, and what it says about what it does not.
 *
 * The harness keeps one JSONL log per session generation under
 * `<root>/sessions/<project bucket>/<encoded session id>/`, and normally frames it
 * with zstd. Its writer compresses the header line on its own and appends later
 * batches as further frames, so a log on disk is a concatenation of frames rather
 * than one stream. The fixtures below mirror what that writer emits; the last
 * describe block reads its committed snapshot logs, which are the writer's own
 * output and therefore the strongest available ground truth.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import type { AgentMessage } from "@labunbun/ai";
import { type DshEntry, type DshRead, listDshSessions, readDshLog } from "../src/dsh-session.ts";
import { type RunMigrationResult, runMigration } from "../src/migrate.ts";
import { importedSessionId, listHistory, readHistory } from "../src/migrate-history.ts";

/** A project that exists on disk, so the cwd rules keep the sessions that name it. */
const CWD = process.cwd();

/** Epoch ms of the fixtures' header, which is where a listed session's start time comes from. */
const T0 = Date.parse("2026-03-01T00:00:00.000Z");

const SESSION_ID = "dsh-session-1";

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

/** Files a fake harness home should contain, keyed by path relative to it. */
type SourceTree = Record<string, string | Uint8Array>;

/**
 * Run `body` against a throwaway labunbun home seeded with `tree`.
 *
 * `HOME`/`USERPROFILE` point at it, so a test that does not set `DSH_HOME` itself
 * is testing the `~/.dsh` fallback — which is every test but the one about the
 * variable.
 */
function withHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-dsh-history-"));
	roots.push(home);
	setEnv("USERPROFILE", home);
	setEnv("HOME", home);
	for (const [path, content] of Object.entries(tree)) {
		const full = join(home, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	body(home);
}

/** The harness's own root inside a fake home. */
function harnessRoot(home: string): string {
	return join(home, ".dsh");
}

/** Safe code units stay literal and everything else becomes `~XXXX`, as a session id is encoded. */
function encodeSegment(raw: string): string {
	let out = "";
	for (const ch of raw) {
		out +=
			ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)
				? ch
				: `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return out;
}

/** `<root>/sessions/<bucket>/<encoded session id>/`. */
function sessionDir(root: string, bucket: string, id: string): string {
	return join(root, "sessions", bucket, encodeSegment(id));
}

/** One event row, before the writer adds the `seq` it is addressed by. */
interface DshEvent {
	type: string;
	data?: unknown;
	ignorable?: boolean;
	surfaceOp?: "append" | { op: "replace"; startSeq: number; endSeq: number };
}

/** The header line: what the harness writes first, and where a session's cwd lives. */
function logHeader(id: string, cwd: string | undefined, createdAt = T0): Record<string, unknown> {
	return {
		type: "session",
		version: 3,
		id,
		createdAt,
		...(cwd === undefined ? {} : { cwd }),
		isSeeded: false,
		delegationDepth: 0,
	};
}

/**
 * A log as one text: a header line, then one line per event.
 *
 * The harness addresses an event by its position rather than by a field, and its
 * writer emits no `seq`; the fixture states it anyway and keeps the two readings
 * in agreement, so a reader may use either. A string row is passed through, which
 * is how a damaged fixture states its damage. `base` moves the whole log's clock,
 * including the header's, so a fixture that starts later starts later throughout.
 */
function logText(header: Record<string, unknown>, events: Array<DshEvent | string>, base = T0): string {
	const rows = [JSON.stringify(header)];
	events.forEach((event, index) => {
		rows.push(typeof event === "string" ? event : JSON.stringify({ ...event, seq: index, time: base + index * 1000 }));
	});
	return `${rows.join("\n")}\n`;
}

/** The log as a single zstd frame. */
function zstdLog(text: string): Uint8Array {
	return Bun.zstdCompressSync(Buffer.from(text, "utf8"));
}

/** The log as independently compressed frames, concatenated — what the harness writes. */
function zstdFrames(...texts: string[]): Uint8Array {
	return Buffer.concat(texts.map((text) => Buffer.from(zstdLog(text))));
}

/** A log split into its header line and the rest, which is how the harness frames it. */
function headerAndBody(text: string): [string, string] {
	const end = text.indexOf("\n") + 1;
	return [text.slice(0, end), text.slice(end)];
}

/** Write one generation file of a session, creating its directory. */
function writeSession(root: string, bucket: string, id: string, file: string, content: string | Uint8Array): string {
	const path = join(sessionDir(root, bucket, id), file);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	return path;
}

const textBlock = (text: string): Record<string, unknown> => ({ type: "text", text });
const reasoningBlock = (text: string): Record<string, unknown> => ({ type: "reasoning", text });

/** A `tool-call` block: the harness keeps the arguments as the raw JSON text it streamed. */
function toolCallBlock(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
	return { type: "tool-call", id, name, arguments: JSON.stringify(args) };
}

/** A `user/message` event: `data` is the message itself. */
function userEvent(id: string, text: string): DshEvent {
	return {
		type: "user/message",
		data: { content: [textBlock(text)], source: { kind: "user" }, role: "user", id },
		surfaceOp: "append",
	};
}

/** An `assistant/message` event: `data.message` is the message the model produced. */
function assistantEvent(id: string, content: Array<Record<string, unknown>>): DshEvent {
	return {
		type: "assistant/message",
		data: {
			turn: 1,
			step: 1,
			message: {
				role: "assistant",
				content,
				source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
				id,
			},
			usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 },
		},
		surfaceOp: "append",
	};
}

/**
 * A `tool/result` event: `data.message` is the result the tool produced.
 *
 * A failed call records its reason inside the message, and may repeat it on the
 * envelope; the fixture writes both together so it says one thing either way.
 */
function toolResultEvent(id: string, callId: string, text: string, error?: string): DshEvent {
	return {
		type: "tool/result",
		data: {
			turn: 1,
			step: 1,
			message: {
				source: { kind: "tool", callId },
				content: [
					{ type: "tool-result", toolCallId: callId, content: [textBlock(text)], isError: error !== undefined },
				],
				role: "user",
				id,
			},
			...(error === undefined ? {} : { error }),
		},
		surfaceOp: "append",
	};
}

/** A `system/message` event: the harness's own prompt, which is not the user's conversation. */
function systemEvent(id: string, text: string): DshEvent {
	return {
		type: "system/message",
		data: {
			turn: 1,
			step: 1,
			message: {
				role: "system",
				content: [textBlock(text)],
				source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" },
				id,
			},
		},
		surfaceOp: "append",
	};
}

/** The bookkeeping a real turn writes around its messages; none of it is conversation. */
function logOnlyEvents(callId: string): { open: DshEvent[]; call: DshEvent; close: DshEvent[] } {
	return {
		open: [
			{ type: "turn/start", data: { turn: 1 } },
			{ type: "step/start", data: { turn: 1, step: 1 } },
		],
		call: { type: "tool/call", data: { turn: 1, step: 1, callId, name: "bash", arguments: '{"command":"ls"}' } },
		close: [
			{ type: "step/end", data: { turn: 1, step: 1 } },
			{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
		],
	};
}

/** A read that has to have succeeded; the reader's own words are the failure. */
function logRead(path: string): DshRead {
	const read = readDshLog(path);
	if ("error" in read) throw new Error(`readDshLog refused ${path}: ${read.error}`);
	return read;
}

/** The converted messages, in order, with any compaction marker left out. */
function messagesOf(entries: DshEntry[]): AgentMessage[] {
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

/** Everything a reader says it left behind, in one number. */
function heldBack(notes: Array<{ count: number }>): number {
	return notes.reduce((total, note) => total + note.count, 0);
}

/** Every file and directory under a root, with its size, mtime and content digest. */
function snapshotTree(root: string): string[] {
	const lines: string[] = [];
	const entries = readdirSync(root, { recursive: true }).map(String).sort();
	for (const entry of entries) {
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

describe("migrate: history from DeepSeek Harness", () => {
	test("the newest canonical generation lists, and no other name is guessed", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const decoy = logText(logHeader("dsh-decoy", join(home, "decoy")), [userEvent("m9", "DECOY-CANARY")]);
			const live = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl.zstd",
				zstdFrames(...headerAndBody(logText(logHeader(SESSION_ID, CWD), [userEvent("m1", "live")]))),
			);
			// Older generations, and two names that are not generations at all.
			writeSession(root, "--G-repo--", SESSION_ID, "session.jsonl", logText(logHeader(SESSION_ID, CWD), []));
			writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v2.jsonl",
				logText({ ...logHeader(SESSION_ID, CWD), version: 2 }, []),
			);
			writeSession(root, "--G-repo--", SESSION_ID, "session.v03.jsonl", decoy);
			writeSession(root, "--G-repo--", SESSION_ID, "session.V4.jsonl", decoy);
			// A session whose only logs are non-canonical is not a session.
			writeSession(root, "--G-repo--", "dsh-noncanonical", "session.v03.jsonl", decoy);

			const listing = listDshSessions(root);
			expect(listing.sessions.length).toBe(1);
			expect(listing.sessions[0].path).toBe(live);
			expect(listing.sessions[0].sessionId).toBe(SESSION_ID);
			expect(listing.sessions[0].cwd).toBe(CWD);
			expect(listing.sessions[0].startedAt).toBe(T0);
			// The decoy is a valid log for a different project; guessing it would show.
			expect(messagesOf(logRead(live).entries).map(textOf)).toEqual(["live"]);
		});
	});

	test("both spellings of one generation: the raw log is the one read", () => {
		// The harness can leave the plain text beside the compressed artifact of the
		// same version, and then the choice between them is the reader's. Whichever
		// it makes has to be the one the rule states rather than the order the
		// directory happens to list in, so the rule is pinned here.
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const raw = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl",
				logText(logHeader(SESSION_ID, CWD), [userEvent("m1", "RAW-CANARY")]),
			);
			writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl.zstd",
				zstdFrames(...headerAndBody(logText(logHeader(SESSION_ID, CWD), [userEvent("m2", "COMPRESSED-CANARY")]))),
			);

			const listing = listDshSessions(root);
			expect(listing.sessions.length).toBe(1);
			expect(listing.sessions[0].path).toBe(raw);
			expect(messagesOf(logRead(raw).entries).map(textOf)).toEqual(["RAW-CANARY"]);
		});
	});

	test("a raw log and a zstd log — one frame or many — read the same", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const events = [
				systemEvent("m1", "SYSTEM"),
				userEvent("m2", "hello"),
				assistantEvent("m3", [textBlock("hi there")]),
			];
			const text = logText(logHeader(SESSION_ID, CWD), events);
			const [headerLine, body] = headerAndBody(text);
			const cut = Math.floor(body.length / 2);
			const raw = writeSession(root, "--a--", "dsh-raw", "session.v3.jsonl", text);
			const single = writeSession(root, "--a--", "dsh-single", "session.v3.jsonl.zstd", zstdLog(text));
			// What the harness writes: the header is its own frame, the rest follows.
			const framed = writeSession(root, "--a--", "dsh-framed", "session.v3.jsonl.zstd", zstdFrames(headerLine, body));
			// And a record split across two frames, which its reader joins before parsing.
			const split = writeSession(
				root,
				"--a--",
				"dsh-split",
				"session.v3.jsonl.zstd",
				zstdFrames(headerLine, body.slice(0, cut), body.slice(cut)),
			);

			const expected = messagesOf(logRead(raw).entries).map(textOf);
			expect(expected).toEqual(["hello", "hi there"]);
			expect(messagesOf(logRead(single).entries).map(textOf)).toEqual(expected);
			expect(messagesOf(logRead(framed).entries).map(textOf)).toEqual(expected);
			expect(messagesOf(logRead(split).entries).map(textOf)).toEqual(expected);
		});
	});

	test("a project bucket and the no-cwd bucket both list, each with its header's cwd", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			writeSession(
				root,
				"--G-repo--",
				"dsh-project",
				"session.v3.jsonl",
				logText(logHeader("dsh-project", CWD), [userEvent("m1", "in a project")]),
			);
			writeSession(
				root,
				"_no-cwd",
				"dsh-nocwd",
				"session.v3.jsonl",
				logText(logHeader("dsh-nocwd", undefined), [userEvent("m2", "nowhere")]),
			);

			const listed = new Map(listDshSessions(root).sessions.map((session) => [session.sessionId, session]));
			expect([...listed.keys()].sort()).toEqual(["dsh-nocwd", "dsh-project"]);
			expect(listed.get("dsh-project")?.cwd).toBe(CWD);
			// A session the harness recorded without a project has none to carry.
			expect(listed.get("dsh-nocwd")?.cwd).toBe("");
		});
	});

	test("a session with no directory is named as such, not as one that went missing", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			writeSession(
				root,
				"_no-cwd",
				"dsh-nocwd",
				"session.v3.jsonl",
				logText(logHeader("dsh-nocwd", undefined), [userEvent("m1", "nowhere")]),
			);

			const listing = listHistory("deepseek-harness", home, { cwd: CWD, scope: "all" });

			// The harness started this session outside any project, so there is
			// nowhere to file it — but nothing was lost either. Telling the user a
			// working directory no longer exists sends them looking for one that was
			// never recorded.
			expect(listing.candidates).toEqual([]);
			expect(listing.notes.some((note) => note.reason === "no working directory recorded" && note.count === 1)).toBe(
				true,
			);
			expect(listing.notes.some((note) => note.reason === "working directory no longer exists")).toBe(false);
		});
	});

	test("a turn converts with its tool call, its result and the stop reason that made it", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const path = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl",
				logText(logHeader(SESSION_ID, CWD), [
					userEvent("m1", "read notes.md"),
					assistantEvent("m2", [
						reasoningBlock("weighing it"),
						textBlock("Looking"),
						toolCallBlock("call_1", "read", { path: "notes.md" }),
					]),
					toolResultEvent("m3", "call_1", "file body"),
					assistantEvent("m4", [textBlock("done")]),
				]),
			);

			const messages = messagesOf(logRead(path).entries);
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

			// The harness stores reasoning as plain text of its own kind; whether the
			// importer carries it as thinking is not what this asserts.
			const assistant = messages[1];
			expect(
				assistant.role === "assistant" &&
					assistant.content.filter((block) => block.type !== "thinking").map((block) => block.type),
			).toEqual(["text", "toolCall"]);
			expect(assistant.role === "assistant" && assistant.content.find((block) => block.type === "toolCall")).toEqual({
				type: "toolCall",
				id: "call_1",
				name: "read",
				arguments: '{"path":"notes.md"}',
			});
			// A turn that carried calls is one the API must be able to answer.
			expect(assistant.role === "assistant" && assistant.stopReason).toBe("toolUse");
			expect(messages[3].role === "assistant" && messages[3].stopReason).toBe("stop");

			const result = messages[2];
			expect(result.role === "toolResult" && result.toolCallId).toBe("call_1");
			expect(result.role === "toolResult" && result.toolName).toBe("read");
			expect(result.role === "toolResult" && result.isError).toBe(false);
			expect(result.role === "toolResult" && textOf(result)).toBe("file body");
		});
	});

	test("a failed tool call keeps its error", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const path = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl",
				logText(logHeader(SESSION_ID, CWD), [
					userEvent("m1", "write it"),
					assistantEvent("m2", [toolCallBlock("call_1", "write", { path: "settings.txt" })]),
					toolResultEvent("m3", "call_1", "cannot modify settings.txt", "cannot modify settings.txt"),
				]),
			);

			const result = messagesOf(logRead(path).entries)[2];
			expect(result.role === "toolResult" && result.isError).toBe(true);
			expect(result.role === "toolResult" && textOf(result)).toBe("cannot modify settings.txt");
		});
	});

	test("a system message is left behind and counted, and bookkeeping is not conversation", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const bookkeeping = logOnlyEvents("call_1");
			const path = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl",
				logText(logHeader(SESSION_ID, CWD), [
					...bookkeeping.open,
					systemEvent("m1", "SYSTEM-CANARY"),
					userEvent("m2", "run it"),
					assistantEvent("m3", [textBlock("on it"), toolCallBlock("call_1", "bash", { command: "ls" })]),
					bookkeeping.call,
					toolResultEvent("m4", "call_1", "a.txt"),
					...bookkeeping.close,
				]),
			);

			const read = logRead(path);
			const messages = messagesOf(read.entries);
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(messages.map(textOf).join("\n")).not.toContain("SYSTEM-CANARY");
			// One system message, one note. Counting tool/call, turn/* and step/* as
			// dropped conversation would make this six.
			expect(heldBack(read.notes)).toBe(1);
		});
	});

	test("each entry carries the log's clock: the row's own time, or the one running", () => {
		// Not every row is stamped — the harness records a `time` on the events it
		// writes in the moment and leaves it off the ones it derives from an earlier
		// row. A reader that gave every entry the header's creation time, or the
		// epoch, would still produce a readable transcript, which is exactly why this
		// needs an assertion: the history would say the whole session happened at
		// once, and nothing else here would notice.
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const rows = [
				JSON.stringify(logHeader(SESSION_ID, CWD)),
				// Unstamped, and first: the header's createdAt is the clock so far.
				JSON.stringify({ ...userEvent("m1", "first"), seq: 0 }),
				// Stamped: a row that records when it happened.
				JSON.stringify({ ...userEvent("m2", "second"), seq: 1, time: T0 + 5_000 }),
				// Unstamped again: it inherits the time the previous row set.
				JSON.stringify({ ...userEvent("m3", "third"), seq: 2 }),
			];
			const path = writeSession(root, "--G-repo--", SESSION_ID, "session.v3.jsonl", `${rows.join("\n")}\n`);

			expect(messagesOf(logRead(path).entries).map((message) => message.timestamp)).toEqual([
				T0,
				T0 + 5_000,
				T0 + 5_000,
			]);
		});
	});

	test("a surface replacement removes what it replaced", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const path = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl",
				logText(logHeader(SESSION_ID, CWD), [
					systemEvent("m1", "SYSTEM"),
					userEvent("m2", "ORIGINAL-QUESTION"),
					assistantEvent("m3", [textBlock("ORIGINAL-ANSWER")]),
					// Compaction: the events at seq 1 and 2 were rewritten into this one.
					{ ...userEvent("m4", "CHECKPOINT-SUMMARY"), surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 } },
				]),
			);

			const messages = messagesOf(logRead(path).entries);
			const text = messages.map(textOf).join("\n");
			expect(messages.map((message) => message.role)).toEqual(["user"]);
			expect(text).toContain("CHECKPOINT-SUMMARY");
			expect(text).not.toContain("ORIGINAL-QUESTION");
			expect(text).not.toContain("ORIGINAL-ANSWER");
		});
	});

	test("an unknown event refuses the log unless the harness marked it ignorable", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const unknown: DshEvent = { type: "future/experiment", data: { note: "UNKNOWN-CANARY" } };
			const refused = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl",
				logText(logHeader(SESSION_ID, CWD), [userEvent("m1", "kept"), unknown]),
			);
			const tolerated = writeSession(
				root,
				"--G-repo--",
				"dsh-ignorable",
				"session.v3.jsonl",
				logText(logHeader("dsh-ignorable", CWD), [userEvent("m2", "kept"), { ...unknown, ignorable: true }]),
			);

			// A build that does not know the event cannot know what the rest of the
			// conversation was built on, so the whole session is refused rather than
			// silently truncated.
			const refusal = readDshLog(refused);
			expect("error" in refusal).toBe(true);
			expect("error" in refusal && refusal.error).toBeTruthy();

			// The same event, marked as droppable by whoever wrote it, costs nothing.
			const read = logRead(tolerated);
			expect(messagesOf(read.entries).map(textOf)).toEqual(["kept"]);
			expect(heldBack(read.notes)).toBe(0);
		});
	});

	test("a malformed line costs a note and the conversation survives it", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const path = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl",
				logText(logHeader(SESSION_ID, CWD), [
					userEvent("m1", "first"),
					'{"type":"assistant/message","data":',
					assistantEvent("m2", [textBlock("second")]),
				]),
			);

			const read = logRead(path);
			expect(messagesOf(read.entries).map(textOf)).toEqual(["first", "second"]);
			expect(heldBack(read.notes)).toBe(1);
		});
	});

	test("a tool result whose call was never seen loses both halves, and says so", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const path = writeSession(
				root,
				"--G-repo--",
				SESSION_ID,
				"session.v3.jsonl",
				logText(logHeader(SESSION_ID, CWD), [
					userEvent("m1", "hi"),
					assistantEvent("m2", [textBlock("kept"), toolCallBlock("orphan-call", "read", {})]),
					toolResultEvent("m3", "orphan-result", "nothing called me"),
				]),
			);

			const read = logRead(path);
			const messages = messagesOf(read.entries);
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			// The half-paired turn keeps its text and loses the call that answered
			// nothing, exactly as the Codex reader does.
			expect(messages[1].role === "assistant" && messages[1].content.map((block) => block.type)).toEqual(["text"]);
			const unpaired = read.notes.find((note) => note.reason.includes("unpaired"));
			expect(unpaired?.count).toBe(2);
		});
	});

	test("a session is titled by what it says, or by the first thing the user asked", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			writeSession(
				root,
				"--G-repo--",
				"dsh-first-prompt",
				"session.v3.jsonl",
				logText(logHeader("dsh-first-prompt", CWD), [
					userEvent("m1", "fix the flaky parser"),
					assistantEvent("m2", [textBlock("on it")]),
				]),
			);
			// The harness records its own title, and the latest one wins.
			writeSession(
				root,
				"--G-repo--",
				"dsh-titled",
				"session.v3.jsonl",
				logText(logHeader("dsh-titled", CWD), [
					{ type: "session/title", data: { title: "Parser repair", messageSeqs: [1], source: { kind: "user" } } },
					userEvent("m1", "fix the flaky parser"),
				]),
			);

			const listed = new Map(listDshSessions(root).sessions.map((session) => [session.sessionId, session]));
			expect(listed.get("dsh-first-prompt")?.title).toContain("fix the flaky parser");
			expect(listed.get("dsh-titled")?.title).toContain("Parser repair");
		});
	});

	test("DSH_HOME decides which harness home is read, and blank means the default", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const elsewhere = join(home, "elsewhere");
			const session = (id: string, cwd: string): string => logText(logHeader(id, cwd), [userEvent("m1", "hello")]);
			writeSession(root, "--G-repo--", "dsh-default", "session.v3.jsonl", session("dsh-default", CWD));
			writeSession(elsewhere, "--G-repo--", "dsh-env", "session.v3.jsonl", session("dsh-env", CWD));

			// Unset: the fallback root.
			expect(
				listHistory("deepseek-harness", home, { cwd: CWD, scope: "all" }).candidates.map((c) => c.sourceId),
			).toEqual(["dsh-default"]);

			// Set: the variable decides, and the fallback is not consulted.
			setEnv("DSH_HOME", elsewhere);
			expect(
				listHistory("deepseek-harness", home, { cwd: CWD, scope: "all" }).candidates.map((c) => c.sourceId),
			).toEqual(["dsh-env"]);

			// Blank: a root that names nothing is not a root.
			setEnv("DSH_HOME", "   ");
			const fallback = listHistory("deepseek-harness", home, { cwd: CWD, scope: "all" }).candidates;
			expect(fallback.map((c) => c.sourceId)).toEqual(["dsh-default"]);
			expect(fallback[0]?.path.startsWith(root)).toBe(true);
		});
	});

	test("a ~-rooted DSH_HOME is one tree to the plan and to the history walk alike", () => {
		withHome({}, (home) => {
			// The harness expands a leading `~` before it uses the value, so a user
			// who wrote one keeps their state in `<home>/dsh-alt`. Two readers ask
			// where that root is — the plan, to decide whether the sessions are worth
			// walking at all, and the history importer, to walk them — and a user
			// whose root one of them fails to expand gets their settings imported
			// beside a cheerful report that they have no sessions. Both are asserted
			// here together, because it is their agreement that is the contract.
			const root = join(home, "dsh-alt");
			setEnv("DSH_HOME", "~/dsh-alt");
			writeSession(
				root,
				"--G-repo--",
				"dsh-tilde",
				"session.v3.jsonl",
				logText(logHeader("dsh-tilde", CWD), [userEvent("m1", "from a relocated root")]),
			);

			const listed = listHistory("deepseek-harness", home, { cwd: CWD, scope: "all" });
			expect(listed.candidates.map((candidate) => candidate.sourceId)).toEqual(["dsh-tilde"]);

			const result = runMigration({
				home,
				from: "deepseek-harness",
				only: ["history"],
				historyScope: "all",
				apply: false,
			});
			expect(result.error).toBeUndefined();
			expect(historyWrites(result, home).length).toBe(1);
		});
	});

	test("the converted sessions land in the history of a home the source never sees", () => {
		withHome({}, (home) => {
			const root = join(home, "harness");
			setEnv("DSH_HOME", root);
			writeSession(
				root,
				"--G-repo--",
				"dsh-one",
				"session.v3.jsonl",
				logText(logHeader("dsh-one", CWD), [
					userEvent("m1", "read notes.md"),
					assistantEvent("m2", [textBlock("Looking"), toolCallBlock("call_1", "read", { path: "notes.md" })]),
					toolResultEvent("m3", "call_1", "file body"),
				]),
			);
			writeSession(
				root,
				"--G-repo--",
				"dsh-two",
				"session.v3.jsonl.zstd",
				zstdLog(logText(logHeader("dsh-two", CWD, T0 + 60_000), [userEvent("m4", "second session")], T0 + 60_000)),
			);
			const before = snapshotTree(root);

			const listing = listHistory("deepseek-harness", home, { cwd: CWD, scope: "all" });
			const read = readHistory("deepseek-harness", home, listing.candidates);
			expect(read.sessions.length).toBe(2);
			expect(read.sessions.map((session) => messagesOf(session.entries).length).sort()).toEqual([1, 3]);

			const result = runMigration({
				home,
				from: "deepseek-harness",
				only: ["history"],
				historyScope: "all",
				apply: true,
			});
			expect(result.error).toBeUndefined();
			// This home holds a harness tree and nothing else: a source that was named
			// on the way in is read on its own account, not on another's.
			expect(historyWrites(result, home).length).toBe(2);

			// Every entry the reader produced is in the file the migration wrote.
			for (const session of read.sessions) {
				const path = result.plan.writes.find((write) =>
					write.path.includes(importedSessionId("deepseek-harness", session.sourceId)),
				)?.path;
				expect(path).toBeDefined();
				const store = SessionStore.load(path ?? "");
				expect(store.messages().length).toBe(messagesOf(session.entries).length);
				const header = store.linearEntries()[0];
				expect(header.type === "header" && header.createdAt).toBe(session.startedAt);
				expect(header.type === "header" && header.cwd).toBe(CWD);
			}
			// The source's own start time travels: the second session is the newer one.
			expect(read.sessions.find((session) => session.sourceId === "dsh-two")?.startedAt).toBe(T0 + 60_000);

			// Reading a source must not touch it — not even a directory mtime.
			expect(snapshotTree(root)).toEqual(before);
		});
	});
});

describe("migrate: history from DeepSeek Harness snapshot logs", () => {
	/**
	 * The harness's own committed snapshot logs, read in place.
	 *
	 * These are the harness writer's output, so they are the strongest ground truth
	 * for the format available here; nothing under that tree is ever written to.
	 */
	const HARNESS_SNAPSHOTS = "G:/Bunttta/deepseek-harness-master/snapshots/session";

	/** Copy one snapshot's live generation into a fake harness root. */
	function copySnapshot(root: string, name: string): string {
		const id = `snapshot-${name}`;
		const path = join(sessionDir(root, `--${name}--`, id), "session.v3.jsonl");
		mkdirSync(join(path, ".."), { recursive: true });
		copyFileSync(join(HARNESS_SNAPSHOTS, name, "session.v3.jsonl"), path);
		return path;
	}

	test("the writer's own logs list and convert without refusal", () => {
		withHome({}, (home) => {
			const root = harnessRoot(home);
			const copied = ["bash-tool-turn", "fs-policy-reject", "compaction-recovery"].map((name) =>
				copySnapshot(root, name),
			);
			// The committed snapshots are sanitized: they all carry the same
			// placeholder id, so nothing about them can be told apart by id — which
			// makes them a fair test of whether the bucket and the path are carried.
			const listed = listDshSessions(root).sessions;
			expect(listed.map((session) => session.path).sort()).toEqual([...copied].sort());

			for (const path of copied) {
				const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]) as { id: string; cwd: string };
				const entry = listed.find((session) => session.path === path);
				expect(entry?.sessionId).toBe(header.id);
				expect(entry?.cwd).toBe(header.cwd);

				const messages = messagesOf(logRead(path).entries);
				expect(messages.length).toBeGreaterThan(0);
				for (const message of messages) {
					expect(["user", "assistant", "toolResult"]).toContain(message.role);
					expect(textOf(message).length).toBeGreaterThan(0);
				}
			}
		});
	});

	test("a real failed tool call keeps its error", () => {
		withHome({}, (home) => {
			const path = copySnapshot(harnessRoot(home), "fs-policy-reject");
			const results = messagesOf(logRead(path).entries).filter((message) => message.role === "toolResult");
			expect(results.length).toBeGreaterThan(0);
			const failed = results.filter((message) => message.role === "toolResult" && message.isError);
			expect(failed.length).toBeGreaterThan(0);
			expect(failed.map(textOf).join("\n")).toContain("Error: cannot modify");
		});
	});

	test("a real compaction replacement drops what the harness dropped", () => {
		withHome({}, (home) => {
			const path = copySnapshot(harnessRoot(home), "compaction-recovery");
			const read = logRead(path);
			const text = messagesOf(read.entries).map(textOf).join("\n");

			// The harness states the boundary in `compaction/summary` and then rewrites
			// the range it names with a checkpoint prompt repeating the same summary;
			// that pair is one boundary, and the token count is the harness's own.
			const boundary = read.entries.find((entry) => entry.kind === "compaction");
			expect(boundary?.kind === "compaction" && boundary.summary).toContain(
				"The request established a durable compaction premise.",
			);
			expect(boundary?.kind === "compaction" && boundary.preTokens).toBe(373);

			// The two messages the replacement covered are not replayed …
			expect(text).not.toContain("Record every part of this historical evidence");
			expect(text).not.toContain("Current runtime context");
			// … and the turn the session continued with is.
			expect(text).toContain("COMPACTION RECOVERED");
		});
	});
});
