import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import type { AgentMessage } from "@labunbun/ai";
import { loadHistory } from "../src/history.ts";
import { type RunMigrationResult, runMigration } from "../src/migrate.ts";
import { importedSessionId, parseHistoryScope, readPromptHistory, repairToolPairing } from "../src/migrate-history.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

function withHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-history-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		for (const [path, content] of Object.entries(tree)) {
			const full = join(home, path);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, content);
		}
		body(home);
	} finally {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		rmSync(home, { recursive: true, force: true });
	}
}

/** Write JSONL, passing strings through so a test can add a malformed line. */
function writeJsonl(path: string, rows: Array<Record<string, unknown> | string>): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`);
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

const CWD = process.cwd();

/** A Claude Code transcript: one tool call, its result, then a closing answer. */
function claudeRows(cwd: string, extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
	return [
		{ type: "user", timestamp: at(0), cwd, message: { role: "user", content: "hello" } },
		{
			type: "assistant",
			timestamp: at(1),
			cwd,
			message: {
				role: "assistant",
				model: "claude-opus-5",
				stop_reason: "tool_use",
				usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
				content: [
					{ type: "thinking", thinking: "let me look" },
					{ type: "text", text: "Looking" },
					{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "notes.md" } },
				],
			},
		},
		{
			type: "user",
			timestamp: at(2),
			cwd,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "file body" }] }],
			},
		},
		{
			type: "assistant",
			timestamp: at(3),
			cwd,
			message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
		},
		...extra,
	];
}

function claudePath(home: string, id: string, project = "-tmp-proj"): string {
	return join(home, ".claude", "projects", project, `${id}.jsonl`);
}

/** History-only migration: the other categories would add unrelated writes. */
function runHistory(home: string, extra: Partial<Parameters<typeof runMigration>[0]> = {}): RunMigrationResult {
	return runMigration({ home, only: ["history"], historyScope: "all", ...extra });
}

/** The transcript writes in a plan, as `~`-relative paths. */
function historyWrites(result: RunMigrationResult, home: string): string[] {
	return result.plan.writes
		.filter((write) => write.kind === "history")
		.map((write) => write.path.replace(/\\/g, "/").replace(home.replace(/\\/g, "/"), "~"))
		.sort();
}

/** Item details, which is where every skip explains itself. */
function details(result: RunMigrationResult): string[] {
	return result.plan.items.map((item) => item.detail);
}

describe("migrate: history from Claude Code", () => {
	test("a transcript becomes a session file the store can load", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-1111"), claudeRows(CWD));
			const result = runHistory(home, { apply: true });
			expect(result.error).toBeUndefined();
			expect(historyWrites(result, home)).toEqual([
				`~/.labunbun/projects/${CWD.replace(/[:\\/]/g, "-")}/${importedSessionId("claude-code", "aaaa-1111")}.jsonl`,
			]);

			const store = SessionStore.load(result.plan.writes[0].path);
			const entries = store.linearEntries();
			expect(entries[0].type).toBe("header");
			expect(entries[0].parentId).toBeNull();
			// The header keeps the source session's start time, not the import time.
			expect(entries[0].type === "header" && entries[0].createdAt).toBe(T0);
			for (let i = 1; i < entries.length; i += 1) expect(entries[i].parentId).toBe(entries[i - 1].id);

			const messages = store.messages();
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
			expect(messages[0].timestamp).toBe(T0);

			const assistant = messages[1];
			expect(assistant.role === "assistant" && assistant.content.map((block) => block.type)).toEqual([
				"thinking",
				"text",
				"toolCall",
			]);
			expect(assistant.role === "assistant" && assistant.usage).toEqual({
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
			});
			expect(assistant.role === "assistant" && assistant.stopReason).toBe("toolUse");
			expect(assistant.role === "assistant" && assistant.model).toBe("claude-opus-5");

			// The result's tool name comes from the call it answers.
			const toolResult = messages[2];
			expect(toolResult.role === "toolResult" && toolResult.toolName).toBe("Read");
			expect(toolResult.role === "toolResult" && toolResult.toolCallId).toBe("toolu_1");
			expect(toolResult.role === "toolResult" && toolResult.isError).toBe(false);
			expect(messages[3].role === "assistant" && messages[3].timestamp).toBe(T0 + 3000);
		});
	});

	test("malformed lines are counted, not fatal", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-2222"), [
				...claudeRows(CWD).slice(0, 1),
				'{"type": "user", "message"',
				"not json at all",
				...claudeRows(CWD).slice(1),
			]);
			const result = runHistory(home, { apply: true });
			expect(result.error).toBeUndefined();
			expect(details(result).some((detail) => detail.includes("malformed line — 2 turned away"))).toBe(true);
			expect(SessionStore.load(result.plan.writes[0].path).messages().length).toBe(4);
		});
	});

	test("a file that is only session bookkeeping produces nothing", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-3333"), [
				{ type: "mode", mode: "normal" },
				{ type: "mode", mode: "normal" },
			]);
			const result = runHistory(home, { apply: true });
			expect(result.plan.writes).toEqual([]);
			expect(details(result).some((detail) => detail.includes("no working directory — 1 turned away"))).toBe(true);
		});
	});

	test("sidechains and subagent transcripts stay out of the conversation", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-4444"), [
				...claudeRows(CWD),
				{
					type: "assistant",
					timestamp: at(4),
					cwd: CWD,
					isSidechain: true,
					message: { role: "assistant", content: [{ type: "text", text: "SIDECHAIN-CANARY" }] },
				},
			]);
			writeJsonl(join(home, ".claude", "projects", "-tmp-proj", "aaaa-4444", "subagents", "agent-1.jsonl"), [
				{ type: "user", timestamp: at(5), cwd: CWD, message: { role: "user", content: "SUBAGENT-CANARY" } },
			]);

			const result = runHistory(home, { apply: true });
			expect(details(result).some((detail) => detail.startsWith("sidechain entry — 1"))).toBe(true);
			expect(
				details(result).some((detail) =>
					detail.includes("subagent transcript (kept out of the parent conversation) — 1 turned away"),
				),
			).toBe(true);
			expect(SessionStore.load(result.plan.writes[0].path).messages().length).toBe(4);
			expect(result.report).not.toContain("SIDECHAIN-CANARY");
			expect(result.report).not.toContain("SUBAGENT-CANARY");
		});
	});

	test("a session whose project directory is gone is skipped", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-5555"), claudeRows(join(home, "deleted-project")));
			const result = runHistory(home, { apply: true });
			expect(result.plan.writes).toEqual([]);
			expect(details(result).some((detail) => detail.includes("working directory no longer exists — 1"))).toBe(true);
		});
	});

	test("the default scope is the current project", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-6666"), claudeRows(CWD));
			writeJsonl(claudePath(home, "aaaa-7777"), claudeRows(home));
			const result = runMigration({ home, only: ["history"] });
			expect(result.plan.writes.length).toBe(1);
			expect(result.plan.writes[0].path).toContain(importedSessionId("claude-code", "aaaa-6666"));
			expect(details(result).some((detail) => detail.includes('another project (scope is "cwd") — 1'))).toBe(true);
		});
	});

	test("a tool call with no result loses both halves", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-8888"), [
				{ type: "user", timestamp: at(0), cwd: CWD, message: { role: "user", content: "hello" } },
				{
					type: "assistant",
					timestamp: at(1),
					cwd: CWD,
					message: {
						role: "assistant",
						stop_reason: "tool_use",
						content: [
							{ type: "text", text: "Looking" },
							{ type: "tool_use", id: "toolu_lost", name: "Read", input: {} },
						],
					},
				},
				{
					type: "assistant",
					timestamp: at(2),
					cwd: CWD,
					message: { role: "assistant", content: [{ type: "text", text: "done" }] },
				},
			]);
			const result = runHistory(home, { apply: true });
			const messages = SessionStore.load(result.plan.writes[0].path).messages();
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
			expect(messages[1].role === "assistant" && messages[1].content.map((block) => block.type)).toEqual(["text"]);
			expect(details(result).some((detail) => detail.includes("unpaired tool call or result — 1"))).toBe(true);
		});
	});

	test("repair drops each half in both directions", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hi", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "kept" },
					{ type: "toolCall", id: "orphan-call", name: "Read", arguments: "{}" },
				],
				provider: "",
				model: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "orphan-result",
				toolName: "Read",
				content: [{ type: "text", text: "nothing called me" }],
				isError: false,
				timestamp: 0,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "only-a-call", name: "Read", arguments: "{}" }],
				provider: "",
				model: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 0,
			},
		];
		const repaired = repairToolPairing(messages);
		// Counted separately: the orphan call, the orphan result, the orphan call
		// that was alone in its message, and that emptied message.
		expect(repaired.dropped).toBe(4);
		expect(repaired.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(repaired.messages[1].role === "assistant" && repaired.messages[1].content).toEqual([
			{ type: "text", text: "kept" },
		]);
	});
});

describe("migrate: history from Codex", () => {
	const CODEX_ROWS: Array<Record<string, unknown>> = [
		{ timestamp: at(0), type: "session_meta", payload: { cwd: "", session_id: "sess-1" } },
		{ timestamp: at(0), type: "turn_context", payload: { cwd: "", model: "gpt-5" } },
		{
			timestamp: at(1),
			type: "response_item",
			payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
		},
		{ timestamp: at(2), type: "response_item", payload: { type: "reasoning", summary: [] } },
		{
			timestamp: at(2),
			type: "response_item",
			payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "be terse" }] },
		},
		{
			timestamp: at(3),
			type: "response_item",
			payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
		},
		// One turn, two calls: Codex writes the calls before any of their outputs,
		// which is what the importer's accumulation has to keep together.
		{
			timestamp: at(4),
			type: "response_item",
			payload: { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"command":["ls"]}' },
		},
		{
			timestamp: at(5),
			type: "response_item",
			payload: { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch" },
		},
		{
			timestamp: at(6),
			type: "response_item",
			payload: { type: "function_call_output", call_id: "call_1", output: '{"output":"a","success":true}' },
		},
		{
			timestamp: at(7),
			type: "response_item",
			payload: { type: "custom_tool_call_output", call_id: "call_2", output: '{"success":false}' },
		},
	];

	function codexPath(home: string, name: string): string {
		return join(home, ".codex", "sessions", "2026", "01", "02", `rollout-2026-01-02T00-00-00-${name}.jsonl`);
	}

	test("a rollout keeps its calls paired and counts what it drops", () => {
		withHome({}, (home) => {
			writeJsonl(
				codexPath(home, "sess-1"),
				CODEX_ROWS.map((row) =>
					row.type === "session_meta" || row.type === "turn_context"
						? { ...row, payload: { ...(row.payload as Record<string, unknown>), cwd: CWD } }
						: row,
				),
			);
			const result = runHistory(home, { apply: true });
			expect(result.error).toBeUndefined();
			expect(result.plan.writes.length).toBe(1);
			// The rollout's start time comes from its own first line, not its mtime.
			const store = SessionStore.load(result.plan.writes[0].path);
			const header = store.linearEntries()[0];
			expect(header.type === "header" && header.createdAt).toBe(T0);

			const messages = store.messages();
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult"]);
			const assistant = messages[1];
			expect(assistant.role === "assistant" && assistant.content.map((block) => block.type)).toEqual([
				"text",
				"toolCall",
				"toolCall",
			]);
			expect(assistant.role === "assistant" && assistant.content[1]).toEqual({
				type: "toolCall",
				id: "call_1",
				name: "shell",
				arguments: '{"command":["ls"]}',
			});
			// `custom_tool_call` has no arguments object; its input is wrapped.
			expect(assistant.role === "assistant" && assistant.content[2]).toEqual({
				type: "toolCall",
				id: "call_2",
				name: "apply_patch",
				arguments: '{"input":"*** Begin Patch"}',
			});
			expect(messages[2].role === "toolResult" && messages[2].isError).toBe(false);
			expect(messages[3].role === "toolResult" && messages[3].isError).toBe(true);

			const reported = details(result);
			expect(reported.some((detail) => detail.includes("reasoning item (stored encrypted) — 1"))).toBe(true);
			expect(reported.some((detail) => detail.includes("developer message") && detail.includes("— 1"))).toBe(true);
		});
	});

	test("an opening line larger than the head window still names the session", () => {
		withHome({}, (home) => {
			// Real rollouts carry the full base instruction set in that first line,
			// so it is not a line that can be assumed to fit in a fixed head.
			writeJsonl(
				codexPath(home, "long"),
				CODEX_ROWS.map((row) =>
					row.type === "session_meta"
						? {
								timestamp: at(0),
								type: "session_meta",
								payload: { cwd: CWD, session_id: "sess-long", instructions: "x".repeat(70_000) },
							}
						: row,
				),
			);
			const result = runHistory(home, { apply: true });
			expect(result.error).toBeUndefined();
			expect(result.plan.writes.length).toBe(1);
			expect(details(result).some((detail) => detail.includes("rollout without session metadata"))).toBe(false);
		});
	});

	test("a subagent thread is counted, not imported", () => {
		withHome({}, (home) => {
			writeJsonl(
				codexPath(home, "child"),
				CODEX_ROWS.map((row) =>
					row.type === "session_meta"
						? {
								timestamp: at(0),
								type: "session_meta",
								payload: { cwd: CWD, session_id: "sess-2", parent_thread_id: "sess-1" },
							}
						: row,
				),
			);
			const result = runHistory(home, { apply: true });
			expect(result.plan.writes).toEqual([]);
			expect(details(result).some((detail) => detail.includes("subagent thread — 1"))).toBe(true);
		});
	});
});

describe("migrate: history from ZCode", () => {
	interface ZcodeFixture {
		sessions: Array<{ id: string; parentId?: string | null; directory: string; title?: string; timeCreated: number }>;
		messages: Array<{ id: string; sessionId: string; timeCreated: number; data: Record<string, unknown> }>;
		parts: Array<{
			id: string;
			messageId: string;
			sessionId: string;
			timeCreated: number;
			data: Record<string, unknown>;
		}>;
	}

	function makeHistoryDb(home: string, fixture: ZcodeFixture): string {
		const dir = join(home, ".zcode", "cli", "db");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "db.sqlite");
		const db = new Database(path);
		db.run(
			"create table session (id text primary key, parent_id text, directory text, title text, time_created integer)",
		);
		db.run("create table message (id text primary key, session_id text, time_created integer, data text)");
		db.run(
			"create table part (id text primary key, message_id text, session_id text, time_created integer, data text)",
		);
		db.run("create table local_setting (scope text, scope_id text, namespace text, key text, value text)");
		for (const session of fixture.sessions) {
			db.run("insert into session values (?, ?, ?, ?, ?)", [
				session.id,
				session.parentId ?? null,
				session.directory,
				session.title ?? "",
				session.timeCreated,
			]);
		}
		for (const message of fixture.messages) {
			db.run("insert into message values (?, ?, ?, ?)", [
				message.id,
				message.sessionId,
				message.timeCreated,
				JSON.stringify(message.data),
			]);
		}
		for (const part of fixture.parts) {
			db.run("insert into part values (?, ?, ?, ?, ?)", [
				part.id,
				part.messageId,
				part.sessionId,
				part.timeCreated,
				JSON.stringify(part.data),
			]);
		}
		db.close();
		return path;
	}

	const FIXTURE: ZcodeFixture = {
		sessions: [
			{ id: "ses-1", parentId: null, directory: CWD, title: "Fix the parser", timeCreated: T0 },
			{ id: "ses-1-child", parentId: "ses-1", directory: CWD, title: "Subagent", timeCreated: T0 + 1 },
		],
		messages: [
			{ id: "m1", sessionId: "ses-1", timeCreated: T0, data: { role: "user", time: { created: T0 } } },
			{ id: "m2", sessionId: "ses-1", timeCreated: T0 + 10, data: { role: "assistant", time: { created: T0 + 10 } } },
			{ id: "m3", sessionId: "ses-1", timeCreated: T0 + 20, data: { role: "user", time: { created: T0 + 20 } } },
			{
				id: "child-1",
				sessionId: "ses-1-child",
				timeCreated: T0 + 1,
				data: { role: "user", time: { created: T0 + 1 } },
			},
		],
		parts: [
			{ id: "p1", messageId: "m1", sessionId: "ses-1", timeCreated: T0, data: { type: "text", text: "hi" } },
			{ id: "p2", messageId: "m1", sessionId: "ses-1", timeCreated: T0, data: { type: "step-start" } },
			{
				id: "p3",
				messageId: "m2",
				sessionId: "ses-1",
				timeCreated: T0 + 10,
				data: { type: "reasoning", text: "weighing options" },
			},
			{ id: "p4", messageId: "m2", sessionId: "ses-1", timeCreated: T0 + 10, data: { type: "text", text: "answer" } },
			{
				id: "p5",
				messageId: "m2",
				sessionId: "ses-1",
				timeCreated: T0 + 10,
				data: {
					type: "tool",
					callID: "call_a",
					tool: "bash",
					state: { status: "completed", input: '{"command":"ls"}', output: "done" },
				},
			},
			{
				id: "p6",
				messageId: "m2",
				sessionId: "ses-1",
				timeCreated: T0 + 11,
				data: {
					type: "tool",
					callID: "call_b",
					tool: "read",
					state: { status: "error", input: '{"path":"/nope"}', error: "" },
				},
			},
			{
				id: "p7",
				messageId: "m2",
				sessionId: "ses-1",
				timeCreated: T0 + 12,
				data: { type: "compaction", preCompactTokenCount: 4321, summaryMessageId: "m3" },
			},
			{
				id: "p8",
				messageId: "m3",
				sessionId: "ses-1",
				timeCreated: T0 + 20,
				data: { type: "text", text: "summary text" },
			},
			{
				id: "p9",
				messageId: "child-1",
				sessionId: "ses-1-child",
				timeCreated: T0 + 1,
				data: { type: "text", text: "CHILD-CANARY" },
			},
		],
	};

	test("messages and parts become a transcript with its compaction", () => {
		withHome({}, (home) => {
			makeHistoryDb(home, FIXTURE);
			const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
			const before = { bytes: readFileSync(dbPath), mtime: statSync(dbPath).mtimeMs };

			const result = runHistory(home, { apply: true });
			expect(result.error).toBeUndefined();
			expect(result.plan.writes.length).toBe(1);
			const store = SessionStore.load(result.plan.writes[0].path);
			const entries = store.linearEntries();
			expect(entries.map((entry) => entry.type)).toEqual([
				"header",
				"message",
				"message",
				"message",
				"message",
				"compaction",
				"message",
			]);
			const messages = store.messages();
			expect(messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"toolResult",
				"user",
			]);
			const assistant = messages[1];
			expect(assistant.role === "assistant" && assistant.content.map((block) => block.type)).toEqual([
				"thinking",
				"text",
				"toolCall",
				"toolCall",
			]);
			expect(assistant.role === "assistant" && assistant.content[0]).toEqual({
				type: "thinking",
				thinking: "weighing options",
			});
			// A failed call keeps its place with the output the source never wrote.
			expect(messages[3].role === "toolResult" && messages[3].isError).toBe(true);
			expect(messages[3].role === "toolResult" && messages[3].content).toEqual([
				{ type: "text", text: "(no output recorded)" },
			]);
			const compaction = entries[5];
			expect(compaction.type === "compaction" && compaction.preTokens).toBe(4321);
			expect(compaction.type === "compaction" && compaction.summary).toBe("summary text");

			// The user's title and the skipped sub-session both show up.
			expect(result.plan.items.some((item) => item.from.includes("Fix the parser"))).toBe(true);
			expect(details(result).some((detail) => detail.includes("subagent session — 1"))).toBe(true);
			expect(result.report).not.toContain("CHILD-CANARY");

			// Reading a source's database must not touch it.
			expect(readFileSync(dbPath).equals(before.bytes)).toBe(true);
			expect(statSync(dbPath).mtimeMs).toBe(before.mtime);
		});
	});

	test("a tool with no recorded name keeps its place under a placeholder", () => {
		withHome({}, (home) => {
			makeHistoryDb(home, {
				sessions: [{ id: "ses-2", directory: CWD, title: "", timeCreated: T0 }],
				messages: [
					{ id: "n1", sessionId: "ses-2", timeCreated: T0, data: { role: "user", time: { created: T0 } } },
					{ id: "n2", sessionId: "ses-2", timeCreated: T0 + 1, data: { role: "assistant", time: { created: T0 + 1 } } },
				],
				parts: [
					{ id: "q1", messageId: "n1", sessionId: "ses-2", timeCreated: T0, data: { type: "text", text: "run it" } },
					{
						id: "q2",
						messageId: "n2",
						sessionId: "ses-2",
						timeCreated: T0 + 1,
						data: { type: "tool", callID: "call_x", state: { status: "completed", input: "{}", output: "ok" } },
					},
				],
			});
			const result = runHistory(home, { apply: true });
			const messages = SessionStore.load(result.plan.writes[0].path).messages();
			const assistant = messages[1];
			expect(assistant.role === "assistant" && assistant.content[0]).toEqual({
				type: "toolCall",
				id: "call_x",
				name: "unknown",
				arguments: "{}",
			});
			expect(messages[2].role === "toolResult" && messages[2].toolName).toBe("unknown");
		});
	});

	test("a home with no database gains no database", () => {
		withHome({ ".zcode/v2/config.json": "{}" }, (home) => {
			const result = runHistory(home, { apply: true });
			expect(result.plan.writes).toEqual([]);
			expect(existsSync(join(home, ".zcode", "cli", "db", "db.sqlite"))).toBe(false);
		});
	});
});

describe("migrate: history options", () => {
	test("parseHistoryScope takes the three values and nothing else", () => {
		expect(parseHistoryScope(undefined)).toBe("cwd");
		expect(parseHistoryScope("")).toBe("cwd");
		expect(parseHistoryScope("all")).toBe("all");
		expect(parseHistoryScope(" none ")).toBe("none");
		const bad = parseHistoryScope("everything");
		expect(typeof bad === "string").toBe(false);
		expect(typeof bad !== "string" && bad.error).toContain("Invalid history scope");
	});

	test("scope none says so instead of quietly importing nothing", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-9999"), claudeRows(CWD));
			const result = runMigration({ home, only: ["history"], historyScope: "none" });
			expect(result.plan.writes).toEqual([]);
			expect(details(result).some((detail) => detail.includes("history import is off"))).toBe(true);
		});
	});

	test("the limit caps the import and reports the rest", () => {
		withHome({}, (home) => {
			for (let index = 0; index < 5; index += 1) {
				writeJsonl(
					claudePath(home, `aaaa-limit-${index}`),
					claudeRows(CWD).map((row) => ({ ...row, timestamp: at(index * 3600) })),
				);
			}
			const result = runHistory(home, { historyLimit: 2, apply: true });
			expect(result.plan.writes.length).toBe(2);
			expect(result.report).toContain("3 more session(s) matched but exceeded the limit");
			// Newest first, so the two newest are the ones taken.
			expect(
				result.plan.writes.some((write) => write.path.includes(importedSessionId("claude-code", "aaaa-limit-4"))),
			).toBe(true);
			expect(
				result.plan.writes.some((write) => write.path.includes(importedSessionId("claude-code", "aaaa-limit-0"))),
			).toBe(false);
		});
	});

	test("a limit of zero imports nothing and says how much was left", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-none"), claudeRows(CWD));
			const result = runHistory(home, { historyLimit: 0 });
			expect(result.error).toBeUndefined();
			expect(result.plan.writes).toEqual([]);
			expect(result.report).toContain("1 more session(s) matched but exceeded the limit");
		});
	});

	test("a second run writes nothing and says why", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-idem"), claudeRows(CWD));
			const first = runHistory(home, { apply: true });
			const path = first.plan.writes[0].path;
			const content = readFileSync(path, "utf8");

			const second = runHistory(home, { apply: true });
			expect(second.plan.writes).toEqual([]);
			expect(details(second).some((detail) => detail.includes("already imported"))).toBe(true);
			expect(readFileSync(path, "utf8")).toBe(content);
			// The target path is derived from the source id, so the two runs agree.
			expect(path).toContain(importedSessionId("claude-code", "aaaa-idem"));
		});
	});

	test("the written transcripts all load with their header in place", () => {
		withHome({}, (home) => {
			writeJsonl(claudePath(home, "aaaa-mix"), claudeRows(CWD));
			const result = runHistory(home, { apply: true });
			expect(result.applied?.failed ?? []).toEqual([]);
			expect(result.applied?.written.length).toBe(1);
			for (const write of result.plan.writes) {
				const store = SessionStore.load(write.path);
				expect(store.messages().length).toBeGreaterThan(0);
				expect(store.linearEntries()[0].type).toBe("header");
			}
		});
	});
});

describe("migrate: prompt history", () => {
	/** A line of the source's prompt history, in the shape Claude Code writes. */
	function sourcePrompt(text: string, cwd: string, ms: number): Record<string, unknown> {
		return { display: text, pastedContents: {}, project: cwd, sessionId: "s-1", timestamp: ms };
	}

	/** A line of the recall file as this build writes it. */
	function recallEntry(text: string, cwd: string, ms: number): Record<string, unknown> {
		return { text, cwd, timestamp: ms };
	}

	const claudePrompts = (home: string): string => join(home, ".claude", "history.jsonl");
	const recallPath = (home: string): string => join(home, ".labunbun", "history.jsonl");

	/** The recall file the run would write, parsed line by line. */
	function writtenPrompts(result: RunMigrationResult): Array<{ text: string; cwd: string; timestamp: number }> {
		const write = result.plan.writes.find((w) => w.kind === "prompt-history");
		return (write?.content ?? "")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { text: string; cwd: string; timestamp: number });
	}

	test("prompts become recall entries tagged with the directory they were typed in", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [
				sourcePrompt("  first prompt  ", CWD, T0),
				sourcePrompt("second prompt", CWD, T0 + 1000),
			]);
			const result = runHistory(home, { apply: true });
			expect(result.error).toBeUndefined();
			expect(writtenPrompts(result)).toEqual([
				{ text: "first prompt", cwd: CWD, timestamp: T0 },
				{ text: "second prompt", cwd: CWD, timestamp: T0 + 1000 },
			]);
			// The written shape is the one ↑ reads back, so check it through recall.
			expect(loadHistory(CWD, 100, home)).toEqual(["first prompt", "second prompt"]);
		});
	});

	test("what the source's own recorder would have skipped is skipped here too", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [
				sourcePrompt("/compact", CWD, T0),
				sourcePrompt("   ", CWD, T0),
				sourcePrompt("[Pasted text #1 +42 lines]", CWD, T0),
				sourcePrompt("look at [Pasted text #2 +3 lines] and fix it", CWD, T0 + 4000),
			]);
			const result = runHistory(home);
			// A prompt that merely mentions a paste is a real prompt and travels.
			expect(writtenPrompts(result).map((entry) => entry.text)).toEqual([
				"look at [Pasted text #2 +3 lines] and fix it",
			]);
			const report = result.report;
			expect(report).toContain("slash command — 1 not imported");
			expect(report).toContain("empty prompt — 1 not imported");
			expect(report).toContain("pasted block");
		});
	});

	test("a history of nothing but slash commands writes nothing, and says why", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [sourcePrompt("/compact", CWD, T0), sourcePrompt("/migrate", CWD, T0)]);
			const result = runHistory(home, { apply: true });
			expect(result.plan.writes).toEqual([]);
			expect(result.report).toContain("slash command — 2 not imported");
		});
	});

	test("the default scope is this project, and the rest is accounted for", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [
				sourcePrompt("here", CWD, T0),
				sourcePrompt("elsewhere", join(CWD, "..", "other-project"), T0 + 1000),
			]);
			const result = runMigration({ home, only: ["history"] });
			expect(writtenPrompts(result).map((entry) => entry.text)).toEqual(["here"]);
			expect(result.report).toContain("prompt from another directory — 1 not imported");
		});
	});

	test("codex prompts find their directory through the session's rollout", () => {
		withHome({}, (home) => {
			writeJsonl(join(home, ".codex", "sessions", "2026", "01", "02", "rollout-2026-01-02T00-00-00-sess-1.jsonl"), [
				{ timestamp: at(0), type: "session_meta", payload: { cwd: CWD, session_id: "sess-1" } },
			]);
			writeJsonl(join(home, ".codex", "history.jsonl"), [
				// Codex records seconds; the target stores epoch ms.
				{ session_id: "sess-1", text: "codex prompt", ts: (T0 + 1000) / 1000 },
				{ session_id: "sess-unknown", text: "orphan prompt", ts: (T0 + 2000) / 1000 },
			]);
			const result = runHistory(home, { apply: true });
			expect(writtenPrompts(result)).toEqual([{ text: "codex prompt", cwd: CWD, timestamp: T0 + 1000 }]);
			// A prompt no directory can recall is not worth writing, but it is worth saying.
			expect(result.report).toContain("no rollout on disk — 1 not imported");
		});
	});

	test("both sources land in one file, in the order they were typed", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [sourcePrompt("claude prompt", CWD, T0 + 5000)]);
			writeJsonl(join(home, ".codex", "sessions", "2026", "01", "02", "rollout-2026-01-02T00-00-00-sess-1.jsonl"), [
				{ timestamp: at(0), type: "session_meta", payload: { cwd: CWD, session_id: "sess-1" } },
			]);
			writeJsonl(join(home, ".codex", "history.jsonl"), [
				{ session_id: "sess-1", text: "codex prompt", ts: (T0 + 1000) / 1000 },
			]);
			const result = runHistory(home, { apply: true });
			expect(writtenPrompts(result).map((entry) => entry.text)).toEqual(["codex prompt", "claude prompt"]);
		});
	});

	test("an entry already in the recall file is kept there, not written twice", () => {
		withHome({}, (home) => {
			writeJsonl(recallPath(home), [recallEntry("mine already", CWD, T0 + 9000)]);
			writeJsonl(claudePrompts(home), [
				sourcePrompt("imported one", CWD, T0),
				sourcePrompt("mine already", CWD, T0 - 10_000),
			]);
			const result = runHistory(home);
			// Imported prompts go in front: the newest entries are what ↑ offers first.
			expect(writtenPrompts(result)).toEqual([
				{ text: "imported one", cwd: CWD, timestamp: T0 },
				{ text: "mine already", cwd: CWD, timestamp: T0 + 9000 },
			]);
			expect(result.report).toContain("1 prompt(s) added to the recall history, 1 already there");
			expect(result.plan.writes.find((w) => w.kind === "prompt-history")?.path).toBe(recallPath(home));
		});
	});

	test("the same prompt typed in two directories is two entries", () => {
		withHome({}, (home) => {
			const other = join(CWD, "..", "other-project");
			writeJsonl(recallPath(home), [recallEntry("same words", other, T0 + 9000)]);
			writeJsonl(claudePrompts(home), [sourcePrompt("same words", CWD, T0), sourcePrompt("same words", other, T0)]);
			const result = runHistory(home);
			// Recall is filtered per directory, so the copy for this project is not a
			// duplicate of the one under another — while the copy under the other
			// directory is, and is left where it already is.
			expect(writtenPrompts(result).map((entry) => entry.cwd)).toEqual([CWD, other]);
		});
	});

	test("a second run writes nothing at all", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [sourcePrompt("remember me", CWD, T0)]);
			const first = runHistory(home, { apply: true });
			const path = first.plan.writes[0].path;
			const content = readFileSync(path, "utf8");

			const second = runHistory(home, { apply: true });
			expect(second.plan.writes).toEqual([]);
			expect(details(second).some((detail) => detail.includes("already in the recall history"))).toBe(true);
			expect(readFileSync(path, "utf8")).toBe(content);
			// The source keeps its own history: a migration reads, never rewrites.
			expect(readFileSync(claudePrompts(home), "utf8")).toContain("remember me");
		});
	});

	test("the limit takes the newest prompts, and counts the rest", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [
				sourcePrompt("old", CWD, T0),
				sourcePrompt("middle", CWD, T0 + 1000),
				sourcePrompt("new", CWD, T0 + 2000),
			]);
			const read = readPromptHistory("claude-code", home, { cwd: CWD, scope: "all", limit: 2 });
			expect(read.seen).toBe(3);
			expect(read.entries.map((entry) => entry.text)).toEqual(["middle", "new"]);
			expect(read.overLimit).toBe(1);
		});
	});

	test("a line that is not a prompt is counted, not fatal", () => {
		withHome(
			{
				".claude/history.jsonl": `not json at all\n${JSON.stringify(sourcePrompt("real", CWD, T0))}\n`,
			},
			(home) => {
				const result = runMigration({ home, only: ["history"], historyScope: "all" });
				expect(writtenPrompts(result).map((entry) => entry.text)).toEqual(["real"]);
				expect(result.report).toContain("line not in the history shape — 1 not imported");
			},
		);
	});

	test("scope none leaves the recall list alone", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [sourcePrompt("keep out", CWD, T0)]);
			const result = runMigration({ home, only: ["history"], historyScope: "none" });
			expect(result.plan.writes).toEqual([]);
		});
	});

	test("the categories decide: history off means no recall entries either", () => {
		withHome({}, (home) => {
			writeJsonl(claudePrompts(home), [sourcePrompt("keep out", CWD, T0)]);
			const result = runMigration({ home, only: ["settings", "assets"], historyScope: "all" });
			expect(result.plan.writes).toEqual([]);
		});
	});
});
