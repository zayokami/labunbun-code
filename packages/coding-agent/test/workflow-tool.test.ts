/**
 * The Workflow tool's shell: which input is used, how a saved name resolves,
 * and what the model reads back.
 *
 * Everything the tool decides is visible in its result, because that text is
 * all the parent model gets — the run id to resume from, the counts, the kept
 * worktrees. The runner's behaviour is `workflow-runner.test.ts`'s subject.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyTool } from "@labunbun/agent";
import type { WorkflowDefinition } from "../src/workflow-definitions.ts";
import type { WorkflowSpawn, WorkflowSpawnRequest, WorkflowSpawnResult } from "../src/workflow-runner.ts";
import { createWorkflowTool } from "../src/workflow-tool.ts";
import type { WorkflowGit } from "../src/workflow-worktree.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lbb-workflow-tool-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spawner(step: (request: WorkflowSpawnRequest) => WorkflowSpawnResult = () => ({ ok: true, report: "ok" })) {
	const requests: WorkflowSpawnRequest[] = [];
	const spawn: WorkflowSpawn = async (request) => {
		requests.push(request);
		return step(request);
	};
	return { requests, spawn };
}

function definition(name: string, script: string, description = ""): WorkflowDefinition {
	return { name, description, script, sourcePath: `${name}.js`, source: "user" };
}

function callTool(tool: AnyTool, input: Record<string, unknown>) {
	return tool.call(input, {
		callId: "t1",
		signal: new AbortController().signal,
		cwd: process.cwd(),
		sandbox: "workspace-write" as const,
		network: { access: "enabled" as const, domains: [] },
		onUpdate: () => {},
	});
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

function toolWith(spawn: WorkflowSpawn, definitions: () => WorkflowDefinition[] = () => []) {
	return createWorkflowTool({ cwd: tempRoot(), runsRoot: tempRoot(), spawn, definitions });
}

describe("inline scripts", () => {
	test("the result carries the value, the counts and the run id", async () => {
		const { spawn, requests } = spawner((request) => ({ ok: true, report: `echo:${request.prompt}` }));
		const tool = toolWith(spawn);

		const result = await callTool(tool, { script: 'return await agent("hi", { label: "greet" });' });
		const text = textOf(result);

		expect(result.isError).toBeFalsy();
		expect(requests).toHaveLength(1);
		expect(text).toContain('Workflow "workflow" completed in');
		expect(text).toContain("1 agent calls (1 run, 0 cached, 0 failed)");
		expect(text).toContain("Result:\necho:hi");
		expect(text).toMatch(/\[workflow run: wf-[^\]]+\] Resume with resume_from: "wf-/);
		expect(text).toContain("Run directory: ");
		expect((result.details as Record<string, unknown>).agentsRun).toBe(1);
		expect((result.details as Record<string, unknown>).resumed).toBe(false);
	});

	test("a meta name labels the run", async () => {
		const tool = toolWith(spawner().spawn);
		const result = await callTool(tool, {
			script: 'export const meta = { name: "inline-demo" };\nreturn 1;',
		});
		expect(textOf(result)).toContain('Workflow "inline-demo" completed');
	});

	test("an object result is printed as JSON and a missing one is said out loud", async () => {
		const tool = toolWith(spawner().spawn);
		const objectResult = await callTool(tool, { script: "return { a: [1, 2] };" });
		expect(textOf(objectResult)).toContain('Result:\n{\n  "a": [\n    1,\n    2\n  ]\n}');
		const empty = await callTool(tool, { script: "return undefined;" });
		expect(textOf(empty)).toContain("(the script returned no value)");
	});

	test("args reach the script", async () => {
		const tool = toolWith(spawner().spawn);
		const result = await callTool(tool, { script: "return args;", args: { target: "src" } });
		expect(textOf(result)).toContain('Result:\n{\n  "target": "src"\n}');
	});

	test("the agent budget is reported, not hidden", async () => {
		const tool = toolWith(spawner().spawn);
		const result = await callTool(tool, {
			script: `
				await agent("one");
				try { await agent("two"); } catch (error) { log("refused"); }
				return "done";
			`,
			max_agents: 1,
		});
		const text = textOf(result);
		expect(text).toContain("the agent budget was reached");
		expect((result.details as Record<string, unknown>).truncated).toBe(true);
	});
});

describe("saved workflows", () => {
	const saved = definition("saved", 'return await agent("from the file");', "Runs the saved script");

	test("a name resolves to the saved script", async () => {
		const { spawn, requests } = spawner(() => ({ ok: true, report: "ran" }));
		const tool = toolWith(spawn, () => [saved]);
		const result = await callTool(tool, { name: "saved" });
		expect(result.isError).toBeFalsy();
		expect(requests[0].prompt).toBe("from the file");
	});

	test("definitions are read at call time, so an approval mid-session is usable", async () => {
		const { spawn } = spawner(() => ({ ok: true, report: "ran" }));
		let current: WorkflowDefinition[] = [];
		const tool = toolWith(spawn, () => current);

		const before = await callTool(tool, { name: "saved" });
		expect(before.isError).toBe(true);

		current = [saved];
		const after = await callTool(tool, { name: "saved" });
		expect(after.isError).toBeFalsy();
	});

	test("an unknown name lists what is available", async () => {
		const tool = toolWith(spawner().spawn, () => [saved, definition("other", "return 1;")]);
		const result = await callTool(tool, { name: "nope" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe('Unknown workflow "nope". Saved workflows: saved, other.');
	});

	test("with nothing saved the error says so", async () => {
		const tool = toolWith(spawner().spawn);
		const result = await callTool(tool, { name: "nope" });
		expect(textOf(result)).toBe('Unknown workflow "nope". No saved workflows are available.');
	});

	test("the description lists the saved workflows", () => {
		const tool = toolWith(spawner().spawn, () => [saved]);
		expect(tool.description).toContain("- saved: Runs the saved script");
		expect(tool.description).toContain("1000 agent calls per run");
	});
});

describe("input resolution", () => {
	test("a script and a name together are refused", async () => {
		const tool = toolWith(spawner().spawn);
		const result = await callTool(tool, { script: "return 1;", name: "saved" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Pass either a script or a saved workflow name, not both.");
	});

	test("nothing to run is refused", async () => {
		const tool = toolWith(spawner().spawn);
		const result = await callTool(tool, {});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Pass a script, a saved workflow name, or a resume_from run id.");
	});

	test("an unknown run id fails with the path it looked in", async () => {
		const tool = toolWith(spawner().spawn);
		const result = await callTool(tool, { resume_from: "nope" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Workflow failed: Unknown workflow run nope (looked in");
	});

	test("a script error names the run directory to resume from", async () => {
		const tool = toolWith(spawner().spawn);
		const result = await callTool(tool, { script: 'throw new Error("nope");' });
		const text = textOf(result);
		expect(result.isError).toBe(true);
		expect(text).toContain("Workflow failed: nope");
		expect(text).toMatch(/Run directory: .*\(resume_from: "wf-/);
	});
});

describe("resume through the tool", () => {
	test("the run id from one call replays the next", async () => {
		const runsRoot = tempRoot();
		const { spawn, requests } = spawner(() => ({ ok: true, report: "the answer" }));
		const tool = createWorkflowTool({ cwd: tempRoot(), runsRoot, spawn, definitions: () => [] });

		const first = await callTool(tool, { script: 'return await agent("hi");' });
		const runId = /\[workflow run: ([^\]]+)\]/.exec(textOf(first))?.[1];
		expect(runId).toBeTruthy();

		const resumed = await callTool(tool, { resume_from: runId });
		const text = textOf(resumed);
		expect(resumed.isError).toBeFalsy();
		expect(text).toContain('Workflow "workflow" resumed');
		expect(text).toContain("1 agent calls (0 run, 1 cached, 0 failed)");
		expect(requests).toHaveLength(1);
		expect((resumed.details as Record<string, unknown>).resumed).toBe(true);
	});
});

describe("kept worktrees", () => {
	test("they are listed in the result", async () => {
		const git: WorkflowGit = async (args, cwd) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return cwd;
			if (args[0] === "rev-parse" && args[1] === "HEAD") return "base\n";
			if (args[0] === "status") return " M src/changed.ts\n";
			return "";
		};
		const { spawn, requests } = spawner(() => ({ ok: true, report: "done" }));
		const tool = createWorkflowTool({ cwd: tempRoot(), runsRoot: tempRoot(), spawn, definitions: () => [], git });

		const result = await callTool(tool, { script: 'return await agent("x", { isolation: "worktree" });' });

		const text = textOf(result);
		expect(text).toContain("Kept worktrees (their agents changed files):");
		expect(text).toContain(requests[0].cwd);
		expect((result.details as Record<string, unknown>).keptWorktrees).toEqual([requests[0].cwd]);
	});
});
