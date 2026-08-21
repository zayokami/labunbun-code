/**
 * Skills: SKILL.md folders discovered from user/project dirs and exposed as
 * prompt-type slash commands (the expansion path shared with /explain etc.).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command, PromptCommand } from "./commands.ts";

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

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { data: {}, body: content };
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { data, body: content.slice(match[0].length) };
}

export function loadSkills(cwd: string, home = homedir()): Skill[] {
	const user = loadSkillsFromDir(join(home, ".labunbun", "skills"));
	const project = loadSkillsFromDir(join(cwd, ".labunbun", "skills"));
	// Project skills override user skills with the same name.
	const byName = new Map<string, Skill>();
	for (const skill of [...user, ...project]) byName.set(skill.name, skill);
	return [...byName.values()];
}

/** Convert skills into prompt-type commands: invoking expands to the body. */
export function skillsAsCommands(skills: Skill[]): Command[] {
	return skills.map(
		(skill): PromptCommand => ({
			name: `skill-${skill.name}`,
			description: skill.description || `Skill: ${skill.name}`,
			type: "prompt",
			getPrompt: (args) =>
				`<skill name="${skill.name}" source="${skill.sourcePath}">\n${skill.body}\n</skill>\n\n${args}`.trim(),
		}),
	);
}
