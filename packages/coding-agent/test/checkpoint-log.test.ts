/**
 * The tool ledger: the entry one finished tool call leaves, and the three
 * readers that turn the file back into answers.
 *
 * The hashes are the point of the record, so the tests that read them back
 * compute their own with `node:crypto` rather than with the function under
 * test: a suite that asked `sha256Of` what `sha256Of` computed would stay green
 * through any change to what is being hashed — including hashing the wrong
 * string, which is the one bug this field can have.
 *
 * `/checkpoint` is driven through the real `handleAppCommand` with a hand-built
 * context, because what it renders is the whole contract: the command is the
 * only reader of the ledger a user ever sees, and its lines are built from
 * snapshots rather than from strings it keeps.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEntry, SessionStore } from "@labunbun/agent";
import { textContent, toolResultMessage } from "@labunbun/ai";
import type { AgentTask } from "@labunbun/tools";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import {
	createToolLedger,
	FAILED_TESTS_MAX,
	failedTestsFromTestOutput,
	formatResumeSummary,
	INPUT_SUMMARY_MAX_CHARS,
	latestTestFailures,
	looksLikeTestRun,
	nextStepFromTasks,
	readToolCheckpoints,
	recordRewind,
	resendCheckpointsAcrossCompaction,
	summarizeToolInput,
	touchedFileReports,
	writeToolCheckpoint,
} from "../src/checkpoint-log.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp directory that is cleaned up with the run. */
function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** The test's own sha256 — see the file comment for why it is not the module's. */
function hashOf(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** The payloads of every `custom` entry of one kind, in file order. */
function customs(entries: readonly SessionEntry[], kind: string): unknown[] {
	return entries
		.filter((entry) => entry.type === "custom")
		.map((entry) => entry as Extract<SessionEntry, { type: "custom" }>)
		.filter((entry) => entry.kind === kind)
		.map((entry) => entry.data);
}

describe("the checkpoint entry", () => {
	test("round-trips through the session file field for field", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-cwd-"), scratch("lbb-cplog-home-"));
		const record = {
			at: 1_700_000_000_000,
			callId: "call-1",
			toolName: "Edit",
			isError: false,
			filesTouched: [{ path: "/tmp/x", beforeHash: "aa", afterHash: "bb" }],
			inputSummary: "bun test",
			truncated: true,
		};
		writeToolCheckpoint(store, record);

		// Back out of the written entries, the way a later resuming process reads
		// them — not out of the object the test still has a reference to.
		expect(readToolCheckpoints(store.entries)).toEqual([record]);
	});

	test("a payload this build cannot read costs only itself", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-cwd-"), scratch("lbb-cplog-home-"));
		store.appendCustom("checkpoint", null);
		store.appendCustom("checkpoint", { toolName: "Bash" }); // no callId, no isError, no at
		store.appendCustom("checkpoint", { callId: "c", toolName: "Bash", isError: "no", at: 7 });
		// A different kind wearing a similar shape is not this reader's business.
		store.appendCustom("file_checkpoint", { path: "/tmp/x", content: "v", at: 1 });
		store.appendCustom("checkpoint", { callId: "c2", toolName: "Bash", isError: false, at: 8 });

		const records = readToolCheckpoints(store.entries);
		expect(records).toEqual([{ at: 8, callId: "c2", toolName: "Bash", isError: false }]);
	});

	test("a file row with no path is dropped, and a readable one beside it is kept", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-cwd-"), scratch("lbb-cplog-home-"));
		store.appendCustom("checkpoint", {
			at: 1,
			callId: "c",
			toolName: "Edit",
			isError: false,
			filesTouched: [{ path: "/tmp/ok", beforeHash: "h", afterHash: null }, null, { beforeHash: "h" }],
		});

		expect(readToolCheckpoints(store.entries)[0]?.filesTouched).toEqual([
			{ path: "/tmp/ok", beforeHash: "h", afterHash: null },
		]);
	});
});

