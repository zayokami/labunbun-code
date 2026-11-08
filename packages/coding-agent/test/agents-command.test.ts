/**
 * `/agents` — what it lists, and what approving a project's definitions does.
 *
 * The gate in `project-trust.test.ts` says nothing loads before an approval; this
 * is about the other half: that the approval is reachable at all, that it says
 * what it is about to load, and that what it loads *works* from the next line
 * typed rather than from the next start. A definition that is loaded into a list
 * nothing reads is the failure mode that would look correct here and do nothing
 * in a session, so the assertions go through the same lookups the app uses —
 * `findCommand` for the skill, the live `agentDefinitions` array for the agent.
 *
 * The context is assembled by hand, as `/gamepad`'s tests assemble theirs: the
 * command's own file has to be readable by a caller that is not a mounted REPL.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, sanitizeCwd, type ToolCallContext } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { expandPromptCommand, findCommand } from "../src/commands.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { withheldProjectMemoryFiles } from "../src/memory.ts";
import { loadOutputStyles, withheldProjectOutputStyles } from "../src/output-styles.ts";
import { loadTrustedDefinitionKinds } from "../src/project-trust.ts";
import { createSkillTool } from "../src/skill-tool.ts";
import { adoptApprovedSkills, loadSkills, type Skill, skillsAsCommands, withheldProjectSkills } from "../src/skills.ts";
import { loadAgentDefinitions, withheldProjectAgents } from "../src/subagents.ts";
import { loadWorkflowDefinitions, withheldProjectWorkflows } from "../src/workflow-definitions.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plant(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

/**
 * A session whose lists are the live ones, built the way the app builds them.
 *
 * `loadAgentDefinitions`/`loadSkills` and the withheld readers are the production
 * calls, not stand-ins: a harness that handed `/agents` its own arrays would pass
 * while the app handed it different ones.
 */
function harness(): {
	ctx: AppCommandContext;
	lines: () => string;
	home: string;
	cwd: string;
	skills: Skill[];
} {
	const home = mkdtempSync(join(tmpdir(), "lbb-agents-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-agents-cwd-"));
	roots.push(home, cwd);
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>({ ...initialUiState() });
	const agentDefinitions = loadAgentDefinitions(cwd, home);
	const skills = loadSkills(cwd, home);

	const ctx = {
		getSession: () => session,
		handle: { store },
		cwd,
		home,
		commands: skillsAsCommands(skills),
		agentDefinitions,
		withheldAgents: withheldProjectAgents(cwd, home),
		withheldSkills: withheldProjectSkills(cwd, home),
		withheldStyles: withheldProjectOutputStyles(cwd, home),
		baseRules: [],
		sessionRules: [],
		sessionStore: () => undefined,
		// The mounted app hands the adopted skills to the live array the Skill
		// tool closes over; a hand-built context has to do the same or the
		// test can only see the slash-command half of an approval.
		adoptSkills: (adopted: Skill[]) => {
			adoptApprovedSkills(skills, adopted);
		},
	} as unknown as AppCommandContext;

	return {
		ctx,
		home,
		cwd,
		skills,
		lines: () =>
			store
				.get()
				.entries.filter((entry) => entry.kind === "info")
				.map((entry) => (entry as { text: string }).text)
				.join("\n"),
	};
}

/** The file the approval ledger is supposed to land in — spelled out, not recomputed. */
function ledgerPath(home: string, cwd: string): string {
	return join(home, ".labunbun", "projects", sanitizeCwd(cwd), "trusted-definitions.json");
}

/** The Skill tool reads no part of this context; `Tool.call` still requires one. */
function callCtx(): ToolCallContext {
	return {
		callId: "t1",
		signal: new AbortController().signal,
		cwd: process.cwd(),
		sandbox: "workspace-write",
		network: { access: "enabled", domains: [] },
		onUpdate: () => {},
	};
}

