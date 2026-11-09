/**
 * The work environment's own record of what it did.
 *
 * A declared command's result is written to the task as a `TaskRun` — command,
 * exit code, a bounded cut of the output that keeps the spill pointer — and a
 * `build`/`verify` task's verdict is decided from those runs, not from anything
 * a member said. The claims pinned here: only declared commands are evidence,
 * only the latest run of each command counts, a run with no exit code fails,
 * the run list is bounded, a clean verify closes the task, and a failing one
 * leaves it open with the error pheromone set.
 *
 * The recorder is tested directly, without a session: `begin`/`record` are the
 * whole seam between a tool event and the board.
 */
import { describe, expect, test } from "bun:test";
import { TaskStore } from "@labunbun/tools";
import {
	commandOf,
	decidedVerdict,
	latestRuns,
	parseExitCode,
	resultText,
	TaskPheromoneRecorder,
} from "../src/task-pheromone.ts";

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text }] };
}

/** A task already claimed by a seat — the shape the recorder sees in a live band. */
function claimed(store: TaskStore, extras: Parameters<TaskStore["create"]>[5]) {
	const task = store.create("verify the parser", "Run the declared commands.", undefined, "george", [], extras);
	store.update(task.id, { status: "in_progress" });
	return store.get(task.id) as NonNullable<ReturnType<TaskStore["get"]>>;
}

describe("reading a command's result", () => {
	test("the exit code is the line Bash writes, even behind a spill header", () => {
		expect(parseExitCode("[exit code: 0]\nok")).toBe(0);
		expect(parseExitCode("[full output: 900 chars → /tmp/spill.txt]\n[exit code: 2]\nboom")).toBe(2);
		expect(parseExitCode("[exit code: -1]\nkilled")).toBe(-1);
		expect(parseExitCode("[command timed out or was killed]")).toBeNull();
		expect(parseExitCode("plain output")).toBeNull();
	});

	test("a command is a trimmed non-empty string, and nothing else is one", () => {
		expect(commandOf({ command: "  bun test  " })).toBe("bun test");
		expect(commandOf({ command: "   " })).toBeUndefined();
		expect(commandOf({ path: "x" })).toBeUndefined();
		expect(commandOf("bun test")).toBeUndefined();
		expect(commandOf(null)).toBeUndefined();
	});

	test("the text of a multi-block result is joined the way the transcript reads it", () => {
		expect(
			resultText({
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			}),
		).toBe("first\nsecond");
	});

	test("latestRuns keeps the last run of each command, in first-seen order", () => {
		const runs = [
			{ command: "a", exitCode: 1, summary: "", at: 1 },
			{ command: "b", exitCode: 0, summary: "", at: 2 },
			{ command: "a", exitCode: 0, summary: "", at: 3 },
		];
		const latest = latestRuns(runs);
		expect([...latest.keys()]).toEqual(["a", "b"]);
		expect(latest.get("a")?.at).toBe(3);
	});
});

describe("the verdict the evidence supports", () => {
	const verify = (commands: string[]) => ({ kind: "verify" as const, commands });

	test("nothing is decided until every declared command has run", () => {
		expect(decidedVerdict(verify(["a", "b"]), [])).toBeUndefined();
		expect(decidedVerdict(verify(["a", "b"]), [{ command: "a", exitCode: 0, summary: "", at: 1 }])).toBeUndefined();
	});

	test("passed only when every latest run exited zero", () => {
		const runs = [
			{ command: "a", exitCode: 0, summary: "", at: 1 },
			{ command: "b", exitCode: 0, summary: "", at: 2 },
		];
		expect(decidedVerdict(verify(["a", "b"]), runs)).toBe("passed");
		runs[1] = { command: "b", exitCode: 1, summary: "", at: 3 };
		expect(decidedVerdict(verify(["a", "b"]), runs)).toBe("failed");
	});

	test("only each command's latest run counts, so a fixed command passes", () => {
		const runs = [
			{ command: "a", exitCode: 1, summary: "", at: 1 },
			{ command: "a", exitCode: 0, summary: "", at: 2 },
		];
		expect(decidedVerdict(verify(["a"]), runs)).toBe("passed");
	});

	test("a run with no exit code is not a zero", () => {
		expect(decidedVerdict(verify(["a"]), [{ command: "a", exitCode: null, summary: "", at: 1 }])).toBe("failed");
	});

	test("a declared command is trimmed the way the call is", () => {
		expect(decidedVerdict(verify(["  a  "]), [{ command: "a", exitCode: 0, summary: "", at: 1 }])).toBe("passed");
	});

	test("only build and verify tasks have a deterministic verdict", () => {
		expect(
			decidedVerdict({ kind: "implement", commands: ["a"] }, [{ command: "a", exitCode: 0, summary: "", at: 1 }]),
		).toBeUndefined();
		expect(
			decidedVerdict({ kind: "verify", commands: [] }, [{ command: "a", exitCode: 0, summary: "", at: 1 }]),
		).toBeUndefined();
	});
});