describe("the input summary", () => {
	test("keeps the field that names the act, not whatever key came first", () => {
		expect(summarizeToolInput({ timeout: 5000, command: "bun test" })).toEqual({
			text: "bun test",
			truncated: false,
		});
		expect(summarizeToolInput({ file_path: "/a/b.ts" })).toEqual({ text: "/a/b.ts", truncated: false });
		expect(summarizeToolInput({ pattern: "TODO" })).toEqual({ text: "TODO", truncated: false });
	});

	test("an empty known field does not win over a populated one", () => {
		expect(summarizeToolInput({ command: "", file_path: "/f" })).toEqual({ text: "/f", truncated: false });
	});

	test("caps the text and admits the cut", () => {
		const long = "x".repeat(INPUT_SUMMARY_MAX_CHARS + 50);
		const summary = summarizeToolInput({ command: long });
		expect(summary?.text).toBe(`${"x".repeat(INPUT_SUMMARY_MAX_CHARS)}…`);
		expect(summary?.truncated).toBe(true);
	});

	test("nothing worth quoting is no summary, not an empty one", () => {
		expect(summarizeToolInput({})).toBeUndefined();
		expect(summarizeToolInput({ timeout: 5 })).toBeUndefined();
		expect(summarizeToolInput({ command: 5 })).toBeUndefined();
		expect(summarizeToolInput(null)).toBeUndefined();
		expect(summarizeToolInput("ls")).toBeUndefined();
	});
});

describe("the files a session touched, against the disk now", () => {
	const cwd = scratch("lbb-cplog-drift-");
	const existing = join(cwd, "a.ts");
	writeFileSync(existing, "as recorded", "utf8");
	const gone = join(cwd, "b.ts");
	const unhashed = join(cwd, "c.ts");
	writeFileSync(unhashed, "whatever", "utf8");

	test("each path gets the newest fingerprint, and one of four verdicts", () => {
		const readFile = (path: string): string | null => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		};
		const reports = touchedFileReports(
			[
				{
					at: 1,
					callId: "c1",
					toolName: "Write",
					isError: false,
					// A stale first pass on `a.ts`, superseded by the second entry.
					filesTouched: [{ path: existing, beforeHash: null, afterHash: hashOf("something else") }],
				},
				{
					at: 2,
					callId: "c2",
					toolName: "Edit",
					isError: false,
					filesTouched: [
						{ path: existing, beforeHash: hashOf("something else"), afterHash: hashOf("as recorded") },
						{ path: gone, beforeHash: null, afterHash: hashOf("was here") },
						{ path: unhashed, beforeHash: null, afterHash: null },
					],
				},
			],
			readFile,
		);

		expect(reports).toEqual([
			{ path: existing, state: "unchanged", afterHash: hashOf("as recorded") },
			{ path: gone, state: "missing", afterHash: hashOf("was here") },
			// The file is right there — and still unfingerprinted: no hash was taken,
			// and hashing it now would invent the comparison the entry never made.
			{ path: unhashed, state: "unfingerprinted", afterHash: null },
		]);
	});

	test("a file that moved since is changed", () => {
		const moved = join(cwd, "d.ts");
		writeFileSync(moved, "new content", "utf8");
		const reports = touchedFileReports(
			[
				{
					at: 1,
					callId: "c",
					toolName: "Write",
					isError: false,
					filesTouched: [{ path: moved, beforeHash: null, afterHash: hashOf("old content") }],
				},
			],
			(path) => {
				try {
					return readFileSync(path, "utf8");
				} catch {
					return null;
				}
			},
		);
		expect(reports).toEqual([{ path: moved, state: "changed", afterHash: hashOf("old content") }]);
	});
});

