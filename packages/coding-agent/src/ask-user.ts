/**
 * AskUserQuestion tool: lets the agent ask the user structured multiple-choice
 * questions through the TUI dialog. Answers return as the tool result.
 */

import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

export interface AskUserBridge {
	/**
	 * Show the questions and resolve with the answers, or null when the user
	 * dismissed them.
	 *
	 * `signal` is the calling run's abort: the dialog is a wait on a human, and a
	 * run aborted while it is up must settle this call rather than leave the turn
	 * waiting on a question nobody is looking at.
	 */
	askUser(
		questions: Array<{
			question: string;
			header: string;
			options: Array<{ label: string; description?: string }>;
			multiSelect?: boolean;
		}>,
		signal?: AbortSignal,
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
			"Ask the user a structured multiple-choice question when a decision is genuinely theirs " +
			"and cannot be resolved from the repository: an ambiguous requirement, a trade-off in " +
			"scope, or a choice with materially different cost or risk. This is a last resort, not a " +
			"check-in: decide reversible implementation details yourself, and never ask for a fact the " +
			"code, tests, or configuration can answer.",
		inputSchema: z.object({
			questions: z
				.array(
					z.object({
						question: z.string().describe("The complete question, ending with a question mark"),
						header: z.string().max(12).describe("Very short label shown as a chip"),
						options: z.array(optionSchema).min(2).max(4).describe("Mutually exclusive choices"),
						multiSelect: z
							.boolean()
							.optional()
							.describe(
								'True when more than one option may be chosen; the answer comes back as the chosen labels joined with ", "',
							),
					}),
				)
				.min(1)
				.max(4),
		}),
		prompt:
			"- Use this only after inspecting the repository; if the answer is discoverable, find it instead of asking.\n" +
			"- Do not use it to confirm a reversible step you can undo, or to hand back work the user already asked for.\n" +
			"- Batch related questions into one call. Put your recommended option first and say in its description what changes if it is chosen.",
		isReadOnly: () => true,
		isConcurrencySafe: () => false,
		call: async (input, toolCtx) => {
			const answers = await bridge.askUser(
				input.questions.map((q) => ({
					question: q.question,
					header: q.header,
					options: q.options,
					multiSelect: q.multiSelect,
				})),
				toolCtx.signal,
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
