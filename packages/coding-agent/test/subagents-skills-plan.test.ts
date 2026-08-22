import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type AnyTool, buildTool, SessionStore } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { z } from "zod";
import { createPlanModeTools } from "../src/plan-mode.ts";
import { loadSkills, skillsAsCommands } from "../src/skills.ts";
import { createTaskTool, loadAgentDefinitions } from "../src/subagents.ts";

function echoTool(): AnyTool {
	return buildTool({
		name: "echo",
		description: "echo",
		inputSchema: z.object({ text: z.string() }),
		call: async (input: any) => ({ content: [{ type: "text", text: input.text }] }),
	});
}

describe("agent definitions", () => {
	test("loads frontmatter .md files from user and project dirs", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-ag-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-ag-proj-"));
		mkdirSync(join(home, ".labunbun", "agents"), { recursive: true });
		mkdirSync(join(cwd, ".labunbun", "agents"), { recursive: true });
		writeFileSync(
			join(home, ".labunbun", "agents", "researcher.md"),
			"---\nname: researcher\ndescription: Deep research agent\ntools: Read, Grep\nmaxTurns: 5\n---\nSystem body.",
		);
		writeFileSync(join(cwd, ".labunbun", "agents", "deployer.md"), "---\ndescription: Deploys the app\n---\nBody.");

		const defs = loadAgentDefinitions(cwd, home);
		const researcher = defs.find((d) => d.agentType === "researcher");
		expect(researcher).toMatchObject({ whenToUse: "Deep research agent", source: "user", maxTurns: 5 });
		expect(researcher?.tools).toEqual(["Read", "Grep"]);
		expect(defs.find((d) => d.agentType === "deployer")?.source).toBe("project");
	});
});

