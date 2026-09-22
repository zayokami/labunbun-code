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
import { AgentSession, sanitizeCwd } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { expandPromptCommand, findCommand } from "../src/commands.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { loadTrustedDefinitionKinds } from "../src/project-trust.ts";
import { loadSkills, skillsAsCommands, withheldProjectSkills } from "../src/skills.ts";
import { loadAgentDefinitions, withheldProjectAgents } from "../src/subagents.ts";

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
		baseRules: [],
		sessionRules: [],
		sessionStore: () => undefined,
	} as unknown as AppCommandContext;

	return {
		ctx,
		home,
		cwd,
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

describe("/agents", () => {
	test("lists what is loaded, with its tier, and what the gate is holding back", () => {
		const h = harness();
		plant(join(h.home, ".labunbun", "agents", "researcher.md"), "---\ndescription: Deep research\n---\nUser body.\n");
		plant(join(h.cwd, ".labunbun", "agents", "deployer.md"), "---\ndescription: Deploys the app\n---\nProject body.\n");
		plant(join(h.cwd, ".labunbun", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\nDeploy body.\n");
		// Re-read through the readers a mounted app would have used at startup.
		h.ctx.agentDefinitions = loadAgentDefinitions(h.cwd, h.home);
		h.ctx.withheldAgents = withheldProjectAgents(h.cwd, h.home);
		h.ctx.withheldSkills = withheldProjectSkills(h.cwd, h.home);

		expect(handleAppCommand("/agents", h.ctx)).toBe(true);

		const text = h.lines();
		expect(text).toContain("general-purpose [builtin]");
		expect(text).toContain("researcher [user] — Deep research");
		// The withheld one is named too, and with the way to load it: a listing that
		// showed only what loaded would make a repository's agent look absent.
		expect(text).toContain("deployer [project, not loaded — /agents approve]");
		expect(text).toContain("1 project skill not loaded: deploy — /agents approve loads both");
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
