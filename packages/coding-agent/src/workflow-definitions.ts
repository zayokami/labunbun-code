/**
 * Saved workflows: `.js` scripts under `~/.labunbun/workflows` and, once the
 * checkout is trusted, `.labunbun/workflows`. They are addressed by name, so
 * `Workflow({name: "review"})` does not need the script pasted into the call.
 *
 * The name rule is the skills rule — lowercase, digits, single hyphens, at
 * most 64 characters, and the file's own stem — because the name reaches a
 * prompt position in the Workflow tool's description. A project tier is
 * executable code, not prose, so it stays behind the trust gate until the
 * person approves it, exactly like a project agent or skill.
 *
 * Runs are kept under the same directory, one folder each, so `resume_from`
 * has one place to look and a definition and its history sit together.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMissingPathError } from "@labunbun/tools";
import { isProjectTierTrusted } from "./project-trust.ts";
import { parseWorkflowScript } from "./workflow-script.ts";

const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKFLOW_NAME_MAX_CHARS = 64;
const DESCRIPTION_MAX_CHARS = 1024;

export interface WorkflowDefinition {
	name: string;
	description: string;
	whenToUse?: string;
	script: string;
	sourcePath: string;
	source: "user" | "project";
}

export interface WorkflowDefinitionLoad {
	workflows: WorkflowDefinition[];
	/** One line per held-back or unreadable workflow file. */
	notes: string[];
}

/** The directory saved workflows live in, under one home. */
export function workflowDefinitionsRoot(home = homedir()): string {
	return join(home, ".labunbun", "workflows");
}

/** The directory holding one folder per run. */
export function workflowRunsRoot(home = homedir()): string {
	return join(workflowDefinitionsRoot(home), "runs");
}

function nameProblem(stem: string, name: string): string | null {
	if (name.length > WORKFLOW_NAME_MAX_CHARS) return "name is longer than 64 characters";
	if (!WORKFLOW_NAME_PATTERN.test(name)) return "name must be lowercase letters, digits and single hyphens";
	if (name !== stem) return `meta name "${name}" must match the file name`;
	return null;
}

function loadWorkflowsFromDir(
	root: string,
	source: WorkflowDefinition["source"],
	notes: string[],
): WorkflowDefinition[] {
	const out: WorkflowDefinition[] = [];
	if (!existsSync(root)) return out;
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
			const stem = entry.name.slice(0, -3);
			const sourcePath = join(root, entry.name);
			let script: string;
			try {
				script = readFileSync(sourcePath, "utf8");
			} catch {
				notes.push(`workflow "${stem}" not loaded: file could not be read`);
				continue;
			}
			const parsed = parseWorkflowScript(script);
			if (parsed.error) {
				notes.push(`workflow "${stem}" not loaded: ${parsed.error}`);
				continue;
			}
			const name = parsed.meta?.name ?? stem;
			const problem = nameProblem(stem, name);
			if (problem !== null) {
				notes.push(`workflow "${stem}" not loaded: ${problem}`);
				continue;
			}
			const description = parsed.meta?.description ?? "";
			if (description.length > DESCRIPTION_MAX_CHARS) {
				notes.push(`workflow "${stem}" not loaded: description is longer than ${DESCRIPTION_MAX_CHARS} characters`);
				continue;
			}
			const whenToUse = parsed.meta?.whenToUse;
			out.push({
				name,
				description,
				...(whenToUse ? { whenToUse } : {}),
				script,
				sourcePath,
				source,
			});
		}
	} catch (error) {
		if (!isMissingPathError(error)) {
			notes.push(
				`workflows directory ${root} could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return out;
}

function projectWorkflows(cwd: string, notes: string[]): WorkflowDefinition[] {
	return loadWorkflowsFromDir(join(cwd, ".labunbun", "workflows"), "project", notes);
}

/**
 * The user tier always, the project tier only once this directory is trusted.
 * Unlike skills there is no bundled tier: a workflow is about the repository
 * it runs in, and shipping one that assumes someone else's layout would be a
 * definition that only sometimes makes sense.
 */
export function loadWorkflowDefinitions(cwd: string, home = homedir()): WorkflowDefinitionLoad {
	const notes: string[] = [];
	const user = loadWorkflowsFromDir(workflowDefinitionsRoot(home), "user", notes);
	const project = isProjectTierTrusted(cwd, "workflows", home) ? projectWorkflows(cwd, notes) : [];
	const byName = new Map<string, WorkflowDefinition>();
	for (const workflow of [...user, ...project]) byName.set(workflow.name, workflow);
	const workflows = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
	return { workflows, notes };
}

/**
 * The project's workflow files, named without being read.
 *
 * The withheld tier exists so a dialog can say what an approval would load, and
 * nothing about that needs the file's contents. Reading `meta` would mean
 * evaluating a repository's code before the person trusted it — `node:vm` is
 * not a security boundary (`this.constructor.constructor` reaches the host
 * realm's `process`), so an unread file is the only safe offer. Name validation
 * is still applied to the stem, because that is the name the catalogue would
 * use.
 */
function projectWorkflowFiles(cwd: string): WorkflowDefinition[] {
	const root = join(cwd, ".labunbun", "workflows");
	const out: WorkflowDefinition[] = [];
	if (!existsSync(root)) return out;
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
			const stem = entry.name.slice(0, -3);
			if (stem.length > WORKFLOW_NAME_MAX_CHARS || !WORKFLOW_NAME_PATTERN.test(stem)) continue;
			out.push({
				name: stem,
				description: "",
				script: "",
				sourcePath: join(root, entry.name),
				source: "project",
			});
		}
	} catch {
		// An unreadable directory offers nothing; once the tier is trusted the
		// loader reports the same failure as a note.
	}
	return out.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The project workflows the trust gate is holding back, for a dialog to offer.
 *
 * Deliberately not `projectWorkflows`: that parses every file, and parsing
 * evaluates `meta` in a vm context. Before an approval, the file is untrusted
 * input, so this lists names and paths only.
 */
export function withheldProjectWorkflows(cwd: string, home = homedir()): WorkflowDefinition[] {
	if (isProjectTierTrusted(cwd, "workflows", home)) return [];
	return projectWorkflowFiles(cwd);
}

/** The saved-workflow lines the Workflow tool's description lists. */
export function workflowCatalogue(definitions: WorkflowDefinition[]): string {
	return definitions
		.map((definition) => {
			const description = definition.description === "" ? "(no description)" : definition.description;
			const when = definition.whenToUse ? ` — ${definition.whenToUse}` : "";
			return `- ${definition.name}: ${description}${when}`;
		})
		.join("\n");
}