describe("Task tool (subagents)", () => {
	function makeHarness(store?: SessionStore) {
		// Subagent script: uses echo tool then reports.
		const subScript = [
			{ toolCalls: [{ name: "echo", arguments: { text: "sub ran" } }] },
			{ text: "SUBAGENT FINAL REPORT" },
		];
		const subFaux = fauxProvider(subScript);
		const ctx = {
			streamFn: subFaux.streamFn,
			model: FAUX_MODEL,
			allTools: [echoTool()],
			definitions: [],
			store,
		};
		return { taskTool: createTaskTool(ctx), ctx };
	}

	test("runs a nested session and returns its final report", async () => {
		const { taskTool } = makeHarness();
		const result = await taskTool.call(
			{ description: "run sub", prompt: "do the thing", subagent_type: "general-purpose" },
			{ callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
		);
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toContain("SUBAGENT FINAL REPORT");
	});

	test("unknown agent type yields isError with available list", async () => {
		const { taskTool } = makeHarness();
		const result = await taskTool.call(
			{ description: "x", prompt: "y", subagent_type: "nope" },
			{ callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
		);
		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("general-purpose");
	});

	test("sidechain entries persist to the parent session tree", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-side-"));
		// Temp home: without it the session file lands in ~/.labunbun/projects.
		const store = SessionStore.startNew(dir, mkdtempSync(join(tmpdir(), "lbb-side-home-")));
		const { taskTool } = makeHarness(store);

		await taskTool.call(
			{ description: "x", prompt: "task body" },
			{ callId: "t1", signal: new AbortController().signal, cwd: dir, onUpdate: () => {} },
		);

		const customs = store.linearEntries().filter((e) => e.type === "custom");
		const kinds = customs.map((e) => (e as any).kind);
		expect(kinds).toContain("subagent_start");
		expect(kinds).toContain("subagent_end");
	});

	test("subagent inherits parent permissionMode and denies a tool the rules don't allow", async () => {
		// Subagent script attempts the echo tool; with no allow rule and mode
		// "default", an unresolved ask must fail closed to a tool-result error
		// (there is no interactive dialog inside a subagent), not run the tool.
		const subScript = [{ toolCalls: [{ name: "echo", arguments: { text: "should be blocked" } }] }, { text: "done" }];
		const subFaux = fauxProvider(subScript);
		const ctx = {
			streamFn: subFaux.streamFn,
			model: FAUX_MODEL,
			allTools: [echoTool()],
			definitions: [],
			permissionMode: "default" as const,
			getPermissionRules: () => [],
		};
		const taskTool = createTaskTool(ctx);
		const result = await taskTool.call(
			{ description: "run sub", prompt: "do the thing" },
			{ callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
		);
		expect(result.isError).toBeFalsy();
		// The subagent's own transcript recorded a denied tool call rather than "ok".
		expect((result.content[0] as any).text).not.toContain("should be blocked");
	});

	test("subagent with an explicit allow rule can use the tool", async () => {
		const subScript = [
			{ toolCalls: [{ name: "echo", arguments: { text: "allowed run" } }] },
			{ text: "SUBAGENT DONE" },
		];
		const subFaux = fauxProvider(subScript);
		const ctx = {
			streamFn: subFaux.streamFn,
			model: FAUX_MODEL,
			allTools: [echoTool()],
			definitions: [],
			permissionMode: "default" as const,
			getPermissionRules: () => [{ toolName: "echo", behavior: "allow" as const, source: "session" as const }],
		};
		const taskTool = createTaskTool(ctx);
		const result = await taskTool.call(
			{ description: "run sub", prompt: "do the thing" },
			{ callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
		);
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toContain("SUBAGENT DONE");
	});

	test("undefined permissionMode leaves subagents unrestricted (back-compat default)", async () => {
		const { taskTool } = makeHarness();
		const result = await taskTool.call(
			{ description: "run sub", prompt: "do the thing" },
			{ callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
		);
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toContain("SUBAGENT FINAL REPORT");
	});
});

describe("skills", () => {
	test("SKILL.md folders become prompt commands", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-skill-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-skill-proj-"));
		mkdirSync(join(home, ".labunbun", "skills", "review"), { recursive: true });
		mkdirSync(join(cwd, ".labunbun", "skills", "deploy"), { recursive: true });
		writeFileSync(
			join(home, ".labunbun", "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review code changes\n---\nReview the following carefully.",
		);
		writeFileSync(
			join(cwd, ".labunbun", "skills", "deploy", "SKILL.md"),
			"---\nname: deploy\ndescription: Deploy steps\n---\nDeploy checklist body.",
		);

		const skills = loadSkills(cwd, home);
		expect(skills.map((s) => s.name).sort()).toEqual(["deploy", "review"]);

		const commands = skillsAsCommands(skills);
		const deploy = commands.find((c) => c.name === "skill-deploy");
		expect(deploy?.type).toBe("prompt");
		if (deploy?.type === "prompt") {
			const expanded = deploy.getPrompt("to staging");
			expect(expanded).toContain('<skill name="deploy"');
			expect(expanded).toContain("Deploy checklist body.");
			expect(expanded.endsWith("to staging")).toBe(true);
		}
	});
});

describe("plan mode tools", () => {
	test("EnterPlanMode flips mode; ExitPlanMode blocks on approval", async () => {
		let entered = false;
		const approvals: string[] = [];
		const [enter, exit] = createPlanModeTools({
			enterPlanMode: () => {
				entered = true;
			},
			requestPlanApproval: async (plan) => {
				approvals.push(plan);
				return plan.includes("bad idea") ? { approved: false, feedback: "too risky" } : { approved: true };
			},
		});
		const ctx = { callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} };

		await enter.call({}, ctx);
		expect(entered).toBe(true);

		const rejected = await exit.call({ plan: "a bad idea" }, ctx);
		expect(rejected.isError).toBeFalsy();
		expect((rejected.content[0] as any).text).toContain("rejected");
		expect((rejected.content[0] as any).text).toContain("too risky");

		const approved = await exit.call({ plan: "solid plan" }, ctx);
		expect((approved.content[0] as any).text).toContain("approved");
	});
});

describe("plan mode restricts mutating tools end-to-end", () => {
	test("session in plan mode denies Write via permission engine", async () => {
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "x" } }] }, { text: "done" }]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			tools: [echoTool()],
			permissionMode: "plan",
			deps: { streamFn: faux.streamFn },
		});
		// The engine denies non-read-only tools in plan mode.
		const { evaluatePermissions } = await import("@labunbun/agent");
		const decision = evaluatePermissions("echo", { text: "x" }, { mode: session.permissionMode, rules: [], cwd: "/" });
		expect(decision.behavior).toBe("deny");
	});
});