describe("what a compaction pass re-sends", () => {
	test("latest checkpoint per path and every unclosed shell, and nothing else", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-cwd-"), scratch("lbb-cplog-home-"));
		const p1 = "/tmp/one.ts";
		const p2 = "/tmp/two.ts";
		store.appendCustom("file_checkpoint", { path: p1, content: "one", at: 1 });
		store.appendCustom("file_checkpoint", { path: p1, content: "two", at: 2 });
		store.appendCustom("file_checkpoint", { path: p2, content: "x", at: 3 });
		// A pid that started and ended: nothing to re-send.
		store.appendCustom("shell_start", {
			shellId: "sh-1",
			pid: 111,
			command: "first",
			cwd: "/",
			startedAt: 1,
			outputFile: "/tmp/1.log",
		});
		store.appendCustom("shell_end", { pid: 111, status: "completed", exitCode: 0 });
		// A pid that started, ended, and started again: the later start is the shell.
		store.appendCustom("shell_start", {
			shellId: "sh-2",
			pid: 222,
			command: "old",
			cwd: "/",
			startedAt: 2,
			outputFile: "/tmp/2.log",
		});
		store.appendCustom("shell_start", {
			shellId: "sh-3",
			pid: 222,
			command: "second",
			cwd: "/",
			startedAt: 3,
			outputFile: "/tmp/3.log",
		});
		const before = store.entries.length;

		resendCheckpointsAcrossCompaction(store);

		const added = store.entries.slice(before);
		expect(added.map((entry) => (entry.type === "custom" ? entry.kind : entry.type))).toEqual([
			"file_checkpoint",
			"file_checkpoint",
			"shell_start",
		]);
		expect(added[0]?.type === "custom" ? added[0].data : null).toEqual({ path: p1, content: "two", at: 2 });
		expect(added[1]?.type === "custom" ? added[1].data : null).toEqual({ path: p2, content: "x", at: 3 });
		// The pid-222 start re-sent is the *later* one: with no end between them
		// there is one shell to speak of, and the later record is the live one.
		const shellCommands = added
			.slice(2)
			.map((entry) => (entry.type === "custom" ? (entry.data as { command?: string }).command : undefined));
		expect(shellCommands).toEqual(["second"]);
	});

	test("no store is not an error", () => {
		expect(() => resendCheckpointsAcrossCompaction(undefined)).not.toThrow();
	});
});

describe("recordRewind", () => {
	test("writes the path, the entry restored from, and a time", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-cwd-"), scratch("lbb-cplog-home-"));
		const before = Date.now();
		recordRewind(store, "/tmp/x.ts", "entry-7");

		const [data] = customs(store.entries, "rewind") as Array<{ at: number; path: string; fromEntryId: string }>;
		expect(data?.path).toBe("/tmp/x.ts");
		expect(data?.fromEntryId).toBe("entry-7");
		expect(data?.at).toBeGreaterThanOrEqual(before);
	});
});

/**
 * `/rewind` and `/checkpoint` through the real dispatch, on a session file and
 * a UI store built by hand — the same wiring `rewind-checkpoint.test.ts` uses.
 */
interface Harness {
	ctx: AppCommandContext;
	store: SessionStore;
	cwd: string;
	target: string;
	info(): string;
}

function harness(overrides: Record<string, unknown> = {}): Harness {
	const home = scratch("lbb-cpcmd-home-");
	const cwd = scratch("lbb-cpcmd-cwd-");
	const store = SessionStore.startNew(cwd, home);
	const target = join(cwd, "notes.md");
	const ui = createStore<UiState>(initialUiState(false));
	const ctx = {
		getSession: () => null,
		sessionStore: () => store,
		handle: { store: ui },
		...overrides,
	} as unknown as AppCommandContext;
	return {
		ctx,
		store,
		cwd,
		target,
		info: () =>
			ui
				.get()
				.entries.filter((entry) => entry.kind === "info")
				.map((entry) => (entry as { text: string }).text)
				.join("\n"),
	};
}

describe("/rewind writes the rollback it made", () => {
	test("a successful restore leaves a rewind entry naming the checkpoint it came from", () => {
		const h = harness();
		writeFileSync(h.target, "after the edit", "utf8");
		const entry = h.store.appendCustom("file_checkpoint", { path: h.target, content: "before the edit", at: 1 });

		expect(handleAppCommand("/rewind 0", h.ctx)).toBe(true);

		expect(readFileSync(h.target, "utf8")).toBe("before the edit");
		const [record] = customs(h.store.entries, "rewind") as Array<{ path: string; fromEntryId: string }>;
		expect(record?.path).toBe(h.target);
		expect(record?.fromEntryId).toBe(entry.id);
	});

	test("a refused restore records nothing", () => {
		const h = harness();
		writeFileSync(h.target, "still here", "utf8");
		// A payload with no content: refused, so no write happened — and a rewind
		// entry for a restore that did not happen would be the ledger lying.
		h.store.appendCustom("file_checkpoint", { path: h.target, at: 1 });

		expect(handleAppCommand("/rewind 0", h.ctx)).toBe(true);

		expect(h.info()).toContain("cannot be read");
		expect(customs(h.store.entries, "rewind")).toEqual([]);
	});
});

