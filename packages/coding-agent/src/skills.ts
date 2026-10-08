/**
 * Skills: SKILL.md folders discovered from user/project dirs and exposed in two
 * ways — as prompt-type slash commands (the expansion path shared with
 * /explain etc.), and as a discovery block in the system prompt, from which the
 * model may invoke one implicitly when the task matches its description.
 *
 * The second way is why the frontmatter rules are enforced here rather than
 * trusted: a skill's name and description reach the system prompt of every
 * session in which it loads, so a name that is not `[a-z0-9-]`, is longer than
 * 64 characters, or disagrees with its directory is a repo-controlled string in
 * a prompt position. Both Anthropic and OpenAI converged on the same rule set
 * (agentskills.io: "Must match the parent directory name", lowercase, hyphens,
 * ≤64); an invalid skill is held back and named in a notice instead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command, PromptCommand } from "./commands.ts";
import { isProjectTierTrusted } from "./project-trust.ts";

/** `a-b`, not `A_b` or `-a` or `a--b`: the shared Agent Skills name rule. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX_CHARS = 64;
/** The shared Agent Skills cap on the one line the model matches requests against. */
const DESCRIPTION_MAX_CHARS = 1024;

export interface Skill {
	name: string;
	description: string;
	body: string;
	sourcePath: string;
	/**
	 * Frontmatter `disable-model-invocation` — command-only, never offered to
	 * the model for implicit use. Absent means invocable (both vendors default
	 * to implicit allowed); any value other than a bare `false` counts as set,
	 * because the failure mode that matters is a skill reaching prompts its
	 * author did not intend, not one staying hidden.
	 */
	disableModelInvocation: boolean;
}

/** Why a skill folder was held back, phrased for the startup notice. */
export interface SkillNote {
	dir: string;
	reason: string;
}

export interface SkillLoadResult {
	skills: Skill[];
	/** One line per held-back skill folder, in directory order. */
	notes: string[];
}

function skillNameProblem(dir: string, data: Record<string, string>): string | null {
	if (dir.length > SKILL_NAME_MAX_CHARS) return "name is longer than 64 characters";
	if (!SKILL_NAME_PATTERN.test(dir)) return "name must be lowercase letters, digits and single hyphens";
	// The frontmatter name has to be the directory's own. Two names for one
	// skill would make the discovery block and the /skill- command disagree
	// about what it is called.
	if (data.name !== undefined && data.name !== dir)
		return `frontmatter name "${data.name}" must match the directory name`;
	return null;
}

function loadSkillsFromDir(skillsRoot: string, notes: string[]): Skill[] {
	const out: Skill[] = [];
	if (!existsSync(skillsRoot)) return out;
	try {
		for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skillPath = join(skillsRoot, entry.name, "SKILL.md");
			if (!existsSync(skillPath)) continue;
			try {
				const { data, body } = parseFrontmatter(readFileSync(skillPath, "utf8"));
				const problem = skillNameProblem(entry.name, data);
				if (problem !== null) {
					notes.push(`skill "${entry.name}" not loaded: ${problem}`);
					continue;
				}
				const description = data.description ?? "";
				if (description.length > DESCRIPTION_MAX_CHARS) {
					notes.push(
						`skill "${entry.name}" not loaded: description is longer than ${DESCRIPTION_MAX_CHARS} characters`,
					);
					continue;
				}
				out.push({
					name: entry.name,
					description,
					body: body.trim(),
					sourcePath: skillPath,
					disableModelInvocation:
						(data["disable-model-invocation"] ?? "").toLowerCase() !== "false" && "disable-model-invocation" in data,
				});
			} catch {
				notes.push(`skill "${entry.name}" not loaded: SKILL.md could not be read`);
			}
		}
	} catch {
		return out;
	}
	return out;
}

/**
 * The lines of a YAML block scalar starting at `start`, unindented.
 *
 * `>` (folded) joins wrapped lines with spaces and keeps blank lines as breaks;
 * `|` (literal) keeps every line break. The chomping and indent indicators
 * (`-`, `+`, a digit) do not change the result here: the value is a one-line
 * description, and a trailing break is not part of it either way.
 */