describe("the recorder", () => {
	test("only a declared command becomes evidence", () => {
		const store = new TaskStore();
		const task = claimed(store, { kind: "verify", commands: ["bun test"] });
		const recorder = new TaskPheromoneRecorder({ store });

		recorder.begin("c1", "Bash", { command: "bun test" });
		const run = recorder.record("george", task.id, "Bash", "c1", textResult("[exit code: 0]\nok"));
		expect(run).toMatchObject({ command: "bun test", exitCode: 0, by: "george" });
		expect(store.get(task.id)?.runs).toHaveLength(1);

		recorder.begin("c2", "Bash", { command: "ls" });
		expect(recorder.record("george", task.id, "Bash", "c2", textResult("[exit code: 0]\nfiles"))).toBeUndefined();
		expect(store.get(task.id)?.runs).toHaveLength(1);

		// A non-Bash call is not a command at all.
		recorder.begin("c3", "Read", { command: "bun test" });
		expect(recorder.record("george", task.id, "Read", "c3", textResult("[exit code: 0]"))).toBeUndefined();
		expect(store.get(task.id)?.runs).toHaveLength(1);
	});

	test("a call with no start, or no current task, records nothing", () => {
		const store = new TaskStore();
		const task = claimed(store, { kind: "verify", commands: ["bun test"] });
		const recorder = new TaskPheromoneRecorder({ store });

		expect(recorder.record("george", task.id, "Bash", "unknown", textResult("[exit code: 0]"))).toBeUndefined();
		recorder.begin("c1", "Bash", { command: "bun test" });
		expect(recorder.record("george", undefined, "Bash", "c1", textResult("[exit code: 0]"))).toBeUndefined();
		expect(store.get(task.id)?.runs).toBeUndefined();
	});

	test("the summary is bounded and keeps the spill pointer", () => {
		const store = new TaskStore();
		const task = claimed(store, { kind: "verify", commands: ["bun test"] });
		const recorder = new TaskPheromoneRecorder({ store, errorChars: 120 });
		const header = "[full output: 5000 chars → /tmp/spill.txt]\n";
		const output = `${header}[exit code: 1]\n${"x".repeat(5000)}`;

		recorder.begin("c1", "Bash", { command: "bun test" });
		const run = recorder.record("george", task.id, "Bash", "c1", textResult(output));

		expect(run?.exitCode).toBe(1);
		expect(run?.summary.startsWith(header)).toBe(true);
		expect(run?.summary).toContain("[truncated ");
		// The pointer plus the budget plus the marker line, nothing like 5k.
		expect(run?.summary.length).toBeLessThan(200);
		expect(store.get(task.id)?.errorSummary).toBe(run?.summary);
	});

	test("the run list is bounded, newest last", () => {
		const store = new TaskStore();
		// An implement task records evidence but has no deterministic verdict, so
		// the loop below keeps running instead of closing on the first clean run.
		const task = claimed(store, { kind: "implement", commands: ["bun test"] });
		const recorder = new TaskPheromoneRecorder({ store, maxRuns: 3 });

		for (let index = 0; index < 5; index++) {
			const callId = `c${index}`;
			recorder.begin(callId, "Bash", { command: "bun test" });
			recorder.record("george", task.id, "Bash", callId, textResult(`[exit code: ${index}]\n`));
		}

		expect(store.get(task.id)?.runs?.map((run) => run.exitCode)).toEqual([2, 3, 4]);
	});

	test("a clean verify closes the task; the verdict has a notice", () => {
		const store = new TaskStore();
		const task = claimed(store, { kind: "verify", commands: ["bun test"] });
		const notices: string[] = [];
		const recorder = new TaskPheromoneRecorder({ store, notice: (line) => notices.push(line) });

		recorder.begin("c1", "Bash", { command: "bun test" });
		recorder.record("george", task.id, "Bash", "c1", textResult("[exit code: 0]\nok"));

		const closed = store.get(task.id);
		expect(closed).toMatchObject({ status: "completed", verdict: "passed" });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("every declared command passed");
	});

	test("a failing verify writes the verdict and the error pheromone, and leaves the task open", () => {
		const store = new TaskStore();
		const task = claimed(store, { kind: "verify", commands: ["a", "b"] });
		const notices: string[] = [];
		const recorder = new TaskPheromoneRecorder({ store, notice: (line) => notices.push(line) });

		recorder.begin("c1", "Bash", { command: "a" });
		recorder.record("george", task.id, "Bash", "c1", textResult("[exit code: 0]\nok"));
		// Half the evidence is not a verdict.
		expect(store.get(task.id)?.verdict).toBeUndefined();
		expect(notices).toHaveLength(0);

		recorder.begin("c2", "Bash", { command: "b" });
		const failing = recorder.record("george", task.id, "Bash", "c2", textResult("[exit code: 1]\nAssertionError"));

		const open = store.get(task.id);
		expect(open).toMatchObject({ status: "in_progress", verdict: "failed" });
		expect(open?.errorSummary).toBe(failing?.summary);
		expect(notices[0]).toContain("b exited 1 — verdict failed");
	});

	test("a passing rerun keeps the failure that caused the repair", () => {
		const store = new TaskStore();
		const task = claimed(store, { kind: "verify", commands: ["a"] });
		const recorder = new TaskPheromoneRecorder({ store });

		recorder.begin("c1", "Bash", { command: "a" });
		recorder.record("george", task.id, "Bash", "c1", textResult("[exit code: 1]\nfailed"));
		const failure = store.get(task.id)?.errorSummary;
		expect(failure).toContain("[exit code: 1]");

		recorder.begin("c2", "Bash", { command: "a" });
		recorder.record("george", task.id, "Bash", "c2", textResult("[exit code: 0]\nfixed"));

		const task2 = store.get(task.id);
		expect(task2).toMatchObject({ status: "completed", verdict: "passed" });
		expect(task2?.errorSummary).toBe(failure as string);
	});

	test("a completed task is history: a late result is not recorded", () => {
		const store = new TaskStore();
		const task = claimed(store, { kind: "verify", commands: ["bun test"] });
		store.update(task.id, { status: "completed" });
		const recorder = new TaskPheromoneRecorder({ store });

		recorder.begin("c1", "Bash", { command: "bun test" });
		expect(recorder.record("george", task.id, "Bash", "c1", textResult("[exit code: 0]"))).toBeUndefined();
		expect(store.get(task.id)?.runs).toBeUndefined();
		expect(store.get(task.id)?.rev).toBe(2);
	});
});