describe("/checkpoint", () => {
	test("an empty session says what it is", () => {
		const h = harness();
		expect(handleAppCommand("/checkpoint", h.ctx)).toBe(true);
		const info = h.info();
		expect(info).toContain("No tool calls recorded yet");
		expect(info).toContain("Tasks: none.");
		expect(info).toContain("Context: no live session to measure.");
	});

	test("the last call, the files against the disk, the tasks, and the context", () => {
		const h = harness({
			taskSnapshot: () => [
				{ id: "1", subject: "Scaffold", description: "d", status: "completed", blockedBy: [], createdAt: 0 },
				{ id: "2", subject: "Fix the parser", description: "d", status: "in_progress", blockedBy: [], createdAt: 0 },
			],
			compaction: () => ({ limits: () => ({ contextWindow: 200_000, threshold: 200_000, hardLimit: 205_000 }) }),
			getSession: () => ({
				currentContext: () => ({ systemPrompt: "x".repeat(40), messages: [] }),
			}),
		});
		// The disk has moved on since the call that recorded the hash — which is
		// exactly the verdict the report exists to state.
		writeFileSync(h.target, "v2", "utf8");
		writeToolCheckpoint(h.store, {
			at: 1_700_000_000_000,
			callId: "c1",
			toolName: "Write",
			isError: false,
			filesTouched: [{ path: h.target, beforeHash: null, afterHash: hashOf("v1") }],
			inputSummary: h.target,
		});
		writeToolCheckpoint(h.store, {
			at: 1_700_000_001_000,
			callId: "c2",
			toolName: "Bash",
			isError: true,
			inputSummary: "bun test",
		});

		expect(handleAppCommand("/checkpoint", h.ctx)).toBe(true);

		const info = h.info();
		expect(info).toContain("Checkpoints — 2 tool calls recorded, 1 failed.");
		expect(info).toContain("Last: Bash failed at ");
		expect(info).toContain("(bun test).");
		expect(info).toContain("Files touched (1), read against the disk now:");
		expect(info).toContain("changed");
		expect(info).toContain(h.target);
		expect(info).toContain("no longer matches the hash the last call recorded");
		expect(info).toContain("Tasks (2): 1 done, 1 in progress, 0 pending.");
		expect(info).toContain("#2 [in_progress] Fix the parser");
		// 40 chars at 4 chars a token, measured by the same estimate the status row
		// shows — the number itself is asserted only as a number, since the constant
		// is the estimator's to own.
		expect(info).toMatch(/Context: \d+ tokens used of 200\.0k before auto-compact\./);
	});

	test("files read clean are reported as they are found", () => {
		const h = harness();
		writeFileSync(h.target, "as recorded", "utf8");
		writeToolCheckpoint(h.store, {
			at: 1_700_000_000_000,
			callId: "c1",
			toolName: "Edit",
			isError: false,
			filesTouched: [{ path: h.target, beforeHash: hashOf("before"), afterHash: hashOf("as recorded") }],
		});

		expect(handleAppCommand("/checkpoint", h.ctx)).toBe(true);
		expect(h.info()).toContain("unchanged");
		expect(h.info()).toContain(h.target);
	});

	test("the failing tests and the next step the ledger holds", () => {
		const h = harness();
		// The test run is an older call; the next step is the newest one's. The
		// two clauses read from different entries on purpose — a run's failures
		// stay true until another run, while the plan is only what the newest
		// call said it was.
		writeToolCheckpoint(h.store, {
			at: 1_700_000_000_000,
			callId: "c1",
			toolName: "Bash",
			isError: true,
			inputSummary: "bun test",
			failedTests: ["parser > rejects empty", "runner > slow"],
		});
		writeToolCheckpoint(h.store, {
			at: 1_700_000_001_000,
			callId: "c2",
			toolName: "Edit",
			isError: false,
			nextStep: "Fixing the parser",
		});

		expect(handleAppCommand("/checkpoint", h.ctx)).toBe(true);

		const info = h.info();
		expect(info).toContain("Next: Fixing the parser");
		expect(info).toContain("Failing tests (2, from the run at ");
		expect(info).toContain("  parser > rejects empty");
		expect(info).toContain("  runner > slow");
	});

	test("a capped run keeps its count and admits the names it did not keep", () => {
		const h = harness();
		writeToolCheckpoint(h.store, {
			at: 1_700_000_000_000,
			callId: "c1",
			toolName: "Bash",
			isError: true,
			failedTests: ["first > one", "second > two"],
			failedTestsOmitted: 3,
		});

		expect(handleAppCommand("/checkpoint", h.ctx)).toBe(true);
		expect(h.info()).toContain("Failing tests (5, from the run at ");
		expect(h.info()).toContain("…and 3 more not named.");
	});

	test("a call that stated no next step leaves the line out", () => {
		const h = harness();
		writeToolCheckpoint(h.store, { at: 1, callId: "c1", toolName: "Read", isError: false, nextStep: "Old plan" });
		writeToolCheckpoint(h.store, { at: 2, callId: "c2", toolName: "Read", isError: false });

		expect(handleAppCommand("/checkpoint", h.ctx)).toBe(true);
		// The board had no open work as of the newest call; the older plan is
		// history, and printing it would say the session is still on it.
		expect(h.info()).not.toContain("Next:");
		expect(h.info()).not.toContain("Old plan");
	});
});

