/**
 * The one-time trust a project's definitions need before they load.
 *
 * A cloned repository used to be able to change what the model is told to be:
 * its `.labunbun/agents` markdown became subagent system prompts, and its
 * `.labunbun/skills` folders became prompt expansions, with no user action
 * beyond opening the folder. The project tier now loads only after the directory
 * has been approved once, and the approval is kept under the user's home.
 *
 * So there are two things under test, and the second is the one with teeth: that
 * nothing loads before the gate is passed, and that the ledger lives somewhere a
 * repository cannot write. A ledger inside the working tree would be a file the
 * repo author ships pre-approved, which is the whole hole.
 *
 * The ledger is written here through `approveProjectDefinitions` rather than by
 * driving `/agents`: what the command does with these functions — listing,
 * adopting mid-session — is `agents-command.test.ts`'s subject.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeCwd } from "@labunbun/agent";
import {
	approveProjectDefinitions,
	describeWithheld,
	enclosingRepositoryRoot,
	isProjectTierTrusted,
	loadTrustedDefinitionKinds,
	withheldDefinitionNotice,
} from "../src/project-trust.ts";
import { loadSkills, withheldProjectSkills } from "../src/skills.ts";
import { loadAgentDefinitions, withheldProjectAgents } from "../src/subagents.ts";

/** A throwaway home and working directory: the gate is a fact about both. */
function fixture(): { home: string; cwd: string } {
	return {
		home: mkdtempSync(join(tmpdir(), "lbb-trust-home-")),
		cwd: mkdtempSync(join(tmpdir(), "lbb-trust-cwd-")),
	};
}