function readBlockScalar(lines: string[], start: number, marker: string): { value: string; next: number } {
	const collected: string[] = [];
	let index = start;
	while (index < lines.length && (lines[index].trim() === "" || /^\s/.test(lines[index]))) {
		collected.push(lines[index]);
		index += 1;
	}
	while (collected.length > 0 && collected[collected.length - 1].trim() === "") collected.pop();
	const indent = collected.find((line) => line.trim() !== "")?.match(/^\s*/)?.[0].length ?? 0;
	const stripped = collected.map((line) => line.slice(indent));
	const value =
		marker === "|"
			? stripped.join("\n")
			: stripped
					.join("\n")
					.split(/\n\s*\n/)
					.map((paragraph) =>
						paragraph
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line !== "")
							.join(" "),
					)
					.filter((paragraph) => paragraph !== "")
					.join("\n");
	return { value, next: index };
}

/**
 * Split a skill's frontmatter from its body. Exported because the importer has
 * to read a skill file with the same reader the loader uses — a description it
 * cannot parse there would be written back as a description this build cannot
 * read either.
 */
export function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { data: {}, body: content };
	const data: Record<string, string> = {};
	const lines = match[1].split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const value = line.slice(idx + 1).trim();
		// A skill description written as `description: >-` carries its text on the
		// lines below. Reading only the marker loses the one sentence that tells
		// the model when to reach for the skill.
		if (/^[>|]([+-]?\d?|\d[+-]?)?$/.test(value)) {
			const block = readBlockScalar(lines, index + 1, value[0]);
			index = block.next - 1;
			data[line.slice(0, idx).trim()] = block.value;
			continue;
		}
		data[line.slice(0, idx).trim()] = value;
	}
	return { data, body: content.slice(match[0].length) };
}

function projectSkills(cwd: string, notes: string[]): Skill[] {
	return loadSkillsFromDir(join(cwd, ".labunbun", "skills"), notes);
}

/**
 * The user tier always, the project tier only once this directory is trusted.
 *
 * A skill's body is sent to the model as the text the user typed, so a repository
 * that ships one can write what reaches the prompt — see `project-trust.ts`. The
 * gate is here and not at the call sites: a loader that could be called around it
 * is a loader with two meanings, and the headless path, which has no dialog to
 * approve anything with, calls this one.
 *
 * Notes report held-back skill folders rather than staying silent: a folder
 * whose name fails validation is invisible to every command and to discovery,
 * and the failure mode that matters is the author believing it loaded.
 */
export function loadSkillsWithNotes(cwd: string, home = homedir()): SkillLoadResult {
	const notes: string[] = [];
	const user = loadSkillsFromDir(join(home, ".labunbun", "skills"), notes);
	const project = isProjectTierTrusted(cwd, "skills", home) ? projectSkills(cwd, notes) : [];
	// Project skills override user skills with the same name.
	const byName = new Map<string, Skill>();
	for (const skill of [...user, ...project]) byName.set(skill.name, skill);
	return { skills: [...byName.values()], notes };
}

export function loadSkills(cwd: string, home = homedir()): Skill[] {
	return loadSkillsWithNotes(cwd, home).skills;
}

/** The project skills the trust gate is holding back, for a dialog to offer. */
export function withheldProjectSkills(cwd: string, home = homedir()): Skill[] {
	if (isProjectTierTrusted(cwd, "skills", home)) return [];
	// Notes are not collected here: a withheld skill is counted by the withheld
	// notice, and a held-back one would be reported twice.
	return projectSkills(cwd, []);
}

/**
 * Convert skills into prompt-type commands: invoking expands to the body.
 *
 * A body that says `$ARGUMENTS` — how command files written for other tools
 * address the text typed after the name — gets the arguments substituted in
 * place, and they are not also appended. Nothing else is expanded: `$1`-`$9`
 * and inline shell expansion would be a second, undocumented language, and a
 * body that uses them reads as written instead of losing its arguments
 * silently. The report says so when a migrated command relies on them.
 */