describe("the test-run gate", () => {
	test("recognizes the invocations this project actually types", () => {
		expect(looksLikeTestRun("bun test")).toBe(true);
		expect(looksLikeTestRun("bun run test")).toBe(true);
		// Quoted, path-qualified, with a package after it — the repo's own form.
		expect(looksLikeTestRun('"$USERPROFILE/.bun/bin/bun.exe" test packages/coding-agent/test/x.test.ts')).toBe(true);
		expect(looksLikeTestRun("pnpm test")).toBe(true);
		expect(looksLikeTestRun("npm run test")).toBe(true);
		expect(looksLikeTestRun("yarn test")).toBe(true);
		expect(looksLikeTestRun("cd packages/x && bun test --filter y")).toBe(true);
		expect(looksLikeTestRun("NODE_ENV=test bun test")).toBe(true);
		expect(looksLikeTestRun("./node_modules/.bin/vitest run")).toBe(true);
		expect(looksLikeTestRun("./node_modules/.bin/jest")).toBe(true);
	});

	test("a mention inside someone else's words is not a test run", () => {
		expect(looksLikeTestRun("echo bun test")).toBe(false);
		expect(looksLikeTestRun("grep -r 'bun test' README.md")).toBe(false);
		expect(looksLikeTestRun("bun install")).toBe(false);
		expect(looksLikeTestRun("bun run build")).toBe(false);
		expect(looksLikeTestRun("bun")).toBe(false);
		expect(looksLikeTestRun("npm run lint")).toBe(false);
		expect(looksLikeTestRun("cat test")).toBe(false);
	});
});

describe("failing test names out of a result", () => {
	test("reads bun's (fail) lines, with or without the timing suffix", () => {
		const text = [
			"bun test v1.3.5",
			"",
			"(fail) parser > rejects an empty body [16.00ms]",
			"some other line",
			"(fail) runner > times out",
			"(fail) windows line endings [0.21ms]\r",
			" 3 fail",
		].join("\n");

		expect(failedTestsFromTestOutput(text)).toEqual({
			names: ["parser > rejects an empty body", "runner > times out", "windows line endings"],
			omitted: 0,
		});
	});

	test("a line that only looks like one is not one", () => {
		expect(failedTestsFromTestOutput("(fail) ")).toBeUndefined();
		expect(failedTestsFromTestOutput("not (fail) at the start")).toBeUndefined();
		expect(failedTestsFromTestOutput("(failed) x")).toBeUndefined();
		expect(failedTestsFromTestOutput("")).toBeUndefined();
	});

	test("keeps the first names and counts the rest", () => {
		// The cap is a number the spec fixed, not one this file derives.
		expect(FAILED_TESTS_MAX).toBe(20);
		const lines: string[] = [];
		for (let i = 0; i < FAILED_TESTS_MAX + 3; i++) lines.push(`(fail) test number ${i} [1.00ms]`);

		const parsed = failedTestsFromTestOutput(lines.join("\n"));
		expect(parsed?.names).toHaveLength(FAILED_TESTS_MAX);
		expect(parsed?.names[0]).toBe("test number 0");
		expect(parsed?.names.at(-1)).toBe(`test number ${FAILED_TESTS_MAX - 1}`);
		expect(parsed?.omitted).toBe(3);
	});

	test("names are kept as printed, duplicates included", () => {
		// Two suites can hold a test with the same name, and a failure line does
		// not say which file it came from — collapsing them would under-report.
		expect(failedTestsFromTestOutput("(fail) a > x\n(fail) a > x")?.names).toEqual(["a > x", "a > x"]);
	});
});