function plant(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function plantProjectAgent(cwd: string, name = "deployer"): void {
	plant(join(cwd, ".labunbun", "agents", `${name}.md`), "---\ndescription: Deploys the app\n---\nPROJECT-AGENT-BODY\n");
}

function plantProjectSkill(cwd: string, name = "deploy"): void {
	plant(join(cwd, ".labunbun", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nPROJECT-SKILL-BODY\n`);
}

function plantUserAgent(home: string, name = "researcher"): void {
	plant(join(home, ".labunbun", "agents", `${name}.md`), "---\ndescription: Deep research\n---\nUSER-AGENT-BODY\n");
}

function plantUserSkill(home: string, name: string, body = "USER-SKILL-BODY"): void {
	plant(join(home, ".labunbun", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
}

/** Where the ledger is supposed to be, spelled out rather than recomputed by the code under test. */
function ledgerPath(home: string, cwd: string): string {
	return join(home, ".labunbun", "projects", sanitizeCwd(cwd), "trusted-definitions.json");
}

describe("how the withheld counts are phrased", () => {
	test("singular and plural, for both tiers", () => {
		// Printed by three lines (the startup notice, the approval confirmation and a
		// `-p` run's stderr), which is why it is phrased once.
		expect(describeWithheld({ agents: 1, skills: 1 })).toBe("1 agent definition, 1 skill");
		expect(describeWithheld({ agents: 2, skills: 0 })).toBe("2 agent definitions, 0 skills");
	});
});

describe("project-tier agent definitions", () => {
	test("are not loaded until the directory is trusted, and are reported as withheld", () => {
		const { home, cwd } = fixture();
		plantProjectAgent(cwd);

		// Both halves matter: an empty load is also what a broken reader looks like,
		// so the withheld list is what says the definition was found and held back.
		expect(loadAgentDefinitions(cwd, home)).toEqual([]);
		expect(withheldProjectAgents(cwd, home).map((definition) => definition.agentType)).toEqual(["deployer"]);
		expect(isProjectTierTrusted(cwd, "agents", home)).toBe(false);
	});

	test("load once the directory is trusted, and stop being reported as withheld", () => {
		const { home, cwd } = fixture();
		plantProjectAgent(cwd);

		approveProjectDefinitions(cwd, ["agents"], home);

		const loaded = loadAgentDefinitions(cwd, home);
		expect(loaded.map((definition) => definition.agentType)).toEqual(["deployer"]);
		expect(loaded[0]?.source).toBe("project");
		// Read through the same reader as the loader, so a listing cannot show
		// something the loader would refuse.
		expect(withheldProjectAgents(cwd, home)).toEqual([]);
	});

	test("the user tier is never held back", () => {
		const { home, cwd } = fixture();
		plantUserAgent(home);

		// Nothing approved, and the user's own definition still loads: the gate is
		// about what a repository ships, not about definitions as such.
		expect(loadAgentDefinitions(cwd, home).map((definition) => definition.agentType)).toEqual(["researcher"]);
		expect(withheldProjectAgents(cwd, home)).toEqual([]);
	});

	test("approving one tier does not trust the other", () => {
		const { home, cwd } = fixture();
		plantProjectAgent(cwd);
		plantProjectSkill(cwd);

		approveProjectDefinitions(cwd, ["agents"], home);

		expect(loadTrustedDefinitionKinds(cwd, home)).toEqual(new Set(["agents"]));
		expect(loadSkills(cwd, home)).toEqual([]);
		expect(withheldProjectSkills(cwd, home).map((skill) => skill.name)).toEqual(["deploy"]);
	});

	test("one approval can cover both tiers, which is what /agents approve records", () => {
		const { home, cwd } = fixture();
		plantProjectAgent(cwd);
		plantProjectSkill(cwd);

		approveProjectDefinitions(cwd, ["agents", "skills"], home);

		expect(loadAgentDefinitions(cwd, home).map((definition) => definition.agentType)).toEqual(["deployer"]);
		expect(loadSkills(cwd, home).map((skill) => skill.name)).toEqual(["deploy"]);
	});
});

describe("project-tier skills", () => {
	test("a withheld project skill cannot shadow the user's skill of the same name", () => {
		const { home, cwd } = fixture();
		plantUserSkill(home, "echo", "USER-ECHO-BODY");
		plantProjectSkill(cwd, "echo");

		// The project tier wins on a name collision — that is what makes a project
		// skill useful — so the gate has to keep a repository from redirecting a
		// skill the user wrote and uses, by naming its folder the same thing.
		expect(loadSkills(cwd, home).map((skill) => skill.body.trim())).toEqual(["USER-ECHO-BODY"]);
		expect(withheldProjectSkills(cwd, home).map((skill) => skill.name)).toEqual(["echo"]);
	});

	test("once trusted, the project skill overrides the user's again, and stops being reported as withheld", () => {
		const { home, cwd } = fixture();
		plantUserSkill(home, "echo", "USER-ECHO-BODY");
		plantProjectSkill(cwd, "echo");

		approveProjectDefinitions(cwd, ["skills"], home);

		expect(loadSkills(cwd, home).map((skill) => skill.body.trim())).toEqual(["PROJECT-SKILL-BODY"]);
		// The other half of the gate, and the one nothing else pins: the withheld
		// list is what the startup notice and `/agents` read, so a trusted project
		// still listed as pending would tell the user their approved skill is not
		// loaded — every session, from then on.
		expect(withheldProjectSkills(cwd, home)).toEqual([]);
	});
});

describe("the kinds the gate covers", () => {
	test("each records on its own, and the ledger writes them in one fixed order", () => {
		const { home, cwd } = fixture();

		// Memory and styles are decisions of the same shape as agents and skills —
		// recorded by name, so trust for one tier never covers another, which is
		// what keeps a kind added later from riding on an earlier decision.
		approveProjectDefinitions(cwd, ["memory", "styles"], home);
		expect(loadTrustedDefinitionKinds(cwd, home)).toEqual(new Set(["memory", "styles"]));
		expect(isProjectTierTrusted(cwd, "agents", home)).toBe(false);

		// A second approval in a different order writes the same bytes: the kinds
		// are filtered through the fixed list rather than appended in call order.
		approveProjectDefinitions(cwd, ["skills", "agents"], home);
		expect(loadTrustedDefinitionKinds(cwd, home)).toEqual(new Set(["agents", "skills", "memory", "styles"]));
		expect(JSON.parse(readFileSync(ledgerPath(home, cwd), "utf8"))).toEqual({
			trustedDefinitionKinds: ["agents", "skills", "memory", "styles"],
		});
	});
});

/** A repository root and a nested directory under it; `.git` as file covers worktrees. */
function repoFixture(gitKind: "dir" | "file" = "dir"): { root: string; sub: string } {
	const root = mkdtempSync(join(tmpdir(), "lbb-repo-"));
	if (gitKind === "dir") mkdirSync(join(root, ".git"), { recursive: true });
	else writeFileSync(join(root, ".git"), "gitdir: ../elsewhere\n", "utf8");
	const sub = join(root, "packages", "nested");
	mkdirSync(sub, { recursive: true });
	return { root, sub };
}

describe("enclosingRepositoryRoot", () => {
	test("a cwd that is itself a repository root reports nothing", () => {
		const { root } = repoFixture();
		// The walk starts at the parent: a session started at the root is not "in
		// a subdirectory of a Git project", and the note must not claim it is.
		expect(enclosingRepositoryRoot(root)).toBeUndefined();
	});

	test("finds the root above a subdirectory, at any depth", () => {
		const { root, sub } = repoFixture();
		expect(enclosingRepositoryRoot(sub)).toBe(root);
		// Purely lexical above the cwd: levels below it need not exist on disk.
		expect(enclosingRepositoryRoot(join(sub, "deeper"))).toBe(root);
	});

	test("a .git file counts — a worktree or submodule is still a repository", () => {
		const { root, sub } = repoFixture("file");
		expect(enclosingRepositoryRoot(sub)).toBe(root);
	});

	test("a repository nested inside another reports its own root, not the outer one", () => {
		const { root } = repoFixture();
		const inner = join(root, "vendored");
		mkdirSync(join(inner, ".git"), { recursive: true });
		// Started at the inner root: that repository is the project, the outer one
		// is background, and the note must not point the decision at it. This is
		// what the walk-starting-at-start guard buys, and only this.
		expect(enclosingRepositoryRoot(inner)).toBeUndefined();
		// Below the inner root, the nearest root wins — the way git resolves it.
		const deep = join(inner, "src");
		mkdirSync(deep, { recursive: true });
		expect(enclosingRepositoryRoot(deep)).toBe(inner);
	});

	test("no repository on the way up, nothing to say", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-norepo-"));
		expect(enclosingRepositoryRoot(dir)).toBeUndefined();
	});
});

describe("the git-root scope note", () => {
	test("states this app's scope, not Codex's — the ledger is keyed by the cwd", () => {
		const base = withheldDefinitionNotice({ agents: 1, skills: 1 }, "repl");
		const noted = withheldDefinitionNotice({ agents: 1, skills: 1 }, "repl", join("somewhere", "repo"));
		// The two-argument sentence is a prefix; the note is one appended line.
		expect(noted.startsWith(`${base}\n`)).toBe(true);
		expect(noted).toBe(
			`${base}\nNote: you're in a subdirectory of a Git project — approval covers this directory, not the repository root at ${join("somewhere", "repo")}.`,
		);
	});

	test("both audiences get it — scope is not a property of where the line is read", () => {
		expect(withheldDefinitionNotice({ agents: 0, skills: 1 }, "headless", "/repo")).toContain(
			"not the repository root at /repo.",
		);
		// And the two-argument form is what it always was.
		expect(withheldDefinitionNotice({ agents: 0, skills: 1 }, "headless")).not.toContain("subdirectory");
	});
});

