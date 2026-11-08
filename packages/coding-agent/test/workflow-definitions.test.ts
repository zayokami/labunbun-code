/**
 * Saved workflows: where they live, which tier wins, and the notes a bad file
 * earns instead of a silent skip.
 *
 * The name reaches the Workflow tool's description, so it is held to the skills
 * rule; the project tier is executable code, so it waits behind the same trust
 * decision as a project agent or skill. Both are asserted here because both are
 * promises made to someone who saved a file and expects it to run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveProjectDefinitions } from "../src/project-trust.ts";
import {
	loadWorkflowDefinitions,
	withheldProjectWorkflows,
	workflowCatalogue,
	workflowDefinitionsRoot,
	workflowRunsRoot,
} from "../src/workflow-definitions.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lbb-workflow-defs-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout() {
	const home = tempRoot();
	const cwd = tempRoot();
	const userDir = workflowDefinitionsRoot(home);
	const projectDir = join(cwd, ".labunbun", "workflows");
	mkdirSync(userDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	return { home, cwd, userDir, projectDir };
}

function write(dir: string, file: string, content: string): void {
	const path = join(dir, file);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function workflow(name: string, description = "Does the thing"): string {
	return `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)} };\nreturn 1;`;
}

describe("the roots", () => {
	test("definitions and runs sit under the same home directory", () => {
		const home = join(tempRoot(), "somewhere");
		expect(workflowDefinitionsRoot(home)).toBe(join(home, ".labunbun", "workflows"));
		expect(workflowRunsRoot(home)).toBe(join(home, ".labunbun", "workflows", "runs"));
	});
});

describe("loading", () => {
	test("the user tier loads with its meta", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "review.js", workflow("review", "Review the diff"));

		const { workflows, notes } = loadWorkflowDefinitions(cwd, home);

		expect(notes).toEqual([]);
		expect(workflows).toHaveLength(1);
		expect(workflows[0]).toMatchObject({
			name: "review",
			description: "Review the diff",
			source: "user",
			sourcePath: join(userDir, "review.js"),
		});
		expect(workflows[0].script).toContain("export const meta");
	});

	test("the project tier waits for trust, then loads", () => {
		const { home, cwd, projectDir } = layout();
		write(projectDir, "deploy.js", workflow("deploy", "Deploy it"));

		const withheld = loadWorkflowDefinitions(cwd, home);
		expect(withheld.workflows).toEqual([]);
		expect(withheld.notes).toEqual([]);
		expect(withheldProjectWorkflows(cwd, home).map((definition) => definition.name)).toEqual(["deploy"]);

		approveProjectDefinitions(cwd, ["workflows"], home);
		const trusted = loadWorkflowDefinitions(cwd, home);
		expect(trusted.workflows.map((definition) => definition.name)).toEqual(["deploy"]);
		expect(trusted.workflows[0].source).toBe("project");
		expect(withheldProjectWorkflows(cwd, home)).toEqual([]);
	});

	test("trust for another kind does not unlock workflows", () => {
		const { home, cwd, projectDir } = layout();
		write(projectDir, "deploy.js", workflow("deploy"));
		approveProjectDefinitions(cwd, ["agents"], home);
		expect(loadWorkflowDefinitions(cwd, home).workflows).toEqual([]);
	});

	test("a project definition overrides a user definition of the same name", () => {
		const { home, cwd, userDir, projectDir } = layout();
		write(userDir, "shared.js", workflow("shared", "From the user tier"));
		write(projectDir, "shared.js", workflow("shared", "From the project tier"));
		approveProjectDefinitions(cwd, ["workflows"], home);

		const { workflows } = loadWorkflowDefinitions(cwd, home);
		expect(workflows).toHaveLength(1);
		expect(workflows[0].description).toBe("From the project tier");
		expect(workflows[0].source).toBe("project");
	});

	test("definitions are sorted by name", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "zeta.js", workflow("zeta"));
		write(userDir, "alpha.js", workflow("alpha"));
		expect(loadWorkflowDefinitions(cwd, home).workflows.map((definition) => definition.name)).toEqual([
			"alpha",
			"zeta",
		]);
	});

	test("only direct .js children are definitions", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "real.js", workflow("real"));
		write(userDir, "notes.txt", "not a workflow");
		write(userDir, join("references", "example.js"), workflow("example"));
		expect(loadWorkflowDefinitions(cwd, home).workflows.map((definition) => definition.name)).toEqual(["real"]);
	});

	test("a missing directory is empty and silent", () => {
		const home = tempRoot();
		const cwd = tempRoot();
		expect(loadWorkflowDefinitions(cwd, home)).toEqual({ workflows: [], notes: [] });
	});

	test("a workflow without meta is named by its file", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "bare.js", "return 1;");
		const { workflows, notes } = loadWorkflowDefinitions(cwd, home);
		expect(notes).toEqual([]);
		expect(workflows[0]).toMatchObject({ name: "bare", description: "" });
	});
});

describe("bad files become notes", () => {
	test("a name that is not a valid workflow name", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "Bad_Name.js", "return 1;");
		const { workflows, notes } = loadWorkflowDefinitions(cwd, home);
		expect(workflows).toEqual([]);
		expect(notes[0]).toContain('workflow "Bad_Name" not loaded');
		expect(notes[0]).toContain("lowercase letters, digits and single hyphens");
	});

	test("a meta name that disagrees with the file name", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "saved.js", workflow("other"));
		const { workflows, notes } = loadWorkflowDefinitions(cwd, home);
		expect(workflows).toEqual([]);
		expect(notes[0]).toContain('meta name "other" must match the file name');
	});

	test("an invalid meta literal", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "computed.js", "export const meta = { name: buildName() };");
		const { notes } = loadWorkflowDefinitions(cwd, home);
		expect(notes[0]).toContain("Invalid workflow meta");
	});

	test("a second export", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "extra.js", "export default 1;");
		const { notes } = loadWorkflowDefinitions(cwd, home);
		expect(notes[0]).toContain("only `export const meta` is supported");
	});

	test("an over-long description", () => {
		const { home, cwd, userDir } = layout();
		write(userDir, "long.js", workflow("long", "x".repeat(1025)));
		const { notes } = loadWorkflowDefinitions(cwd, home);
		expect(notes[0]).toContain("description is longer than 1024 characters");
	});
});

describe("the catalogue", () => {
	test("it lists name, description and whenToUse, with a placeholder for none", () => {
		const definitions = [
			{
				name: "a",
				description: "",
				script: "",
				sourcePath: "a.js",
				source: "user" as const,
			},
			{
				name: "b",
				description: "Bee",
				whenToUse: "When bees",
				script: "",
				sourcePath: "b.js",
				source: "project" as const,
			},
		];
		expect(workflowCatalogue(definitions)).toBe("- a: (no description)\n- b: Bee — When bees");
	});
});
