/**
 * One workflow run, end to end: the journal before and after the script, the
 * cache that makes resume real, and the worktree cleanup that must never eat an
 * agent's work.
 *
 * The spawn is a plain function here — that is the seam the tool fills with
 * `SubagentControl.spawn` — so these tests assert what the runner asks for
 * (cwd, model, schema) and what it writes down, without a model in the loop.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAUX_MODEL, type Model } from "@labunbun/ai";
import {
	type RunWorkflowOptions,
	runWorkflow,
	WorkflowRunError,
	type WorkflowSpawn,
	type WorkflowSpawnRequest,
	type WorkflowSpawnResult,
} from "../src/workflow-runner.ts";
import { WorkflowAbortedError } from "../src/workflow-script.ts";
import type { WorkflowGit } from "../src/workflow-worktree.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lbb-workflow-run-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spawner(step: (request: WorkflowSpawnRequest) => Promise<WorkflowSpawnResult> | WorkflowSpawnResult) {
	const requests: WorkflowSpawnRequest[] = [];
	const spawn: WorkflowSpawn = async (request) => {
		requests.push(request);
		return step(request);
	};
	return { requests, spawn };
}

function readJournal(dir: string): Array<Record<string, any>> {
	const path = join(dir, "journal.jsonl");
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8").trim();
	return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line));
}

function readRunMeta(dir: string): Record<string, any> {
	return JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
}

/** A git that succeeds and reports each worktree as unchanged unless told otherwise. */
function fakeGit(worktreeStatus: (path: string) => string = () => "") {
	const calls: string[][] = [];
	const git: WorkflowGit = async (args, cwd) => {
		calls.push([...args]);
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return cwd;
		if (args[0] === "rev-parse" && args[1] === "HEAD") return "base-head\n";
		if (args[0] === "status") return worktreeStatus(cwd);
		if (args[0] === "worktree") return "";
		throw new Error(`unexpected git call: ${args.join(" ")}`);
	};
	return { calls, git };
}

function baseOptions(overrides: Partial<RunWorkflowOptions>): RunWorkflowOptions {
	return {
		cwd: tempRoot(),
		runsRoot: tempRoot(),
		signal: new AbortController().signal,
		spawn: spawner(() => ({ ok: true, report: "ok" })).spawn,
		...overrides,
	};
}

describe("a completed run", () => {
	test("the script value, the calls and the run record are all written down", async () => {
		const { requests, spawn } = spawner((request) => ({ ok: true, report: `echo:${request.prompt}` }));
		const options = baseOptions({ script: 'return await agent("hi", { label: "greet" });', spawn });

		const result = await runWorkflow(options);

		expect(result.value).toBe("echo:hi");
		expect(result.name).toBe("workflow");
		expect(result.resumed).toBe(false);
		expect(result.agentsRun).toBe(1);
		expect(result.agentsCached).toBe(0);
		expect(result.agentsFailed).toBe(0);
		expect(requests).toHaveLength(1);
		expect(requests[0].cwd).toBe(options.cwd);

		const entries = readJournal(result.dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			key: expect.stringMatching(/^[a-f0-9]{16}#0$/),
			label: "greet",
			status: "ok",
			resultKind: "text",
			result: "echo:hi",
		});
		expect(readRunMeta(result.dir)).toMatchObject({
			status: "completed",
			agents: { run: 1, cached: 0, failed: 0 },
		});
		expect(readFileSync(join(result.dir, "log.txt"), "utf8")).toContain("✓ greet");
	});

	test("the report is prefixed with the workflow's name", async () => {
		const lines: string[] = [];
		const options = baseOptions({
			script: 'log("hello");\nreturn 0;',
			name: "custom",
			report: (line) => lines.push(line),
		});
		const result = await runWorkflow(options);
		expect(result.name).toBe("custom");
		expect(lines).toContain("[workflow custom] hello");
	});
});

