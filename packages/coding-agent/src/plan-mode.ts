/**
 * Plan mode tools: EnterPlanMode switches the session to read-only planning;
 * ExitPlanMode presents the plan for user approval before mutations resume.
 */

import { type AgentSession, type AnyTool, buildTool, type PermissionMode } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

export interface PlanModeCallbacks {
	enterPlanMode(): void;
	/**
	 * Present the plan; resolves when the user approves or rejects.
	 *
	 * `signal` is the calling run's abort. The dialog is a wait on a human, and
	 * the run can be aborted while it is up — without the signal the tool call
	 * stays awaited by a turn that is already over, and the dialog outlives the
	 * session it was asking about.
	 */
	requestPlanApproval(plan: string, signal?: AbortSignal): Promise<{ approved: boolean; feedback?: string }>;
}

export interface PlanApprovalUi {
	/** Present a permission dialog; resolves to false when refused or canceled. */
	requestPermission(toolName: string, input: unknown, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Wire plan-mode tools to a live session and REPL handle.
 *
 * Mode bookkeeping is deliberately session-captured at call time: the approval
 * dialog is async, and an in-app /resume can swap the running session while it
 * is open — the saved mode then belongs to the session that asked, not to
 * whichever session is current when the user answers.
 */
export function createPlanModeCallbacks(
	getSession: () => AgentSession | null,
	getUi: () => PlanApprovalUi | null,
): PlanModeCallbacks {
	const previousModes = new WeakMap<AgentSession, PermissionMode>();
	return {
		enterPlanMode: () => {
			const session = getSession();
			if (!session) return;
			if (session.permissionMode !== "plan") {
				previousModes.set(session, session.permissionMode);
			}
			session.setPermissionMode("plan");
		},
		requestPlanApproval: async (plan, signal) => {
			// Capture everything before the await: the session that entered plan
			// mode and the mode it had before. A swap must leave the newcomer's
			// mode untouched.
			const session = getSession();
			const ui = getUi();
			if (!session || !ui) {
				return { approved: false, feedback: "No interactive session to approve the plan" };
			}
			const previousMode =
				session.permissionMode === "plan" ? (previousModes.get(session) ?? "default") : session.permissionMode;
			let approved: boolean;
			try {
				approved = await ui.requestPermission("ExitPlanMode", { plan }, signal);
			} catch {
				return { approved: false, feedback: "Plan approval dialog failed" };
			}
			if (!approved) {
				return { approved: false };
			}
			// An interrupt that raced the dialog (Esc while it was up) counts as
			// canceled, not approved: leave the plan-mode gate exactly as it was.
			// The signal is the same statement one level up, and it is checked here
			// as well as at the UI: a dialog that answered "approved" without racing
			// its own signal must still not lift plan mode for an aborted run.
			if (session.isInterrupted || signal?.aborted) {
				return { approved: false, feedback: "Plan approval canceled" };
			}
			if (getSession() !== session) {
				// The session was swapped mid-dialog; the new session is not plan
				// mode and must not inherit a lift granted to its predecessor.
				return { approved: false, feedback: "Session changed during approval" };
			}
			// Keep the saved mode across rejection/retry; consume it only on approval.
			session.setPermissionMode(previousMode);
			previousModes.delete(session);
			return { approved: true };
		},
	};
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
						"Plan mode active. You may only use read-only tools (Read/Grep/Glob/LS, plus " +
							"WebFetch/WebSearch for background), and AskUserQuestion when a decision is the " +
							"user's. Design your approach, then call ExitPlanMode with the plan for approval.",
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
		call: async (input, toolCtx) => {
			const decision = await callbacks.requestPlanApproval(input.plan, toolCtx.signal);
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