export function skillsAsCommands(skills: Skill[]): Command[] {
	return skills.map((skill): PromptCommand => {
		// Decided once, at load: whether the body addresses its arguments at all.
		const placeholder = skill.body.includes("$ARGUMENTS");
		return {
			name: `skill-${skill.name}`,
			description: skill.description || `Skill: ${skill.name}`,
			type: "prompt",
			getPrompt: (args) => {
				const body = placeholder ? skill.body.replaceAll("$ARGUMENTS", args) : skill.body;
				const tail = placeholder ? "" : `\n\n${args}`;
				return `<skill name="${skill.name}" source="${skill.sourcePath}">\n${body}\n</skill>${tail}`.trim();
			},
		};
	});
}

/**
 * The discovery budget, in characters.
 *
 * Codex's documented rule is "roughly 2% of the model's context window, or 8,000
 * characters when the context window is unknown". The cap is what binds for
 * every current model — 2% of a 200k window is ~16k characters — so the
 * window-aware branch is a floor for much smaller windows, not a second number
 * anyone will see. The 2% is in tokens and this is in characters, and the docs
 * themselves say "roughly", so tokens × 4 is the documented approximation
 * rather than a promise.
 */
export const SKILL_DISCOVERY_BUDGET_CHARS = 8000;

export function skillDiscoveryBudgetChars(contextWindow?: number): number {
	if (!contextWindow || contextWindow <= 0) return SKILL_DISCOVERY_BUDGET_CHARS;
	return Math.min(SKILL_DISCOVERY_BUDGET_CHARS, Math.floor(contextWindow * 0.02) * 4);
}

const DISCOVERY_HEADER =
	"# Skills\nEach is invoked as /skill-<name>. Invoke one when the task matches its description.";
const SHORT_DESCRIPTION_MAX_CHARS = 120;

function entryLine(name: string, description: string): string {
	return description ? `- ${name} — ${description}` : `- ${name}`;
}

/** The first sentence of a description, hard-capped: Codex shortens before it drops. */
function shortenDescription(description: string): string {
	const boundary = description.search(/\.\s/);
	const sentence = boundary === -1 ? description : description.slice(0, boundary + 1);
	return sentence.length > SHORT_DESCRIPTION_MAX_CHARS
		? `${sentence.slice(0, SHORT_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`
		: sentence;
}

function noteLine(hidden: number): string {
	return `- … and ${hidden} more skill${hidden === 1 ? "" : "s"} not listed (discovery budget); invoke one directly with /skill-<name>.`;
}

/**
 * The system-prompt block that makes skills discoverable.
 *
 * Levels, the way both vendors describe them: the name and description live in
 * every prompt (this block); the body is sent only when the skill is invoked
 * (via `skillsAsCommands`); anything else in the skill folder stays on disk
 * until the body says to read it.
 *
 * The budget is spent on the whole block, and the order in which it gives
 * ground is fixed: full descriptions, then shortened ones, then names alone,
 * and only then entries dropped from the end — with the count of what was
 * dropped, because a skill missing without a word is one nobody knows to
 * invoke. Names alone come before dropping for the single-skill case: one
 * skill with a paragraph-long description must not empty the list, when
 * `- name` costs ten characters and is the difference between the model
 * knowing a skill exists and not.
 *
 * Skills carrying `disable-model-invocation` are absent here by construction:
 * the flag exists to keep a skill out of this exact list.
 */
export function skillDiscoveryBlock(skills: Skill[], budget = SKILL_DISCOVERY_BUDGET_CHARS): string {
	const listed = skills.filter((skill) => !skill.disableModelInvocation);
	if (listed.length === 0) return "";
	const render = (entries: string[], note?: string): string =>
		[DISCOVERY_HEADER, ...entries, ...(note ? [note] : [])].join("\n");
	const full = listed.map((skill) => entryLine(skill.name, skill.description));
	if (render(full).length <= budget) return render(full);
	const shortened = listed.map((skill) => entryLine(skill.name, shortenDescription(skill.description)));
	if (render(shortened).length <= budget) return render(shortened);
	const namesOnly = listed.map((skill) => `- ${skill.name}`);
	if (render(namesOnly).length <= budget) return render(namesOnly);
	const entries = namesOnly;
	while (entries.length > 0) {
		const hidden = listed.length - entries.length;
		const note = hidden > 0 ? noteLine(hidden) : undefined;
		if (render(entries, note).length <= budget) return render(entries, note);
		entries.pop();
	}
	return render([], noteLine(listed.length));
}