describe("the next step out of the task board", () => {
	const task = (over: Partial<AgentTask>): AgentTask => ({
		id: "1",
		subject: "a subject",
		description: "d",
		status: "pending",
		blockedBy: [],
		createdAt: 0,
		...over,
	});

	test("the in-progress task speaks for the session, its label first", () => {
		expect(
			nextStepFromTasks([
				task({ id: "1", subject: "Scaffold the parser" }),
				task({ id: "2", subject: "Fix the parser", status: "in_progress", activeForm: "Fixing the parser" }),
			]),
		).toBe("Fixing the parser");
		expect(nextStepFromTasks([task({ id: "2", subject: "Fix the parser", status: "in_progress" })])).toBe(
			"Fix the parser",
		);
	});

	test("otherwise the first pending task, and no open work is no step", () => {
		expect(
			nextStepFromTasks([
				task({ id: "1", subject: "Done already", status: "completed" }),
				task({ id: "2", subject: "Run the tests" }),
			]),
		).toBe("Run the tests");
		expect(nextStepFromTasks([task({ status: "completed" })])).toBeUndefined();
		expect(nextStepFromTasks([])).toBeUndefined();
	});
});

/** The ledger under test: writes into `store`, reads real files off the disk. */
function makeLedger(store: SessionStore | undefined) {
	return createToolLedger({
		store: () => store,
		readFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
	});
}

/** One finished call, the way the loop's end event carries it. */
function endedCall(callId: string, toolName: string, output: string, isError: boolean) {
	return { callId, toolName, result: toolResultMessage(callId, toolName, [textContent(output)], isError) };
}

