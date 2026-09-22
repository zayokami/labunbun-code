import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type AnyTool, buildTool, type PermissionMode, SessionStore } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type Model, type StreamFn } from "@labunbun/ai";
import { z } from "zod";
import { createPlanModeCallbacks, createPlanModeTools, type PlanApprovalUi } from "../src/plan-mode.ts";
import { approveProjectDefinitions } from "../src/project-trust.ts";
import { loadSkills, skillsAsCommands } from "../src/skills.ts";
import { agentSystemPrompt, createTaskTool, loadAgentDefinitions } from "../src/subagents.ts";

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

		// The project tier sits behind a one-time trust gate now; this test is about
		// what the reader does with the file once it is loaded, so it approves the
		// directory first. The gate itself — before/after/rejected, and the ledger's
		// location — is `project-trust.test.ts`.
		approveProjectDefinitions(cwd, ["agents"], home);

		const defs = loadAgentDefinitions(cwd, home);
		const researcher = defs.find((d) => d.agentType === "researcher");
		expect(researcher).toMatchObject({ whenToUse: "Deep research agent", source: "user", maxTurns: 5 });
		expect(researcher?.tools).toEqual(["Read", "Grep"]);
		expect(defs.find((d) => d.agentType === "deployer")?.source).toBe("project");
	});

	// The body is the agent's actual instructions; discarding it left every
	// custom agent running on its one-line description instead.
	test("keeps the markdown body as the agent's prompt", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-ag-body-"));
		mkdirSync(join(home, ".labunbun", "agents"), { recursive: true });
		writeFileSync(
			join(home, ".labunbun", "agents", "researcher.md"),
			"---\nname: researcher\ndescription: Deep research agent\n---\n\nYou write terse reports.\n",
		);
		writeFileSync(join(home, ".labunbun", "agents", "bare.md"), "No frontmatter at all.\n");

		const defs = loadAgentDefinitions(process.cwd(), home);
		expect(defs.find((d) => d.agentType === "researcher")?.body).toBe("You write terse reports.");
		expect(defs.find((d) => d.agentType === "bare")?.body).toBe("No frontmatter at all.");
	});

	test("a definition without a body falls back to the generic prompt, byte for byte", () => {
		expect(agentSystemPrompt({ agentType: "researcher", whenToUse: "Deep research agent", source: "user" })).toBe(
			"You are researcher, a focused subagent. Deep research agent\nComplete the task and report results concisely.",
		);
		expect(agentSystemPrompt({ agentType: "x", whenToUse: "", source: "builtin", body: "Custom body." })).toBe(
			"Custom body.",
		);
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
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			store: () => store,
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

	test("a subagent that runs out of room compacts its own context and keeps going", async () => {
		// A subagent has a context window of its own, and the research task it is
		// given is exactly the shape that fills one. Without its own compaction, a
		// long subagent died on the provider's refusal and handed the parent that
		// error as the tool result — the parent's own compaction cannot help a
		// window that is not its own.
		const subFaux = fauxProvider([
			{ stopReason: "error", errorMessage: "prompt is too long: 250000 tokens", errorKind: "context_overflow" },
			{ text: "<summary>1. Primary Request: do the thing</summary>" },
			{ text: "SUBAGENT FINAL REPORT" },
		]);
		const taskTool = createTaskTool({
			streamFn: subFaux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
		});

		const result = await taskTool.call(
			{ description: "run sub", prompt: "do the thing" },
			{ callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
		);

		expect(result.isError).toBeFalsy();
		expect((result.content[0] as any).text).toContain("SUBAGENT FINAL REPORT");
		// Three calls: the refused request, the summary it forced, and the request
		// that carried it. The subagent's transcript is its own — no store, so
		// nothing of this reaches the parent's session file.
		expect(subFaux.receivedContexts).toHaveLength(3);
		expect(JSON.stringify(subFaux.receivedContexts[2]?.messages)).toContain("Conversation compacted");
	});

	test("the description names the agent types the model may pass", () => {
		// `subagent_type` is a free string, and the model's only way to know what
		// to put in it is the tool description. It used to list nothing: a session
		// shipping a `researcher` agent could be reached only by guessing the name
		// and reading the error the guess earned.
		const home = mkdtempSync(join(tmpdir(), "lbb-cat-home-"));
		mkdirSync(join(home, ".labunbun", "agents"), { recursive: true });
		writeFileSync(
			join(home, ".labunbun", "agents", "researcher.md"),
			"---\nname: researcher\ndescription: Deep research agent\n---\nYou dig.\n",
		);
		const definitions = loadAgentDefinitions(process.cwd(), home);
		const taskTool = createTaskTool({
			streamFn: fauxProvider([]).streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => definitions,
		});

		expect(taskTool.description).toContain("- researcher: Deep research agent");
		// The built-in is not in any list on disk and is the default, so it has to
		// be named too.
		expect(taskTool.description).toContain("general-purpose");
	});

	test("a definition with no description is still listed by name", () => {
		const taskTool = createTaskTool({
			streamFn: fauxProvider([]).streamFn,
			model: () => FAUX_MODEL,
			allTools: [],
			definitions: () => [{ agentType: "bare", whenToUse: "", source: "user" }],
		});
		expect(taskTool.description).toContain("- bare");
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
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			permissionMode: () => "default" as const,
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
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			permissionMode: () => "default" as const,
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

	test("a definition's body reaches the subagent system prompt", async () => {
		const subFaux = fauxProvider([{ text: "done" }]);
		const taskTool = createTaskTool({
			streamFn: subFaux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [
				{ agentType: "scribe", whenToUse: "Writes things", source: "user", body: "You write terse commit messages." },
			],
		});
		await taskTool.call(
			{ description: "run sub", prompt: "do the thing", subagent_type: "scribe" },
			{ callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
		);
		expect(subFaux.receivedContexts[0]?.systemPrompt).toBe("You write terse commit messages.");
	});

	test("systemPromptFor still overrides the definition body", async () => {
		const subFaux = fauxProvider([{ text: "done" }]);
		const taskTool = createTaskTool({
			streamFn: subFaux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [{ agentType: "scribe", whenToUse: "Writes things", source: "user", body: "Body." }],
			systemPromptFor: () => "OVERRIDE",
		});
		await taskTool.call(
			{ description: "run sub", prompt: "do the thing", subagent_type: "scribe" },
			{ callId: "t1", signal: new AbortController().signal, cwd: process.cwd(), onUpdate: () => {} },
		);
		expect(subFaux.receivedContexts[0]?.systemPrompt).toBe("OVERRIDE");
	});

	describe("cancellation", () => {
		/** Blocks until its own ctx.signal aborts — stands in for a slow subagent step. */
		function stallingTool(onEnter: () => void): AnyTool {
			return buildTool({
				name: "stall",
				description: "blocks until its signal aborts",
				inputSchema: z.object({}),
				call: async (_input, ctx) => {
					onEnter();
					if (!ctx.signal.aborted) {
						await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
					}
					return { content: [{ type: "text", text: ctx.signal.aborted ? "stall aborted" : "stall released" }] };
				},
			});
		}

		async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					promise,
					new Promise<"timeout">((resolve) => {
						timer = setTimeout(() => resolve("timeout"), ms);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}

		test("a parent abort stops the subagent and settles the call", async () => {
			const entered = Promise.withResolvers<void>();
			const abortController = new AbortController();
			const subFaux = fauxProvider([
				{ toolCalls: [{ id: "s1", name: "stall", arguments: {} }] },
				{ text: "subagent continued anyway" },
			]);
			const taskTool = createTaskTool({
				streamFn: subFaux.streamFn,
				model: () => FAUX_MODEL,
				allTools: [stallingTool(() => entered.resolve())],
				definitions: () => [],
			});

			const call = taskTool.call(
				{ description: "run sub", prompt: "do the thing" },
				{ callId: "t1", signal: abortController.signal, cwd: process.cwd(), onUpdate: () => {} },
			);
			expect(await settleWithin(entered.promise, 5_000)).not.toBe("timeout");
			abortController.abort();

			const result = await settleWithin(call, 5_000);
			expect(result).not.toBe("timeout");
			if (result === "timeout") return;
			expect(result.isError).toBe(true);
			expect((result.content[0] as any).text).toBe("Tool execution aborted");
			expect(result.details).toMatchObject({ reason: "aborted" });
			// The subagent must not have been handed another turn after the cancel.
			expect(subFaux.receivedContexts).toHaveLength(1);
		});

		test("aborting the parent session ends the run instead of blocking on the tool batch", async () => {
			// End-to-end shape of the reported bug: Esc during a Task call left the
			// spinner on "Running tools…" until the subagent finished on its own.
			const entered = Promise.withResolvers<void>();
			const subFaux = fauxProvider([{ toolCalls: [{ id: "s1", name: "stall", arguments: {} }] }, { text: "sub done" }]);
			const taskTool = createTaskTool({
				streamFn: subFaux.streamFn,
				model: () => FAUX_MODEL,
				allTools: [stallingTool(() => entered.resolve())],
				definitions: () => [],
			});
			const parentFaux = fauxProvider([
				{
					toolCalls: [{ id: "t1", name: "Task", arguments: { description: "stall", prompt: "block until cancelled" } }],
				},
				{ text: "parent finished" },
			]);
			const session = new AgentSession({
				model: FAUX_MODEL,
				tools: [taskTool],
				permissionMode: "bypassPermissions",
				deps: { streamFn: parentFaux.streamFn, canUseTool: async () => ({ behavior: "allow" as const }) },
			});

			const run = session.prompt("go");
			expect(await settleWithin(entered.promise, 5_000)).not.toBe("timeout");
			expect(session.isRunning).toBe(true);
			session.abort();

			expect(await settleWithin(run, 5_000)).toBe("aborted");
			const results = session.messages.filter((m) => m.role === "toolResult");
			expect(results).toHaveLength(1);
			expect(results[0].isError).toBe(true);
			expect((results[0].content[0] as { text: string }).text).toBe("Tool execution aborted");
			expect(parentFaux.receivedContexts).toHaveLength(1);
			expect(session.isRunning).toBe(false);
		});
	});
});

/**
 * What a subagent is built from, and when it is read.
 *
 * The Task tool outlives the state it used to capture at construction. `/model`
 * swaps the model, `/resume` swaps the session a sidechain is written into, a
 * mode change moves the parent's permission mode — and a subagent spawned after
 * any of those has to be built from the session as it is now, not as it was when
 * the REPL started. The failure is quiet in every case: the subagent runs, and
 * answers, on the wrong model / into the wrong file / under the wrong rules.
 */
describe("what the Task tool reads at the call", () => {
	const OTHER: Model = { ...FAUX_MODEL, id: "other-model" };

	/** A stream function that records which model each request was made to. */
	function recordedModels(provider: { streamFn: StreamFn }) {
		const models: string[] = [];
		const streamFn: StreamFn = async function* (model, context, options) {
			models.push(model.id);
			yield* provider.streamFn(model, context, options);
		};
		return { models, streamFn };
	}

	function callTool(tool: AnyTool, input: Record<string, unknown> = { description: "x", prompt: "do it" }) {
		return tool.call(input, {
			callId: "t1",
			signal: new AbortController().signal,
			cwd: process.cwd(),
			onUpdate: () => {},
		});
	}

	test("the model is the session's current one, not the one at construction", async () => {
		// /model mid-session. The window the subagent compacts against is derived
		// from this model too, so a stale one is not only spent wrongly — it fails
		// to manage a context it should have summarized.
		const subFaux = fauxProvider([{ text: "sub done" }]);
		let current: Model = FAUX_MODEL;
		const { models, streamFn } = recordedModels(subFaux);
		const taskTool = createTaskTool({
			streamFn,
			model: () => current,
			allTools: [echoTool()],
			definitions: () => [],
		});

		current = OTHER;
		await callTool(taskTool);

		expect(models).toEqual([OTHER.id]);
	});

	test("a sidechain is written into the session that is live now", async () => {
		// /resume mid-session: the entries belong to the conversation the subagent
		// was spawned from, and the file it left behind must not grow them.
		const subFaux = fauxProvider([{ text: "sub done" }]);
		const before = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-side-a-")),
			mkdtempSync(join(tmpdir(), "lbb-side-h-")),
		);
		const after = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-side-b-")),
			mkdtempSync(join(tmpdir(), "lbb-side-h-")),
		);
		let store: SessionStore | undefined = before;
		const taskTool = createTaskTool({
			streamFn: subFaux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			store: () => store,
		});

		store = after;
		await callTool(taskTool);

		const kinds = (s: SessionStore) =>
			s
				.linearEntries()
				.filter((e) => e.type === "custom")
				.map((e) => (e as { kind?: string }).kind);
		expect(kinds(after)).toEqual(["subagent_start", "subagent_end"]);
		expect(kinds(before)).toEqual([]);
	});

	test("the parent's permission mode is read now, not captured", async () => {
		// EnterPlanMode mid-session: the subagent must inherit plan restrictions. A
		// captured "default" would let it run the mutating tool while its parent is
		// only allowed to read. The same call is made twice under the same allow-all
		// rule — the mode is the only thing that changes, so the pair says what the
		// mode is worth rather than what the fixture happens to allow.
		const subFaux = fauxProvider([
			{ toolCalls: [{ name: "echo", arguments: { text: "ran" } }] },
			{ text: "done" },
			{ toolCalls: [{ name: "echo", arguments: { text: "ran" } }] },
			{ text: "done" },
		]);
		const store = SessionStore.startNew(
			mkdtempSync(join(tmpdir(), "lbb-mode-")),
			mkdtempSync(join(tmpdir(), "lbb-mode-home-")),
		);
		let mode: PermissionMode = "default";
		const taskTool = createTaskTool({
			streamFn: subFaux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [echoTool()],
			definitions: () => [],
			store: () => store,
			permissionMode: () => mode,
			getPermissionRules: () => [{ toolName: "*", behavior: "allow", source: "session" }],
		});

		await callTool(taskTool);
		mode = "plan";
		await callTool(taskTool);

		// The subagent's own record of what its tools did, in order.
		const ends = store
			.linearEntries()
			.filter((e) => e.type === "custom" && (e as { kind?: string }).kind === "subagent_end")
			.map((e) => (e as { data: { toolCalls: string[] } }).data.toolCalls);
		expect(ends).toEqual([["echo: ok"], ["echo: error"]]);
	});

	test("a definition's own model is used, and an unknown one falls back out loud", async () => {
		// `model:` in the frontmatter was parsed from the start and read by nothing,
		// which is worse than not supporting it: the definition said how it should
		// run and the app agreed with its eyes closed.
		const subFaux = fauxProvider([{ text: "sub done" }]);
		const { models, streamFn } = recordedModels(subFaux);
		const reported: string[] = [];
		const taskTool = createTaskTool({
			streamFn,
			model: () => FAUX_MODEL,
			resolveModel: (ref) => (ref === "other-model" ? OTHER : undefined),
			allTools: [echoTool()],
			definitions: () => [
				{ agentType: "quick", whenToUse: "Small jobs", source: "user", model: "other-model" },
				{ agentType: "retired", whenToUse: "Old jobs", source: "user", model: "gone-model" },
			],
			report: (text) => reported.push(text),
		});

		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "quick" });
		expect(models).toEqual([OTHER.id]);
		expect(reported).toEqual([]);

		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "retired" });
		expect(models).toEqual([OTHER.id, FAUX_MODEL.id]);
		// Said, not silent: a definition quietly running on a different model than
		// it asks for reads as that model having a bad day.
		expect(reported).toEqual(['[retired] Unknown model "gone-model" — running on the session model instead.']);
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

		// Same one-time trust as the agent definitions above: project skills are not
		// loaded until the directory is approved, and this test is about the reader.
		approveProjectDefinitions(cwd, ["skills"], home);

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

	test("a description wrapped over several lines is one description", () => {
		// `description: >-` is how a skill written for another tool wraps a long
		// sentence. Reading only the marker would leave the model with ">-" where
		// the text telling it when to use the skill should be.
		const home = mkdtempSync(join(tmpdir(), "lbb-skill-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-skill-proj-"));
		mkdirSync(join(home, ".labunbun", "skills", "find-docs"), { recursive: true });
		writeFileSync(
			join(home, ".labunbun", "skills", "find-docs", "SKILL.md"),
			[
				"---",
				"name: find-docs",
				"description: >-",
				"  Answer questions about a library's API by fetching its live documentation.",
				"  Use when the question is about how something is used today.",
				"---",
				"Body text.",
			].join("\n"),
		);
		const skills = loadSkills(cwd, home);
		const findDocs = skills.find((s) => s.name === "find-docs");
		expect(findDocs?.description).toBe(
			"Answer questions about a library's API by fetching its live documentation. " +
				"Use when the question is about how something is used today.",
		);
		expect(findDocs?.body).toBe("Body text.");
	});

	test("a literal block keeps its line breaks", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-skill-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-skill-proj-"));
		mkdirSync(join(home, ".labunbun", "skills", "steps"), { recursive: true });
		writeFileSync(
			join(home, ".labunbun", "skills", "steps", "SKILL.md"),
			["---", "name: steps", "description: |", "  First line.", "  Second line.", "---", "Body."].join("\n"),
		);
		const steps = loadSkills(cwd, home).find((s) => s.name === "steps");
		expect(steps?.description).toBe("First line.\nSecond line.");
	});

	test("plain frontmatter is read exactly as before", () => {
		const home = mkdtempSync(join(tmpdir(), "lbb-skill-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "lbb-skill-proj-"));
		mkdirSync(join(home, ".labunbun", "skills", "plain"), { recursive: true });
		writeFileSync(
			join(home, ".labunbun", "skills", "plain", "SKILL.md"),
			"---\nname: plain\ndescription: A demo: with a colon\n---\nBody here.",
		);
		const plain = loadSkills(cwd, home).find((s) => s.name === "plain");
		expect(plain?.description).toBe("A demo: with a colon");
		expect(plain?.body).toBe("Body here.");
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

describe("plan mode callbacks", () => {
	interface HarnessOptions {
		mode?: PermissionMode;
		ui?: PlanApprovalUi | null;
		approve?: boolean;
		swapDuringApproval?: () => void;
		rejectApproval?: () => void;
	}

	function makeHarness(options: HarnessOptions = {}) {
		const faux = fauxProvider([{ text: "done" }]);
		const events: string[] = [];
		let current: AgentSession | null = new AgentSession({
			model: FAUX_MODEL,
			tools: [],
			permissionMode: options.mode ?? "default",
			deps: { streamFn: faux.streamFn },
		});
		const ui: PlanApprovalUi | null =
			options.ui === undefined
				? {
						requestPermission: async () => {
							events.push(`approval:${options.approve === false ? "rejected" : "accepted"}`);
							options.swapDuringApproval?.();
							options.rejectApproval?.();
							return options.approve !== false;
						},
					}
				: options.ui;
		const callbacks = createPlanModeCallbacks(
			() => current,
			() => ui,
		);
		return {
			callbacks,
			events,
			get session() {
				return current;
			},
			swapSession(nextMode: PermissionMode = "default") {
				current = new AgentSession({
					model: FAUX_MODEL,
					tools: [],
					permissionMode: nextMode,
					deps: { streamFn: faux.streamFn },
				});
			},
			abortSession() {
				current?.abort();
			},
		};
	}

	test("approval restores the mode the session had before plan mode", async () => {
		const harness = makeHarness({ mode: "acceptEdits" });
		const decision = await harness.callbacks.requestPlanApproval("the plan");
		expect(decision.approved).toBe(true);
		expect(harness.session?.permissionMode).toBe("acceptEdits");
	});

	test("initial plan approval defaults to default mode", async () => {
		const harness = makeHarness({ mode: "plan" });
		const decision = await harness.callbacks.requestPlanApproval("the plan");
		expect(decision.approved).toBe(true);
		expect(harness.session?.permissionMode).toBe("default");
	});

	test("rejection keeps plan mode active", async () => {
		const harness = makeHarness({ approve: false, mode: "plan" });
		const decision = await harness.callbacks.requestPlanApproval("the plan");
		expect(decision.approved).toBe(false);
		expect(harness.session?.permissionMode).toBe("plan");
	});

	test("absent UI denies instead of silently approving", async () => {
		const harness = makeHarness({ ui: null, mode: "plan" });
		const decision = await harness.callbacks.requestPlanApproval("the plan");
		expect(decision.approved).toBe(false);
		expect(harness.session?.permissionMode).toBe("plan");
	});

	test("canceled approval (interrupt during dialog) keeps plan mode", async () => {
		const harness = makeHarness({ mode: "plan", rejectApproval: () => harness.abortSession() });
		const decision = await harness.callbacks.requestPlanApproval("the plan");
		expect(decision.approved).toBe(false);
		expect(harness.session?.permissionMode).toBe("plan");
	});

	test("interrupted run then approval inside the same dialog resolve stays canceled", async () => {
		const harness = makeHarness({ mode: "plan" });
		const session = harness.session;
		if (session) {
			// Simulate the loop unwinding mid-dialog: abort() then the run's finally
			// clears the controller, so the interrupt must be latched, not polled.
			session.abort();
		}
		const decision = await harness.callbacks.requestPlanApproval("the plan");
		expect(decision.approved).toBe(false);
		expect(session?.permissionMode).toBe("plan");
	});

	test("session swapped mid-dialog leaves the new session's mode untouched", async () => {
		const harness = makeHarness({ mode: "plan", swapDuringApproval: () => harness.swapSession("default") });
		const swapped = harness.session;
		const decision = await harness.callbacks.requestPlanApproval("the plan");
		expect(decision.approved).toBe(false);
		expect(swapped?.permissionMode).toBe("plan");
		expect(harness.session?.permissionMode).toBe("default");
	});

	test("EnterPlanMode flips only the captured session", async () => {
		const harness = makeHarness({ mode: "default" });
		harness.callbacks.enterPlanMode();
		expect(harness.session?.permissionMode).toBe("plan");
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
