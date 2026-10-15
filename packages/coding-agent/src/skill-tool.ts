/**
 * The Skill tool: the model's own door to the skills a user sees as
 * `/skill-<name>` commands.
 *
 * The loading and the expansion live in `skills.ts`; this file is only the
 * tool shape around them. The body is rendered through the same
 * `renderSkillPrompt` the slash-command path calls, so `$ARGUMENTS` means the
 * same thing to whoever invoked the skill — the one place the two paths would
 * otherwise drift is exactly the place a skill's author relies on.
 *
 * The tool is declared read-only: it returns text from a list loaded at
 * startup and touches nothing, which is what admits it in plan mode (the
 * allow-list test walks this declaration against the mode's name list).
 */

import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import { renderSkillPrompt, type Skill } from "./skills.ts";

export function createSkillTool(skills: Skill[]): AnyTool {
	return buildTool({
		name: "Skill",
		description:
			"Invoke a skill by name. A skill is a saved instruction document for a recurring task, " +
			"listed under `# Skills` in the system prompt; this call returns the skill's text, and " +
			"the call's args are substituted where the skill says $ARGUMENTS. Use it when the task " +
			"matches a skill's description.",
		inputSchema: z.object({
			name: z.string().describe("Skill name, exactly as listed under `# Skills`"),
			args: z.string().optional().describe("Arguments for the skill, substituted where its body says $ARGUMENTS"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			const skill = skills.find((candidate) => candidate.name === input.name);
			if (!skill) {
				// The list is what the model may retry with. A command-only skill is
				// not in it: naming one here would invite the call the next check
				// refuses.
				const names = skills
					.filter((candidate) => !candidate.disableModelInvocation)
					.map((candidate) => candidate.name);
				return {
					content: [
						textContent(
							names.length === 0
								? `Unknown skill "${input.name}". No skills are available in this session.`
								: `Unknown skill "${input.name}". Available skills: ${names.join(", ")}.`,
						),
					],
					isError: true,
				};
			}
			if (skill.disableModelInvocation) {
				return {
					content: [
						textContent(
							`Skill "${skill.name}" is restricted to manual invocation (disable-model-invocation): ` +
								`it runs only when the user types /skill-${skill.name}.`,
						),
					],
					isError: true,
				};
			}
			// `args` is optional at the schema; the empty string is what the slash
			// path passes when the user typed the bare command, so an invocation
			// with no arguments renders exactly as `/skill-<name>` would.
			return { content: [textContent(renderSkillPrompt(skill, input.args ?? ""))] };
		},
	});
}