describe("the ledger writer", () => {
	test("a failed test run leaves its failing tests, and the board's next step", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-ledger-cwd-"), scratch("lbb-cplog-ledger-home-"));
		store.appendCustom("tasks", [
			{ id: "1", subject: "Scaffold", description: "d", status: "completed", blockedBy: [], createdAt: 0 },
			{
				id: "2",
				subject: "Fix the parser",
				description: "d",
				status: "in_progress",
				activeForm: "Fixing the parser",
				blockedBy: [],
				createdAt: 0,
			},
		]);
		const ledger = makeLedger(store);

		ledger.noteToolStart("c1", { command: "bun test packages/x" });
		ledger.noteToolEnd(endedCall("c1", "Bash", "(fail) parser > rejects empty [1.00ms]\n(fail) runner > slow", true));

		const [record] = readToolCheckpoints(store.entries);
		expect(record).toEqual({
			at: expect.any(Number),
			callId: "c1",
			toolName: "Bash",
			isError: true,
			inputSummary: "bun test packages/x",
			failedTests: ["parser > rejects empty", "runner > slow"],
			nextStep: "Fixing the parser",
		});
	});

	test("a successful call and a non-test command are not parsed", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-ledger-cwd-"), scratch("lbb-cplog-ledger-home-"));
		const ledger = makeLedger(store);
		// Exit 0: whatever the output holds, the run said it succeeded.
		ledger.noteToolStart("c1", { command: "bun test" });
		ledger.noteToolEnd(endedCall("c1", "Bash", "(fail) x [1ms]", false));
		// Failed, but not a test run: one failure line quoted out of something
		// else must not become this session's failing tests.
		ledger.noteToolStart("c2", { command: "cat build.log" });
		ledger.noteToolEnd(endedCall("c2", "Bash", "(fail) y [1ms]", true));

		const records = readToolCheckpoints(store.entries);
		expect(records).toHaveLength(2);
		expect(records[0]?.failedTests).toBeUndefined();
		expect(records[1]?.failedTests).toBeUndefined();
		expect(records[0]?.nextStep).toBeUndefined();
	});

	test("the cap keeps the count honest", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-ledger-cwd-"), scratch("lbb-cplog-ledger-home-"));
		const ledger = makeLedger(store);
		const output = Array.from({ length: FAILED_TESTS_MAX + 2 }, (_, i) => `(fail) test ${i} [1ms]`).join("\n");
		ledger.noteToolStart("c1", { command: "pnpm test" });
		ledger.noteToolEnd(endedCall("c1", "Bash", output, true));

		const [record] = readToolCheckpoints(store.entries);
		expect(record?.failedTests).toHaveLength(FAILED_TESTS_MAX);
		expect(record?.failedTestsOmitted).toBe(2);
	});

	test("with no store nothing is written and nothing throws", () => {
		const ledger = makeLedger(undefined);
		expect(() => {
			ledger.noteToolStart("c1", { command: "bun test" });
			ledger.noteToolEnd(endedCall("c1", "Bash", "(fail) x", true));
			ledger.noteBeforeMutation("Write", { file_path: "/tmp/never" });
			ledger.noteAfterMutation("Write", { file_path: "/tmp/never" }, false);
		}).not.toThrow();
	});

	test("an Edit leaves the fingerprints, the rewind payload, and the entry", () => {
		const cwd = scratch("lbb-cplog-ledger-cwd-");
		const target = join(cwd, "notes.txt");
		writeFileSync(target, "before", "utf8");
		const store = SessionStore.startNew(cwd, scratch("lbb-cplog-ledger-home-"));
		const ledger = makeLedger(store);

		ledger.noteBeforeMutation("Edit", { file_path: target });
		writeFileSync(target, "after", "utf8");
		ledger.noteAfterMutation("Edit", { file_path: target }, false);
		ledger.noteToolStart("c1", { file_path: target, old_string: "before", new_string: "after" });
		ledger.noteToolEnd(endedCall("c1", "Edit", "edited", false));

		const [record] = readToolCheckpoints(store.entries);
		expect(record?.filesTouched).toEqual([{ path: target, beforeHash: hashOf("before"), afterHash: hashOf("after") }]);
		expect(record?.nextStep).toBeUndefined();
		// The same read fed /rewind: the content the before side was hashed from.
		const fileCheckpoints = customs(store.entries, "file_checkpoint");
		expect(fileCheckpoints).toEqual([{ path: target, content: "before", at: expect.any(Number) }]);
	});

	test("a failed mutation leaves the after side unfingerprinted, not guessed", () => {
		const cwd = scratch("lbb-cplog-ledger-cwd-");
		const target = join(cwd, "never-created.txt");
		const store = SessionStore.startNew(cwd, scratch("lbb-cplog-ledger-home-"));
		const ledger = makeLedger(store);

		ledger.noteBeforeMutation("Write", { file_path: target });
		writeFileSync(target, "the write actually landed", "utf8");
		ledger.noteAfterMutation("Write", { file_path: target }, true);
		ledger.noteToolStart("c1", { file_path: target, content: "x" });
		ledger.noteToolEnd(endedCall("c1", "Write", "failed", true));

		const [record] = readToolCheckpoints(store.entries);
		expect(record?.filesTouched).toEqual([{ path: target, beforeHash: null, afterHash: null }]);
	});

	test("a call whose before hook never ran leaves no file row", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-ledger-cwd-"), scratch("lbb-cplog-ledger-home-"));
		const ledger = makeLedger(store);
		// No noteBeforeMutation: the shape the loop leaves for an input the
		// schema refused — nothing validated, so nothing was fingerprinted, and a
		// row would be a claim built on input nothing accepted.
		ledger.noteToolStart("c1", { file_path: "/somewhere/else.txt" });
		ledger.noteToolEnd(endedCall("c1", "Edit", "blocked", true));

		const [record] = readToolCheckpoints(store.entries);
		expect(record?.filesTouched).toBeUndefined();
	});
});

describe("the checkpoint entry's new fields", () => {
	test("round-trip, and a malformed list costs the list, not the entry", () => {
		const store = SessionStore.startNew(scratch("lbb-cplog-rt-cwd-"), scratch("lbb-cplog-rt-home-"));
		const record = {
			at: 7,
			callId: "c1",
			toolName: "Bash",
			isError: true,
			failedTests: ["a > b", "c > d"],
			failedTestsOmitted: 4,
			nextStep: "Fix it",
		};
		writeToolCheckpoint(store, record);
		expect(readToolCheckpoints(store.entries)).toEqual([record]);

		store.appendCustom("checkpoint", {
			at: 8,
			callId: "c2",
			toolName: "Bash",
			isError: true,
			failedTests: [5, ""],
			failedTestsOmitted: 0,
			nextStep: "",
		});
		expect(readToolCheckpoints(store.entries)[1]).toEqual({ at: 8, callId: "c2", toolName: "Bash", isError: true });
	});
});