describe("resume", () => {
	test("resuming with the same runs root replays every ok entry", async () => {
		const runsRoot = tempRoot();
		const first = spawner((request) => ({ ok: true, report: `echo:${request.prompt}` }));
		const original = await runWorkflow({
			cwd: tempRoot(),
			runsRoot,
			signal: new AbortController().signal,
			script: 'return await agent("hi", { label: "one" });',
			spawn: first.spawn,
			name: "replay-me",
		});

		const second = spawner(() => {
			throw new Error("the resumed run must not spawn");
		});
		const resumed = await runWorkflow({
			cwd: tempRoot(),
			runsRoot,
			signal: new AbortController().signal,
			resumeFrom: original.runId,
			spawn: second.spawn,
		});

		expect(second.requests).toHaveLength(0);
		expect(resumed.value).toBe("echo:hi");
		expect(resumed.name).toBe("replay-me");
		expect(resumed.resumed).toBe(true);
		expect(resumed.agentsCached).toBe(1);
		expect(resumed.agentsRun).toBe(0);
	});

	test("a failed call is journaled as an error and gets another chance", async () => {
		const runsRoot = tempRoot();
		const failing = spawner(() => ({ ok: false, error: "boom" }));
		const original = await runWorkflow({
			cwd: tempRoot(),
			runsRoot,
			signal: new AbortController().signal,
			script: 'return await agent("hi");',
			spawn: failing.spawn,
		});
		expect(original.value).toBeNull();
		expect(original.agentsFailed).toBe(1);
		const failedEntry = readJournal(original.dir)[0];
		expect(failedEntry.status).toBe("error");
		expect(failedEntry.error).toBe("boom");

		const working = spawner(() => ({ ok: true, report: "second time lucky" }));
		const resumed = await runWorkflow({
			cwd: tempRoot(),
			runsRoot,
			signal: new AbortController().signal,
			resumeFrom: original.runId,
			spawn: working.spawn,
		});

		expect(working.requests).toHaveLength(1);
		expect(resumed.agentsRun).toBe(1);
		expect(resumed.agentsCached).toBe(0);
		expect(resumed.value).toBe("second time lucky");
		const entries = readJournal(original.dir);
		expect(entries).toHaveLength(2);
		// The occurrence slot is reused: the second attempt is the same call, not a
		// new one, so a later call in the script still lines up.
		expect(entries[1].key).toBe(entries[0].key);
		expect(entries[1].status).toBe("ok");
	});

	test("two identical calls get distinct occurrence slots and both replay", async () => {
		const runsRoot = tempRoot();
		let calls = 0;
		const first = spawner(() => {
			calls++;
			return { ok: true, report: `answer-${calls}` };
		});
		const original = await runWorkflow({
			cwd: tempRoot(),
			runsRoot,
			signal: new AbortController().signal,
			script: 'return [await agent("q"), await agent("q")];',
			spawn: first.spawn,
		});
		expect(original.value).toEqual(["answer-1", "answer-2"]);
		const keys = readJournal(original.dir).map((entry) => entry.key);
		expect(keys).toHaveLength(2);
		expect(keys[0].slice(0, keys[0].lastIndexOf("#"))).toBe(keys[1].slice(0, keys[1].lastIndexOf("#")));
		expect(keys[0].endsWith("#0")).toBe(true);
		expect(keys[1].endsWith("#1")).toBe(true);

		const second = spawner(() => {
			throw new Error("cached");
		});
		const resumed = await runWorkflow({
			cwd: tempRoot(),
			runsRoot,
			signal: new AbortController().signal,
			resumeFrom: original.runId,
			spawn: second.spawn,
		});
		expect(resumed.value).toEqual(["answer-1", "answer-2"]);
		expect(second.requests).toHaveLength(0);
	});

	test("a resumed run with an edited script keeps the original record", async () => {
		const runsRoot = tempRoot();
		const original = await runWorkflow({
			cwd: tempRoot(),
			runsRoot,
			signal: new AbortController().signal,
			script: 'return await agent("hi");',
			spawn: spawner(() => ({ ok: true, report: "echo" })).spawn,
		});
		const edited = 'return "changed";';
		const resumed = await runWorkflow({
			cwd: tempRoot(),
			runsRoot,
			signal: new AbortController().signal,
			resumeFrom: original.runId,
			script: edited,
			spawn: spawner(() => ({ ok: false, error: "unused" })).spawn,
		});

		expect(resumed.value).toBe("changed");
		expect(readFileSync(join(original.dir, "script.js"), "utf8")).toBe('return await agent("hi");');
		expect(readFileSync(join(original.dir, "script.resume.js"), "utf8")).toBe(edited);
	});

	test("without a script or a run there is nothing to run", async () => {
		await expect(runWorkflow(baseOptions({}))).rejects.toThrow("A workflow needs a script or a run to resume");
	});
});

describe("structured answers", () => {
	test("the schema is passed to the spawn and its object is the call's value", async () => {
		const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
		const { requests, spawn } = spawner(() => ({ ok: true, report: '{"n":7}', structured: { n: 7 } }));
		const result = await runWorkflow(
			baseOptions({ script: `return await agent("x", { schema: ${JSON.stringify(schema)} });`, spawn }),
		);

		expect(requests[0].outputSchema).toEqual(schema);
		expect(result.value).toEqual({ n: 7 });
		const entry = readJournal(result.dir)[0];
		expect(entry.resultKind).toBe("json");
		expect(entry.result).toEqual({ n: 7 });
	});

	test("a schema failure is journaled with the validator's complaint", async () => {
		const result = await runWorkflow(
			baseOptions({
				script: 'return await agent("x", { schema: { type: "object", properties: { n: { type: "number" } } } });',
				spawn: spawner(() => ({ ok: false, report: '{"n":"no"}', structuredError: "$.n: expected number, got string" }))
					.spawn,
			}),
		);

		expect(result.value).toBeNull();
		expect(result.agentsFailed).toBe(1);
		const entry = readJournal(result.dir)[0];
		expect(entry.status).toBe("error");
		expect(entry.error).toBe("$.n: expected number, got string");
	});
});