describe("/agents", () => {
	test("lists what is loaded, with its tier, and what the gate is holding back", () => {
		const h = harness();
		plant(join(h.home, ".labunbun", "agents", "researcher.md"), "---\ndescription: Deep research\n---\nUser body.\n");
		plant(join(h.cwd, ".labunbun", "agents", "deployer.md"), "---\ndescription: Deploys the app\n---\nProject body.\n");
		plant(join(h.cwd, ".labunbun", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\nDeploy body.\n");
		plant(join(h.cwd, "LABUNBUN.md"), "# House rules\n");
		plant(join(h.cwd, ".labunbun", "output-styles", "brief.md"), "PROJECT-BRIEF");
		// Re-read through the readers a mounted app would have used at startup.
		h.ctx.agentDefinitions = loadAgentDefinitions(h.cwd, h.home);
		h.ctx.withheldAgents = withheldProjectAgents(h.cwd, h.home);
		h.ctx.withheldSkills = withheldProjectSkills(h.cwd, h.home);
		h.ctx.withheldMemory = withheldProjectMemoryFiles(h.cwd, h.home);
		h.ctx.withheldStyles = withheldProjectOutputStyles(h.cwd, h.home);

		expect(handleAppCommand("/agents", h.ctx)).toBe(true);

		const text = h.lines();
		expect(text).toContain("general-purpose [builtin]");
		expect(text).toContain("researcher [user] — Deep research");
		// The withheld one is named too, and with the way to load it: a listing that
		// showed only what loaded would make a repository's agent look absent.
		expect(text).toContain("deployer [project, not loaded — /agents approve]");
		expect(text).toContain("1 project skill not loaded: deploy — /agents approve loads both");
		// Memory is the third pending tier, named by path so it can be read before
		// the decision — and with the restart, which the other two do not need.
		// The planted LABUNBUN.md is the nearest file, so it closes the list.
		expect(text).toContain(`LABUNBUN.md — /agents approve, then restart`);
		// The fourth kind, named by path: a style is invisible until approved, and
		// this listing is where the user sees what the decision would load.
		expect(text).toContain("1 project output style not loaded: ");
		expect(text).toContain("brief.md — /agents approve, then restart");
	});

	test("approve loads both tiers, and they answer from the next line typed", () => {
		const h = harness();
		plant(join(h.cwd, ".labunbun", "agents", "deployer.md"), "---\ndescription: Deploys the app\n---\nProject body.\n");
		plant(join(h.cwd, ".labunbun", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\nPROJECT-SKILL-BODY\n");
		h.ctx.agentDefinitions = loadAgentDefinitions(h.cwd, h.home);
		h.ctx.withheldAgents = withheldProjectAgents(h.cwd, h.home);
		h.ctx.withheldSkills = withheldProjectSkills(h.cwd, h.home);

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		// Recorded where the gate reads it, through the reader rather than the file.
		expect(loadTrustedDefinitionKinds(h.cwd, h.home)).toEqual(new Set(["agents", "skills"]));
		// The agent joined the array the Task tool resolves `subagent_type` against.
		expect(h.ctx.agentDefinitions.map((definition) => definition.agentType)).toContain("deployer");
		// And the skill joined the registry the dispatcher searches: the expansion is
		// the proof that it would answer `/skill-deploy` now, not on the next start.
		expect(findCommand(h.ctx.commands, "/skill-deploy")).toBeDefined();
		expect(expandPromptCommand(h.ctx.commands, "/skill-deploy to staging")).toContain("PROJECT-SKILL-BODY");
		// Nothing is left to approve twice, and the line says what was loaded.
		expect(h.ctx.withheldAgents).toEqual([]);
		expect(h.ctx.withheldSkills).toEqual([]);
		expect(h.lines()).toContain("1 agent definition, 1 skill now loaded");
	});

	test("approve loads the skill into the Skill tool, not only the slash commands", async () => {
		const h = harness();
		plant(join(h.cwd, ".labunbun", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\nPROJECT-SKILL-BODY\n");
		h.ctx.commands = skillsAsCommands(loadSkills(h.cwd, h.home));
		h.ctx.withheldSkills = withheldProjectSkills(h.cwd, h.home);
		const skillTool = createSkillTool(h.skills);

		// Before the decision the tool names the session's list, and deploy is not on it.
		const before = await skillTool.call({ name: "deploy" }, callCtx());
		expect(before.isError).toBe(true);
		expect((before.content[0] as { text: string }).text).toContain("No skills are available");

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		// The array the Skill tool closes over is the one the approval fed. Without
		// `adoptSkills` the registry learned the command and the model could not
		// invoke the skill until a restart, which the confirmation never mentioned.
		expect(h.skills.map((skill) => skill.name)).toEqual(["deploy"]);
		const after = await skillTool.call({ name: "deploy" }, callCtx());
		expect(after.isError).toBeFalsy();
		expect((after.content[0] as { text: string }).text).toContain("PROJECT-SKILL-BODY");
	});

	test("a project skill takes a same-named user skill's place at both invocation paths", async () => {
		const h = harness();
		plant(join(h.home, ".labunbun", "skills", "review", "SKILL.md"), "---\nname: review\n---\nUSER-BODY\n");
		plant(join(h.cwd, ".labunbun", "skills", "review", "SKILL.md"), "---\nname: review\n---\nPROJECT-BODY\n");
		// The startup state: the user tier is live, the project copy is withheld.
		h.skills.push(...loadSkills(h.cwd, h.home));
		h.ctx.commands = skillsAsCommands(h.skills);
		h.ctx.withheldSkills = withheldProjectSkills(h.cwd, h.home);
		const skillTool = createSkillTool(h.skills);

		expect(expandPromptCommand(h.ctx.commands, "/skill-review")).toContain("USER-BODY");
		expect((await skillTool.call({ name: "review" }, callCtx())).content[0]).toMatchObject({
			text: expect.stringContaining("USER-BODY"),
		});

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		// A restart resolves a collision in the project's favour. The live state has
		// to agree in both places: appending would leave `find` on the user's body
		// while the slash command answered with the project's, and the confirmation
		// would claim a load that only one path could see.
		expect(h.ctx.commands.filter((command) => command.name === "skill-review")).toHaveLength(1);
		expect(expandPromptCommand(h.ctx.commands, "/skill-review")).toContain("PROJECT-BODY");
		expect(h.skills.map((skill) => skill.name)).toEqual(["review"]);
		const invoked = await skillTool.call({ name: "review" }, callCtx());
		expect((invoked.content[0] as { text: string }).text).toContain("PROJECT-BODY");
		expect((invoked.content[0] as { text: string }).text).not.toContain("USER-BODY");
	});

	test("an approval whose ledger write fails says so and leaves everything withheld", () => {
		const h = harness();
		plant(join(h.cwd, ".labunbun", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\nDeploy body.\n");
		h.ctx.withheldSkills = withheldProjectSkills(h.cwd, h.home);
		// `~/.labunbun` is a file, so the ledger's parent cannot be created and
		// mkdir -p fails. Before the catch this error left `/agents approve` and
		// took the REPL's line with it: the user was asked to trust a repository
		// and the command answering crashed instead of recording or refusing.
		writeFileSync(join(h.home, ".labunbun"), "not a directory", "utf8");

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		expect(h.lines()).toContain("Approval failed, so nothing was loaded");
		// Nothing was spliced: no decision was recorded, so the definitions are
		// still pending and a later approval can still grant them.
		expect(h.ctx.withheldSkills).toHaveLength(1);
		expect(h.ctx.commands.some((command) => command.name === "skill-deploy")).toBe(false);
	});

	test("approve records memory with the rest, and the confirmation asks for a restart", () => {
		const h = harness();
		plant(join(h.cwd, "LABUNBUN.md"), "# House rules\n");
		// The memory walk extends above the fixture, so the count is computed the
		// way the app computes it; the planted file guarantees it is non-zero.
		h.ctx.withheldMemory = withheldProjectMemoryFiles(h.cwd, h.home);
		const withheld = h.ctx.withheldMemory.length;
		expect(withheld).toBeGreaterThan(0);

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		// Recorded under its own kind: the other tiers are not trusted by this.
		expect(loadTrustedDefinitionKinds(h.cwd, h.home)).toEqual(new Set(["memory"]));
		expect(h.ctx.withheldMemory).toEqual([]);
		// "now loaded" would be false for memory within this session — it is read
		// once at startup into the system prompt — so the line says restart, the
		// one thing still owed, instead of a "loaded" the next message contradicts.
		expect(h.lines()).toContain(`${withheld} memory file${withheld === 1 ? "" : "s"}; memory loads on the next start`);
		// Nothing is left pending for a second approve: the decision is recorded,
		// and the restart is not something a second approval can buy.
		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);
		expect(h.lines()).toContain("Nothing pending");
	});

	test("approve records styles, the one kind nothing else can open", () => {
		const h = harness();
		plant(join(h.cwd, ".labunbun", "output-styles", "brief.md"), "PROJECT-BRIEF");
		h.ctx.withheldStyles = withheldProjectOutputStyles(h.cwd, h.home);
		expect(h.ctx.withheldStyles).toHaveLength(1);

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		// `styles` is its own kind in the ledger. Before this path recorded it,
		// `loadOutputStyles` asked the gate for a decision no command could make,
		// so a repository's style was unreachable for the life of the checkout.
		expect(loadTrustedDefinitionKinds(h.cwd, h.home)).toEqual(new Set(["styles"]));
		expect(h.ctx.withheldStyles).toEqual([]);
		expect(loadOutputStyles(h.cwd, h.home).map((style) => style.name)).toEqual(["brief"]);
		// The prompt was built at startup, so the style is not live in this
		// session; the line says restart rather than claiming a load the next
		// message would refute.
		expect(h.lines()).toContain("1 output style; output styles load on the next start");

		// And a second approval has nothing left to grant.
		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);
		expect(h.lines()).toContain("Nothing pending");
	});

	test("approve loads workflows, and the project file takes the user file's place", () => {
		const h = harness();
		plant(
			join(h.home, ".labunbun", "workflows", "shared.js"),
			'export const meta = { name: "shared" };\nreturn "user";\n',
		);
		plant(
			join(h.cwd, ".labunbun", "workflows", "shared.js"),
			'export const meta = { name: "shared" };\nreturn "project";\n',
		);
		h.ctx.workflowDefinitions = loadWorkflowDefinitions(h.cwd, h.home).workflows;
		h.ctx.withheldWorkflows = withheldProjectWorkflows(h.cwd, h.home);
		// Before the decision only the user tier is live; the project file is pending.
		expect(h.ctx.workflowDefinitions.map((workflow) => workflow.source)).toEqual(["user"]);
		expect(h.ctx.withheldWorkflows).toHaveLength(1);

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		expect(loadTrustedDefinitionKinds(h.cwd, h.home)).toEqual(new Set(["workflows"]));
		expect(h.ctx.withheldWorkflows).toEqual([]);
		// The project definition replaces the user one rather than joining it: the
		// tool resolves a name with `find`, so an appended project file would sit
		// behind the user copy and the approval would appear to do nothing.
		const live = h.ctx.workflowDefinitions ?? [];
		expect(live).toHaveLength(1);
		expect(live[0].source).toBe("project");
		expect(live[0].script).toContain('"project"');
		expect(h.lines()).toContain("1 workflow now loaded");
	});

	test("approve says when a project workflow did not survive loading", () => {
		const h = harness();
		plant(join(h.cwd, ".labunbun", "workflows", "broken.js"), "export const meta = { name: 7 };");
		h.ctx.workflowDefinitions = loadWorkflowDefinitions(h.cwd, h.home).workflows;
		h.ctx.withheldWorkflows = withheldProjectWorkflows(h.cwd, h.home);
		// The pending entry is the file name: the file itself is not read or
		// evaluated until the approval makes it trusted.
		expect(h.ctx.withheldWorkflows.map((workflow) => workflow.name)).toEqual(["broken"]);

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		expect(h.ctx.workflowDefinitions).toEqual([]);
		expect(h.ctx.withheldWorkflows).toEqual([]);
		expect(h.lines()).toContain('Workflow: workflow "broken" not loaded');
	});

	test("approve with nothing pending says so and writes nothing", () => {
		const h = harness();
		plant(join(h.home, ".labunbun", "agents", "researcher.md"), "---\ndescription: Deep research\n---\nUser body.\n");

		expect(handleAppCommand("/agents approve", h.ctx)).toBe(true);

		expect(h.lines()).toContain("Nothing pending");
		// No ledger at all: an approval with nothing behind it must not leave a file
		// that claims this directory was ever trusted.
		expect(existsSync(ledgerPath(h.home, h.cwd))).toBe(false);
	});

	test("a repo that ships a pre-approved ledger still gets asked", () => {
		const h = harness();
		plant(join(h.cwd, ".labunbun", "agents", "deployer.md"), "---\ndescription: Deploys the app\n---\nProject body.\n");
		plant(join(h.cwd, ".labunbun", "trusted-definitions.json"), '{"trustedDefinitionKinds":["agents","skills"]}\n');
		h.ctx.withheldAgents = withheldProjectAgents(h.cwd, h.home);
		h.ctx.withheldSkills = withheldProjectSkills(h.cwd, h.home);

		expect(handleAppCommand("/agents", h.ctx)).toBe(true);

		expect(h.lines()).toContain("deployer [project, not loaded — /agents approve]");
	});
});
