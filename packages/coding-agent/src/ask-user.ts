/**
 * AskUserQuestion tool: lets the agent ask the user structured multiple-choice
 * questions through the TUI dialog. Answers return as the tool result.
 */

import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

export interface AskUserBridge {
	askUser(
		questions: Array<{
			question: string;
			header: string;
			options: Array<{ label: string; description?: string }>;
			multiSelect?: boolean;
		}>,
	): Promise<string[] | null>;
}

const optionSchema = z.object({
	label: z.string().describe("Concise choice text (1-5 words)"),
	description: z.string().optional().describe("Explanation of what this choice means"),
});

export function createAskUserQuestionTool(bridge: AskUserBridge): AnyTool {
	return buildTool({
		name: "AskUserQuestion",
		description:
			"Ask the user structured multiple-choice questions when you need a decision that is " +
			"theirs to make (approach, trade-offs, requirements). Use sparingly — only when the " +
			"answer changes what you do next and cannot be resolved from context.",
		inputSchema: z.object({
			questions: z
				.array(
					z.object({
						question: z.string().describe("The complete question, ending with a question mark"),
						header: z.string().max(12).describe("Very short label shown as a chip"),
						options: z.array(optionSchema).min(2).max(4).describe("Mutually exclusive choices"),
						multiSelect: z.boolean().optional(),
					}),
				)
				.min(1)
				.max(4),
		}),
		prompt:
			"- Prefer AskUserQuestion over guessing when user intent genuinely forks the approach.\n" +
			"- Put your recommended option first with its rationale in the description.",
		isReadOnly: () => true,
		isConcurrencySafe: () => false,
		call: async (input) => {
			const answers = await bridge.askUser(
				input.questions.map((q) => ({
					question: q.question,
					header: q.header,
					options: q.options,
					multiSelect: q.multiSelect,
				})),
			);
			if (!answers) {
				return {
					content: [textContent("The user dismissed the questions. Proceed with your best judgment.")],
					isError: false,
				};
			}
			const lines = input.questions.map((q, i) => `${q.question}\n  → ${answers[i] ?? "(no answer)"}`);
			return { content: [textContent(`User answers:\n${lines.join("\n")}`)], details: { answers } };
		},
	});
}