describe("the ledger", () => {
	test("is written outside the working tree, keyed by the cwd", () => {
		const { home, cwd } = fixture();
		plantProjectAgent(cwd);

		approveProjectDefinitions(cwd, ["skills"], home);

		// Under the user's home, next to that project's sessions, keyed with the same
		// slug SessionStore keys them with — and recording exactly the tier that was
		// approved, not both of them.
		expect(existsSync(ledgerPath(home, cwd))).toBe(true);
		expect(JSON.parse(readFileSync(ledgerPath(home, cwd), "utf8"))).toEqual({ trustedDefinitionKinds: ["skills"] });
		// Nothing was written into the repository: the file a repo author would have
		// to ship to pre-approve its own definitions is not the file this reads.
		expect(existsSync(join(cwd, ".labunbun", "trusted-definitions.json"))).toBe(false);
		expect(loadAgentDefinitions(cwd, home)).toEqual([]);
	});

	test("one shipped inside the repository pre-approves nothing", () => {
		const { home, cwd } = fixture();
		plantProjectAgent(cwd);
		// The exact ledger a repo author would ship to approve their own definitions,
		// in the exact shape this build writes.
		plant(join(cwd, ".labunbun", "trusted-definitions.json"), '{"trustedDefinitionKinds":["agents","skills"]}\n');
		plant(join(cwd, "settings.local.json"), '{"trustedDefinitionKinds":["agents","skills"]}\n');

		expect(loadAgentDefinitions(cwd, home)).toEqual([]);
		expect(isProjectTierTrusted(cwd, "agents", home)).toBe(false);
	});

	test("an unreadable ledger grants nothing rather than throwing", () => {
		const { home, cwd } = fixture();
		plantProjectAgent(cwd);
		plant(ledgerPath(home, cwd), "{ this is not JSON");

		expect(loadTrustedDefinitionKinds(cwd, home)).toEqual(new Set());
		expect(loadAgentDefinitions(cwd, home)).toEqual([]);
	});

	test("a kind this build does not load is ignored, and the rest still counts", () => {
		const { home, cwd } = fixture();
		plantProjectAgent(cwd);
		plant(ledgerPath(home, cwd), '{"trustedDefinitionKinds":["mcp","agents"]}\n');

		expect(loadTrustedDefinitionKinds(cwd, home)).toEqual(new Set(["agents"]));
		expect(loadAgentDefinitions(cwd, home).map((definition) => definition.agentType)).toEqual(["deployer"]);
	});

	test("a second approval extends the record instead of replacing it", () => {
		const { home, cwd } = fixture();
		plant(ledgerPath(home, cwd), '{"note":"hand-written","trustedDefinitionKinds":["agents"]}\n');

		approveProjectDefinitions(cwd, ["skills"], home);

		// The file holds whatever else it held: it is the user's, and re-approving a
		// tier is not a reason to take a line they wrote out of it.
		const record = JSON.parse(readFileSync(ledgerPath(home, cwd), "utf8"));
		expect(record).toEqual({ note: "hand-written", trustedDefinitionKinds: ["agents", "skills"] });
	});
});