describe("the recovery line", () => {
	const at = new Date("2026-10-13T10:11:12");
	const when = at.toLocaleTimeString();
	const checkpoint = (over: Partial<ToolCheckpointForTest>): ToolCheckpointForTest => ({
		at: at.getTime(),
		callId: "c",
		toolName: "Bash",
		isError: false,
		...over,
	});

	// The same shape the module exports, restated so this file does not import
	// the type it is testing against — the strings are the contract here.
	type ToolCheckpointForTest = Parameters<typeof formatResumeSummary>[0][number];

	test("says what the ledger holds, in the order a reader needs it", () => {
		expect(
			formatResumeSummary([
				checkpoint({
					at: at.getTime() - 60_000,
					callId: "c1",
					toolName: "Edit",
					filesTouched: [{ path: "/a", beforeHash: null, afterHash: "xx" }],
				}),
				checkpoint({
					callId: "c2",
					isError: true,
					failedTests: ["parser > rejects empty"],
					nextStep: "Fixing the parser",
				}),
			]),
		).toBe(
			`Resumed: last Bash failed at ${when}, 2 tool calls recorded, 1 file touched, 1 failing test. ` +
				"Next: Fixing the parser. /checkpoint shows the ledger; /rewind restores a file.",
		);
	});

	test("one call reads as one call, and distinct paths are counted once", () => {
		expect(
			formatResumeSummary([
				checkpoint({
					toolName: "Write",
					filesTouched: [{ path: "/a", beforeHash: null, afterHash: null }],
				}),
			]),
		).toBe(
			`Resumed: last Write ok at ${when}, 1 tool call recorded, 1 file touched. /checkpoint shows the ledger; /rewind restores a file.`,
		);
	});

	test("the count of files is paths, not rows", () => {
		expect(
			formatResumeSummary([
				checkpoint({ toolName: "Edit", filesTouched: [{ path: "/a", beforeHash: null, afterHash: "1" }] }),
				checkpoint({ toolName: "Edit", filesTouched: [{ path: "/a", beforeHash: "1", afterHash: "2" }] }),
				checkpoint({ toolName: "Edit", filesTouched: [{ path: "/b", beforeHash: null, afterHash: "3" }] }),
			]),
		).toBe(
			`Resumed: last Edit ok at ${when}, 3 tool calls recorded, 2 files touched. /checkpoint shows the ledger; /rewind restores a file.`,
		);
	});

	test("the failing-test count is the newest run's, and it includes the unnamed", () => {
		expect(
			formatResumeSummary([
				checkpoint({ at: at.getTime() - 60_000, toolName: "Bash", isError: true, failedTests: ["old > one"] }),
				checkpoint({ toolName: "Read" }),
				checkpoint({
					at: at.getTime() - 30_000,
					toolName: "Bash",
					isError: true,
					failedTests: ["x > one", "y > two"],
					failedTestsOmitted: 3,
				}),
			]),
		).toContain("5 failing tests");
	});

	test("an empty ledger prints nothing", () => {
		expect(formatResumeSummary([])).toBeUndefined();
	});

	test("the next step comes from the newest call, never from an older plan", () => {
		const line = formatResumeSummary([
			checkpoint({ at: at.getTime() - 60_000, toolName: "TaskUpdate", nextStep: "Old plan" }),
			checkpoint({ toolName: "Read" }),
		]);
		expect(line).not.toContain("Old plan");
		expect(line).not.toContain(". Next:");
	});

	test("latestTestFailures skips the entries that never ran a test", () => {
		expect(
			latestTestFailures([checkpoint({ at: 5, failedTests: ["a > b"] }), checkpoint({ at: 9, toolName: "Read" })]),
		).toEqual({ at: 5, names: ["a > b"], omitted: 0 });
		expect(latestTestFailures([checkpoint({ toolName: "Read" })])).toBeUndefined();
	});
});
