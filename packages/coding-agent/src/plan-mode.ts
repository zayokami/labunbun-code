/**
 * Plan mode tools: EnterPlanMode switches the session to read-only planning;
 * ExitPlanMode presents the plan for user approval before mutations resume.
 */

import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

export interface PlanModeCallbacks {
	enterPlanMode(): void;
	/** Present the plan; resolves when the user approves or rejects. */
	requestPlanApproval(plan: string): Promise<{ approved: boolean; feedback?: string }>;
}

export function createPlanModeTools(callbacks: PlanModeCallbacks): AnyTool[] {
	const enter = buildTool({
		name: "EnterPlanMode",
		description:
			"Switch to plan mode: research and design without making changes. Use for non-trivial " +
			"implementation tasks where the approach needs user sign-off first.",
		inputSchema: z.object({}),
		prompt: "- Call EnterPlanMode before designing multi-file or architectural changes.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async () => {
			callbacks.enterPlanMode();
			return {
				content: [
					textContent(
						"Plan mode active. You may only use read-only tools (Read/Grep/Glob/LS). " +
							"Design your approach, then call ExitPlanMode with the plan for approval.",
					),
				],
			};
		},
	});

	const exit = buildTool({
		name: "ExitPlanMode",
		description:
			"Present your implementation plan for user approval. Blocks until the user approves " +
			"or provides feedback. Only call after researching in plan mode.",
		inputSchema: z.object({
			plan: z.string().describe("The complete implementation plan for review"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => false,
		call: async (input) => {
			const decision = await callbacks.requestPlanApproval(input.plan);
			if (decision.approved) {
				return {
					content: [textContent("Plan approved. Plan mode restrictions lifted — you may now implement.")],
					details: { approved: true },
				};
			}
			return {
				content: [
					textContent(
						`Plan rejected by the user.${decision.feedback ? ` Feedback: ${decision.feedback}` : ""} Revise the plan and call ExitPlanMode again.`,
					),
				],
				details: { approved: false },
			};
		},
	});

	return [enter, exit];
}