describe("models", () => {
	test("a call's model is resolved and handed to the spawn", async () => {
		const chosen: Model = { ...FAUX_MODEL, id: "fast-model" };
		const { requests, spawn } = spawner(() => ({ ok: true, report: "done" }));
		const result = await runWorkflow(
			baseOptions({
				script: 'return await agent("x", { model: "fast" });',
				spawn,
				resolveModel: (ref) => (ref === "fast" ? chosen : undefined),
			}),
		);

		expect(result.value).toBe("done");
		expect(requests[0].model).toBe(chosen);
	});

	test("a model that does not resolve fails the call without spawning", async () => {
		const { requests, spawn } = spawner(() => ({ ok: true, report: "should not run" }));
		const result = await runWorkflow(
			baseOptions({ script: 'return await agent("x", { model: "gone" });', spawn, resolveModel: () => undefined }),
		);

		expect(requests).toHaveLength(0);
		expect(result.value).toBeNull();
		expect(result.agentsFailed).toBe(1);
		expect(readJournal(result.dir)[0].error).toBe('Unknown model "gone"');
	});
});

describe("worktree isolation", () => {
	test("a call runs in its own worktree, which is removed when unchanged", async () => {
		const { calls, git } = fakeGit();
		const { requests, spawn } = spawner(() => ({ ok: true, report: "done" }));
		const result = await runWorkflow(
			baseOptions({ script: 'return await agent("x", { isolation: "worktree" });', spawn, git }),
		);

		expect(result.keptWorktrees).toEqual([]);
		expect(requests[0].cwd).toContain("worktrees");
		const add = calls.find((args) => args[0] === "worktree" && args[1] === "add");
		expect(add).toEqual(["worktree", "add", "--detach", requests[0].cwd, "base-head"]);
		const remove = calls.find((args) => args[0] === "worktree" && args[1] === "remove");
		expect(remove).toEqual(["worktree", "remove", "--force", requests[0].cwd]);
		expect(readJournal(result.dir)[0].worktree).toBe(requests[0].cwd);
	});

	test("a worktree the agent changed is kept and reported", async () => {
		const { calls, git } = fakeGit(() => " M src/changed.ts\n");
		const lines: string[] = [];
		const { requests, spawn } = spawner(() => ({ ok: true, report: "done" }));
		const result = await runWorkflow(
			baseOptions({
				script: 'return await agent("x", { isolation: "worktree" });',
				spawn,
				git,
				report: (line) => lines.push(line),
			}),
		);

		expect(result.keptWorktrees).toEqual([requests[0].cwd]);
		expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
		expect(lines.join("\n")).toContain(`kept worktree: ${requests[0].cwd}`);
	});

	test("a worktree that cannot be created fails the call, not the run", async () => {
		const git: WorkflowGit = async (args) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo";
			if (args[0] === "rev-parse" && args[1] === "HEAD") return "base-head\n";
			if (args[0] === "worktree") throw new Error("no worktrees here");
			return "";
		};
		const { requests, spawn } = spawner(() => ({ ok: true, report: "should not run" }));
		const result = await runWorkflow(
			baseOptions({ script: 'return await agent("x", { isolation: "worktree" });', spawn, git }),
		);

		expect(requests).toHaveLength(0);
		expect(result.value).toBeNull();
		const entry = readJournal(result.dir)[0];
		expect(entry.status).toBe("error");
		expect(entry.error).toContain("Could not create a worktree");
	});
});

describe("failures", () => {
	test("a script throw finishes the run as failed and names the directory", async () => {
		const options = baseOptions({ script: 'throw new Error("nope");' });
		let error: unknown;
		try {
			await runWorkflow(options);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(WorkflowRunError);
		const runError = error as WorkflowRunError;
		expect(runError.message).toBe("nope");
		expect(readRunMeta(runError.dir).status).toBe("failed");
	});

	test("an aborted run is recorded as aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const runsRoot = tempRoot();
		const options = baseOptions({ script: "return 1;", signal: controller.signal, runsRoot });
		await expect(runWorkflow(options)).rejects.toBeInstanceOf(WorkflowAbortedError);
		const [dir] = readdirSync(runsRoot);
		expect(readRunMeta(join(runsRoot, dir)).status).toBe("aborted");
	});
});
