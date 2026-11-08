/**
 * The run journal — the record that makes `resume_from` replay instead of
 * re-spend, and the reason a script may not call the clock.
 *
 * The two rules worth pinning are the ones a naive implementation gets wrong:
 * every assigned key counts toward its occurrence index (a failed call consumes
 * its slot, or a resumed loop shifts), and a result too large to store is
 * recorded as an error rather than truncated. The rest is file layout.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalJson,
	hashWorkflowScript,
	hashWorkflowValue,
	MAX_JOURNAL_RESULT_CHARS,
	WorkflowJournal,
	workflowCallKey,
} from "../src/workflow-journal.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lbb-workflow-journal-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function journalAt(root: string, overrides: { name?: string; script?: string; args?: unknown } = {}) {
	return WorkflowJournal.create({
		root,
		name: overrides.name ?? "demo",
		script: overrides.script ?? "return 1;",
		args: overrides.args,
		runId: "run-1",
		now: () => 1_000,
	});
}

describe("WorkflowJournal.create", () => {
	test("it writes the run's metadata, script and args", () => {
		const root = tempRoot();
		const journal = journalAt(root, { args: { target: "diff" } });

		expect(journal.dir).toBe(join(root, "run-1"));
		expect(journal.resumed).toBe(false);
		const meta = JSON.parse(readFileSync(join(journal.dir, "run.json"), "utf8"));
		expect(meta).toMatchObject({
			version: 1,
			kind: "workflow",
			runId: "run-1",
			name: "demo",
			scriptHash: hashWorkflowScript("return 1;"),
			argsHash: hashWorkflowValue({ target: "diff" }),
			createdAt: 1_000,
			updatedAt: 1_000,
			status: "running",
		});
		expect(readFileSync(join(journal.dir, "script.js"), "utf8")).toBe("return 1;");
		expect(JSON.parse(readFileSync(join(journal.dir, "args.json"), "utf8"))).toEqual({ target: "diff" });
		expect(journal.args).toEqual({ target: "diff" });
		// The meta is written by replacement; the temp half must not survive it.
		expect(existsSync(join(journal.dir, "run.json.tmp"))).toBe(false);
	});

	test("no args means no args file", () => {
		const root = tempRoot();
		const journal = journalAt(root);
		expect(existsSync(join(journal.dir, "args.json"))).toBe(false);
		expect(journal.args).toBeUndefined();
	});

	test("a missing run id is generated and unique per run", () => {
		const root = tempRoot();
		const one = WorkflowJournal.create({ root, name: "x", script: "", now: () => 5 });
		const two = WorkflowJournal.create({ root, name: "x", script: "", now: () => 5 });
		expect(one.runId).not.toBe(two.runId);
	});
});

describe("occurrence keys", () => {
	test("each call hash gets its own sequence", () => {
		const journal = journalAt(tempRoot());
		expect(journal.nextKey("aaa")).toBe("aaa#0");
		expect(journal.nextKey("aaa")).toBe("aaa#1");
		expect(journal.nextKey("bbb")).toBe("bbb#0");
		expect(journal.nextKey("aaa")).toBe("aaa#2");
	});

	test("reopening replays from the first occurrence, failures included", () => {
		const root = tempRoot();
		const journal = journalAt(root);
		journal.record({ key: "h1#0", label: "a", status: "ok", result: "v", resultKind: "text" });
		journal.record({ key: "h2#0", label: "b", status: "error", error: "nope" });
		journal.record({ key: "h1#1", label: "c", status: "ok", result: "w", resultKind: "text" });

		const reopened = WorkflowJournal.open({ root, runId: "run-1" });
		// A resume re-runs the script from the top: the first identical call must
		// claim #0 again so it meets the entry the previous run wrote. Seeding the
		// counter from the journal would turn every replay into a cache miss.
		expect(reopened.nextKey("h1")).toBe("h1#0");
		expect(reopened.nextKey("h1")).toBe("h1#1");
		expect(reopened.nextKey("h2")).toBe("h2#0");
		expect(reopened.lookup("h1#0")?.result).toBe("v");
		expect(reopened.lookup("h2#0")?.status).toBe("error");
		expect(reopened.resumed).toBe(true);
		expect(reopened.script).toBe("return 1;");
	});

	test("record assigns seq and at, and appends one line per call", () => {
		const root = tempRoot();
		const journal = journalAt(root);
		const first = journal.record({ key: "k#0", label: "a", status: "ok", result: "v" });
		const second = journal.record({ key: "k#1", label: "b", status: "error", error: "bad" });
		expect(first.seq).toBe(0);
		expect(second.seq).toBe(1);
		expect(first.at).toBe(1_000);
		const lines = readFileSync(join(journal.dir, "journal.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1])).toMatchObject({ seq: 1, key: "k#1", status: "error", error: "bad" });
	});
});

describe("the journal's honesty rules", () => {
	test("a result over the size limit is recorded as an error, not truncated", () => {
		const journal = journalAt(tempRoot());
		const huge = "x".repeat(MAX_JOURNAL_RESULT_CHARS + 1);
		const entry = journal.record({ key: "k#0", label: "big", status: "ok", result: huge, resultKind: "text" });
		expect(entry.status).toBe("error");
		expect(entry.result).toBeUndefined();
		expect(entry.resultKind).toBeUndefined();
		expect(entry.error).toContain("over the journal limit");
		expect(journal.lookup("k#0")?.status).toBe("error");
	});

	test("a torn final line costs only itself", () => {
		const root = tempRoot();
		const journal = journalAt(root);
		journal.record({ key: "k#0", label: "a", status: "ok", result: "v" });
		appendFileSync(join(journal.dir, "journal.jsonl"), '{"seq": 1, "key": "k#1"', "utf8");

		const reopened = WorkflowJournal.open({ root, runId: "run-1" });
		expect(reopened.lookup("k#0")?.result).toBe("v");
		// The torn line is skipped; the replay still starts at the first slot.
		expect(reopened.nextKey("k")).toBe("k#0");
	});

	test("a torn line is cut at open, so the next record is not fused onto it", () => {
		const root = tempRoot();
		const journal = journalAt(root);
		journal.record({ key: "k#0", label: "a", status: "ok", result: "v" });
		const path = join(journal.dir, "journal.jsonl");
		appendFileSync(path, '{"seq": 1, "key": "k#1"', "utf8");

		const reopened = WorkflowJournal.open({ root, runId: "run-1" });
		reopened.record({ key: "k#1", label: "b", status: "ok", result: "w" });

		// Appending straight after the torn tail would produce one line that
		// parses as neither record, losing both on the next open.
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
		expect(WorkflowJournal.open({ root, runId: "run-1" }).lookup("k#1")?.result).toBe("w");
	});

	test("a complete final line missing its newline keeps its entry", () => {
		const root = tempRoot();
		const journal = journalAt(root);
		journal.record({ key: "k#0", label: "a", status: "ok", result: "v" });
		const path = join(journal.dir, "journal.jsonl");
		writeFileSync(path, readFileSync(path, "utf8").slice(0, -1), "utf8");

		const reopened = WorkflowJournal.open({ root, runId: "run-1" });

		expect(reopened.lookup("k#0")?.result).toBe("v");
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
	});

	test("finish seals the run with its counts", () => {
		const root = tempRoot();
		const journal = journalAt(root);
		journal.finish("completed", { run: 2, cached: 1, failed: 0 });
		const meta = JSON.parse(readFileSync(join(journal.dir, "run.json"), "utf8"));
		expect(meta.status).toBe("completed");
		expect(meta.agents).toEqual({ run: 2, cached: 1, failed: 0 });
	});

	test("an unknown run id names the path it looked in", () => {
		const root = tempRoot();
		expect(() => WorkflowJournal.open({ root, runId: "nope" })).toThrow(
			/Unknown workflow run nope \(looked in .*nope\)/,
		);
	});

	test("a run id that would leave the runs root is refused", () => {
		const root = tempRoot();
		expect(() => WorkflowJournal.open({ root, runId: "../escape" })).toThrow("Invalid workflow run id");
		expect(() => WorkflowJournal.open({ root, runId: ".." })).toThrow("Invalid workflow run id");
		expect(() => WorkflowJournal.open({ root, runId: "a/b" })).toThrow("Invalid workflow run id");
	});

	test("a run without its saved script cannot be resumed", () => {
		const root = tempRoot();
		const dir = join(root, "broken");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "broken" }), "utf8");
		expect(() => WorkflowJournal.open({ root, runId: "broken" })).toThrow("has no saved script");
	});

	test("the log is append-only lines", () => {
		const root = tempRoot();
		const journal = journalAt(root);
		journal.appendLog("one");
		journal.appendLog("two");
		expect(readFileSync(join(journal.dir, "log.txt"), "utf8")).toBe("one\ntwo\n");
	});
});

describe("content addressing", () => {
	test("canonical JSON sorts keys at every depth", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
			'{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
		);
	});

	test("non-finite numbers and undefined hash like null", () => {
		expect(canonicalJson(Number.NaN)).toBe("null");
		expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe("null");
		expect(hashWorkflowValue(undefined)).toBe(hashWorkflowValue(null));
	});

	test("key order in a schema does not change the call key", () => {
		const left = workflowCallKey({ prompt: "p", schema: { type: "object", properties: { a: {}, b: {} } } });
		const right = workflowCallKey({ prompt: "p", schema: { properties: { b: {}, a: {} }, type: "object" } });
		expect(left).toBe(right);
	});

	test("anything that changes the request changes the key", () => {
		const base = workflowCallKey({ prompt: "p" });
		expect(workflowCallKey({ prompt: "q" })).not.toBe(base);
		expect(workflowCallKey({ prompt: "p", model: "fast" })).not.toBe(base);
		expect(workflowCallKey({ prompt: "p", effort: "high" })).not.toBe(base);
		expect(workflowCallKey({ prompt: "p", agentType: "quick" })).not.toBe(base);
		expect(workflowCallKey({ prompt: "p", isolation: "worktree" })).not.toBe(base);
		expect(workflowCallKey({ prompt: "p", schema: { type: "object" } })).not.toBe(base);
	});
});
