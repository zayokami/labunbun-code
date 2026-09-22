/**
 * Skills: SKILL.md folders discovered from user/project dirs and exposed as
 * prompt-type slash commands (the expansion path shared with /explain etc.).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command, PromptCommand } from "./commands.ts";
import { isProjectTierTrusted } from "./project-trust.ts";

export interface Skill {
	name: string;
	description: string;
	body: string;
	sourcePath: string;
}

function loadSkillsFromDir(skillsRoot: string): Skill[] {
	const out: Skill[] = [];
	if (!existsSync(skillsRoot)) return out;
	try {
		for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skillPath = join(skillsRoot, entry.name, "SKILL.md");
			if (!existsSync(skillPath)) continue;
			try {
				const { data, body } = parseFrontmatter(readFileSync(skillPath, "utf8"));
				out.push({
					name: data.name ?? entry.name,
					description: data.description ?? "",
					body: body.trim(),
					sourcePath: skillPath,
				});
			} catch {}
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

function projectSkills(cwd: string): Skill[] {
	return loadSkillsFromDir(join(cwd, ".labunbun", "skills"));
}

/**
 * The user tier always, the project tier only once this directory is trusted.
 *
 * A skill's body is sent to the model as the text the user typed, so a repository
 * that ships one can write what reaches the prompt — see `project-trust.ts`. The
 * gate is here and not at the call sites: a loader that could be called around it
 * is a loader with two meanings, and the headless path, which has no dialog to
 * approve anything with, calls this one.
 */
export function loadSkills(cwd: string, home = homedir()): Skill[] {
	const user = loadSkillsFromDir(join(home, ".labunbun", "skills"));
	const project = isProjectTierTrusted(cwd, "skills", home) ? projectSkills(cwd) : [];
	// Project skills override user skills with the same name.
	const byName = new Map<string, Skill>();
	for (const skill of [...user, ...project]) byName.set(skill.name, skill);
	return [...byName.values()];
}

/** The project skills the trust gate is holding back, for a dialog to offer. */
export function withheldProjectSkills(cwd: string, home = homedir()): Skill[] {
	if (isProjectTierTrusted(cwd, "skills", home)) return [];
	return projectSkills(cwd);
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
